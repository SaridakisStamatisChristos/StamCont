import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createCliExecutionBackend,
  permissionModeToExecutionProfile,
  prepareCliToolArgs,
} from "./cliExecution.js";

const tempRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("CLI execution boundary", () => {
  it("confines normal-mode reads to the CLI workspace", async () => {
    const workspace = await tempDir("stamcont-cli-workspace-");
    const outside = await tempDir("stamcont-cli-outside-");
    const target = path.join(outside, "secret.txt");
    await writeFile(target, "secret", "utf8");

    await expect(
      prepareCliToolArgs(
        "Read",
        { filepath: target },
        "normal",
        workspace,
      ),
    ).rejects.toThrow(/outside workspace|not accessible/i);
  });

  it("keeps auto mode unrestricted", async () => {
    const workspace = await tempDir("stamcont-cli-workspace-");
    const outside = await tempDir("stamcont-cli-outside-");
    const target = path.join(outside, "visible.txt");
    await writeFile(target, "visible", "utf8");

    const prepared = await prepareCliToolArgs(
      "Read",
      { filepath: target },
      "auto",
      workspace,
    );

    expect(prepared.args.filepath).toBe(target);
    expect(prepared.backend.kind).toBe("host");
  });

  it("resolves normal-mode writes below the workspace root", async () => {
    const workspace = await tempDir("stamcont-cli-workspace-");

    const prepared = await prepareCliToolArgs(
      "Write",
      { filepath: "nested/file.txt", content: "ok" },
      "normal",
      workspace,
    );

    expect(prepared.backend.kind).toBe("sandbox");
    expect(prepared.args.filepath).toBe(
      path.join(workspace, "nested", "file.txt"),
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects normal-mode symlink escapes",
    async () => {
      const workspace = await tempDir("stamcont-cli-workspace-");
      const outside = await tempDir("stamcont-cli-outside-");
      await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
      await symlink(outside, path.join(workspace, "escape"), "dir");

      await expect(
        prepareCliToolArgs(
          "Read",
          { filepath: "escape/secret.txt" },
          "normal",
          workspace,
        ),
      ).rejects.toThrow(/outside workspace/i);
    },
  );

  it("maps CLI permission modes to canonical execution profiles", () => {
    expect(permissionModeToExecutionProfile("plan")).toBe("plan");
    expect(permissionModeToExecutionProfile("normal")).toBe("interactive");
    expect(permissionModeToExecutionProfile("auto")).toBe("full_access");
  });

  it("maps plan and normal to sandbox but auto to host", async () => {
    const workspace = await tempDir("stamcont-cli-workspace-");

    expect(createCliExecutionBackend("normal", workspace).kind).toBe(
      "sandbox",
    );
    expect(createCliExecutionBackend("plan", workspace).kind).toBe(
      "sandbox",
    );
    expect(createCliExecutionBackend("auto", workspace).kind).toBe("host");
  });
});
