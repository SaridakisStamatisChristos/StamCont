import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentModelInputItem,
  AgentToolResult,
} from "./model";
import {
  appendAgentLifecycleState,
  AgentLifecycleError,
  appendAgentToolAttempt,
  analyzeDurableAgentSession,
  initializeDurableAgentSession,
  prepareDurableAgentContext,
  reconcileDurableAgentToolAttempt,
} from "./lifecycle";
import {
  AgentSessionStore,
} from "./persistence";
import type {
  AgentRunEvent,
  AgentToolCallItem,
} from "./protocol";
import {
  readAgentCompactionArtifact,
} from "./compaction";

const temporaryDirectories: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "stamcont-agent-lifecycle-"),
  );
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

type EventWithoutEnvelope<T> = T extends AgentRunEvent
  ? Omit<T, "eventId" | "sequence">
  : never;
type EventInput = EventWithoutEnvelope<AgentRunEvent>;

function event(
  sequence: number,
  input: EventInput,
): AgentRunEvent {
  return {
    ...input,
    eventId: "event-" + sequence,
    sequence,
  } as AgentRunEvent;
}

const initialInput: readonly AgentModelInputItem[] = [
  {
    type: "message",
    role: "user",
    content: "hello",
  },
];

const toolCall: AgentToolCallItem = {
  id: "tool-1",
  type: "tool_call",
  callId: "call-1",
  name: "write_file",
  input: { path: "a.txt", content: "x" },
};

function toolUseEvents(
  assistantContent = "working",
): readonly AgentRunEvent[] {
  return [
    event(1, {
      type: "response.started",
      responseId: "response-1",
    }),
    event(2, {
      type: "output_item.added",
      responseId: "response-1",
      item: { id: "message-1", type: "message" },
    }),
    event(3, {
      type: "output_item.completed",
      responseId: "response-1",
      item: {
        id: "message-1",
        type: "message",
        role: "assistant",
        content: assistantContent,
      },
    }),
    event(4, {
      type: "output_item.added",
      responseId: "response-1",
      item: { id: toolCall.id, type: "tool_call" },
    }),
    event(5, {
      type: "output_item.completed",
      responseId: "response-1",
      item: toolCall,
    }),
    event(6, {
      type: "response.completed",
      responseId: "response-1",
      stopReason: "tool_use",
    }),
  ];
}

async function appendToolUseRound(
  store: AgentSessionStore,
  assistantContent = "working",
): Promise<void> {
  await appendAgentLifecycleState(store, "waiting_for_model", 1);
  for (const item of toolUseEvents(assistantContent)) {
    await store.appendModelEvent(item);
  }
  await appendAgentLifecycleState(store, "waiting_for_tool", 1);
}

describe("StamCont durable agent lifecycle", () => {
  it("treats a started tool attempt without a persisted result as ambiguous", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "ambiguous-tool",
    });
    await initializeDurableAgentSession(store, initialInput);
    await appendToolUseRound(store);
    await appendAgentToolAttempt(
      store,
      toolCall,
      "started",
      1,
    );

    const analysis = analyzeDurableAgentSession(
      await store.readAllRecords(),
      store.sessionId,
    );

    expect(analysis.disposition).toBe("blocked");
    expect(analysis.blockReason).toBe(
      "ambiguous_tool_execution",
    );
    expect(analysis.ambiguousToolAttempts).toEqual([
      expect.objectContaining({
        toolCallItemId: "tool-1",
        callId: "call-1",
        status: "started",
      }),
    ]);
    await store.close();
  });

  it("does not consider a started tool ambiguous once its durable result exists", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "result-wins",
    });
    await initializeDurableAgentSession(store, initialInput);
    await appendToolUseRound(store);
    await appendAgentToolAttempt(
      store,
      toolCall,
      "started",
      1,
    );
    const result: AgentToolResult = {
      type: "tool_result",
      toolCallItemId: toolCall.id,
      callId: toolCall.callId,
      name: toolCall.name,
      status: "success",
      output: { ok: true },
    };
    await store.appendToolResult(result);

    const analysis = analyzeDurableAgentSession(
      await store.readAllRecords(),
      store.sessionId,
    );

    expect(analysis.disposition).toBe("resume");
    expect(analysis.ambiguousToolAttempts).toEqual([]);
    expect(analysis.pendingToolResponseId).toBeUndefined();
    await store.close();
  });

  it("blocks automatic resume after output_item.completed when the provider response never reached a terminal event", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "incomplete-model",
    });
    await initializeDurableAgentSession(store, initialInput);
    await appendAgentLifecycleState(
      store,
      "waiting_for_model",
      1,
    );
    await store.appendModelEvent(
      event(1, {
        type: "response.started",
        responseId: "response-1",
      }),
    );
    await store.appendModelEvent(
      event(2, {
        type: "output_item.added",
        responseId: "response-1",
        item: { id: "message-1", type: "message" },
      }),
    );
    await store.appendModelEvent(
      event(3, {
        type: "output_item.completed",
        responseId: "response-1",
        item: {
          id: "message-1",
          type: "message",
          role: "assistant",
          content: "authoritative but not terminal",
        },
      }),
    );

    const analysis = analyzeDurableAgentSession(
      await store.readAllRecords(),
      store.sessionId,
    );

    expect(analysis.disposition).toBe("blocked");
    expect(analysis.blockReason).toBe(
      "incomplete_model_response",
    );
    await store.close();
  });

  it("reconstructs cancelled and failed lifecycle states as terminal", async () => {
    const root = await makeRoot();
    const cancelled = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "cancelled-terminal",
    });
    await initializeDurableAgentSession(cancelled, initialInput);
    await appendAgentLifecycleState(
      cancelled,
      "cancelled",
      1,
      { stopReason: "cancelled" },
    );
    const cancelledAnalysis = analyzeDurableAgentSession(
      await cancelled.readAllRecords(),
      cancelled.sessionId,
    );
    expect(cancelledAnalysis).toMatchObject({
      disposition: "terminal",
      terminalKind: "cancelled",
      stopReason: "cancelled",
    });
    await cancelled.close();

    const failed = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "failed-terminal",
    });
    await initializeDurableAgentSession(failed, initialInput);
    await appendAgentLifecycleState(
      failed,
      "failed",
      1,
      {
        stopReason: "error",
        error: {
          code: "driver_error",
          message: "provider unavailable",
        },
      },
    );
    const failedAnalysis = analyzeDurableAgentSession(
      await failed.readAllRecords(),
      failed.sessionId,
    );
    expect(failedAnalysis).toMatchObject({
      disposition: "terminal",
      terminalKind: "failed",
      stopReason: "error",
      error: {
        code: "driver_error",
        message: "provider unavailable",
      },
    });
    await failed.close();
  });

  it("persists a compaction checkpoint that remains valid after immediate restart", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "compaction-restart",
    });
    await initializeDurableAgentSession(store, initialInput);
    await appendToolUseRound(store, "x".repeat(8_000));
    await appendAgentToolAttempt(
      store,
      toolCall,
      "started",
      1,
    );
    await store.appendToolResult({
      type: "tool_result",
      toolCallItemId: toolCall.id,
      callId: toolCall.callId,
      name: toolCall.name,
      status: "success",
      output: { ok: true },
    });
    await appendAgentToolAttempt(
      store,
      toolCall,
      "completed",
      1,
    );

    const estimator = {
      id: "test-json-length",
      version: 1,
      accuracy: "estimated" as const,
      estimateInputTokens(value: readonly AgentModelInputItem[]) {
        return JSON.stringify(value).length;
      },
      estimateToolDefinitionTokens() {
        return 0;
      },
    };
    const context = {
      budget: {
        contextLimitTokens: 2_000,
        reservedOutputTokens: 100,
        safetyMarginTokens: 100,
      },
      estimator,
      compactionSummarizer: {
        async summarize() {
          return "compact summary";
        },
      },
    };

    const plan = await prepareDurableAgentContext(
      store,
      context,
      [],
      "post_tool",
      new AbortController().signal,
    );
    expect(plan.decision).toBe(
      "fits_with_existing_compaction",
    );
    expect(
      (await readAgentCompactionArtifact(store)).status,
    ).toBe("valid");
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "compaction-restart",
    });
    expect(
      (await readAgentCompactionArtifact(reopened)).status,
    ).toBe("valid");

    const restartedPlan = await prepareDurableAgentContext(
      reopened,
      {
        budget: context.budget,
        estimator,
      },
      [],
      "pre_request",
      new AbortController().signal,
    );
    expect(restartedPlan.decision).toBe(
      "fits_with_existing_compaction",
    );
    await reopened.close();
  });

  it("rejects unsupported lifecycle schema versions instead of ignoring them", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "unsupported-lifecycle-schema",
    });
    await store.appendLifecycle({
      schemaVersion: 999,
      type: "state",
      state: "created",
      iteration: 0,
    });

    const records = await store.readAllRecords();
    try {
      analyzeDurableAgentSession(
        records,
        store.sessionId,
      );
      throw new Error("expected unsupported lifecycle schema rejection");
    } catch (error) {
      expect(error).toMatchObject({
        code: "unsupported_lifecycle_schema",
      });
    }
    await store.close();
  });

  it("enforces the durable lifecycle transition graph", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "invalid-transition",
    });
    await initializeDurableAgentSession(store, initialInput);

    await expect(
      appendAgentLifecycleState(
        store,
        "completed",
        0,
        { stopReason: "end_turn" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_lifecycle",
    });
    await store.close();
  });

  it("treats a cancelled tool attempt without a durable result as ambiguous until explicitly reconciled", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "cancelled-tool-ambiguity",
    });
    await initializeDurableAgentSession(store, initialInput);
    await appendToolUseRound(store);
    await appendAgentToolAttempt(store, toolCall, "started", 1);
    await appendAgentToolAttempt(
      store,
      toolCall,
      "cancelled",
      1,
      "abort observed",
    );

    let analysis = analyzeDurableAgentSession(
      await store.readAllRecords(),
      store.sessionId,
    );
    expect(analysis.disposition).toBe("blocked");
    expect(analysis.blockReason).toBe("ambiguous_tool_execution");
    expect(analysis.ambiguousToolAttempts).toEqual([
      expect.objectContaining({
        toolCallItemId: toolCall.id,
        callId: toolCall.callId,
        status: "cancelled",
      }),
    ]);

    await reconcileDurableAgentToolAttempt(
      store,
      toolCall,
      {
        iteration: 1,
        reason: "operator verified the external action never started",
      },
    );
    analysis = analyzeDurableAgentSession(
      await store.readAllRecords(),
      store.sessionId,
    );
    expect(analysis.disposition).toBe("resume");
    expect(analysis.ambiguousToolAttempts).toEqual([]);
    expect(analysis.pendingToolResponseId).toBe("response-1");
    await store.close();
  });

  it("rejects execution activity appended after a terminal lifecycle state", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "activity-after-terminal",
    });
    await initializeDurableAgentSession(store, initialInput);
    await appendAgentLifecycleState(
      store,
      "cancelled",
      1,
      { stopReason: "cancelled" },
    );
    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "must not exist after terminal",
    });

    const records = await store.readAllRecords();
    expect(() =>
      analyzeDurableAgentSession(
        records,
        store.sessionId,
      ),
    ).toThrowError(AgentLifecycleError);
    await store.close();
  });

  it("repairs a crash during created-state initial input persistence from an exact durable prefix", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "created-prefix-repair",
    });
    const fullInput: readonly AgentModelInputItem[] = [
      {
        type: "message",
        role: "system",
        content: "system",
      },
      {
        type: "message",
        role: "user",
        content: "task",
      },
    ];

    await appendAgentLifecycleState(store, "created", 0);
    await store.appendModelInput(fullInput[0]);

    const analysis = await initializeDurableAgentSession(
      store,
      fullInput,
    );
    expect(analysis.disposition).toBe("resume");
    expect(analysis.lifecycleState).toBe("running");
    expect(analysis.replay.input).toEqual(fullInput);
    await store.close();
  });

  it("preserves the live-loop invariant that tool_use without executable calls is terminally failed", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "empty-tool-use",
    });
    await initializeDurableAgentSession(store, initialInput);
    await appendAgentLifecycleState(
      store,
      "waiting_for_model",
      1,
    );
    await store.appendModelEvent(
      event(1, {
        type: "response.started",
        responseId: "response-empty",
      }),
    );
    await store.appendModelEvent(
      event(2, {
        type: "response.completed",
        responseId: "response-empty",
        stopReason: "tool_use",
      }),
    );

    const analysis = analyzeDurableAgentSession(
      await store.readAllRecords(),
      store.sessionId,
    );
    expect(analysis).toMatchObject({
      disposition: "terminal",
      terminalKind: "failed",
      stopReason: "error",
      error: {
        code: "tool_use_without_executable_calls",
      },
    });
    await store.close();
  });

});
