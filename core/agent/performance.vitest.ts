import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import {
  planAgentContextBudgetForStore,
} from "./budget";
import {
  compactAgentHistory,
  writeAgentCompactionArtifact,
  type AgentCompactionSummarizer,
} from "./compaction";
import type { AgentToolResult } from "./model";
import {
  AgentSessionStore,
} from "./persistence";
import type { AgentRunEvent } from "./protocol";
import {
  createInitialAgentRunState,
  getLatestAgentResponse,
  reduceAgentRunEvent,
} from "./reducer";

const temporaryDirectories: string[] = [];

type EventWithoutEnvelope<T> = T extends AgentRunEvent
  ? Omit<T, "eventId" | "sequence">
  : never;
type EventInput = EventWithoutEnvelope<AgentRunEvent>;

interface PerformanceMetrics {
  reducerStreamMs?: number;
  reducerHeapDeltaBytes?: number;
  appendRecords?: number;
  appendTotalMs?: number;
  appendAverageMs?: number;
  replayRecords?: number;
  replayTotalMs?: number;
  replayHeapDeltaBytes?: number;
  snapshotWriteMs?: number;
  snapshotReadMs?: number;
  indexRebuildMs?: number;
  compactionMs?: number;
  contextAssemblyMs?: number;
  contextRecordReads?: number;
  largeToolResultBytes?: number;
  largeToolResultRoundTripMs?: number;
}

async function makeRoot(label: string): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "stamcont-pr15-" + label + "-"),
  );
  temporaryDirectories.push(root);
  return root;
}

function event(
  sequence: number,
  value: EventInput,
  prefix = "perf",
): AgentRunEvent {
  return {
    ...value,
    eventId: prefix + "-event-" + sequence,
    sequence,
  } as AgentRunEvent;
}

function elapsed(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(3));
}

function heapDelta(before: number): number {
  return Math.max(0, process.memoryUsage().heapUsed - before);
}

async function appendSyntheticTurn(
  store: AgentSessionStore,
  turn: number,
  eventSequence: number,
): Promise<number> {
  const responseId = "perf-response-" + turn;
  const messageId = responseId + "-message";

  await store.appendModelInput({
    type: "message",
    role: "user",
    content: "Synthetic coding turn " + turn + " " + "u".repeat(96),
  });

  await store.appendModelEvent(
    event(
      eventSequence++,
      {
        type: "response.started",
        responseId,
        providerMetadata: {
          provider: "synthetic",
          requestId: "request-" + turn,
        },
      },
      responseId,
    ),
  );

  if (turn % 6 === 0) {
    const reasoningId = responseId + "-reasoning";
    await store.appendModelEvent(
      event(
        eventSequence++,
        {
          type: "output_item.added",
          responseId,
          item: { id: reasoningId, type: "reasoning" },
        },
        responseId,
      ),
    );
    await store.appendModelEvent(
      event(
        eventSequence++,
        {
          type: "output_item.completed",
          responseId,
          item: {
            id: reasoningId,
            type: "reasoning",
            text: "opaque continuation fixture",
            opaque: {
              encrypted: "cipher-" + turn,
              signature: "sig-" + turn,
            },
            providerMetadata: {
              providerItemId: "reasoning-item-" + turn,
            },
          },
        },
        responseId,
      ),
    );
  }

  await store.appendModelEvent(
    event(
      eventSequence++,
      {
        type: "output_item.added",
        responseId,
        item: { id: messageId, type: "message" },
      },
      responseId,
    ),
  );

  let authoritative = "";
  for (let chunk = 0; chunk < 6; chunk += 1) {
    const delta =
      "turn-" + turn + "-chunk-" + chunk + "-" + "x".repeat(64);
    authoritative += delta;
    await store.appendModelEvent(
      event(
        eventSequence++,
        {
          type: "content.delta",
          responseId,
          itemId: messageId,
          delta,
        },
        responseId,
      ),
    );
  }

  await store.appendModelEvent(
    event(
      eventSequence++,
      {
        type: "output_item.completed",
        responseId,
        item: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: authoritative,
          providerMetadata: {
            providerItemId: "message-item-" + turn,
          },
        },
      },
      responseId,
    ),
  );

  await store.appendModelEvent(
    event(
      eventSequence++,
      {
        type: "response.completed",
        responseId,
        stopReason: "end_turn",
      },
      responseId,
    ),
  );

  return eventSequence;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe("PR15 deterministic performance fixtures", () => {
  it("preserves authoritative completions across large mixed provider streams", () => {
    const responseId = "mixed-stream-response";
    const messageId = responseId + "-message";
    const reasoningId = responseId + "-reasoning";
    const toolId = responseId + "-tool";
    let sequence = 1;
    let state = createInitialAgentRunState();

    const apply = (value: EventInput): void => {
      state = reduceAgentRunEvent(
        state,
        event(sequence++, { ...value, responseId } as EventInput, "mixed"),
      );
    };

    apply({ type: "response.started", responseId });
    apply({
      type: "output_item.added",
      responseId,
      item: { id: messageId, type: "message" },
    });
    apply({
      type: "output_item.added",
      responseId,
      item: { id: reasoningId, type: "reasoning" },
    });
    apply({
      type: "output_item.added",
      responseId,
      item: { id: toolId, type: "tool_call" },
    });

    for (let index = 0; index < 750; index += 1) {
      apply({
        type: "content.delta",
        responseId,
        itemId: messageId,
        delta: "m",
      });
      apply({
        type: "reasoning.delta",
        responseId,
        itemId: reasoningId,
        delta: "r",
      });
      apply({
        type: "tool_call.delta",
        responseId,
        itemId: toolId,
        argumentsDelta: "a",
      });
    }

    apply({
      type: "output_item.completed",
      responseId,
      item: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: "authoritative-message",
      },
    });
    apply({
      type: "output_item.completed",
      responseId,
      item: {
        id: reasoningId,
        type: "reasoning",
        text: "authoritative-reasoning",
        opaque: { encrypted: "opaque-mixed-stream" },
      },
    });
    apply({
      type: "output_item.completed",
      responseId,
      item: {
        id: toolId,
        type: "tool_call",
        callId: "call-mixed",
        name: "mixed_tool",
        input: { value: "authoritative-tool-input" },
      },
    });
    apply({
      type: "response.completed",
      responseId,
      stopReason: "tool_use",
    });

    const response = getLatestAgentResponse(state);
    expect(response).toMatchObject({
      status: "completed",
      stopReason: "tool_use",
    });
    expect(response?.outputItems).toMatchObject([
      { status: "completed", text: "authoritative-message" },
      { status: "completed", text: "authoritative-reasoning" },
      {
        status: "completed",
        callId: "call-mixed",
        name: "mixed_tool",
      },
    ]);
  });

  it(
    "measures representative long-session hot paths without weakening semantics",
    async () => {
      const metrics: PerformanceMetrics = {};

      const streamResponseId = "perf-stream-response";
      const streamItemId = streamResponseId + "-message";
      const streamChunks = 2_500;
      let streamSequence = 1;
      const streamEvents: AgentRunEvent[] = [
        event(streamSequence++, {
          type: "response.started",
          responseId: streamResponseId,
        }),
        event(streamSequence++, {
          type: "output_item.added",
          responseId: streamResponseId,
          item: { id: streamItemId, type: "message" },
        }),
      ];
      for (let index = 0; index < streamChunks; index += 1) {
        streamEvents.push(
          event(streamSequence++, {
            type: "content.delta",
            responseId: streamResponseId,
            itemId: streamItemId,
            delta: "x",
          }),
        );
      }
      streamEvents.push(
        event(streamSequence++, {
          type: "output_item.completed",
          responseId: streamResponseId,
          item: {
            id: streamItemId,
            type: "message",
            role: "assistant",
            content: "x".repeat(streamChunks),
          },
        }),
        event(streamSequence++, {
          type: "response.completed",
          responseId: streamResponseId,
          stopReason: "end_turn",
        }),
      );

      let state = createInitialAgentRunState();
      const reducerHeapBefore = process.memoryUsage().heapUsed;
      let startedAt = performance.now();
      for (const streamEvent of streamEvents) {
        state = reduceAgentRunEvent(state, streamEvent);
      }
      metrics.reducerStreamMs = elapsed(startedAt);
      metrics.reducerHeapDeltaBytes = heapDelta(reducerHeapBefore);
      expect(getLatestAgentResponse(state)).toMatchObject({
        status: "completed",
        stopReason: "end_turn",
      });
      expect(state.appliedEvents).toHaveLength(streamEvents.length);

      const appendRoot = await makeRoot("append");
      const appendStore = await AgentSessionStore.open({
        rootDirectory: appendRoot,
        sessionId: "append-latency",
      });
      const appendRecords = 180;
      startedAt = performance.now();
      for (let index = 0; index < appendRecords; index += 1) {
        await appendStore.appendMetadata({
          index,
          payload: "m".repeat(128),
        });
      }
      metrics.appendRecords = appendRecords;
      metrics.appendTotalMs = elapsed(startedAt);
      metrics.appendAverageMs = Number(
        (metrics.appendTotalMs / appendRecords).toFixed(3),
      );
      expect(appendStore.lastSequence).toBe(appendRecords);
      await appendStore.close();

      const longRoot = await makeRoot("long-session");
      const longStore = await AgentSessionStore.open({
        rootDirectory: longRoot,
        sessionId: "long-session",
      });
      let durableEventSequence = 1;
      for (let turn = 0; turn < 24; turn += 1) {
        durableEventSequence = await appendSyntheticTurn(
          longStore,
          turn,
          durableEventSequence,
        );
      }

      const replayHeapBefore = process.memoryUsage().heapUsed;
      startedAt = performance.now();
      const replay = await longStore.replay();
      metrics.replayTotalMs = elapsed(startedAt);
      metrics.replayHeapDeltaBytes = heapDelta(replayHeapBefore);
      metrics.replayRecords = replay.records.length;
      expect(replay.input.filter((item) => item.type === "message")).toHaveLength(
        24,
      );
      expect(replay.runState.responses).toHaveLength(24);

      const snapshotState = {
        marker: "snapshot",
        payload: "s".repeat(256 * 1024),
      };
      startedAt = performance.now();
      await longStore.writeSnapshot(snapshotState);
      metrics.snapshotWriteMs = elapsed(startedAt);

      startedAt = performance.now();
      const snapshot = await longStore.readSnapshot<typeof snapshotState>();
      metrics.snapshotReadMs = elapsed(startedAt);
      expect(snapshot.status).toBe("fresh");
      expect(snapshot.snapshot?.state.marker).toBe("snapshot");

      startedAt = performance.now();
      await longStore.rebuildIndex();
      metrics.indexRebuildMs = elapsed(startedAt);
      expect(longStore.indexDirty).toBe(false);

      const records = await longStore.readAllRecords();
      const summarizer: AgentCompactionSummarizer = {
        async summarize() {
          return "Deterministic synthetic history summary.";
        },
      };
      startedAt = performance.now();
      const artifact = await compactAgentHistory(
        records,
        longStore.sessionId,
        summarizer,
        { createdAt: 1_700_000_000_000 },
      );
      metrics.compactionMs = elapsed(startedAt);
      expect(artifact.sourceSequenceEnd).toBeGreaterThan(0);
      expect(artifact.protectedSourceSequences.length).toBeGreaterThan(0);

      await writeAgentCompactionArtifact(longStore, artifact);
      const originalReadAllRecords = longStore.readAllRecords.bind(longStore);
      let contextRecordReads = 0;
      longStore.readAllRecords = async () => {
        contextRecordReads += 1;
        return originalReadAllRecords();
      };

      startedAt = performance.now();
      const contextPlan = await planAgentContextBudgetForStore(longStore, {
        budget: {
          contextLimitTokens: 10_000_000,
          reservedOutputTokens: 2_000,
          safetyMarginTokens: 1_000,
        },
        tools: [
          {
            name: "synthetic_tool",
            description: "Synthetic PR15 fixture",
            inputSchema: {
              type: "object",
              properties: {
                value: { type: "string" },
              },
            },
          },
        ],
        phase: "pre_request",
      });
      metrics.contextAssemblyMs = elapsed(startedAt);
      metrics.contextRecordReads = contextRecordReads;
      longStore.readAllRecords = originalReadAllRecords;
      expect(contextRecordReads).toBe(1);
      expect(contextPlan.decision).toBe("fits_raw");
      expect(contextPlan.input).toHaveLength(replay.input.length);

      const largePayload = "L".repeat(512 * 1024);
      const largeResult: AgentToolResult = {
        type: "tool_result",
        toolCallItemId: "synthetic-tool-item",
        callId: "synthetic-call",
        name: "synthetic_tool",
        status: "success",
        output: {
          content: largePayload,
        },
      };
      metrics.largeToolResultBytes = Buffer.byteLength(
        largePayload,
        "utf8",
      );
      startedAt = performance.now();
      const largeRecord = await longStore.appendToolResult(largeResult);
      const roundTripped = await longStore.readRecord(
        largeRecord.sequence,
      );
      metrics.largeToolResultRoundTripMs = elapsed(startedAt);
      expect(roundTripped?.payload).toEqual(largeResult);

      await longStore.close();

      console.info(
        "PR15_PERF " +
          JSON.stringify({
            version: 1,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            metrics,
          }),
      );
    },
    120_000,
  );
});
