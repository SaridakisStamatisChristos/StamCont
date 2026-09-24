import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendAgentLifecycleState,
  initializeDurableAgentSession,
} from "./lifecycle";
import type {
  AgentModelDriver,
  AgentModelRequest,
  AgentToolExecutor,
} from "./model";
import { AgentSessionStore } from "./persistence";
import type { AgentRunEvent } from "./protocol";
import {
  AgentSurfaceRuntime,
  type AgentSurfaceResolvedRuntime,
} from "./surfaceRuntime";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function root() {
  const value = await mkdtemp(
    path.join(os.tmpdir(), "stamcont-surface-"),
  );
  roots.push(value);
  return value;
}

function runtimeValue(
  driver: AgentModelDriver,
  toolExecutor?: AgentToolExecutor,
): AgentSurfaceResolvedRuntime {
  return {
    driver,
    tools: toolExecutor
      ? [{ name: "write_file", inputSchema: { type: "object" } }]
      : [],
    toolExecutor,
    context: {
      budget: {
        contextLimitTokens: 100_000,
        reservedOutputTokens: 1_000,
      },
    },
  };
}

function scriptedDriver(): AgentModelDriver {
  let call = 0;
  return {
    async *stream(
      request: AgentModelRequest,
    ): AsyncIterable<AgentRunEvent> {
      let sequence = request.runState.lastSequence;
      const responseId = `r-${sequence + 1}`;
      const next = <T extends Omit<AgentRunEvent, "eventId" | "sequence" | "responseId">>(
        value: T,
      ) =>
        ({
          ...value,
          eventId: `e-${++sequence}`,
          sequence,
          responseId,
        }) as AgentRunEvent;

      yield next({ type: "response.started" });
      if (call++ === 0) {
        yield next({
          type: "output_item.added",
          item: { id: "tool-1", type: "tool_call" },
        });
        yield next({
          type: "output_item.completed",
          item: {
            id: "tool-1",
            type: "tool_call",
            callId: "call-1",
            name: "write_file",
            input: { path: "a.txt" },
          },
        });
        yield next({
          type: "response.completed",
          stopReason: "tool_use",
        });
        return;
      }

      yield next({
        type: "output_item.added",
        item: { id: "message-1", type: "message" },
      });
      yield next({
        type: "content.delta",
        itemId: "message-1",
        delta: "done",
      });
      yield next({
        type: "output_item.completed",
        item: {
          id: "message-1",
          type: "message",
          role: "assistant",
          content: "done",
        },
      });
      yield next({
        type: "response.completed",
        stopReason: "end_turn",
      });
    },
  };
}

describe("AgentSurfaceRuntime tool lifecycle", () => {
  it("orders requested, approval, running, result, and continuation", async () => {
    const driver = scriptedDriver();
    let runtime!: AgentSurfaceRuntime;
    runtime = new AgentSurfaceRuntime(
      await root(),
      ({ approve, onToolRunning }) => {
        const toolExecutor: AgentToolExecutor = {
          async execute(toolCall) {
            const approved = await approve({
              sessionId: "approval",
              profile: "interactive",
              itemId: toolCall.id,
              callId: toolCall.callId,
              toolName: toolCall.name,
              input: toolCall.input as any,
              policy: "allowedWithPermission",
            });
            if (!approved) {
              return {
                status: "failure",
                error: {
                  code: "tool_denied",
                  message: "denied",
                },
              };
            }
            onToolRunning({
              itemId: toolCall.id,
              callId: toolCall.callId,
              toolName: toolCall.name,
            });
            return {
              status: "success",
              output: { ok: true },
            };
          },
        };
        return runtimeValue(driver, toolExecutor);
      },
    );

    const generator = runtime.stream({
      sessionId: "approval",
      profile: "interactive",
      toolNames: ["write_file"],
      userPrompt: "edit it",
    });
    const types: string[] = [];
    let next = await generator.next();
    while (!next.done) {
      types.push(next.value.type);
      if (next.value.type === "approval_required") {
        expect(
          await runtime.approve(
            "approval",
            next.value.approval.approvalId,
            true,
          ),
        ).toBe(true);
      }
      next = await generator.next();
    }

    expect(next.value.status).toBe("completed");
    expect(types.indexOf("tool_requested")).toBeLessThan(
      types.indexOf("approval_required"),
    );
    expect(types.indexOf("approval_required")).toBeLessThan(
      types.indexOf("tool_running"),
    );
    expect(types.indexOf("tool_running")).toBeLessThan(
      types.indexOf("tool_result"),
    );
    expect(types).toContain("assistant_delta");
  });

  it("persists cancellation as a terminal durable state", async () => {
    const runtime = new AgentSurfaceRuntime(
      await root(),
      () => runtimeValue(scriptedDriver()),
    );

    const generator = runtime.stream({
      sessionId: "cancelled",
      profile: "interactive",
      toolNames: [],
      userPrompt: "stop",
    });
    const first = await generator.next();
    expect(first.value).toMatchObject({
      type: "run_state",
      status: "running",
    });
    expect(await runtime.cancel("cancelled", "test")).toBe(true);

    let next = await generator.next();
    while (!next.done) {
      next = await generator.next();
    }
    expect(next.value.status).toBe("cancelled");

    const snapshot = await runtime.getSession("cancelled");
    expect(snapshot?.status).toBe("cancelled");
  });

  it("resumes a durable pending tool round through the surface runtime", async () => {
    const directory = await root();
    const sessionId = "surface-resume";
    const store = await AgentSessionStore.open({
      rootDirectory: directory,
      sessionId,
    });
    await initializeDurableAgentSession(store, [
      { type: "message", role: "user", content: "inspect" },
    ]);
    await appendAgentLifecycleState(store, "waiting_for_model", 1);
    await store.appendModelEvent({
      type: "response.started",
      eventId: "e-1",
      sequence: 1,
      responseId: "r-1",
    });
    await store.appendModelEvent({
      type: "output_item.added",
      eventId: "e-2",
      sequence: 2,
      responseId: "r-1",
      item: { id: "tool-resume", type: "tool_call" },
    });
    await store.appendModelEvent({
      type: "output_item.completed",
      eventId: "e-3",
      sequence: 3,
      responseId: "r-1",
      item: {
        id: "tool-resume",
        type: "tool_call",
        callId: "call-resume",
        name: "write_file",
        input: { path: "a.txt" },
      },
    });
    await store.appendModelEvent({
      type: "response.completed",
      eventId: "e-4",
      sequence: 4,
      responseId: "r-1",
      stopReason: "tool_use",
    });
    await appendAgentLifecycleState(store, "waiting_for_tool", 1);
    await store.close();

    const requests: AgentModelRequest[] = [];
    const driver: AgentModelDriver = {
      async *stream(request) {
        requests.push(request);
        let sequence = request.runState.lastSequence;
        yield {
          type: "response.started",
          eventId: `e-${++sequence}`,
          sequence,
          responseId: "r-2",
        };
        yield {
          type: "response.completed",
          eventId: `e-${++sequence}`,
          sequence,
          responseId: "r-2",
          stopReason: "end_turn",
        };
      },
    };
    const toolExecutor: AgentToolExecutor = {
      async execute() {
        return {
          status: "success",
          output: { resumed: true },
        };
      },
    };
    const runtime = new AgentSurfaceRuntime(
      directory,
      () => runtimeValue(driver, toolExecutor),
    );

    const generator = runtime.stream({
      sessionId,
      profile: "interactive",
      toolNames: ["write_file"],
    });
    let next = await generator.next();
    while (!next.done) {
      next = await generator.next();
    }

    expect(next.value).toMatchObject({
      status: "completed",
      resumed: true,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toContainEqual({
      type: "tool_result",
      toolCallItemId: "tool-resume",
      callId: "call-resume",
      name: "write_file",
      status: "success",
      output: { resumed: true },
    });
  });

  it("rejects a second active run for the same durable session", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driver: AgentModelDriver = {
      async *stream(request) {
        let sequence = request.runState.lastSequence;
        yield {
          type: "response.started",
          eventId: `e-${++sequence}`,
          sequence,
          responseId: "blocking",
        };
        await gate;
        yield {
          type: "response.completed",
          eventId: `e-${++sequence}`,
          sequence,
          responseId: "blocking",
          stopReason: "end_turn",
        };
      },
    };
    const runtime = new AgentSurfaceRuntime(
      await root(),
      () => runtimeValue(driver),
    );

    const first = runtime.stream({
      sessionId: "exclusive",
      profile: "interactive",
      toolNames: [],
      userPrompt: "first",
    });
    expect(await first.next()).toMatchObject({
      done: false,
      value: { type: "run_state", status: "running" },
    });

    const second = runtime.stream({
      sessionId: "exclusive",
      profile: "interactive",
      toolNames: [],
      userPrompt: "second",
    });
    await expect(second.next()).rejects.toThrow(
      'Agent session "exclusive" already has an active run',
    );

    release();
    let next = await first.next();
    while (!next.done) {
      next = await first.next();
    }
    expect(next.value.status).toBe("completed");
  });

  it("preserves a thrown undefined as an actual queue failure", async () => {
    const runtime = new AgentSurfaceRuntime(
      await root(),
      () => {
        throw undefined;
      },
    );
    const generator = runtime.stream({
      sessionId: "undefined-failure",
      profile: "interactive",
      toolNames: [],
      userPrompt: "fail",
    });

    let rejected = false;
    try {
      await generator.next();
    } catch (error) {
      rejected = true;
      expect(error).toBeUndefined();
    }
    expect(rejected).toBe(true);
  });

  it("returns false for stale approvals after a run has settled", async () => {
    const runtime = new AgentSurfaceRuntime(
      await root(),
      () => runtimeValue(scriptedDriver()),
    );
    const generator = runtime.stream({
      sessionId: "stale-approval",
      profile: "interactive",
      toolNames: [],
      userPrompt: "hello",
    });
    let next = await generator.next();
    while (!next.done) {
      next = await generator.next();
    }

    expect(
      await runtime.approve(
        "stale-approval",
        "approval:missing:missing",
        true,
      ),
    ).toBe(false);
  });
});
