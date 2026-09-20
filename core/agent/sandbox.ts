import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { lookup } from "node:dns/promises";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import untildify from "untildify";

import type { FetchFunction, IDE } from "..";
import type { ExecutionBackend } from "./execution";
import type { ResolvedPath } from "../util/pathResolver";
import { markIsolatedProcessGroup } from "../util/processTerminalStates";
import { spawnWindowsAppContainerShell } from "./windowsSandbox";

export class SandboxViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxViolationError";
  }
}

type Env = NodeJS.ProcessEnv;

const SAFE_ENV_KEYS = new Set([
  "PATH",
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "FORCE_COLOR",
  "NO_COLOR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
]);

function getEnvironmentValue(source: Env, name: string): string | undefined {
  const entry = Object.entries(source).find(
    ([key]) => key.toUpperCase() === name.toUpperCase(),
  );
  return entry?.[1];
}

export function sanitizeSandboxEnvironment(
  input: Env | undefined,
  homeDirectory: string,
  tempDirectory = homeDirectory,
): Env {
  const source = input ?? process.env;
  const output: Env = {};

  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toUpperCase();
    if (SAFE_ENV_KEYS.has(normalizedKey) || normalizedKey.startsWith("LC_")) {
      output[normalizedKey] = value;
    }
  }

  // Windows commonly exposes Path rather than PATH. Canonicalize it so helper
  // lookup never falls back to an unsanitized environment by accident.
  output.PATH = getEnvironmentValue(source, "PATH") ?? "";
  output.HOME = homeDirectory;
  output.USERPROFILE = homeDirectory;
  output.TMPDIR = tempDirectory;
  output.TEMP = tempDirectory;
  output.TMP = tempDirectory;
  output.STAMCONT_SANDBOX = "1";
  return output;
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function findExecutable(name: string, env: Env): string | undefined {
  const pathValue = env.PATH ?? process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

function getPortableShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  for (const candidate of ["/bin/bash", "/bin/sh", process.env.SHELL]) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return "/bin/sh";
}

function isBlockedIpv4(address: string): boolean {
  const p = address.split(".").map(Number);
  if (
    p.length !== 4 ||
    p.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && p[2] === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && p[2] === 100) ||
    (a === 203 && b === 0 && p[2] === 113) ||
    a >= 224
  );
}

function isBlockedIp(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isBlockedIpv4(normalized.slice("::ffff:".length));
  }
  if (isIP(address) === 4) {
    return isBlockedIpv4(address);
  }
  if (isIP(address) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89a-f]/.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return true;
}

export interface RestrictedDnsAddress {
  address: string;
  family: number;
}

export type RestrictedDnsResolver = (
  hostname: string,
) => Promise<readonly RestrictedDnsAddress[]>;

const defaultRestrictedDnsResolver: RestrictedDnsResolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export interface RestrictedNetworkTarget {
  url: URL;
  address: string;
  family: number;
}

function normalizeHostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

export async function resolveRestrictedNetworkTarget(
  value: string | URL,
  resolver: RestrictedDnsResolver = defaultRestrictedDnsResolver,
): Promise<RestrictedNetworkTarget> {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SandboxViolationError(
      `Restricted network only permits HTTP(S), received ${url.protocol}`,
    );
  }
  if (url.username || url.password) {
    throw new SandboxViolationError(
      "Restricted network URLs may not contain embedded credentials",
    );
  }

  const hostname = normalizeHostname(url);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new SandboxViolationError(
      `Restricted network blocked local hostname ${hostname}`,
    );
  }

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isBlockedIp(hostname)) {
      throw new SandboxViolationError(
        `Restricted network blocked private/reserved address ${hostname}`,
      );
    }
    return { url, address: hostname, family: literalFamily };
  }

  const addresses = await resolver(hostname);
  if (addresses.length === 0) {
    throw new SandboxViolationError(
      `Restricted network could not resolve ${hostname}`,
    );
  }

  // The policy is intentionally strict: if any answer is private/reserved, the
  // hostname is rejected rather than letting address ordering decide safety.
  const blocked = addresses.find((entry) => isBlockedIp(entry.address));
  if (blocked) {
    throw new SandboxViolationError(
      `Restricted network blocked ${hostname} because it resolves to ${blocked.address}`,
    );
  }

  const selected = addresses[0];
  return {
    url,
    address: selected.address,
    family: selected.family,
  };
}

export async function assertRestrictedNetworkTarget(
  value: string | URL,
  resolver: RestrictedDnsResolver = defaultRestrictedDnsResolver,
): Promise<URL> {
  return (await resolveRestrictedNetworkTarget(value, resolver)).url;
}

export function createPinnedLookup(target: RestrictedNetworkTarget): any {
  const expectedHostname = normalizeHostname(target.url);
  return (
    hostname: string,
    options: any,
    callback?: (...args: any[]) => void,
  ): void => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    if (!callback) {
      throw new Error("Pinned DNS lookup requires a callback");
    }

    const requestedHostname = hostname.replace(/\.$/, "").toLowerCase();
    if (requestedHostname !== expectedHostname) {
      callback(
        new SandboxViolationError(
          `Restricted network refused DNS drift from ${expectedHostname} to ${requestedHostname}`,
        ),
      );
      return;
    }

    if (options?.all) {
      callback(null, [
        {
          address: target.address,
          family: target.family,
        },
      ]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

export interface RestrictedFetchOptions {
  resolver?: RestrictedDnsResolver;
  maxRedirects?: number;
}

export function createRestrictedFetch(
  delegate: FetchFunction,
  options: RestrictedFetchOptions = {},
): FetchFunction {
  const resolver = options.resolver ?? defaultRestrictedDnsResolver;
  const maxRedirects = options.maxRedirects ?? 5;

  const restrictedFetch = async (
    value: string | URL,
    init?: any,
    redirectDepth = 0,
  ): Promise<any> => {
    if (redirectDepth > maxRedirects) {
      throw new SandboxViolationError("Restricted network redirect limit exceeded");
    }

    const target = await resolveRestrictedNetworkTarget(value, resolver);
    const lookupFn = createPinnedLookup(target);
    const agent =
      target.url.protocol === "https:"
        ? new HttpsAgent({ keepAlive: false, lookup: lookupFn })
        : new HttpAgent({ keepAlive: false, lookup: lookupFn });

    // Keep the original hostname in the URL. The custom agent only controls
    // address selection, so HTTP Host, TLS SNI and certificate verification
    // remain bound to the user-visible hostname.
    const response = await delegate(target.url, {
      ...(init ?? {}),
      redirect: "manual",
      agent,
    });

    if (
      response &&
      [301, 302, 303, 307, 308].includes(response.status) &&
      typeof response.headers?.get === "function"
    ) {
      const location = response.headers.get("location");
      if (location) {
        return restrictedFetch(
          new URL(location, target.url),
          init,
          redirectDepth + 1,
        );
      }
    }
    return response;
  };
  return restrictedFetch as FetchFunction;
}

function addLinuxRuntimeBindings(args: string[]): void {
  for (const systemPath of [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/nix/store",
  ]) {
    if (existsSync(systemPath)) {
      args.push("--ro-bind", systemPath, systemPath);
    }
  }

  for (const file of [
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/nsswitch.conf",
    "/etc/localtime",
  ]) {
    if (existsSync(file)) {
      args.push("--ro-bind", file, file);
    }
  }
}

function addParentDirectories(args: string[], roots: string[]): void {
  const dirs = new Set<string>();
  for (const root of roots) {
    let current = path.dirname(root);
    while (current !== path.parse(current).root) {
      dirs.add(current);
      current = path.dirname(current);
    }
  }
  [...dirs]
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)
    .forEach((dir) => args.push("--dir", dir));
}

function buildMacSandboxProfile(
  roots: string[],
  privateTemp: string,
  readOnly: boolean,
): string {
  const quote = (value: string) =>
    value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const rootSubpaths = roots
    .map((root) => `(subpath "${quote(root)}")`)
    .join(" ");
  const writableRoots = readOnly ? "" : rootSubpaths;

  return `(version 1)
(deny default)
(allow process*)
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") (subpath "/opt/homebrew") (subpath "/dev") ${rootSubpaths} (subpath "${quote(privateTemp)}"))
(allow file-write* ${writableRoots} (subpath "${quote(privateTemp)}") (literal "/dev/null"))
(deny network*)`;
}

function createPrivateTempDirectory(): string {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "stamcont-sandbox-"));
  mkdirSync(path.join(tempRoot, "home"), { recursive: true });
  mkdirSync(path.join(tempRoot, "tmp"), { recursive: true });
  return tempRoot;
}

function attachTempCleanup(child: ChildProcess, tempRoot: string): ChildProcess {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort. The directory is uniquely scoped to this
      // sandbox process and contains no host secrets.
    }
  };
  child.once("close", cleanup);
  child.once("error", cleanup);
  return child;
}

function spawnSandboxedShell(
  command: string,
  options: SpawnOptions,
  roots: string[],
  cwd: string,
  readOnly: boolean,
): ChildProcess {
  const shell = getPortableShell();

  if (process.platform === "linux") {
    const env = sanitizeSandboxEnvironment(
      options.env as Env | undefined,
      "/tmp/stamcont-home",
      "/tmp",
    );
    const bwrap = findExecutable("bwrap", env);
    if (!bwrap) {
      throw new SandboxViolationError(
        "Interactive shell sandbox requires bubblewrap (bwrap) on Linux. Full Access remains available explicitly.",
      );
    }
    const args = [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--unshare-net",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/tmp/stamcont-home",
    ];
    addLinuxRuntimeBindings(args);
    addParentDirectories(args, roots);
    for (const root of roots) {
      args.push(readOnly ? "--ro-bind" : "--bind", root, root);
    }
    args.push("--chdir", cwd, "--setenv", "HOME", "/tmp/stamcont-home");
    args.push("--setenv", "TMPDIR", "/tmp", "--setenv", "TEMP", "/tmp");
    args.push("--setenv", "TMP", "/tmp");
    args.push(shell, "-c", command);
    return markIsolatedProcessGroup(
      spawn(bwrap, args, {
        ...options,
        cwd,
        env,
        detached: true,
      }),
    );
  }

  if (process.platform === "win32") {
    const tempRoot = createPrivateTempDirectory();
    const homeDirectory = path.join(tempRoot, "home");
    const tempDirectory = path.join(tempRoot, "tmp");
    const env = sanitizeSandboxEnvironment(
      options.env as Env | undefined,
      homeDirectory,
      tempDirectory,
    );

    try {
      const child = markIsolatedProcessGroup(
        spawnWindowsAppContainerShell(command, {
          roots,
          cwd,
          readOnly,
          homeDirectory,
          tempDirectory,
          env,
          spawnOptions: options,
        }),
      );
      return attachTempCleanup(child, tempRoot);
    } catch (error) {
      rmSync(tempRoot, { recursive: true, force: true });
      throw new SandboxViolationError(
        `Windows AppContainer sandbox launch failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (process.platform === "darwin") {
    const sandboxExec = "/usr/bin/sandbox-exec";
    if (!existsSync(sandboxExec)) {
      throw new SandboxViolationError(
        "Interactive shell sandbox requires sandbox-exec on macOS. Full Access remains available explicitly.",
      );
    }

    const tempRoot = createPrivateTempDirectory();
    const env = sanitizeSandboxEnvironment(
      options.env as Env | undefined,
      path.join(tempRoot, "home"),
      tempRoot,
    );
    try {
      const child = markIsolatedProcessGroup(
        spawn(
          sandboxExec,
          [
            "-p",
            buildMacSandboxProfile(roots, tempRoot, readOnly),
            shell,
            "-c",
            command,
          ],
          {
            ...options,
            cwd,
            env,
            detached: true,
          },
        ),
      );
      return attachTempCleanup(child, tempRoot);
    } catch (error) {
      rmSync(tempRoot, { recursive: true, force: true });
      throw error;
    }
  }

  throw new SandboxViolationError(
    `Interactive shell sandbox is not enforceable on ${process.platform}; use Full Access explicitly for shell execution.`,
  );
}

export interface SandboxExecutionOptions {
  readOnly?: boolean;
}

export class SandboxExecutionBackend implements ExecutionBackend {
  readonly kind = "sandbox" as const;
  readonly enforceSensitivePathChecks = true;

  private workspaceRoots?: Promise<string[]>;
  private resolvedWorkspaceRoots?: string[];

  constructor(
    private readonly ide: IDE,
    private readonly options: SandboxExecutionOptions = {},
  ) {}

  wrapFetch(fetch: FetchFunction): FetchFunction {
    return createRestrictedFetch(fetch);
  }

  async resolveExistingPath(inputPath: string): Promise<ResolvedPath | null> {
    const candidates = await this.resolveCandidates(inputPath);
    for (const candidate of candidates) {
      try {
        const canonical = await fs.realpath(candidate);
        await this.assertInsideWorkspace(canonical);
        return this.toResolvedPath(canonical, inputPath);
      } catch (error) {
        if (error instanceof SandboxViolationError) {
          throw error;
        }
      }
    }
    return null;
  }

  async resolveWritablePath(inputPath: string): Promise<ResolvedPath> {
    if (this.options.readOnly) {
      throw new SandboxViolationError(
        "Plan sandbox is read-only; writable paths are not permitted",
      );
    }
    const [candidate] = await this.resolveCandidates(inputPath, true);
    if (!candidate) {
      throw new SandboxViolationError("No local workspace root is available");
    }
    await this.assertWritableCandidate(candidate);
    return this.toResolvedPath(path.resolve(candidate), inputPath);
  }

  async readFile(resolvedPath: ResolvedPath): Promise<string> {
    const canonical = await fs.realpath(resolvedPath.displayPath);
    await this.assertInsideWorkspace(canonical);
    return fs.readFile(canonical, "utf8");
  }

  async readFileRange(
    resolvedPath: ResolvedPath,
    startLine: number,
    endLine: number,
  ): Promise<string> {
    const content = await this.readFile(resolvedPath);
    return content.split(/\r?\n/).slice(startLine - 1, endLine).join("\n");
  }

  async fileExists(resolvedPath: ResolvedPath): Promise<boolean> {
    try {
      const canonical = await fs.realpath(resolvedPath.displayPath);
      await this.assertInsideWorkspace(canonical);
      return true;
    } catch {
      return false;
    }
  }

  async writeFile(
    resolvedPath: ResolvedPath,
    contents: string,
  ): Promise<void> {
    if (this.options.readOnly) {
      throw new SandboxViolationError(
        "Plan sandbox is read-only; filesystem writes are not permitted",
      );
    }

    await this.assertWritableCandidate(resolvedPath.displayPath);
    await fs.mkdir(path.dirname(resolvedPath.displayPath), { recursive: true });
    await this.assertWritableCandidate(resolvedPath.displayPath);

    // Refuse to follow a final-component symlink during the write itself.
    // Parent-directory replacement is still a platform-level TOCTOU concern,
    // but this closes the most direct validation-to-open race exposed by
    // fs.writeFile following a swapped final symlink.
    const noFollow =
      (fsConstants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
    const handle = await fs.open(
      resolvedPath.displayPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        noFollow,
      0o666,
    );
    try {
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
  }

  async listDirectory(
    resolvedPath: ResolvedPath,
    recursive: boolean,
    maxEntries: number,
  ): Promise<string[]> {
    const root = await fs.realpath(resolvedPath.displayPath);
    await this.assertInsideWorkspace(root);
    const results: string[] = [];

    const walk = async (directory: string, prefix: string): Promise<void> => {
      if (results.length >= maxEntries) {
        return;
      }
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxEntries) {
          return;
        }
        const absolute = path.join(directory, entry.name);
        const relative = prefix ? path.join(prefix, entry.name) : entry.name;
        results.push(relative.replaceAll(path.sep, "/"));
        if (recursive && entry.isDirectory() && !entry.isSymbolicLink()) {
          const canonical = await fs.realpath(absolute);
          await this.assertInsideWorkspace(canonical);
          await walk(canonical, relative);
        }
      }
    };

    await walk(root, "");
    return results;
  }

  async resolveWorkingDirectory(requestedCwd?: string): Promise<string> {
    const input = requestedCwd?.trim() || ".";
    const resolved = await this.resolveExistingPath(input);
    if (!resolved) {
      throw new SandboxViolationError(
        `Sandbox working directory does not exist: ${input}`,
      );
    }
    const canonical = await fs.realpath(resolved.displayPath);
    const stats = await fs.stat(canonical);
    if (!stats.isDirectory()) {
      throw new SandboxViolationError(
        `Sandbox working directory is not a directory: ${input}`,
      );
    }
    return canonical;
  }

  async isLocalShell(): Promise<boolean> {
    const ideInfo = await this.ide.getIdeInfo();
    if (ideInfo.remoteName !== "" && ideInfo.remoteName !== "local") {
      throw new SandboxViolationError(
        "Interactive sandbox currently requires a local workspace host",
      );
    }
    return true;
  }

  spawnShell(command: string, options: SpawnOptions): ChildProcess {
    if (!options.cwd || typeof options.cwd !== "string") {
      throw new SandboxViolationError(
        "Sandbox shell requires an explicit validated working directory",
      );
    }
    const roots = this.resolvedWorkspaceRoots;
    if (!roots) {
      throw new SandboxViolationError(
        "Sandbox roots were not initialized before process launch",
      );
    }
    return spawnSandboxedShell(
      command,
      options,
      roots,
      options.cwd,
      this.options.readOnly === true,
    );
  }

  async runShell(_command: string): Promise<void> {
    throw new SandboxViolationError(
      "Remote IDE shell delegation is disabled in Interactive sandbox mode",
    );
  }

  private async getWorkspaceRoots(): Promise<string[]> {
    if (!this.workspaceRoots) {
      const pending = (async () => {
        const roots: string[] = [];
        for (const uri of await this.ide.getWorkspaceDirs()) {
          if (!uri.startsWith("file:")) {
            continue;
          }
          const canonical = await fs.realpath(fileURLToPath(uri));
          roots.push(canonical);
        }
        if (roots.length === 0) {
          throw new SandboxViolationError(
            "Interactive sandbox requires at least one local file workspace",
          );
        }
        const uniqueRoots = [...new Set(roots)];
        this.resolvedWorkspaceRoots = uniqueRoots;
        return uniqueRoots;
      })();
      this.workspaceRoots = pending;
    }
    return this.workspaceRoots;
  }

  private async resolveCandidates(
    inputPath: string,
    writable = false,
  ): Promise<string[]> {
    const trimmed = inputPath.trim();
    const roots = await this.getWorkspaceRoots();
    if (!trimmed || trimmed === ".") {
      return [roots[0]];
    }
    if (trimmed.startsWith("file://")) {
      return [fileURLToPath(trimmed)];
    }
    const expanded = untildify(trimmed);
    if (
      path.isAbsolute(expanded) ||
      expanded.startsWith("\\\\") ||
      /^[a-zA-Z]:/.test(expanded)
    ) {
      return [path.resolve(expanded)];
    }

    if (writable) {
      return [path.resolve(roots[0], expanded)];
    }
    return roots.map((root) => path.resolve(root, expanded));
  }

  private async assertInsideWorkspace(candidate: string): Promise<void> {
    const roots = await this.getWorkspaceRoots();
    if (!roots.some((root) => pathWithin(root, candidate))) {
      throw new SandboxViolationError(
        `Sandbox blocked path outside workspace: ${candidate}`,
      );
    }
  }

  private async assertWritableCandidate(candidate: string): Promise<void> {
    const absolute = path.resolve(candidate);
    let existing = absolute;
    while (true) {
      try {
        const canonical = await fs.realpath(existing);
        await this.assertInsideWorkspace(canonical);
        const relativeTail = path.relative(existing, absolute);
        const rebuilt = path.resolve(canonical, relativeTail);
        await this.assertInsideWorkspace(rebuilt);
        return;
      } catch (error: any) {
        if (error instanceof SandboxViolationError) {
          throw error;
        }
        if (error?.code !== "ENOENT") {
          throw error;
        }
        const parent = path.dirname(existing);
        if (parent === existing) {
          throw new SandboxViolationError(
            `Sandbox could not resolve writable path: ${candidate}`,
          );
        }
        existing = parent;
      }
    }
  }

  private toResolvedPath(
    absolutePath: string,
    displayInput: string,
  ): ResolvedPath {
    return {
      uri: pathToFileURL(absolutePath).href,
      displayPath: absolutePath,
      isAbsolute:
        path.isAbsolute(displayInput) || displayInput.startsWith("file://"),
      isWithinWorkspace: true,
    };
  }
}
