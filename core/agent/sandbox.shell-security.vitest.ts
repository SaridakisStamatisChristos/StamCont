import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { IDE } from "..";
import { SandboxExecutionBackend, SandboxViolationError } from "./sandbox";

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
  it("fails closed when native shell containment is unavailable", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const workspace = await tempDir("stamcont-shell-workspace-");
    const backend = new SandboxExecutionBackend(ideWithWorkspace(workspace));
    const cwd = await backend.resolveWorkingDirectory(".");

    expect(() =>
      backend.spawnShell("Write-Output blocked", {
        cwd,
        env: process.env,
      }),
    ).toThrow(SandboxViolationError);
  });

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
