import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

const originalStamContGlobalDir = process.env.STAMCONT_GLOBAL_DIR;
const originalContinueGlobalDir = process.env.CONTINUE_GLOBAL_DIR;
const tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function resolveCoreGlobalDir(
  stamcontDir: string | undefined,
  continueDir: string | undefined,
): Promise<string> {
  if (stamcontDir === undefined) {
    delete process.env.STAMCONT_GLOBAL_DIR;
  } else {
    process.env.STAMCONT_GLOBAL_DIR = stamcontDir;
  }

  if (continueDir === undefined) {
    delete process.env.CONTINUE_GLOBAL_DIR;
  } else {
    process.env.CONTINUE_GLOBAL_DIR = continueDir;
  }

  vi.resetModules();
  const { getContinueGlobalPath } = await import("core/util/paths.js");
  return getContinueGlobalPath();
}

afterEach(() => {
  if (originalStamContGlobalDir === undefined) {
    delete process.env.STAMCONT_GLOBAL_DIR;
  } else {
    process.env.STAMCONT_GLOBAL_DIR = originalStamContGlobalDir;
  }

  if (originalContinueGlobalDir === undefined) {
    delete process.env.CONTINUE_GLOBAL_DIR;
  } else {
    process.env.CONTINUE_GLOBAL_DIR = originalContinueGlobalDir;
  }

  vi.resetModules();

  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Core global-directory identity compatibility", () => {
  it("gives STAMCONT_GLOBAL_DIR precedence", async () => {
    const stamcontDir = makeTempDir("stamcont-global");
    const continueDir = makeTempDir("continue-global");

    await expect(resolveCoreGlobalDir(stamcontDir, continueDir)).resolves.toBe(
      stamcontDir,
    );
  });

  it("keeps CONTINUE_GLOBAL_DIR working as a fallback", async () => {
    const continueDir = makeTempDir("continue-global");

    await expect(resolveCoreGlobalDir(undefined, continueDir)).resolves.toBe(
      continueDir,
    );
  });
});
