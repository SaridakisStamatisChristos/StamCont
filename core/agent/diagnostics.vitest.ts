import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentDiagnosticsBuffer,
  buildAgentDebugBundle,
  emitAgentDiagnostic,
  extractProviderRequestId,
  redactAgentDiagnosticObject,
} from "./diagnostics";
import { runAgentLoop } from "./loop";
import type {
  AgentModelDriver,
  AgentModelRequest,
  AgentToolExecutor,
} from "./model";
import { AgentSessionStore } from "./persistence";
import type { AgentRunEvent } from "./protocol";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

function event(
  sequence: number,
  responseId: string,
  value: any,
): AgentRunEvent {
  return {
    ...value,
    eventId: `event-${sequence}`,
    sequence,
    responseId,
  } as AgentRunEvent;
}

describe("agent operational diagnostics", () => {
  it("redacts sensitive fields recursively without changing safe metadata", () => {
    const redacted = redactAgentDiagnosticObject({
      toolName: "read_file",
      authorization: "Bearer secret",
      nested: {
        apiKey: "abc",
        count: 3,
        content: "private file contents",
      },
      opaque: {
        encrypted: "reasoning",
      },
    });

    expect(redacted).toEqual({
      toolName: "read_file",
      authorization: "[REDACTED]",
      nested: {
        apiKey: "[REDACTED]",
        count: 3,
        content: "[REDACTED]",
      },
      opaque: "[REDACTED]",
    });
  });

  it("builds a payload-minimal debug bundle with useful summaries", async () => {
    const buffer = new AgentDiagnosticsBuffer();
    await buffer.sink({
      schemaVersion: 1,
      type: "session.start",
      timestamp: 1,
      sessionId: "session-a",
      executionProfile: "interactive",
      provider: {
        driver: "ContinueAgentModelDriver",
        provider: "openai",
        model: "example",
      },
      details: {
        prompt: "must not escape",
        durable: true,
      },
    });
    await buffer.sink({
      schemaVersion: 1,
      type: "model.end",
      timestamp: 5,
      sessionId: "session-a",
      responseId: "response-1",
      eventId: "event-4",
      providerRequestId: "provider-request-1",
      durationMs: 4,
    });
    await buffer.sink({
      schemaVersion: 1,
      type: "failure",
      timestamp: 6,
      sessionId: "other-session",
      details: { category: "ignored" },
    });

    const bundle = buffer.buildDebugBundle({
      sessionId: "session-a",
      version: "test-version",
    });

    expect(bundle.version).toBe("test-version");
    expect(bundle.sessionId).toBe("session-a");
    expect(bundle.summary).toMatchObject({
      eventCount: 2,
      modelCalls: 1,
      failures: 0,
    });
    expect(bundle.executionProfiles).toEqual(["interactive"]);
    expect(bundle.providers).toEqual([
      {
        driver: "ContinueAgentModelDriver",
        provider: "openai",
        model: "example",
      },
    ]);
    expect(JSON.stringify(bundle)).not.toContain("must not escape");
    expect(bundle.events[0].details?.prompt).toBe("[REDACTED]");
  });

  it("extracts only known provider request correlation fields", () => {
    expect(
      extractProviderRequestId({
        continue: {
          provider: "openai",
          responseId: "req-123",
          opaque: "do-not-read",
        },
      }),
    ).toBe("req-123");
    expect(
      extractProviderRequestId({
        unrelated: "req-should-not-be-used",
      }),
    ).toBeUndefined();
  });

  it("never lets a diagnostics observer failure alter execution", async () => {
    const driver: AgentModelDriver = {
      async *stream(request) {
        let sequence = request.runState.lastSequence;
        const responseId = "response-observer";
        yield event(++sequence, responseId, {
          type: "response.started",
        });
        yield event(++sequence, responseId, {
          type: "response.completed",
          stopReason: "end_turn",
        });
      },
    };

    const result = await runAgentLoop({
      driver,
      input: [{ type: "message", role: "user", content: "hello" }],
      diagnostics: () => {
        throw new Error("telemetry unavailable");
      },
    });

    expect(result.status).toBe("completed");
  });

  it("emits correlated session, model, tool, budget, and recovery telemetry", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "stamcont-diagnostics-"),
    );
    roots.push(root);
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "diagnostic-session",
    });
    const buffer = new AgentDiagnosticsBuffer();
    const requests: AgentModelRequest[] = [];
    let call = 0;

    const driver: AgentModelDriver = {
      async *stream(request) {
        requests.push(request);
        call += 1;
        let sequence = request.runState.lastSequence;
        const responseId = `response-${call}`;
        yield event(++sequence, responseId, {
          type: "response.started",
          providerMetadata: {
            provider: "test-provider",
            requestId: `provider-${call}`,
          },
        });
        if (call === 1) {
          yield event(++sequence, responseId, {
            type: "output_item.added",
            item: { id: "tool-item", type: "tool_call" },
          });
          yield event(++sequence, responseId, {
            type: "output_item.completed",
            item: {
              id: "tool-item",
              type: "tool_call",
              callId: "tool-call-1",
              name: "echo",
              input: { value: "hello" },
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

    const executor: AgentToolExecutor = {
      async execute() {
        return {
          status: "success",
          output: { ok: true },
        };
      },
    };

    try {
      const result = await runAgentLoop({
        driver,
        input: [
          {
            type: "message",
            role: "user",
            content: "use a tool",
          },
        ],
        tools: [{ name: "echo" }],
        toolExecutor: executor,
        diagnostics: buffer.sink,
        diagnosticContext: {
          executionProfile: "interactive",
        },
        durability: {
          store,
          context: {
            budget: {
              contextLimitTokens: 100_000,
              reservedOutputTokens: 1_000,
              safetyMarginTokens: 1_000,
            },
          },
        },
      });

      expect(result.status).toBe("completed");
      const diagnostics = buffer.list("diagnostic-session");
      expect(diagnostics.map((entry) => entry.type)).toEqual(
        expect.arrayContaining([
          "session.start",
          "recovery",
          "context_budget",
          "model.start",
          "model.end",
          "tool.start",
          "tool.end",
          "session.end",
        ]),
      );
      expect(
        diagnostics.find(
          (entry) =>
            entry.type === "tool.end" &&
            entry.toolCallId === "tool-call-1",
        ),
      ).toMatchObject({
        sessionId: "diagnostic-session",
        responseId: "response-1",
        itemId: "tool-item",
        toolName: "echo",
      });
      expect(
        diagnostics.find(
          (entry) =>
            entry.type === "model.end" &&
            entry.responseId === "response-1",
        ),
      ).toMatchObject({
        providerRequestId: "provider-1",
        eventId: "event-4",
      });
      expect(requests).toHaveLength(2);
    } finally {
      await store.close();
    }
  });

  it("filters one session when building a standalone bundle", () => {
    const bundle = buildAgentDebugBundle(
      [
        {
          schemaVersion: 1,
          type: "session.start",
          timestamp: 1,
          sessionId: "a",
        },
        {
          schemaVersion: 1,
          type: "session.start",
          timestamp: 2,
          sessionId: "b",
        },
      ],
      { sessionId: "a" },
    );
    expect(bundle.events).toHaveLength(1);
    expect(bundle.events[0].sessionId).toBe("a");
  });
});
