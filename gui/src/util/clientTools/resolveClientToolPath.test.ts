import { ContinueErrorReason } from "core/util/errors";
import { describe, expect, it, vi } from "vitest";

import type { ClientToolExtras } from "./callClientTool";
import { resolveClientToolExistingPath } from "./resolveClientToolPath";

function extrasFor(
  request: ClientToolExtras["ideMessenger"]["request"],
  executionProfile: "plan" | "interactive" | "full_access" = "interactive",
): ClientToolExtras {
  return {
    getState: () =>
      ({
        session: { executionProfile },
      }) as any,
    dispatch: vi.fn() as any,
    ideMessenger: {
      request,
    } as any,
  };
}

describe("resolveClientToolExistingPath", () => {
  it("passes the active execution profile to Core and returns its canonical URI", async () => {
    const request = vi.fn().mockResolvedValue({
      status: "success",
      content: { uri: "file:///workspace/src/index.ts" },
      done: true,
    });
    const extras = extrasFor(request as any, "interactive");

    await expect(
      resolveClientToolExistingPath("src/index.ts", extras),
    ).resolves.toBe("file:///workspace/src/index.ts");

    expect(request).toHaveBeenCalledWith("tools/resolvePath", {
      filepath: "src/index.ts",
      executionProfile: "interactive",
    });
  });

  it("preserves Full Access selection for host path resolution", async () => {
    const request = vi.fn().mockResolvedValue({
      status: "success",
      content: { uri: "file:///outside/project/file.ts" },
      done: true,
    });
    const extras = extrasFor(request as any, "full_access");

    await resolveClientToolExistingPath("/outside/project/file.ts", extras);

    expect(request).toHaveBeenCalledWith("tools/resolvePath", {
      filepath: "/outside/project/file.ts",
      executionProfile: "full_access",
    });
  });

  it("rejects inaccessible paths returned by Core", async () => {
    const request = vi.fn().mockResolvedValue({
      status: "success",
      content: { uri: null },
      done: true,
    });

    await expect(
      resolveClientToolExistingPath(
        "../outside.txt",
        extrasFor(request as any),
      ),
    ).rejects.toMatchObject({
      reason: ContinueErrorReason.FileNotFound,
    });
  });

  it("converts Core resolver errors into a file access error", async () => {
    const request = vi.fn().mockResolvedValue({
      status: "error",
      error: "Sandbox blocked path outside workspace",
      done: true,
    });

    await expect(
      resolveClientToolExistingPath(
        "/outside/secret.txt",
        extrasFor(request as any),
      ),
    ).rejects.toMatchObject({
      reason: ContinueErrorReason.FileNotFound,
      message: "Sandbox blocked path outside workspace",
    });
  });
});
