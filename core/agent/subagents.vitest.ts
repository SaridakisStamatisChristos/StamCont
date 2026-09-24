import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createCustomExecutionProfile,
  isExecutionCapabilitySubset,
} from "./capabilities";
import { AgentKernel } from "./kernel";
import type {
  AgentModelDriver,
  AgentModelRequest,
} from "./model";
import type {
  AgentRunEvent,
  AgentToolCallItem,
} from "./protocol";
import {
  AgentSubagentRuntime,
  loadDurableAgentSubagentRelation,
} from "./subagents";
import type { AgentTool } from "./tools";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "stamcont-subagent-"),
  );
  roots.push(root);
  return root;
}

const context = {
  budget: {
    contextLimitTokens: 100_000,
    reservedOutputTokens: 1_000,
    safetyMarginTokens: 1_000,
  },
};

function event(
  sequence: number,
  responseId: string,
  value: Omit<AgentRunEvent, "eventId" | "sequence" | "responseId">,
): AgentRunEvent {
  return {
    ...value,
    eventId: `e-${sequence}`,
    sequence,
    responseId,
  } as AgentRunEvent;
}

function endTurnDriver(
  content = "done",
  requests?: AgentModelRequest[],
): AgentModelDriver {
  return {
    async *stream(request) {
      requests?.push(request);
      let sequence = request.runState.lastSequence;
      const responseId = `r-${sequence + 1}`;
      yield event(++sequence, responseId, {
        type: "response.started",
      });
      yield event(++sequence, responseId, {
        type: "output_item.added",
        item: { id: `m-${sequence}`, type: "message" },
      });
      const itemId = `m-${sequence}`;
      yield event(++sequence, responseId, {
        type: "output_item.completed",
        item: {
          id: itemId,
          type: "message",
          role: "assistant",
          content,
        },
      });
      yield event(++sequence, responseId, {
        type: "response.completed",
        stopReason: "end_turn",
      });
    },
  };
}

describe("durable nested agent sessions", () => {
  it("creates a parent-child session and persists the relationship", async () => {
    const root = await makeRoot();
    const kernel = new AgentKernel({
      idFactory: () => "child-created",
    });
    const runtime = new AgentSubagentRuntime({
      rootDirectory: root,
      kernel,
    });
    const parent = await kernel.createSession({
      id: "parent-created",
      profile: "interactive",
    });

    const run = await runtime.run({
      parent,
      id: "child-created",
      driver: endTurnDriver(),
      input: [
        {
          type: "message",
          role: "user",
          content: "child task",
        },
      ],
      context,
    });

    expect(run.result.status).toBe("completed");
    expect(run.child.parentSessionId).toBe(parent.id);
    expect(run.relation).toMatchObject({
      parentSessionId: parent.id,
      childSessionId: "child-created",
      requestedProfileId: "interactive",
    });

    await expect(
      loadDurableAgentSubagentRelation(root, "child-created"),
    ).resolves.toMatchObject({
      parentSessionId: parent.id,
      childSessionId: "child-created",
    });
  });

  it("intersects requested child capabilities with the parent ceiling", async () => {
    const kernel = new AgentKernel();
    const parentProfile = createCustomExecutionProfile(
      "parent-limited",
      "Parent Limited",
      "Limited parent",
      {
        filesystem: { read: "workspace", write: "none" },
        shell: "workspace",
        network: "none",
        processControl: false,
        backgroundJobs: false,
        mcp: false,
        subagents: true,
        computerControl: false,
        approvalMode: "always",
      },
    );
    const parent = await kernel.createSession({
      id: "parent-limited",
      profile: parentProfile,
    });
    const child = await kernel.createSession({
      id: "child-requested-full",
      parent,
      profile: "full_access",
    });

    expect(
      isExecutionCapabilitySubset(
        child.capabilities,
        parent.capabilities,
      ),
    ).toBe(true);
    expect(child.capabilities).toEqual(parent.capabilities);
    expect(child.capabilities.computerControl).toBe(false);
    expect(child.capabilities.network).toBe("none");
    expect(child.capabilities.approvalMode).toBe("always");
  });

  it("rejects subagent creation when the parent lacks the subagents capability", async () => {
    const kernel = new AgentKernel();
    const noChildren = createCustomExecutionProfile(
      "no-children",
      "No Children",
      "Subagents disabled",
      {
        filesystem: { read: "workspace", write: "workspace" },
        shell: "workspace",
        network: "restricted",
        processControl: true,
        backgroundJobs: true,
        mcp: true,
        subagents: false,
        computerControl: false,
        approvalMode: "policy",
      },
    );
    const parent = await kernel.createSession({
      id: "parent-no-children",
      profile: noChildren,
    });

    await expect(
      kernel.createSession({
        id: "forbidden-child",
        parent,
        profile: "plan",
      }),
    ).rejects.toMatchObject({
      name: "AgentSubagentDeniedError",
      parentSessionId: parent.id,
    });
  });

  it("propagates parent cancellation into an active child run", async () => {
    const root = await makeRoot();
    const kernel = new AgentKernel();
    const runtime = new AgentSubagentRuntime({
      rootDirectory: root,
      kernel,
    });
    const parent = await kernel.createSession({
      id: "parent-cancel",
      profile: "interactive",
    });

    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const driver: AgentModelDriver = {
      async *stream(request, signal) {
        let sequence = request.runState.lastSequence;
        const responseId = "r-cancel";
        yield event(++sequence, responseId, {
          type: "response.started",
        });
        started();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        yield event(++sequence, responseId, {
          type: "response.aborted",
          reason: "parent cancelled",
        });
      },
    };

    const childRun = runtime.run({
      parent,
      id: "child-cancel",
      driver,
      input: [
        {
          type: "message",
          role: "user",
          content: "wait",
        },
      ],
      context,
    });

    await modelStarted;
    await kernel.cancelSession(parent, "stop tree");
    const result = await childRun;

    expect(result.result.status).toBe("cancelled");
    expect(result.child.state).toBe("cancelled");
    expect(result.child.cancelReason).toBe(
      "parent session cancelled",
    );
  });

  it("completes a child independently while leaving the parent active", async () => {
    const root = await makeRoot();
    const kernel = new AgentKernel();
    const runtime = new AgentSubagentRuntime({
      rootDirectory: root,
      kernel,
    });
    const parent = await kernel.createSession({
      id: "parent-complete",
    });

    const result = await runtime.run({
      parent,
      id: "child-complete",
      driver: endTurnDriver("child complete"),
      input: [
        {
          type: "message",
          role: "user",
          content: "finish",
        },
      ],
      context,
    });

    expect(result.result.status).toBe("completed");
    expect(result.child.state).toBe("closed");
    expect(parent.state).toBe("active");
  });

  it("contains child failure without cancelling its parent", async () => {
    const root = await makeRoot();
    const kernel = new AgentKernel();
    const runtime = new AgentSubagentRuntime({
      rootDirectory: root,
      kernel,
    });
    const parent = await kernel.createSession({
      id: "parent-failure",
    });
    const driver: AgentModelDriver = {
      async *stream(request) {
        let sequence = request.runState.lastSequence;
        const responseId = "r-failure";
        yield event(++sequence, responseId, {
          type: "response.started",
        });
        yield event(++sequence, responseId, {
          type: "response.failed",
          error: {
            code: "provider_error",
            message: "child provider failed",
          },
        });
      },
    };

    const result = await runtime.run({
      parent,
      id: "child-failure",
      driver,
      input: [
        {
          type: "message",
          role: "user",
          content: "fail",
        },
      ],
      context,
    });

    expect(result.result.status).toBe("failed");
    expect(result.result.error?.message).toBe(
      "child provider failed",
    );
    expect(parent.state).toBe("active");
  });

  it("supports multiple isolated children under the same parent", async () => {
    const root = await makeRoot();
    const kernel = new AgentKernel();
    const runtime = new AgentSubagentRuntime({
      rootDirectory: root,
      kernel,
    });
    const parent = await kernel.createSession({
      id: "parent-many",
    });

    const [first, second] = await Promise.all([
      runtime.run({
        parent,
        id: "child-a",
        driver: endTurnDriver("a"),
        input: [
          {
            type: "message",
            role: "user",
            content: "task a",
          },
        ],
        context,
      }),
      runtime.run({
        parent,
        id: "child-b",
        driver: endTurnDriver("b"),
        input: [
          {
            type: "message",
            role: "user",
            content: "task b",
          },
        ],
        context,
      }),
    ]);

    expect(first.result.status).toBe("completed");
    expect(second.result.status).toBe("completed");
    expect(first.child.id).not.toBe(second.child.id);
    expect(first.child.parentSessionId).toBe(parent.id);
    expect(second.child.parentSessionId).toBe(parent.id);
    expect(runtime.getActiveChildren(parent.id)).toEqual([]);
  });

  it("resumes an interrupted durable child with its persisted parent relationship", async () => {
    const root = await makeRoot();
    const echo: AgentTool<unknown, unknown> = {
      name: "echo",
      description: "Echo input",
      execute: (input) => input,
    };
    const kernel = new AgentKernel({
      tools: [echo],
    });
    const runtime = new AgentSubagentRuntime({
      rootDirectory: root,
      kernel,
    });
    const parent = await kernel.createSession({
      id: "parent-restart",
      profile: "interactive",
    });

    const toolCall: AgentToolCallItem = {
      id: "tool-restart",
      type: "tool_call",
      callId: "call-restart",
      name: "echo",
      input: { value: "persisted" },
    };
    const firstDriver: AgentModelDriver = {
      async *stream(request) {
        let sequence = request.runState.lastSequence;
        const responseId = "r-tool";
        yield event(++sequence, responseId, {
          type: "response.started",
        });
        yield event(++sequence, responseId, {
          type: "output_item.added",
          item: {
            id: toolCall.id,
            type: "tool_call",
          },
        });
        yield event(++sequence, responseId, {
          type: "output_item.completed",
          item: toolCall,
        });
        yield event(++sequence, responseId, {
          type: "response.completed",
          stopReason: "tool_use",
        });
      },
    };

    const interrupted = await runtime.run({
      parent,
      id: "child-restart",
      driver: firstDriver,
      input: [
        {
          type: "message",
          role: "user",
          content: "use tool then continue",
        },
      ],
      context,
      maxIterations: 1,
    });
    expect(interrupted.result.status).toBe(
      "iteration_limit",
    );

    const requests: AgentModelRequest[] = [];
    const resumed = await runtime.resume({
      parent,
      childSessionId: "child-restart",
      driver: endTurnDriver("resumed", requests),
      context,
    });

    expect(resumed.resumed).toBe(true);
    expect(resumed.result.status).toBe("completed");
    expect(resumed.child.parentSessionId).toBe(parent.id);
    expect(resumed.relation.parentSessionId).toBe(parent.id);
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toContainEqual({
      type: "tool_result",
      toolCallItemId: "tool-restart",
      callId: "call-restart",
      name: "echo",
      status: "success",
      output: { value: "persisted" },
    });
  });

  it("does not leak parent metadata or context into child model input", async () => {
    const root = await makeRoot();
    const kernel = new AgentKernel();
    const runtime = new AgentSubagentRuntime({
      rootDirectory: root,
      kernel,
    });
    const parent = await kernel.createSession({
      id: "parent-context",
      metadata: {
        parentSecret: "must-not-leak",
      },
    });
    const requests: AgentModelRequest[] = [];

    await runtime.run({
      parent,
      id: "child-context",
      driver: endTurnDriver("isolated", requests),
      input: [
        {
          type: "message",
          role: "user",
          content: "explicit child context",
        },
      ],
      context,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].input).toEqual([
      {
        type: "message",
        role: "user",
        content: "explicit child context",
      },
    ]);
    expect(JSON.stringify(requests[0])).not.toContain(
      "must-not-leak",
    );
  });

  it("routes child tools through AgentKernel and prevents privilege escalation", async () => {
    const root = await makeRoot();
    const executeDesktop = vi.fn(() => ({ controlled: true }));
    const desktopTool: AgentTool<unknown, unknown> = {
      name: "desktop.control",
      description: "Desktop control",
      requiredCapabilities: {
        computerControl: true,
      },
      execute: executeDesktop,
    };
    const kernel = new AgentKernel({
      tools: [desktopTool],
    });
    const runtime = new AgentSubagentRuntime({
      rootDirectory: root,
      kernel,
    });
    const parent = await kernel.createSession({
      id: "parent-no-desktop",
      profile: "interactive",
    });

    let call = 0;
    const requests: AgentModelRequest[] = [];
    const driver: AgentModelDriver = {
      async *stream(request) {
        requests.push(request);
        call += 1;
        let sequence = request.runState.lastSequence;
        const responseId = `r-kernel-${call}`;
        yield event(++sequence, responseId, {
          type: "response.started",
        });

        if (call === 1) {
          yield event(++sequence, responseId, {
            type: "output_item.added",
            item: {
              id: "tool-desktop",
              type: "tool_call",
            },
          });
          yield event(++sequence, responseId, {
            type: "output_item.completed",
            item: {
              id: "tool-desktop",
              type: "tool_call",
              callId: "call-desktop",
              name: "desktop.control",
              input: {},
            },
          });
          yield event(++sequence, responseId, {
            type: "response.completed",
            stopReason: "tool_use",
          });
          return;
        }

        yield event(++sequence, responseId, {
          type: "response.completed",
          stopReason: "end_turn",
        });
      },
    };

    const result = await runtime.run({
      parent,
      id: "child-no-desktop",
      profile: "full_access",
      driver,
      input: [
        {
          type: "message",
          role: "user",
          content: "try desktop",
        },
      ],
      context,
    });

    expect(result.result.status).toBe("completed");
    expect(executeDesktop).not.toHaveBeenCalled();
    expect(
      isExecutionCapabilitySubset(
        result.child.capabilities,
        parent.capabilities,
      ),
    ).toBe(true);
    expect(requests[1].input).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolCallItemId: "tool-desktop",
        callId: "call-desktop",
        status: "failure",
        error: expect.objectContaining({
          code: "kernel_rejection",
        }),
      }),
    );
  });
});
