import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type { IDE } from "../..";
import { validateSearchAndReplaceFilepath } from "./validateArgs";

function ideWithWorkspaceAndFile(
  workspacePath: string,
  existingFilePath: string,
): IDE {
  const existingUri = pathToFileURL(existingFilePath).href;
  return {
    getWorkspaceDirs: async () => [pathToFileURL(workspacePath).href],
    fileExists: async (uri: string) => uri === existingUri,
  } as unknown as IDE;
}

describe("validateSearchAndReplaceFilepath", () => {
  it("keeps outside-workspace edits blocked by default", async () => {
    const workspace = path.join(os.tmpdir(), "stamcont-workspace");
    const outside = path.join(os.tmpdir(), "stamcont-outside", "file.ts");
    const ide = ideWithWorkspaceAndFile(workspace, outside);

    await expect(
      validateSearchAndReplaceFilepath(outside, ide),
    ).rejects.toThrow("does not exist");
  });

  it("allows an existing absolute host path when explicitly enabled", async () => {
    const workspace = path.join(os.tmpdir(), "stamcont-workspace");
    const outside = path.join(os.tmpdir(), "stamcont-outside", "file.ts");
    const ide = ideWithWorkspaceAndFile(workspace, outside);

    await expect(
      validateSearchAndReplaceFilepath(outside, ide, true),
    ).resolves.toBe(pathToFileURL(outside).href);
  });
});
