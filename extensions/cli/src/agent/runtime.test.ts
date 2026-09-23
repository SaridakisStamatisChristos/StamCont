import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AgentModelDriver,
  AgentToolExecutor,
} from "core/agent/model.js";
import type { AgentRunEvent } from "core/agent/protocol.js";
import { describe, expect, it, vi } from "vitest";

import {
  resolveCliAgentResumeSessionId,
  runCliAgentRuntime,
} from "./runtime.js";

function event(
  sequence: number,
  value: any,
): AgentRunEvent {
  return {
    ...value,
    eventId: `e-${sequence}`,
    sequence,
    responseId: "r-1",
  } as AgentRunEvent;
}

function scriptedDriver(
  factory: () => AgentRunEvent[],
): AgentModelDriver {
  return {
    async *stream() {
      for (const item of factory()) {
        yield item;
      }
    },
  };
}

describe("CLI durable agent runtime", () => {
  it("runs and persists a single turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stamcont-cli-agent-"));
    try {
      const driver = scriptedDriver(() => [
        event(1, { type: "response.started" }),
        event(2, {
          type: "output_item.added",
          item: { id: "m-1", type: "message" },
        }),
        event(3, {
          type: "output_item.completed",
          item: {
            id: "m-1",
            type: "message",
            role: "assistant",
            content: "done",
          },
        }),
        event(4, {
          type: "response.completed",
          stopReason: "end_turn",
        }),
      ]);

      const result = await runCliAgentRuntime({
        rootDirectory: root,
        driver,
        userPrompt: "hello",
        contextLimitTokens: 100_000,
        reservedOutputTokens: 1_000,
      });

      expect(result.result.status).toBe("completed");
      expect(result.result.input.some(
        (item) =>
          item.type === "model_output" &&
          item.item.type === "message" &&
          item.item.content === "done",
      )).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("executes canonical completed tool calls and continues", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stamcont-cli-agent-"));
    let call = 0;
    const executor: AgentToolExecutor = {
      execute: vi.fn(async () => ({
        status: "success" as const,
        output: { ok: true },
      })),
    };
    const driver: AgentModelDriver = {
      async *stream() {
        call += 1;
        if (call === 1) {
          yield event(1, { type: "response.started" });
          yield event(2, {
            type: "output_item.added",
            item: { id: "t-1", type: "tool_call" },
          });
          yield event(3, {
            type: "output_item.completed",
            item: {
              id: "t-1",
              type: "tool_call",
              callId: "c-1",
              name: "read_file",
              input: { filepath: "README.md" },
            },
          });
          yield event(4, {
            type: "response.completed",
            stopReason: "tool_use",
          });
          return;
        }
        yield event(5, { type: "response.started" });
        yield event(6, {
          type: "output_item.added",
          item: { id: "m-2", type: "message" },
        });
        yield event(7, {
          type: "output_item.completed",
          item: {
            id: "m-2",
            type: "message",
            role: "assistant",
            content: "finished",
          },
        });
        yield event(8, {
          type: "response.completed",
          stopReason: "end_turn",
        });
      },
    };

    try {
      const result = await runCliAgentRuntime({
        rootDirectory: root,
        driver,
        userPrompt: "inspect",
        tools: [{ name: "read_file" }],
        toolExecutor: executor,
        contextLimitTokens: 100_000,
        reservedOutputTokens: 1_000,
      });

      expect(result.result.status).toBe("completed");
      expect(executor.execute).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports structured model failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stamcont-cli-agent-"));
    try {
      const result = await runCliAgentRuntime({
        rootDirectory: root,
        driver: scriptedDriver(() => [
          event(1, { type: "response.started" }),
          event(2, {
            type: "response.failed",
            error: {
              code: "provider_error",
              message: "provider unavailable",
              retryable: true,
            },
          }),
        ]),
        userPrompt: "fail",
        contextLimitTokens: 100_000,
        reservedOutputTokens: 1_000,
      });

      expect(result.result.status).toBe("failed");
      expect(result.result.error).toMatchObject({
        code: "provider_error",
        message: "provider unavailable",
        retryable: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not rerun a terminal durable session on resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stamcont-cli-agent-"));
    const stream = vi.fn();
    try {
      const first = await runCliAgentRuntime({
        rootDirectory: root,
        driver: scriptedDriver(() => [
          event(1, { type: "response.started" }),
          event(2, {
            type: "output_item.added",
            item: { id: "m-1", type: "message" },
          }),
          event(3, {
            type: "output_item.completed",
            item: {
              id: "m-1",
              type: "message",
              role: "assistant",
              content: "done",
            },
          }),
          event(4, {
            type: "response.completed",
            stopReason: "end_turn",
          }),
        ]),
        userPrompt: "hello",
        contextLimitTokens: 100_000,
        reservedOutputTokens: 1_000,
      });

      const resumed = await runCliAgentRuntime({
        rootDirectory: root,
        driver: { stream } as unknown as AgentModelDriver,
        resumeSessionId: first.sessionId,
        contextLimitTokens: 100_000,
        reservedOutputTokens: 1_000,
      });

      expect(resumed.result.status).toBe("completed");
      expect(stream).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates cancellation into the durable loop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stamcont-cli-agent-"));
    const controller = new AbortController();
    const driver: AgentModelDriver = {
      async *stream(_request, signal) {
        yield event(1, { type: "response.started" });
        controller.abort("test cancellation");
        yield event(2, {
          type: "response.aborted",
          reason:
            typeof signal.reason === "string"
              ? signal.reason
              : "cancelled",
        });
      },
    };

    try {
      const result = await runCliAgentRuntime({
        rootDirectory: root,
        driver,
        userPrompt: "cancel",
        signal: controller.signal,
        contextLimitTokens: 100_000,
        reservedOutputTokens: 1_000,
      });
      expect(result.result.status).toBe("cancelled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects the newest durable session for bare resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stamcont-cli-agent-"));
    try {
      for (const id of ["older", "newer"]) {
        const dir = path.join(root, id);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "session.jsonl"), "");
      }
      const oldTime = new Date(Date.now() - 10_000);
      const newTime = new Date();
      await utimes(path.join(root, "older", "session.jsonl"), oldTime, oldTime);
      await utimes(path.join(root, "newer", "session.jsonl"), newTime, newTime);

      await expect(
        resolveCliAgentResumeSessionId(root, true),
      ).resolves.toBe("newer");
      await expect(
        resolveCliAgentResumeSessionId(root, "older"),
      ).resolves.toBe("older");
      await expect(
        resolveCliAgentResumeSessionId(root, "missing"),
      ).rejects.toThrow('Durable agent session "missing" does not exist');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
