import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ignore from "ignore";
import untildify from "untildify";

import type { FetchFunction, IDE } from "..";
import { walkDir } from "../indexing/walkDir";
import { inferResolvedUriFromRelativePath } from "../util/ideUtils";
import {
  resolveInputPath,
  type ResolvedPath,
} from "../util/pathResolver";
import type { BuiltInExecutionProfileId } from "./capabilities";
import { SandboxExecutionBackend } from "./sandbox";

export type ExecutionBackendKind = "ide" | "sandbox" | "host";

export interface ExecutionBackend {
  readonly kind: ExecutionBackendKind;
  readonly enforceSensitivePathChecks: boolean;

  wrapFetch(fetch: FetchFunction): FetchFunction;
  resolveExistingPath(inputPath: string): Promise<ResolvedPath | null>;
  resolveWritablePath(inputPath: string): Promise<ResolvedPath>;
  readFile(resolvedPath: ResolvedPath): Promise<string>;
  readFileRange(
    resolvedPath: ResolvedPath,
    startLine: number,
    endLine: number,
  ): Promise<string>;
  fileExists(resolvedPath: ResolvedPath): Promise<boolean>;
  writeFile(resolvedPath: ResolvedPath, contents: string): Promise<void>;
  listDirectory(
    resolvedPath: ResolvedPath,
    recursive: boolean,
    maxEntries: number,
  ): Promise<string[]>;
  resolveWorkingDirectory(requestedCwd?: string): Promise<string>;
  isLocalShell(): Promise<boolean>;
  spawnShell(command: string, options: SpawnOptions): ChildProcess;
  runShell(command: string): Promise<void>;
}

function getShellCommand(command: string): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      shell: "powershell.exe",
      args: ["-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", command],
    };
  }

  const userShell = process.env.SHELL || "/bin/bash";
  return { shell: userShell, args: ["-l", "-c", command] };
}

function spawnShell(command: string, options: SpawnOptions): ChildProcess {
  const invocation = getShellCommand(command);
  return spawn(invocation.shell, invocation.args, options);
}

async function getIdeDefaultWorkingDirectory(ide: IDE): Promise<string> {
  const workspaceDirs = await ide.getWorkspaceDirs();
  const fileWorkspace = workspaceDirs.find((dir) => dir.startsWith("file:/"));
  if (fileWorkspace) {
    try {
      return fileURLToPath(fileWorkspace);
    } catch {
      // Preserve the previous terminal fallback behavior.
    }
  }

  const remoteWorkspace = workspaceDirs.find(
    (dir) => dir.includes("://") && !dir.startsWith("file:/"),
  );
  if (remoteWorkspace) {
    try {
      return decodeURIComponent(new URL(remoteWorkspace).pathname);
    } catch {
      // Preserve the previous terminal fallback behavior.
    }
  }

  try {
    return process.env.HOME || process.env.USERPROFILE || process.cwd();
  } catch {
    return os.tmpdir();
  }
}

export class IdeExecutionBackend implements ExecutionBackend {
  readonly kind = "ide" as const;
  readonly enforceSensitivePathChecks = true;

  constructor(private readonly ide: IDE) {}

  wrapFetch(fetch: FetchFunction): FetchFunction {
    return fetch;
  }

  resolveExistingPath(inputPath: string): Promise<ResolvedPath | null> {
    return resolveInputPath(this.ide, inputPath);
  }

  async resolveWritablePath(inputPath: string): Promise<ResolvedPath> {
    const uri = await inferResolvedUriFromRelativePath(inputPath, this.ide);
    return {
      uri,
      displayPath: inputPath.trim(),
      isAbsolute: false,
      isWithinWorkspace: true,
    };
  }

  readFile(resolvedPath: ResolvedPath): Promise<string> {
    return this.ide.readFile(resolvedPath.uri);
  }

  readFileRange(
    resolvedPath: ResolvedPath,
    startLine: number,
    endLine: number,
  ): Promise<string> {
    return this.ide.readRangeInFile(resolvedPath.uri, {
      start: { line: startLine - 1, character: 0 },
      end: { line: endLine - 1, character: 2147483647 },
    });
  }

  fileExists(resolvedPath: ResolvedPath): Promise<boolean> {
    return this.ide.fileExists(resolvedPath.uri);
  }

  writeFile(resolvedPath: ResolvedPath, contents: string): Promise<void> {
    return this.ide.writeFile(resolvedPath.uri, contents);
  }

  async listDirectory(
    resolvedPath: ResolvedPath,
    recursive: boolean,
    _maxEntries: number,
  ): Promise<string[]> {
    // Preserve the legacy IDE listing behavior so lsTool can report an exact
    // truncation count. The Host backend remains bounded because a recursive
    // whole-machine traversal must not materialize an unbounded result set.
    return walkDir(resolvedPath.uri, this.ide, {
      returnRelativeUrisPaths: true,
      include: "both",
      recursive,
      overrideDefaultIgnores: ignore(),
    });
  }

  async resolveWorkingDirectory(requestedCwd?: string): Promise<string> {
    if (!requestedCwd?.trim()) {
      return getIdeDefaultWorkingDirectory(this.ide);
    }

    const resolved = await resolveInputPath(this.ide, requestedCwd);
    if (!resolved?.isWithinWorkspace) {
      throw new Error(
        `Working directory "${requestedCwd}" is outside the current workspace`,
      );
    }
    return resolved.uri.startsWith("file:")
      ? fileURLToPath(resolved.uri)
      : resolved.displayPath;
  }

  async isLocalShell(): Promise<boolean> {
    const ideInfo = await this.ide.getIdeInfo();
    return ideInfo.remoteName === "" || ideInfo.remoteName === "local";
  }

  spawnShell(command: string, options: SpawnOptions): ChildProcess {
    return spawnShell(command, options);
  }

  runShell(command: string): Promise<void> {
    return this.ide.runCommand(command);
  }
}

export class HostExecutionBackend implements ExecutionBackend {
  readonly kind = "host" as const;
  readonly enforceSensitivePathChecks = false;

  private defaultWorkingDirectory?: Promise<string>;

  constructor(private readonly ide: IDE) {}

  wrapFetch(fetch: FetchFunction): FetchFunction {
    return fetch;
  }

  async resolveExistingPath(inputPath: string): Promise<ResolvedPath | null> {
    const hostPath = await this.resolveHostPath(inputPath);
    try {
      await fs.access(hostPath);
    } catch {
      return null;
    }
    return this.toResolvedPath(hostPath);
  }

  async resolveWritablePath(inputPath: string): Promise<ResolvedPath> {
    return this.toResolvedPath(await this.resolveHostPath(inputPath));
  }

  readFile(resolvedPath: ResolvedPath): Promise<string> {
    return fs.readFile(resolvedPath.displayPath, "utf8");
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
      await fs.access(resolvedPath.displayPath);
      return true;
    } catch {
      return false;
    }
  }

  async writeFile(
    resolvedPath: ResolvedPath,
    contents: string,
  ): Promise<void> {
    await fs.mkdir(path.dirname(resolvedPath.displayPath), { recursive: true });
    await fs.writeFile(resolvedPath.displayPath, contents, "utf8");
  }

  async listDirectory(
    resolvedPath: ResolvedPath,
    recursive: boolean,
    maxEntries: number,
  ): Promise<string[]> {
    const root = resolvedPath.displayPath;
    const results: string[] = [];

    const walk = async (dir: string, prefix: string): Promise<void> => {
      if (results.length >= maxEntries) {
        return;
      }
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxEntries) {
          return;
        }
        const relative = prefix ? path.join(prefix, entry.name) : entry.name;
        results.push(relative.replaceAll(path.sep, "/"));
        if (recursive && entry.isDirectory()) {
          await walk(path.join(dir, entry.name), relative);
        }
      }
    };

    await walk(root, "");
    return results;
  }

  async resolveWorkingDirectory(requestedCwd?: string): Promise<string> {
    const candidate = requestedCwd?.trim()
      ? await this.resolveHostPath(requestedCwd)
      : await this.getDefaultWorkingDirectory();

    const stats = await fs.stat(candidate);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: ${candidate}`);
    }
    return candidate;
  }

  async isLocalShell(): Promise<boolean> {
    return true;
  }

  spawnShell(command: string, options: SpawnOptions): ChildProcess {
    return spawnShell(command, options);
  }

  async runShell(command: string): Promise<void> {
    const cwd = await this.resolveWorkingDirectory();
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnShell(command, {
        cwd,
        env: process.env,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed with exit code ${code}`));
        }
      });
    });
  }

  private async resolveHostPath(inputPath: string): Promise<string> {
    const trimmed = inputPath.trim();
    if (!trimmed || trimmed === ".") {
      return this.getDefaultWorkingDirectory();
    }
    if (trimmed.startsWith("file://")) {
      return path.resolve(fileURLToPath(trimmed));
    }

    const expanded = untildify(trimmed);
    if (
      path.isAbsolute(expanded) ||
      expanded.startsWith("\\\\") ||
      /^[a-zA-Z]:/.test(expanded)
    ) {
      return path.resolve(expanded);
    }
    return path.resolve(await this.getDefaultWorkingDirectory(), expanded);
  }

  private async getDefaultWorkingDirectory(): Promise<string> {
    this.defaultWorkingDirectory ??= (async () => {
      const workspaceDirs = await this.ide.getWorkspaceDirs();
      for (const dir of workspaceDirs) {
        if (!dir.startsWith("file:")) {
          continue;
        }
        try {
          return fileURLToPath(dir);
        } catch {
          // Try the next local workspace.
        }
      }
      return process.cwd();
    })();
    return this.defaultWorkingDirectory;
  }

  private async toResolvedPath(hostPath: string): Promise<ResolvedPath> {
    const absolutePath = path.resolve(hostPath);
    return {
      uri: pathToFileURL(absolutePath).href,
      displayPath: absolutePath,
      isAbsolute: true,
      isWithinWorkspace: await this.isWithinWorkspace(absolutePath),
    };
  }

  private async isWithinWorkspace(hostPath: string): Promise<boolean> {
    const workspaceDirs = await this.ide.getWorkspaceDirs();
    for (const workspaceDir of workspaceDirs) {
      if (!workspaceDir.startsWith("file:")) {
        continue;
      }

      try {
        const root = path.resolve(fileURLToPath(workspaceDir));
        const relative = path.relative(root, hostPath);
        if (
          relative === "" ||
          (relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative))
        ) {
          return true;
        }
      } catch {
        // Ignore malformed/non-local workspace URIs.
      }
    }
    return false;
  }
}

export function createExecutionBackend(
  profile: BuiltInExecutionProfileId,
  ide: IDE,
): ExecutionBackend {
  if (profile === "full_access") {
    return new HostExecutionBackend(ide);
  }
  if (profile === "interactive") {
    return new SandboxExecutionBackend(ide);
  }
  return new IdeExecutionBackend(ide);
}

export function getExecutionBackend(extras: {
  ide: IDE;
  executionBackend?: ExecutionBackend;
}): ExecutionBackend {
  return extras.executionBackend ?? new IdeExecutionBackend(extras.ide);
}
