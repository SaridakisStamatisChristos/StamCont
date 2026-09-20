import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IDE } from "..";
import {
  createRestrictedFetch,
  SandboxExecutionBackend,
  SandboxViolationError,
  sanitizeSandboxEnvironment,
} from "./sandbox";

const tempRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function ideWithWorkspaces(...workspaces: string[]): IDE {
  return {
    getWorkspaceDirs: async () =>
      workspaces.map((workspace) => pathToFileURL(workspace).href),
    getIdeInfo: async () => ({
      ideType: "vscode",
      name: "test",
      version: "test",
      remoteName: "local",
      extensionVersion: "test",
      isPrerelease: false,
    }),
    fileExists: async (uri: string) => {
      try {
        await import("node:fs/promises").then(({ access }) =>
          access(new URL(uri)),
        );
        return true;
      } catch {
        return false;
      }
    },
  } as unknown as IDE;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("SandboxExecutionBackend filesystem confinement", () => {
  it("resolves files inside any configured workspace root", async () => {
    const rootA = await tempDir("stamcont-sandbox-a-");
    const rootB = await tempDir("stamcont-sandbox-b-");
    await writeFile(path.join(rootB, "target.txt"), "ok", "utf8");

    const backend = new SandboxExecutionBackend(ideWithWorkspaces(rootA, rootB));
    const resolved = await backend.resolveExistingPath("target.txt");

    expect(resolved?.displayPath).toBe(path.join(rootB, "target.txt"));
    await expect(backend.readFile(resolved!)).resolves.toBe("ok");
  });

  it("rejects absolute paths outside all workspace roots", async () => {
    const workspace = await tempDir("stamcont-sandbox-workspace-");
    const outside = await tempDir("stamcont-sandbox-outside-");
    const target = path.join(outside, "secret.txt");
    await writeFile(target, "secret", "utf8");

    const backend = new SandboxExecutionBackend(ideWithWorkspaces(workspace));

    await expect(backend.resolveExistingPath(target)).rejects.toBeInstanceOf(
      SandboxViolationError,
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlink escapes after canonicalization",
    async () => {
      const workspace = await tempDir("stamcont-sandbox-workspace-");
      const outside = await tempDir("stamcont-sandbox-outside-");
      await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
      await symlink(outside, path.join(workspace, "escape"), "dir");

      const backend = new SandboxExecutionBackend(ideWithWorkspaces(workspace));

      await expect(
        backend.resolveExistingPath("escape/secret.txt"),
      ).rejects.toBeInstanceOf(SandboxViolationError);
    },
  );

  it("rejects creation through an outside absolute path", async () => {
    const workspace = await tempDir("stamcont-sandbox-workspace-");
    const outside = await tempDir("stamcont-sandbox-outside-");
    const backend = new SandboxExecutionBackend(ideWithWorkspaces(workspace));

    await expect(
      backend.resolveWritablePath(path.join(outside, "new", "file.txt")),
    ).rejects.toBeInstanceOf(SandboxViolationError);
  });

  it("allows creation below a workspace root", async () => {
    const workspace = await tempDir("stamcont-sandbox-workspace-");
    const backend = new SandboxExecutionBackend(ideWithWorkspaces(workspace));
    const target = await backend.resolveWritablePath("new/nested/file.txt");

    await backend.writeFile(target, "sandboxed");

    await expect(
      import("node:fs/promises").then(({ readFile }) =>
        readFile(path.join(workspace, "new/nested/file.txt"), "utf8"),
      ),
    ).resolves.toBe("sandboxed");
  });

  it("rejects a working directory outside the workspace", async () => {
    const workspace = await tempDir("stamcont-sandbox-workspace-");
    const outside = await tempDir("stamcont-sandbox-outside-");
    await mkdir(path.join(outside, "project"));

    const backend = new SandboxExecutionBackend(ideWithWorkspaces(workspace));

    await expect(
      backend.resolveWorkingDirectory(path.join(outside, "project")),
    ).rejects.toBeInstanceOf(SandboxViolationError);
  });
});

describe("Interactive restricted network policy", () => {
  it("blocks localhost and private addresses", async () => {
    const delegate = vi.fn();

    const fetch = createRestrictedFetch(delegate as any);

    await expect(fetch("http://127.0.0.1:3000")).rejects.toBeInstanceOf(
      SandboxViolationError,
    );
    await expect(fetch("http://10.0.0.5")).rejects.toBeInstanceOf(
      SandboxViolationError,
    );
    expect(delegate).not.toHaveBeenCalled();
  });

  it("revalidates redirects before following them", async () => {
    const delegate = vi.fn().mockResolvedValue({
      status: 302,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "location" ? "http://127.0.0.1/admin" : null,
      },
    });

    const fetch = createRestrictedFetch(delegate as any);

    await expect(fetch("https://8.8.8.8/start")).rejects.toBeInstanceOf(
      SandboxViolationError,
    );
    expect(delegate).toHaveBeenCalledTimes(1);
  });
});

describe("sandbox environment", () => {
  it("drops inherited secrets and relocates HOME into the workspace", () => {
    const workspace = path.join(os.tmpdir(), "sandbox-home");
    const env = sanitizeSandboxEnvironment(
      {
        PATH: process.env.PATH,
        LANG: "C",
        AWS_SECRET_ACCESS_KEY: "secret",
        GITHUB_TOKEN: "secret",
        OPENAI_API_KEY: "secret",
      },
      workspace,
    );

    expect(env.PATH).toBe(process.env.PATH);
    expect(env.LANG).toBe("C");
    expect(env.HOME).toBe(workspace);
    expect(env.USERPROFILE).toBe(workspace);
    expect(env.STAMCONT_SANDBOX).toBe("1");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
