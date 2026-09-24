import type { AgentEvent } from "core/agent/events.js";
import { AgentKernel } from "core/agent/kernel.js";
import { describe, expect, it, vi } from "vitest";

import type { Tool } from "../tools/types.js";

import {
  CliAgentKernelBridge,
  permissionModeToExecutionProfile,
} from "./CliAgentKernelBridge.js";

function tool(
  name: string,
  options: Partial<Tool> = {},
): Tool {
  return {
    name,
    displayName: name,
    description: name,
    parameters: { type: "object", properties: {} },
    readonly: true,
    isBuiltIn: true,
    run: async () => "ok",
    ...options,
  };
}

describe("CliAgentKernelBridge", () => {
  it("maps legacy permission modes to kernel profiles", () => {
    expect(permissionModeToExecutionProfile("normal")).toBe("interactive");
    expect(permissionModeToExecutionProfile("plan")).toBe("plan");
    expect(permissionModeToExecutionProfile("auto")).toBe("full_access");
  });

  it("reuses one kernel session per CLI session and profile", async () => {
    const events: string[] = [];
    const kernel = new AgentKernel();
    kernel.subscribe((event: Readonly<AgentEvent>) => {
      events.push(event.type);
    });
    const bridge = new CliAgentKernelBridge(kernel);
    const legacy = tool("Read");

    await bridge.execute({
      tool: legacy,
      args: { filepath: "README.md" },
      mode: "normal",
      sessionId: "chat-1",
    });
    await bridge.execute({
      tool: legacy,
      args: { filepath: "README.md" },
      mode: "normal",
      sessionId: "chat-1",
    });

    expect(
      events.filter((event) => event === "session.created"),
    ).toHaveLength(1);
  });

  it("creates a separate session when the execution profile changes", async () => {
    const createdProfiles: unknown[] = [];
    const kernel = new AgentKernel();
    kernel.subscribe((event: Readonly<AgentEvent>) => {
      if (event.type === "session.created") {
        createdProfiles.push(event.details?.profileId);
      }
    });
    const bridge = new CliAgentKernelBridge(kernel);
    const legacy = tool("Read");

    await bridge.execute({
      tool: legacy,
      args: {},
      mode: "normal",
      sessionId: "chat-1",
    });
    await bridge.execute({
      tool: legacy,
      args: {},
      mode: "auto",
      sessionId: "chat-1",
    });

    expect(createdProfiles).toEqual(["interactive", "full_access"]);
  });

  it("preserves the exact legacy run args and context", async () => {
    const run = vi.fn(async () => "legacy-result");
    const legacy = tool("Read", { run });
    const bridge = new CliAgentKernelBridge();
    const context = {
      toolCallId: "call-1",
      parallelToolCallCount: 3,
    };

    const result = await bridge.execute({
      tool: legacy,
      args: { filepath: "README.md" },
      context,
      mode: "normal",
      sessionId: "chat-1",
    });

    expect(result).toBe("legacy-result");
    expect(run).toHaveBeenCalledWith(
      { filepath: "README.md" },
      expect.objectContaining({
        ...context,
        executionBackend: expect.objectContaining({ kind: "sandbox" }),
        executionSignal: expect.any(AbortSignal),
      }),
    );
  });

  it("blocks workspace writes in plan and permits them in auto/full access", async () => {
    const legacy = tool("Write", {
      readonly: false,
      run: async () => "written",
    });
    const bridge = new CliAgentKernelBridge();

    await expect(
      bridge.execute({
        tool: legacy,
        args: { filepath: "x", content: "y" },
        mode: "plan",
        sessionId: "chat-1",
      }),
    ).rejects.toThrow("filesystem.write:workspace");

    await expect(
      bridge.execute({
        tool: legacy,
        args: { filepath: "x", content: "y" },
        mode: "auto",
        sessionId: "chat-1",
      }),
    ).resolves.toBe("written");
  });

  it("forks a child with explicit lineage without exceeding the parent profile", async () => {
    const bridge = new CliAgentKernelBridge();

    const child = await bridge.forkSession({
      parentSessionId: "parent-chat",
      parentMode: "normal",
      childSessionId: "child-chat",
      childMode: "auto",
    });

    expect(child.parentSessionId).toBe("cli:parent-chat:interactive");
    expect(child.profile.id).toBe("interactive");
    expect(child.capabilities.computerControl).toBe(false);
    expect(child.capabilities.approvalMode).toBe("policy");
    expect(child.state).toBe("active");
  });

  it("cancels a child without cancelling its parent", async () => {
    const bridge = new CliAgentKernelBridge();
    const parentTool = tool("Read");

    await bridge.execute({
      tool: parentTool,
      args: {},
      mode: "normal",
      sessionId: "parent-chat",
    });
    const child = await bridge.forkSession({
      parentSessionId: "parent-chat",
      parentMode: "normal",
      childSessionId: "child-chat",
      childMode: "auto",
    });

    await expect(
      bridge.cancelSession("child-chat", "auto", "child stopped"),
    ).resolves.toBe(true);

    expect(child.state).toBe("cancelled");
    await expect(
      bridge.execute({
        tool: parentTool,
        args: {},
        mode: "normal",
        sessionId: "parent-chat",
      }),
    ).resolves.toBe("ok");
  });

  it("allows closing and recreating a cached session", async () => {
    const events: string[] = [];
    const kernel = new AgentKernel();
    kernel.subscribe((event: Readonly<AgentEvent>) => {
      events.push(event.type);
    });
    const bridge = new CliAgentKernelBridge(kernel);
    const legacy = tool("Read");

    await bridge.execute({
      tool: legacy,
      args: {},
      mode: "normal",
      sessionId: "chat-1",
    });
    await expect(
      bridge.closeSession("chat-1", "normal"),
    ).resolves.toBe(true);
    await bridge.execute({
      tool: legacy,
      args: {},
      mode: "normal",
      sessionId: "chat-1",
    });

    expect(
      events.filter((event) => event === "session.created"),
    ).toHaveLength(2);
    expect(events).toContain("session.closed");
  });
});
