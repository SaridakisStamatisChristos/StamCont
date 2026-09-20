import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { IDE } from "..";
import { SandboxExecutionBackend } from "./sandbox";

const tempRoots: string[] = [];

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
    "enforces Windows AppContainer workspace and outside-file boundaries",
    async () => {
      const workspace = await tempDir("stamcont-win-workspace-");
      const outside = await tempDir("stamcont-win-outside-");
      const outsideSecret = path.join(outside, "secret.txt");
      await writeFile(outsideSecret, "host-secret", "utf8");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));

      const writeResult = await runSandboxCommand(
        backend,
        "$ErrorActionPreference='Stop'; Set-Content -LiteralPath 'shell-write.txt' -Value 'sandboxed' -NoNewline",
      );
      expect(writeResult.code).toBe(0);
      await expect(
        readFile(path.join(workspace, "shell-write.txt"), "utf8"),
      ).resolves.toBe("sandboxed");

      const escapedPath = outsideSecret.replaceAll("'", "''");
      const readResult = await runSandboxCommand(
        backend,
        `$ErrorActionPreference='Stop'; Get-Content -LiteralPath '${escapedPath}' | Out-Null`,
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

      const result = await runSandboxCommand(
        backend,
        "$ErrorActionPreference='Stop'; Set-Content -LiteralPath 'plan-write.txt' -Value 'forbidden' -NoNewline",
      );

      expect(result.code).not.toBe(0);
      await expect(access(path.join(workspace, "plan-write.txt"))).rejects.toBeDefined();
    },
  );

  it.skipIf(process.platform !== "win32")(
    "keeps Windows cmd and nested PowerShell children inside the sandbox",
    async () => {
      const workspace = await tempDir("stamcont-win-children-");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));

      const result = await runSandboxCommand(
        backend,
        [
          "$ErrorActionPreference='Stop'",
          'cmd.exe /d /c "echo cmd-child>cmd-child.txt"',
          "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
          'powershell.exe -NoProfile -NonInteractive -Command "Set-Content -LiteralPath ps-child.txt -Value ps-child -NoNewline"',
          "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
        ].join("; "),
      );

      expect(result.code).toBe(0);
      await expect(
        readFile(path.join(workspace, "cmd-child.txt"), "utf8"),
      ).resolves.toContain("cmd-child");
      await expect(
        readFile(path.join(workspace, "ps-child.txt"), "utf8"),
      ).resolves.toBe("ps-child");
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
          "$ErrorActionPreference='Stop'",
          "if ($env:OPENAI_API_KEY -or $env:GITHUB_TOKEN -or $env:AWS_SECRET_ACCESS_KEY -or $env:NODE_OPTIONS) { exit 9 }",
          "Write-Output clean",
        ].join("; "),
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
        "$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri 'http://1.1.1.1/' | Out-Null",
      );
      expect(networkResult.code).not.toBe(0);
    },
  );

  it.skipIf(process.platform === "win32")(
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
      expect(allowed.code).toBe(0);
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

  it.skipIf(process.platform === "win32")(
    "blocks nested shells from writing outside the workspace",
    async () => {
      const workspace = await tempDir("stamcont-shell-workspace-");
      const outside = await tempDir("stamcont-shell-outside-");
      const outsideTarget = path.join(outside, "escaped.txt");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));

      const result = await runSandboxCommand(
        backend,
        `sh -c "printf escaped > ${shellQuote(outsideTarget)}"`,
      );

      expect(result.code).not.toBe(0);
      await expect(access(outsideTarget)).rejects.toBeDefined();
    },
  );

  it.skipIf(process.platform === "win32")(
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

  it.skipIf(process.platform === "win32")(
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

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("clean");
    },
  );

  it.skipIf(process.platform === "win32")(
    "denies outbound network access from sandbox shell processes",
    async () => {
      const workspace = await tempDir("stamcont-shell-network-");
      const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));

      const result = await runSandboxCommand(
        backend,
        "curl --connect-timeout 2 --max-time 3 -fsS http://1.1.1.1/ >/dev/null 2>&1",
      );

      expect(result.code).not.toBe(0);
    },
  );
});
