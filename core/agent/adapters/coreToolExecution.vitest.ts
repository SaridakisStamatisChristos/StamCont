import { describe, expect, it, vi } from "vitest";

import type { Tool } from "../..";

import { CoreToolKernelBridge } from "./coreToolExecution";

function tool(
  name: string,
  readonly: boolean,
): Tool {
  return {
    type: "function",
    function: {
      name,
      description: name,
    },
    displayTitle: name,
    readonly,
    group: "Built-In",
  };
}

describe("CoreToolKernelBridge", () => {
  it("executes existing Core tools through the shared kernel", async () => {
    const execute = vi.fn(async () => "result");
    const bridge = new CoreToolKernelBridge();

    await expect(
      bridge.execute({
        tool: tool("read_file", true),
        execute,
      }),
    ).resolves.toBe("result");

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("blocks write tools in the plan profile", async () => {
    const execute = vi.fn(async () => "written");
    const bridge = new CoreToolKernelBridge();

    await expect(
      bridge.execute({
        tool: tool("create_new_file", false),
        profile: "plan",
        execute,
      }),
    ).rejects.toThrow("filesystem.write:workspace");

    expect(execute).not.toHaveBeenCalled();
  });

  it("permits unrestricted execution in full_access", async () => {
    const execute = vi.fn(async () => "done");
    const bridge = new CoreToolKernelBridge();

    await expect(
      bridge.execute({
        tool: tool("run_terminal_command", false),
        profile: "full_access",
        execute,
      }),
    ).resolves.toBe("done");
  });

  it("reuses one Core session per profile", async () => {
    const created: string[] = [];
    const bridge = new CoreToolKernelBridge();
    bridge.kernel.subscribe((event) => {
      if (event.type === "session.created") {
        created.push(event.sessionId);
      }
    });

    await bridge.execute({
      tool: tool("read_file", true),
      execute: async () => "a",
    });
    await bridge.execute({
      tool: tool("ls", true),
      execute: async () => "b",
    });

    expect(created).toEqual(["core:ide:interactive"]);
  });
});
