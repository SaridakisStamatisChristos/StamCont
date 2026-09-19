import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import untildify from "untildify";

import type { FetchFunction, IDE } from "..";
import type { ExecutionBackend } from "./execution";
import type { ResolvedPath } from "../util/pathResolver";

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
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
]);

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

export function sanitizeSandboxEnvironment(
  input: Env | undefined,
  workspaceRoot: string,
): Env {
  const source = input ?? process.env;
  const output: Env = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      SAFE_ENV_KEYS.has(key) ||
      key.startsWith("LC_") ||
      key.startsWith("STAMCONT_")
    ) {
      output[key] = value;
    }
  }
  output.HOME = workspaceRoot;
  output.USERPROFILE = workspaceRoot;
  output.STAMCONT_SANDBOX = "1";
  return output;
}

function isBlockedIpv4(address: string): boolean {
  const p = address.split(".").map(Number);
  if (p.length !== 4 || p.some((part) => !Number.isInteger(part))) {
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
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && p[2] === 2) ||
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
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff")
    );
  }
  return true;
}

export async function assertRestrictedNetworkTarget(
  value: string | URL,
): Promise<URL> {
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

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new SandboxViolationError(
      `Restricted network blocked local hostname ${hostname}`,
    );
  }

  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new SandboxViolationError(
        `Restricted network blocked private/reserved address ${hostname}`,
      );
    }
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new SandboxViolationError(
      `Restricted network could not resolve ${hostname}`,
    );
  }
  const blocked = addresses.find((entry) => isBlockedIp(entry.address));
  if (blocked) {
    throw new SandboxViolationError(
      `Restricted network blocked ${hostname} because it resolves to ${blocked.address}`,
    );
  }
  return url;
}

export function createRestrictedFetch(delegate: FetchFunction): FetchFunction {
  const restrictedFetch = async (
    value: string | URL,
    init?: any,
    redirectDepth = 0,
  ): Promise<any> => {
    if (redirectDepth > 5) {
      throw new SandboxViolationError("Restricted network redirect limit exceeded");
    }
    const url = await assertRestrictedNetworkTarget(value);
    const response = await delegate(url, { ...(init ?? {}), redirect: "manual" });
    if (
      response &&
      [301, 302, 303, 307, 308].includes(response.status) &&
      typeof response.headers?.get === "function"
    ) {
      const location = response.headers.get("location");
      if (location) {
        return restrictedFetch(
          new URL(location, url),
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
    "/etc/passwd",
    "/etc/group",
    "/etc/localtime",
    "/etc/gitconfig",
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

function buildMacSandboxProfile(roots: string[]): string {
  const quote = (value: string) =>
    value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const subpaths = roots
    .map((root) => `(subpath "${quote(root)}")`)
    .join(" ");
  return `(version 1)
(deny default)
(allow process*)
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") ${subpaths})
(allow file-write* ${subpaths} (subpath "/tmp") (subpath "/private/tmp"))
(deny network*)`;
}

function spawnSandboxedShell(
  command: string,
  options: SpawnOptions,
  roots: string[],
  cwd: string,
): ChildProcess {
  const workspaceRoot = roots[0];
  const env = sanitizeSandboxEnvironment(options.env as Env | undefined, workspaceRoot);
  const shell = getPortableShell();

  if (process.platform === "linux") {
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
    ];
    addLinuxRuntimeBindings(args);
    addParentDirectories(args, roots);
    for (const root of roots) {
      args.push("--bind", root, root);
    }
    args.push("--chdir", cwd, "--setenv", "HOME", workspaceRoot);
    args.push(shell, "-lc", command);
    return spawn(bwrap, args, {
      ...options,
      cwd,
      env,
      detached: true,
    });
  }

  if (process.platform === "darwin") {
    const sandboxExec = "/usr/bin/sandbox-exec";
    if (!existsSync(sandboxExec)) {
      throw new SandboxViolationError(
        "Interactive shell sandbox requires sandbox-exec on macOS. Full Access remains available explicitly.",
      );
    }
    return spawn(
      sandboxExec,
      ["-p", buildMacSandboxProfile(roots), shell, "-lc", command],
      {
        ...options,
        cwd,
        env,
        detached: true,
      },
    );
  }

  throw new SandboxViolationError(
    `Interactive shell sandbox is not yet enforceable on ${process.platform}; use Full Access explicitly for shell execution.`,
  );
}

export class SandboxExecutionBackend implements ExecutionBackend {
  readonly kind = "sandbox" as const;
  readonly enforceSensitivePathChecks = true;

  private workspaceRoots?: Promise<string[]>;

  constructor(private readonly ide: IDE) {}

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
    await this.assertWritableCandidate(resolvedPath.displayPath);
    await fs.mkdir(path.dirname(resolvedPath.displayPath), { recursive: true });
    await this.assertWritableCandidate(resolvedPath.displayPath);
    await fs.writeFile(resolvedPath.displayPath, contents, "utf8");
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
    const rootsPromise = this.workspaceRoots;
    if (!rootsPromise) {
      throw new SandboxViolationError(
        "Sandbox roots were not initialized before process launch",
      );
    }

    // resolveWorkingDirectory initializes roots before spawnShell is reached.
    const roots = (rootsPromise as Promise<string[]> & { __resolved?: string[] })
      .__resolved;
    if (!roots) {
      throw new SandboxViolationError(
        "Sandbox roots are still initializing; retry the command",
      );
    }
    return spawnSandboxedShell(command, options, roots, options.cwd);
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
        return [...new Set(roots)];
      })();
      this.workspaceRoots = pending;
      pending.then((roots) => {
        (pending as Promise<string[]> & { __resolved?: string[] }).__resolved =
          roots;
      });
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
