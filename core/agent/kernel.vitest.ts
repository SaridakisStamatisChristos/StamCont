import { describe, expect, it } from "vitest";

import {
  AgentCapabilityDeniedError,
  AgentEvent,
  AgentEventBus,
  AgentKernel,
  AgentTool,
  createCustomExecutionProfile,
  EXECUTION_PROFILES,
} from "./index";

describe("StamCont Agent Kernel", () => {
  it("defines an unrestricted full_access profile without approvals", () => {
    const profile = EXECUTION_PROFILES.full_access;

    expect(profile.capabilities.filesystem.read).toBe("unrestricted");
    expect(profile.capabilities.filesystem.write).toBe("unrestricted");
    expect(profile.capabilities.shell).toBe("unrestricted");
    expect(profile.capabilities.network).toBe("full");
    expect(profile.capabilities.processControl).toBe(true);
    expect(profile.capabilities.backgroundJobs).toBe(true);
    expect(profile.capabilities.mcp).toBe(true);
    expect(profile.capabilities.subagents).toBe(true);
    expect(profile.capabilities.computerControl).toBe(true);
    expect(profile.capabilities.approvalMode).toBe("never");
    expect(Object.isFrozen(profile.capabilities)).toBe(true);
    expect(Object.isFrozen(profile.capabilities.filesystem)).toBe(true);
  });

  it("enforces capabilities at the shared tool boundary", async () => {
    const tool: AgentTool<void, string> = {
      name: "desktop.control",
      description: "Control the local desktop",
      requiredCapabilities: { computerControl: true },
      execute: () => "controlled",
    };
    const kernel = new AgentKernel({
      tools: [tool],
      idFactory: () => "session-1",
    });
    const interactive = await kernel.createSession({
      profile: "interactive",
    });

    await expect(
      kernel.executeTool(interactive, "desktop.control", undefined),
    ).rejects.toBeInstanceOf(AgentCapabilityDeniedError);

    const fullAccess = await kernel.createSession({
      id: "session-2",
      profile: "full_access",
    });
    await expect(
      kernel.executeTool(fullAccess, "desktop.control", undefined),
    ).resolves.toBe("controlled");
  });

  it("keeps child session state isolated and propagates parent cancellation", async () => {
    let nextId = 0;
    const kernel = new AgentKernel({
      idFactory: () => `session-${++nextId}`,
    });
    const parent = await kernel.createSession({ profile: "full_access" });
    const child = await kernel.forkSession(parent);

    expect(child.id).not.toBe(parent.id);
    expect(child.parentSessionId).toBe(parent.id);
    expect(child.capabilities).not.toBe(parent.capabilities);
    expect(child.capabilities).toEqual(parent.capabilities);

    await kernel.cancelSession(parent, "user cancelled root run");

    expect(parent.state).toBe("cancelled");
    expect(child.state).toBe("cancelled");
    expect(child.cancelReason).toBe("parent session cancelled");
  });

  it("does not let child cancellation cancel its parent", async () => {
    const kernel = new AgentKernel({
      idFactory: (() => {
        let id = 0;
        return () => `session-${++id}`;
      })(),
    });
    const parent = await kernel.createSession();
    const child = await kernel.forkSession(parent);

    await kernel.cancelSession(child, "child stopped");

    expect(child.state).toBe("cancelled");
    expect(parent.state).toBe("active");
  });

  it("emits deterministic tool lifecycle events", async () => {
    const events: AgentEvent[] = [];
    let now = 100;
    const kernel = new AgentKernel({
      tools: [
        {
          name: "echo",
          description: "Echo input",
          execute: (input: string) => input,
        },
      ],
      clock: () => now++,
      idFactory: () => "session-1",
    });
    kernel.subscribe((event) => {
      events.push(event);
    });

    const session = await kernel.createSession();
    const result = await kernel.executeTool<string, string>(
      session,
      "echo",
      "hello",
    );

    expect(result).toBe("hello");
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "tool.requested",
      "tool.started",
      "tool.completed",
    ]);
    expect(events.map((event) => event.timestamp)).toEqual([
      101, 102, 103, 104,
    ]);
  });

  it("isolates event observer failures from kernel execution", async () => {
    const observerErrors: string[] = [];
    const bus = new AgentEventBus({
      onObserverError: (error) => {
        observerErrors.push(error instanceof Error ? error.message : String(error));
      },
    });
    bus.subscribe(() => {
      throw new Error("telemetry unavailable");
    });

    const kernel = new AgentKernel({
      events: bus,
      tools: [
        {
          name: "echo",
          description: "Echo input",
          execute: (input: string) => input,
        },
      ],
      idFactory: () => "session-1",
    });
    const session = await kernel.createSession();

    await expect(
      kernel.executeTool<string, string>(session, "echo", "ok"),
    ).resolves.toBe("ok");
    expect(observerErrors.length).toBeGreaterThan(0);
  });

  it("supports immutable custom profiles", () => {
    const profile = createCustomExecutionProfile(
      "workspace-no-network",
      "Workspace / No Network",
      "Workspace coding without network access",
      {
        filesystem: { read: "workspace", write: "workspace" },
        shell: "workspace",
        network: "none",
        processControl: true,
        backgroundJobs: true,
        mcp: false,
        subagents: true,
        computerControl: false,
        approvalMode: "policy",
      },
    );

    expect(profile.id).toBe("workspace-no-network");
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.capabilities)).toBe(true);
  });
});
