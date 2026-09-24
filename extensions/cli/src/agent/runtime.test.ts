import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentDiagnosticsBuffer } from "core/agent/diagnostics.js";
import {
  appendAgentLifecycleState,
  initializeDurableAgentSession,
} from "core/agent/lifecycle.js";
import type {
  AgentModelDriver,
  AgentModelRequest,
  AgentToolExecutor,
} from "core/agent/model.js";
import { AgentSessionStore } from "core/agent/persistence.js";
import type { AgentRunEvent } from "core/agent/protocol.js";
import { describe, expect, it, vi } from "vitest";

import {
  resolveCliAgentResumeSessionId,
  runCliAgentRuntime,
} from "./runtime.js";

function event(
  sequence: number,
  value: any,
  responseId = "r-1",
): AgentRunEvent {
  return {
    ...value,
    eventId: `e-${sequence}`,
    sequence,
    responseId,
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
        yield event(5, { type: "response.started" }, "r-2");
        yield event(
          6,
          {
            type: "output_item.added",
            item: { id: "m-2", type: "message" },
          },
          "r-2",
        );
        yield event(
          7,
          {
            type: "output_item.completed",
            item: {
              id: "m-2",
              type: "message",
              role: "assistant",
              content: "finished",
            },
          },
          "r-2",
        );
        yield event(
          8,
          {
            type: "response.completed",
            stopReason: "end_turn",
          },
          "r-2",
        );
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

  it("resumes a nonterminal durable tool boundary and completes it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stamcont-cli-agent-"));
    const sessionId = "resumable-cli";
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId,
    });
    const initialInput = [
      {
        type: "message" as const,
        role: "user" as const,
        content: "inspect",
      },
    ];

    try {
      await initializeDurableAgentSession(store, initialInput);
      await appendAgentLifecycleState(store, "waiting_for_model", 1);
      for (const item of [
        event(1, { type: "response.started" }),
        event(2, {
          type: "output_item.added",
          item: { id: "t-resume", type: "tool_call" },
        }),
        event(3, {
          type: "output_item.completed",
          item: {
            id: "t-resume",
            type: "tool_call",
            callId: "c-resume",
            name: "read_file",
            input: { filepath: "README.md" },
          },
        }),
        event(4, {
          type: "response.completed",
          stopReason: "tool_use",
        }),
      ]) {
        await store.appendModelEvent(item);
      }
      await appendAgentLifecycleState(store, "waiting_for_tool", 1);
    } finally {
      await store.close();
    }

    const executor: AgentToolExecutor = {
      execute: vi.fn(async () => ({
        status: "success" as const,
        output: { resumed: true },
      })),
    };
    const requests: AgentModelRequest[] = [];
    const driver: AgentModelDriver = {
      async *stream(request) {
        requests.push(request);
        yield event(5, { type: "response.started" }, "r-2");
        yield event(
          6,
          {
            type: "response.completed",
            stopReason: "end_turn",
          },
          "r-2",
        );
      },
    };

    try {
      const resumed = await runCliAgentRuntime({
        rootDirectory: root,
        driver,
        resumeSessionId: sessionId,
        tools: [{ name: "read_file" }],
        toolExecutor: executor,
        contextLimitTokens: 100_000,
        reservedOutputTokens: 1_000,
      });

      expect(resumed.resumed).toBe(true);
      expect(resumed.result.status).toBe("completed");
      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(1);
      expect(requests[0].input).toContainEqual({
        type: "tool_result",
        toolCallItemId: "t-resume",
        callId: "c-resume",
        name: "read_file",
        status: "success",
        output: { resumed: true },
      });
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

  it("records content-free compatibility diagnostics for unsupported durable schema", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stamcont-cli-agent-"));
    const sessionId = "old-schema";
    const directory = path.join(root, sessionId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "session.jsonl"),
      JSON.stringify({
        schemaVersion: 999,
        sessionId,
        sequence: 1,
        kind: "metadata",
        payload: { prompt: "must-not-leak" },
      }) + "\n",
      "utf8",
    );
    const diagnostics = new AgentDiagnosticsBuffer();

    try {
      await expect(
        runCliAgentRuntime({
          rootDirectory: root,
          driver: scriptedDriver(() => []),
          resumeSessionId: sessionId,
          contextLimitTokens: 100_000,
          reservedOutputTokens: 1_000,
          diagnostics,
        }),
      ).rejects.toMatchObject({
        code: "unsupported_schema",
      });
      expect(diagnostics.list(sessionId)).toEqual([
        expect.objectContaining({
          type: "failure",
          details: {
            category: "compatibility",
            code: "unsupported_persistence_schema",
          },
        }),
      ]);
      expect(JSON.stringify(diagnostics.list(sessionId))).not.toContain(
        "must-not-leak",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
