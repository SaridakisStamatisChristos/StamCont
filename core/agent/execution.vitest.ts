import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { IDE } from "..";
import {
  createExecutionBackend,
  HostExecutionBackend,
} from "./execution";
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
  it("leaves Full Access networking unrestricted", async () => {
    const workspace = await tempDir("stamcont-workspace-");
    const backend = new HostExecutionBackend(ideWithWorkspace(workspace));
    const delegate = (async () => ({ status: 200 })) as any;

    expect(backend.enforceSensitivePathChecks).toBe(false);
    expect(backend.wrapFetch(delegate)).toBe(delegate);
  });

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

    const canonicalOutput = await realpath(output);
    const canonicalOutside = await realpath(outside);
    expect(
      process.platform === "win32"
        ? canonicalOutput.toLowerCase()
        : canonicalOutput,
    ).toBe(
      process.platform === "win32"
        ? canonicalOutside.toLowerCase()
        : canonicalOutside,
    );
  });
});

describe("execution backend selection", () => {
  it("selects host execution only for full access and keeps Plan read-only", async () => {
    const workspace = await tempDir("stamcont-workspace-");
    const ide = ideWithWorkspace(workspace);

    const host = createExecutionBackend("full_access", ide);
    const interactive = createExecutionBackend("interactive", ide);
    const plan = createExecutionBackend("plan", ide);

    expect(host).toBeInstanceOf(HostExecutionBackend);
    expect(interactive).toBeInstanceOf(SandboxExecutionBackend);
    expect(plan).toBeInstanceOf(SandboxExecutionBackend);

    const canonicalWorkspace = await realpath(workspace);
    await expect(
      interactive.resolveWritablePath("interactive.txt"),
    ).resolves.toMatchObject({
      displayPath: path.join(canonicalWorkspace, "interactive.txt"),
    });
    await expect(plan.resolveWritablePath("plan.txt")).rejects.toBeInstanceOf(
      SandboxViolationError,
    );
  });
});
