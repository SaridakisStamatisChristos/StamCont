import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { IDE } from "..";
import { terminateProcessTree } from "../util/processTerminalStates";
import { SandboxExecutionBackend } from "./sandbox";

const tempRoots: string[] = [];

const requireOsSandboxTests =
  process.env.STAMCONT_REQUIRE_OS_SANDBOX_TESTS === "1";

function executableOnPath(name: string): boolean {
  const fileName = process.platform === "win32" ? `${name}.exe` : name;
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => existsSync(path.join(entry, fileName)));
}

const posixSandboxAvailable =
  process.platform === "linux"
    ? executableOnPath("bwrap")
    : process.platform === "darwin"
      ? existsSync("/usr/bin/sandbox-exec")
      : false;

const skipPosixSandboxTests =
  process.platform === "win32" ||
  (!requireOsSandboxTests && !posixSandboxAvailable);

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function ideWithWorkspace(workspace: string): IDE {
  return {
    getWorkspaceDirs: async () => [pathToFileURL(workspace).href],
    getIdeInfo: async () => ({
      ideType: "vscode",
      name: "security-test",
      version: "test",
      remoteName: "local",
      extensionVersion: "test",
      isPrerelease: false,
    }),
  } as unknown as IDE;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runSandboxCommand(
  backend: SandboxExecutionBackend,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cwd = await backend.resolveWorkingDirectory(".");
  const child = backend.spawnShell(command, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("sandbox shell security properties", () => {
  it.skipIf(process.platform !== "win32")(
    "runs the native Windows command interpreter inside AppContainer",
    async () => {
      const workspace = await tempDir("stamcont-win-comspec-");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));

      const result = await runSandboxCommand(
        backend,
        "echo stamcont-appcontainer-cmd",
      );

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("stamcont-appcontainer-cmd");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "enforces Windows AppContainer workspace and outside-file boundaries",
    async () => {
      const workspace = await tempDir("stamcont-win-workspace-");
      const outside = await tempDir("stamcont-win-outside-");
      const outsideSecret = path.join(outside, "secret.txt");
      await writeFile(outsideSecret, "host-secret", "utf8");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));

      const writeResult = await runSandboxCommand(
        backend,
        "echo sandboxed>shell-write.txt",
      );
      expect(writeResult.code).toBe(0);
      await expect(
        readFile(path.join(workspace, "shell-write.txt"), "utf8"),
      ).resolves.toContain("sandboxed");

      const readResult = await runSandboxCommand(
        backend,
        `type "${outsideSecret}" >nul 2>&1`,
      );
      expect(readResult.code).not.toBe(0);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "enforces Windows Plan read-only at the AppContainer boundary",
    async () => {
      const workspace = await tempDir("stamcont-win-plan-");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace), {
        readOnly: true,
      });
      const sanity = await runSandboxCommand(backend, "ver >nul");
      expect(sanity.code, sanity.stderr).toBe(0);

      const result = await runSandboxCommand(
        backend,
        "echo forbidden>plan-write.txt",
      );

      expect(result.code).not.toBe(0);
      await expect(access(path.join(workspace, "plan-write.txt"))).rejects.toBeDefined();
    },
  );

  it.skipIf(process.platform !== "win32")(
    "keeps nested Windows shell children inside the sandbox",
    async () => {
      const workspace = await tempDir("stamcont-win-children-");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));

      const result = await runSandboxCommand(
        backend,
        [
          "cmd.exe /d /c echo cmd-child^>cmd-child.txt",
          "if errorlevel 1 exit /b %errorlevel%",
          "cmd.exe /d /c echo nested-child^>nested-child.txt",
          "if errorlevel 1 exit /b %errorlevel%",
        ].join(" & "),
      );

      expect(result.code, result.stderr).toBe(0);
      await expect(
        readFile(path.join(workspace, "cmd-child.txt"), "utf8"),
      ).resolves.toContain("cmd-child");
      await expect(
        readFile(path.join(workspace, "nested-child.txt"), "utf8"),
      ).resolves.toContain("nested-child");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "filters Windows shell secrets and denies AppContainer network access",
    async () => {
      const workspace = await tempDir("stamcont-win-env-");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));

      const envResult = await runSandboxCommand(
        backend,
        [
          "if defined OPENAI_API_KEY exit /b 9",
          "if defined GITHUB_TOKEN exit /b 9",
          "if defined AWS_SECRET_ACCESS_KEY exit /b 9",
          "if defined NODE_OPTIONS exit /b 9",
          "echo clean",
        ].join(" & "),
        {
          ...process.env,
          OPENAI_API_KEY: "secret",
          GITHUB_TOKEN: "secret",
          AWS_SECRET_ACCESS_KEY: "secret",
          NODE_OPTIONS: "--require hostile.js",
        },
      );
      expect(envResult.code).toBe(0);
      expect(envResult.stdout).toContain("clean");

      const networkResult = await runSandboxCommand(
        backend,
        "curl.exe --connect-timeout 2 --max-time 3 -fsS http://1.1.1.1/ >nul 2>&1",
      );
      expect(networkResult.code).not.toBe(0);
    },
  );

  it.skipIf(process.platform !== "win32" && skipPosixSandboxTests)(
    "isolates temporary state between sandbox shell invocations",
    async () => {
      const workspace = await tempDir("stamcont-shell-temp-isolation-");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));

      const firstCommand =
        process.platform === "win32"
          ? 'echo private>"%TEMP%\\session-marker"'
          : 'printf private > "$TMPDIR/session-marker"';
      const secondCommand =
        process.platform === "win32"
          ? 'if exist "%TEMP%\\session-marker" exit /b 9'
          : 'test ! -e "$TMPDIR/session-marker"';

      const first = await runSandboxCommand(backend, firstCommand);
      expect(first.code, first.stderr).toBe(0);

      const second = await runSandboxCommand(backend, secondCommand);
      expect(second.code, second.stderr).toBe(0);
    },
  );

  it.skipIf(process.platform !== "win32" && skipPosixSandboxTests)(
    "kills the owned descendant tree without touching an unrelated host process",
    async () => {
      const workspace = await tempDir("stamcont-shell-tree-cancel-");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));
      const cwd = await backend.resolveWorkingDirectory(".");

      const unrelatedTarget = path.join(workspace, "unrelated-alive.txt");
      const unrelated = spawn(
        process.execPath,
        [
          "-e",
          [
            "const fs = require('node:fs');",
            "setTimeout(() => {",
            `  fs.writeFileSync(${JSON.stringify(unrelatedTarget)}, 'alive');`,
            "}, 700);",
          ].join("\n"),
        ],
        {
          cwd: workspace,
          stdio: "ignore",
          windowsHide: true,
        },
      );

      const descendantCommand =
        process.platform === "win32"
          ? [
              'start "" /b cmd.exe /d /s /c "echo child-started>child-started.txt & choice.exe /c Y /d Y /t 2 /n >nul & echo escaped>child-after-kill.txt"',
              "choice.exe /c Y /d Y /t 10 /n >nul",
            ].join(" & ")
          : "(sleep 1.6; printf escaped > child-after-kill.txt) & sleep 10";

      const unrelatedClose = new Promise<void>((resolve, reject) => {
        unrelated.once("error", reject);
        unrelated.once("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`unrelated control exited with code ${code}`));
          }
        });
      });

      const child = backend.spawnShell(descendantCommand, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const childClose = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => resolve());
      });

      if (process.platform === "win32") {
        const started = path.join(workspace, "child-started.txt");
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline && !existsSync(started)) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(existsSync(started)).toBe(true);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      terminateProcessTree(child, "SIGTERM");

      await Promise.race([
        childClose,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("sandbox process tree did not terminate")),
            5_000,
          ),
        ),
      ]);

      await unrelatedClose;
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      await expect(
        access(path.join(workspace, "child-after-kill.txt")),
      ).rejects.toBeDefined();
      await expect(readFile(unrelatedTarget, "utf8")).resolves.toBe("alive");
    },
  );

  it.skipIf(skipPosixSandboxTests)(
    "allows Interactive workspace writes but blocks outside filesystem access",
    async () => {
      const workspace = await tempDir("stamcont-shell-workspace-");
      const outside = await tempDir("stamcont-shell-outside-");
      const outsideSecret = path.join(outside, "secret.txt");
      await writeFile(outsideSecret, "host-secret", "utf8");

      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));

      const allowed = await runSandboxCommand(
        backend,
        "printf sandboxed > shell-write.txt",
      );
      expect(allowed.code, allowed.stderr).toBe(0);
      await expect(
        readFile(path.join(workspace, "shell-write.txt"), "utf8"),
      ).resolves.toBe("sandboxed");

      const denied = await runSandboxCommand(
        backend,
        `cat ${shellQuote(outsideSecret)} >/dev/null 2>&1`,
      );
      expect(denied.code).not.toBe(0);
    },
  );

  it.skipIf(skipPosixSandboxTests)(
    "blocks nested shells from writing outside the workspace",
    async () => {
      const workspace = await tempDir("stamcont-shell-workspace-");
      const outside = await tempDir("stamcont-shell-outside-");
      const outsideTarget = path.join(outside, "escaped.txt");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));
      const sanity = await runSandboxCommand(backend, "true");
      expect(sanity.code, sanity.stderr).toBe(0);

      const result = await runSandboxCommand(
        backend,
        `sh -c "printf escaped > ${shellQuote(outsideTarget)}"`,
      );

      expect(result.code).not.toBe(0);
      await expect(access(outsideTarget)).rejects.toBeDefined();
    },
  );

  it.skipIf(skipPosixSandboxTests)(
    "enforces Plan read-only semantics at the process boundary",
    async () => {
      const workspace = await tempDir("stamcont-plan-shell-");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace), {
        readOnly: true,
      });

      const result = await runSandboxCommand(
        backend,
        "printf forbidden > plan-write.txt",
      );

      expect(result.code).not.toBe(0);
      await expect(access(path.join(workspace, "plan-write.txt"))).rejects.toBeDefined();
    },
  );

  it.skipIf(skipPosixSandboxTests)(
    "filters secrets and loader injection variables from shell children",
    async () => {
      const workspace = await tempDir("stamcont-shell-env-");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));

      const result = await runSandboxCommand(
        backend,
        [
          'test -z "$OPENAI_API_KEY"',
          'test -z "$GITHUB_TOKEN"',
          'test -z "$AWS_SECRET_ACCESS_KEY"',
          'test -z "$NODE_OPTIONS"',
          'test -z "$LD_PRELOAD"',
          'test -z "$PYTHONPATH"',
          'test "$HOME" != "/host/home"',
          'test "$TMPDIR" != "/host/tmp"',
          'printf clean',
        ].join(" && "),
        {
          ...process.env,
          OPENAI_API_KEY: "secret",
          GITHUB_TOKEN: "secret",
          AWS_SECRET_ACCESS_KEY: "secret",
          NODE_OPTIONS: "--require hostile.js",
          LD_PRELOAD: "hostile.so",
          PYTHONPATH: "/host/python",
          HOME: "/host/home",
          TMPDIR: "/host/tmp",
        },
      );

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("clean");
    },
  );

  it.skipIf(skipPosixSandboxTests)(
    "denies outbound network access from sandbox shell processes",
    async () => {
      const workspace = await tempDir("stamcont-shell-network-");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));
      const sanity = await runSandboxCommand(backend, "true");
      expect(sanity.code, sanity.stderr).toBe(0);

      const result = await runSandboxCommand(
        backend,
        "curl --connect-timeout 2 --max-time 3 -fsS http://1.1.1.1/ >/dev/null 2>&1",
      );

      expect(result.code).not.toBe(0);
    },
  );
});
