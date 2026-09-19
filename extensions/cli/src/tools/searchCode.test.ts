import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { searchCodeTool } from "./searchCode.js";

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

describe("searchCodeTool", () => {
  it("filters out result lines longer than 1000 characters", async () => {
    const root = await tempDir("stamcont-search-");
    const long = "a".repeat(1001);
    await writeFile(
      path.join(root, "sample.txt"),
      `${long} match\nshort match\n`,
      "utf8",
    );

    const result = await searchCodeTool.run({
      pattern: "match",
      path: root,
    });

    expect(result).toContain("short match");
    expect(result).not.toContain(long);
  });

  it("treats shell metacharacters as search data, not commands", async () => {
    const root = await tempDir("stamcont-search-injection-");
    const marker = path.join(root, "should-not-exist");
    const pattern = `needle; touch ${marker}`;
    await writeFile(
      path.join(root, "sample.txt"),
      `${pattern}\n`,
      "utf8",
    );

    const result = await searchCodeTool.run({
      pattern,
      path: root,
    });

    expect(result).toContain("needle; touch");
    await expect(
      import("node:fs/promises").then(({ access }) => access(marker)),
    ).rejects.toThrow();
  });

  it("reports no matches without treating rg/grep exit code 1 as an error", async () => {
    const root = await tempDir("stamcont-search-none-");
    await writeFile(path.join(root, "sample.txt"), "hello\n", "utf8");

    await expect(
      searchCodeTool.run({
        pattern: "definitely-not-present",
        path: root,
      }),
    ).resolves.toContain("No matches found");
  });
});
