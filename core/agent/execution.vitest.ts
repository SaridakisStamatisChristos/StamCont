import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { IDE } from "..";
import {
  createExecutionBackend,
  HostExecutionBackend,
  IdeExecutionBackend,
} from "./execution";
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
      name: "test",
      version: "test",
      remoteName: "local",
      extensionVersion: "test",
      isPrerelease: false,
    }),
  } as unknown as IDE;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("HostExecutionBackend", () => {
  it("reads files outside the opened workspace", async () => {
    const workspace = await tempDir("stamcont-workspace-");
    const outside = await tempDir("stamcont-outside-");
    const target = path.join(outside, "outside.txt");
    await writeFile(target, "host-visible", "utf8");

    const backend = new HostExecutionBackend(ideWithWorkspace(workspace));
    const resolved = await backend.resolveExistingPath(target);

    expect(resolved?.isWithinWorkspace).toBe(false);
    await expect(backend.readFile(resolved!)).resolves.toBe("host-visible");
  });

  it("writes across unrelated host directories in one backend", async () => {
    const workspace = await tempDir("stamcont-workspace-");
    const repoA = await tempDir("stamcont-repo-a-");
    const repoB = await tempDir("stamcont-repo-b-");
    const backend = new HostExecutionBackend(ideWithWorkspace(workspace));

    const targetA = await backend.resolveWritablePath(
      path.join(repoA, "nested", "a.txt"),
    );
    const targetB = await backend.resolveWritablePath(
      path.join(repoB, "nested", "b.txt"),
    );
    await backend.writeFile(targetA, "A");
    await backend.writeFile(targetB, "B");

    await expect(readFile(targetA.displayPath, "utf8")).resolves.toBe("A");
    await expect(readFile(targetB.displayPath, "utf8")).resolves.toBe("B");
  });

  it("accepts arbitrary existing working directories", async () => {
    const workspace = await tempDir("stamcont-workspace-");
    const outside = await tempDir("stamcont-cwd-");
    await mkdir(path.join(outside, "project"));

    const backend = new HostExecutionBackend(ideWithWorkspace(workspace));

    await expect(
      backend.resolveWorkingDirectory(path.join(outside, "project")),
    ).resolves.toBe(path.join(outside, "project"));
  });

  it("spawns commands from an arbitrary host working directory", async () => {
    const workspace = await tempDir("stamcont-workspace-");
    const outside = await tempDir("stamcont-shell-cwd-");
    const backend = new HostExecutionBackend(ideWithWorkspace(workspace));

    const output = await new Promise<string>((resolve, reject) => {
      const child = backend.spawnShell('node -p "process.cwd()"', {
        cwd: outside,
        env: process.env,
      });
      let stdout = "";
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`shell exited with code ${code}`));
        }
      });
    });

    const normalize = (value: string) =>
      process.platform === "win32"
        ? path.resolve(value).toLowerCase()
        : path.resolve(value);
    expect(normalize(output)).toBe(normalize(outside));
  });
});

describe("execution backend selection", () => {
  it("selects host execution only for full access", async () => {
    const workspace = await tempDir("stamcont-workspace-");
    const ide = ideWithWorkspace(workspace);

    expect(createExecutionBackend("full_access", ide)).toBeInstanceOf(
      HostExecutionBackend,
    );
    expect(createExecutionBackend("interactive", ide)).toBeInstanceOf(
      SandboxExecutionBackend,
    );
    expect(createExecutionBackend("plan", ide)).toBeInstanceOf(
      IdeExecutionBackend,
    );
  });
});
