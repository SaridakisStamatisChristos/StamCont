import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentModelDriver,
  AgentModelRequest,
  AgentToolExecutor,
} from "./model";
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
});
