import { describe, expect, it, vi } from "vitest";

import type { Tool } from "../..";
import type { BuiltInExecutionProfileId } from "../capabilities";

import { CoreToolKernelBridge } from "./coreToolExecution";

function tool(
  name: string,
  readonly: boolean,
  uri?: string,
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
    uri,
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

  it("permits workspace writes in interactive", async () => {
    const execute = vi.fn(async () => "written");
    const bridge = new CoreToolKernelBridge();

    await expect(
      bridge.execute({
        tool: tool("create_new_file", false),
        profile: "interactive",
        execute,
      }),
    ).resolves.toBe("written");

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("permits unrestricted shell execution in full_access", async () => {
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

  it("permits MCP tools in every built-in profile", async () => {
    const profiles: BuiltInExecutionProfileId[] = [
      "plan",
      "interactive",
      "full_access",
    ];

    for (const profile of profiles) {
      const bridge = new CoreToolKernelBridge();
      await expect(
        bridge.execute({
          tool: tool("dynamic_mcp_tool", false, "mcp://server/tool"),
          profile,
          execute: async () => profile,
        }),
      ).resolves.toBe(profile);
    }
  });

  it("reuses one Core session for repeated calls in the same profile", async () => {
    const created: string[] = [];
    const bridge = new CoreToolKernelBridge();
    bridge.kernel.subscribe((event) => {
      if (event.type === "session.created") {
        created.push(event.sessionId);
      }
    });

    await bridge.execute({
      tool: tool("read_file", true),
      sessionId: "chat-1",
      execute: async () => "a",
    });
    await bridge.execute({
      tool: tool("ls", true),
      sessionId: "chat-1",
      execute: async () => "b",
    });

    expect(created).toEqual(["core:chat-1:interactive"]);
  });

  it("closes the old profile session before switching profiles", async () => {
    const lifecycle: string[] = [];
    const bridge = new CoreToolKernelBridge();
    bridge.kernel.subscribe((event) => {
      if (event.type === "session.created" || event.type === "session.closed") {
        lifecycle.push(`${event.type}:${event.sessionId}`);
      }
    });

    await bridge.execute({
      tool: tool("read_file", true),
      sessionId: "chat-1",
      profile: "interactive",
      execute: async () => "interactive",
    });
    await bridge.execute({
      tool: tool("run_terminal_command", false),
      sessionId: "chat-1",
      profile: "full_access",
      execute: async () => "full",
    });

    expect(lifecycle).toEqual([
      "session.created:core:chat-1:interactive",
      "session.closed:core:chat-1:interactive",
      "session.created:core:chat-1:full_access",
    ]);
  });

  it("keeps different IDE chat sessions isolated", async () => {
    const created: string[] = [];
    const bridge = new CoreToolKernelBridge();
    bridge.kernel.subscribe((event) => {
      if (event.type === "session.created") {
        created.push(event.sessionId);
      }
    });

    await bridge.execute({
      tool: tool("read_file", true),
      sessionId: "chat-a",
      execute: async () => "a",
    });
    await bridge.execute({
      tool: tool("read_file", true),
      sessionId: "chat-b",
      execute: async () => "b",
    });

    expect(created).toEqual([
      "core:chat-a:interactive",
      "core:chat-b:interactive",
    ]);
  });
});
