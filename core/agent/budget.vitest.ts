import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  createFallbackAgentContextEstimator,
  planAgentContextBudget,
  planAgentContextBudgetForStore,
  type AgentContextEstimator,
} from "./budget";
import {
  buildCompactedAgentInput,
  compactAgentHistory,
  compactAndPersistAgentHistory,
  type AgentCompactionArtifact,
  type AgentCompactionArtifactReadResult,
  type AgentCompactionSummarizer,
} from "./compaction";
import type {
  AgentModelInputItem,
  AgentModelToolDefinition,
} from "./model";
import {
  AgentSessionStore,
  replayAgentSession,
} from "./persistence";
import type {
  AgentRunEvent,
  JsonValue,
} from "./protocol";

const temporaryDirectories: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(
      os.tmpdir(),
      "stamcont-agent-budget-",
    ),
  );
  temporaryDirectories.push(root);
  return root;
}

type EventWithoutEnvelope<T> =
  T extends AgentRunEvent
    ? Omit<T, "eventId" | "sequence">
    : never;
type EventInput = EventWithoutEnvelope<AgentRunEvent>;

function event(
  sequence: number,
  value: EventInput,
): AgentRunEvent {
  return {
    ...value,
    eventId: "event-" + sequence,
    sequence,
  } as AgentRunEvent;
}

function summarizer(summary: string): AgentCompactionSummarizer {
  return {
    async summarize() {
      return summary;
    },
  };
}

function jsonEstimator(
  continuationOverheadTokens = 0,
): AgentContextEstimator {
  return {
    id: "test-json-estimator",
    version: 1,
    accuracy: "exact",
    estimateInputTokens(input) {
      return Buffer.byteLength(
        JSON.stringify(input),
        "utf8",
      );
    },
    estimateToolDefinitionTokens(tools) {
      return Buffer.byteLength(
        JSON.stringify(tools),
        "utf8",
      );
    },
    estimateContinuationOverheadTokens() {
      return continuationOverheadTokens;
    },
  };
}

function fixedEstimator(options: {
  readonly inputTokens: number;
  readonly toolTokens?: number;
  readonly continuationTokens?: number;
}): AgentContextEstimator {
  return {
    id: "test-fixed-estimator",
    version: 1,
    accuracy: "exact",
    estimateInputTokens() {
      return options.inputTokens;
    },
    estimateToolDefinitionTokens() {
      return options.toolTokens ?? 0;
    },
    estimateContinuationOverheadTokens() {
      return options.continuationTokens ?? 0;
    },
  };
}

async function appendMessageTurn(
  store: AgentSessionStore,
  eventSequence: number,
  responseId: string,
  content: string,
  providerMetadata?: {
    readonly providerItemId: string;
  },
): Promise<{
  readonly nextEventSequence: number;
  readonly terminalRecordSequence: number;
}> {
  await store.appendModelEvent(
    event(eventSequence, {
      type: "response.started",
      responseId,
    }),
  );
  await store.appendModelEvent(
    event(eventSequence + 1, {
      type: "output_item.added",
      responseId,
      item: {
        id: responseId + "-message",
        type: "message",
      },
    }),
  );
  await store.appendModelEvent(
    event(eventSequence + 2, {
      type: "output_item.completed",
      responseId,
      item: {
        id: responseId + "-message",
        type: "message",
        role: "assistant",
        content,
        ...(providerMetadata ? { providerMetadata } : {}),
      },
    }),
  );
  const terminal = await store.appendModelEvent(
    event(eventSequence + 3, {
      type: "response.completed",
      responseId,
      stopReason: "end_turn",
    }),
  );

  return {
    nextEventSequence: eventSequence + 4,
    terminalRecordSequence: terminal.sequence,
  };
}

async function appendToolResponse(
  store: AgentSessionStore,
  eventSequence: number,
  responseId: string,
  toolCall: {
    readonly itemId: string;
    readonly callId: string;
    readonly name: string;
    readonly input: JsonValue;
  },
): Promise<number> {
  await store.appendModelEvent(
    event(eventSequence, {
      type: "response.started",
      responseId,
    }),
  );
  await store.appendModelEvent(
    event(eventSequence + 1, {
      type: "output_item.added",
      responseId,
      item: {
        id: toolCall.itemId,
        type: "tool_call",
      },
    }),
  );
  await store.appendModelEvent(
    event(eventSequence + 2, {
      type: "output_item.completed",
      responseId,
      item: {
        id: toolCall.itemId,
        type: "tool_call",
        callId: toolCall.callId,
        name: toolCall.name,
        input: toolCall.input,
      },
    }),
  );
  await store.appendModelEvent(
    event(eventSequence + 3, {
      type: "response.completed",
      responseId,
      stopReason: "tool_use",
    }),
  );
  return eventSequence + 4;
}

function validCompaction(
  artifact: AgentCompactionArtifact,
): AgentCompactionArtifactReadResult {
  return {
    status: "valid",
    artifact,
  };
}

function midpointBudget(
  rawInputTokens: number,
  compactedInputTokens: number,
  extraTokens = 0,
): {
  readonly contextLimitTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
} {
  expect(rawInputTokens).toBeGreaterThan(
    compactedInputTokens,
  );
  const inputAllowance = Math.floor(
    (rawInputTokens + compactedInputTokens) / 2,
  );
  return {
    contextLimitTokens: inputAllowance + extraTokens,
    reservedOutputTokens: extraTokens,
    safetyMarginTokens: 0,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, {
          recursive: true,
          force: true,
        }),
      ),
  );
});

describe("StamCont agent context budgeting", () => {
  it("fits raw canonical input and accounts for tools, output reservation, safety margin, and continuation overhead", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "fits-raw",
    });
    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "hello",
    });

    const tools: readonly AgentModelToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
        },
      },
    ];
    const plan = planAgentContextBudget(
      await store.readAllRecords(),
      store.sessionId,
      {
        budget: {
          contextLimitTokens: 100,
          reservedOutputTokens: 30,
          safetyMarginTokens: 10,
        },
        estimator: fixedEstimator({
          inputTokens: 20,
          toolTokens: 7,
          continuationTokens: 3,
        }),
        tools,
      },
    );

    expect(plan.decision).toBe("fits_raw");
    expect(plan.input).toHaveLength(1);
    expect(plan.provenance).toMatchObject({
      contextLimitTokens: 100,
      reservedOutputTokens: 30,
      safetyMarginTokens: 10,
      toolDefinitionTokens: 7,
      baseInputAllowanceTokens: 53,
      rawInputTokens: 20,
      rawContinuationOverheadTokens: 3,
      rawTotalRequiredTokens: 70,
      selectedTotalRequiredTokens: 70,
      compactionUsed: false,
    });

    await store.close();
  });

  it("provides a deterministic conservative UTF-8-byte fallback estimator", () => {
    const estimator = createFallbackAgentContextEstimator();
    const input: readonly AgentModelInputItem[] = [
      {
        type: "message",
        role: "user",
        content: "héllo 🧠",
      },
    ];
    const tools: readonly AgentModelToolDefinition[] = [
      {
        name: "tool",
        inputSchema: {
          type: "object",
          properties: {
            value: {
              type: "string",
            },
          },
        },
      },
    ];

    const inputEstimate =
      estimator.estimateInputTokens(input);
    const toolEstimate =
      estimator.estimateToolDefinitionTokens(tools);

    expect(estimator.accuracy).toBe("estimated");
    expect(inputEstimate).toBe(
      Buffer.byteLength(
        JSON.stringify(input),
        "utf8",
      ),
    );
    expect(toolEstimate).toBe(
      Buffer.byteLength(
        JSON.stringify(tools),
        "utf8",
      ),
    );
    expect(
      estimator.estimateInputTokens(input),
    ).toBe(inputEstimate);
  });

  it("returns needs_compaction when raw input is over budget and a safe boundary exists", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "needs-compaction",
    });
    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "task",
    });
    const turn = await appendMessageTurn(
      store,
      1,
      "response-1",
      "answer",
    );

    const plan = planAgentContextBudget(
      await store.readAllRecords(),
      store.sessionId,
      {
        budget: {
          contextLimitTokens: 100,
          reservedOutputTokens: 10,
        },
        estimator: fixedEstimator({
          inputTokens: 200,
        }),
      },
    );

    expect(plan.decision).toBe("needs_compaction");
    expect(plan.input).toBeUndefined();
    expect(
      plan.provenance
        .latestSafeCompactionBoundarySequence,
    ).toBe(turn.terminalRecordSequence);

    await store.close();
  });

  it("returns explicit non-compactable overflow without dropping system or current-user state", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "required-overflow",
    });
    const system = await store.appendModelInput({
      type: "message",
      role: "system",
      content: "runtime authority",
    });
    const user = await store.appendModelInput({
      type: "message",
      role: "user",
      content: "x".repeat(1000),
    });

    const plan = planAgentContextBudget(
      await store.readAllRecords(),
      store.sessionId,
      {
        budget: {
          contextLimitTokens: 100,
          reservedOutputTokens: 25,
          safetyMarginTokens: 5,
        },
        estimator: fixedEstimator({
          inputTokens: 90,
        }),
      },
    );

    expect(plan.decision).toBe(
      "overflow_non_compactable",
    );
    expect(plan.input).toBeUndefined();
    expect(
      plan.provenance.requiredSourceSequences,
    ).toEqual([system.sequence, user.sequence]);

    await store.close();
  });

  it("uses a valid PR4 artifact only when raw input does not fit and preserves system, current user, and opaque provider-native state", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "existing-compaction",
    });
    await store.appendModelInput({
      type: "message",
      role: "system",
      content: "SYSTEM MUST SURVIVE",
    });
    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "CURRENT TASK",
    });
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
        item: {
          id: "reasoning-1",
          type: "reasoning",
        },
      }),
    );
    const opaqueRecord =
      await store.appendModelEvent(
        event(3, {
          type: "output_item.completed",
          responseId: "response-1",
          item: {
            id: "reasoning-1",
            type: "reasoning",
            text: "provider reasoning",
            opaque: {
              encrypted: "ciphertext",
              signature: "sig",
            },
            providerMetadata: {
              providerItemId: "opaque-1",
            },
          },
        }),
      );
    await store.appendModelEvent(
      event(4, {
        type: "output_item.added",
        responseId: "response-1",
        item: {
          id: "message-1",
          type: "message",
        },
      }),
    );
    await store.appendModelEvent(
      event(5, {
        type: "output_item.completed",
        responseId: "response-1",
        item: {
          id: "message-1",
          type: "message",
          role: "assistant",
          content: "z".repeat(2000),
        },
      }),
    );
    await store.appendModelEvent(
      event(6, {
        type: "response.completed",
        responseId: "response-1",
        stopReason: "end_turn",
      }),
    );

    const records = await store.readAllRecords();
    const artifact = await compactAgentHistory(
      records,
      store.sessionId,
      summarizer("short summary"),
    );
    const estimator = jsonEstimator();
    const rawInput = replayAgentSession(
      records,
      store.sessionId,
    ).input;
    const compactedInput = buildCompactedAgentInput(
      records,
      store.sessionId,
      artifact,
    );
    const rawTokens =
      estimator.estimateInputTokens(rawInput);
    const compactedTokens =
      estimator.estimateInputTokens(compactedInput);
    const budget = midpointBudget(
      rawTokens,
      compactedTokens,
      10,
    );

    const plan = planAgentContextBudget(
      records,
      store.sessionId,
      {
        budget,
        estimator,
        compaction: validCompaction(artifact),
      },
    );

    expect(plan.decision).toBe(
      "fits_with_existing_compaction",
    );
    expect(plan.provenance.compactionUsed).toBe(true);
    expect(
      plan.provenance.protectedSourceSequences,
    ).toContain(opaqueRecord.sequence);
    expect(plan.input).toContainEqual({
      type: "message",
      role: "system",
      content: "SYSTEM MUST SURVIVE",
    });
    expect(plan.input).toContainEqual({
      type: "message",
      role: "user",
      content: "CURRENT TASK",
    });
    expect(plan.input).toContainEqual({
      type: "model_output",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        text: "provider reasoning",
        opaque: {
          encrypted: "ciphertext",
          signature: "sig",
        },
        providerMetadata: {
          providerItemId: "opaque-1",
        },
      },
    });

    await store.close();
  });

  it("retains complete tool-call/result pairs without slicing structured JSON", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "tool-pair",
    });
    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "old task",
    });
    const first = await appendMessageTurn(
      store,
      1,
      "response-1",
      "o".repeat(2000),
    );
    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "read config",
    });

    const toolCall = {
      itemId: "tool-item-1",
      callId: "call-1",
      name: "read_file",
      input: {
        path: "config.json",
        options: {
          encoding: "utf8",
        },
      },
    } as const;
    await appendToolResponse(
      store,
      first.nextEventSequence,
      "response-2",
      toolCall,
    );
    const toolResult = await store.appendToolResult({
      type: "tool_result",
      status: "success",
      toolCallItemId: toolCall.itemId,
      callId: toolCall.callId,
      name: toolCall.name,
      output: {
        nested: {
          exact: ["a", "b", "c"],
        },
      },
    });

    const records = await store.readAllRecords();
    const artifact = await compactAgentHistory(
      records,
      store.sessionId,
      summarizer("older context summary"),
    );
    const estimator = jsonEstimator();
    const rawTokens = estimator.estimateInputTokens(
      replayAgentSession(
        records,
        store.sessionId,
      ).input,
    );
    const compacted = buildCompactedAgentInput(
      records,
      store.sessionId,
      artifact,
    );
    const compactedTokens =
      estimator.estimateInputTokens(compacted);

    const plan = planAgentContextBudget(
      records,
      store.sessionId,
      {
        budget: midpointBudget(
          rawTokens,
          compactedTokens,
        ),
        estimator,
        compaction: validCompaction(artifact),
      },
    );

    expect(plan.decision).toBe(
      "fits_with_existing_compaction",
    );
    expect(plan.input).toContainEqual({
      type: "model_output",
      item: {
        id: toolCall.itemId,
        type: "tool_call",
        callId: toolCall.callId,
        name: toolCall.name,
        input: toolCall.input,
      },
    });
    expect(plan.input).toContainEqual({
      type: "tool_result",
      status: "success",
      toolCallItemId: toolCall.itemId,
      callId: toolCall.callId,
      name: toolCall.name,
      output: {
        nested: {
          exact: ["a", "b", "c"],
        },
      },
    });
    expect(
      plan.provenance.requiredSourceSequences,
    ).toContain(toolResult.sequence);

    await store.close();
  });

  it.each(["stale", "corrupt"] as const)(
    "does not trust a %s compaction artifact",
    async (status) => {
      const root = await makeRoot();
      const store = await AgentSessionStore.open({
        rootDirectory: root,
        sessionId: "bad-compaction-" + status,
      });
      await store.appendModelInput({
        type: "message",
        role: "user",
        content: "task",
      });
      await appendMessageTurn(
        store,
        1,
        "response-1",
        "large answer",
      );

      const records = await store.readAllRecords();
      const artifact = await compactAgentHistory(
        records,
        store.sessionId,
        summarizer("tiny"),
      );
      const supplied: AgentCompactionArtifactReadResult = {
        status,
        artifact,
      };
      const estimator: AgentContextEstimator = {
        id: "artifact-sensitive",
        version: 1,
        accuracy: "exact",
        estimateInputTokens(input) {
          return input.some(
            (item) =>
              item.type === "model_output" &&
              item.item.id.startsWith(
                "stamcont-compaction:",
              ),
          )
            ? 1
            : 200;
        },
        estimateToolDefinitionTokens() {
          return 0;
        },
      };

      const plan = planAgentContextBudget(
        records,
        store.sessionId,
        {
          budget: {
            contextLimitTokens: 100,
            reservedOutputTokens: 10,
          },
          estimator,
          compaction: supplied,
        },
      );

      expect(plan.decision).toBe("needs_compaction");
      expect(plan.provenance.compactionUsed).toBe(
        false,
      );
      expect(plan.provenance.compactionStatus).toBe(
        status,
      );
      expect(plan.input).toBeUndefined();

      await store.close();
    },
  );

  it("detects a post-tool oversized result before the next model request", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "post-tool-budget",
    });
    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "inspect",
    });
    await appendToolResponse(
      store,
      1,
      "response-1",
      {
        itemId: "tool-item-1",
        callId: "call-1",
        name: "read_file",
        input: {
          path: "big.txt",
        },
      },
    );

    const estimator = jsonEstimator();
    const beforeRecords =
      await store.readAllRecords();
    const beforeTokens =
      estimator.estimateInputTokens(
        replayAgentSession(
          beforeRecords,
          store.sessionId,
        ).input,
      );
    const budget = {
      contextLimitTokens: beforeTokens + 25,
      reservedOutputTokens: 10,
      safetyMarginTokens: 5,
    };

    const before = planAgentContextBudget(
      beforeRecords,
      store.sessionId,
      {
        budget,
        estimator,
        phase: "pre_request",
      },
    );
    expect(before.decision).toBe("fits_raw");

    await store.appendToolResult({
      type: "tool_result",
      status: "success",
      toolCallItemId: "tool-item-1",
      callId: "call-1",
      name: "read_file",
      output: "x".repeat(5000),
    });

    const after = planAgentContextBudget(
      await store.readAllRecords(),
      store.sessionId,
      {
        budget,
        estimator,
        phase: "post_tool",
      },
    );
    expect(after.decision).toBe("needs_compaction");
    expect(after.provenance.phase).toBe("post_tool");
    expect(
      after.provenance.rawTotalRequiredTokens,
    ).toBeGreaterThan(
      after.provenance.contextLimitTokens,
    );

    await store.close();
  });

  it("returns overflow when the latest valid compaction still cannot fit and no newer safe boundary exists", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "compacted-overflow",
    });
    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "task",
    });
    await appendMessageTurn(
      store,
      1,
      "response-1",
      "answer",
    );
    const records = await store.readAllRecords();
    const artifact = await compactAgentHistory(
      records,
      store.sessionId,
      summarizer("summary"),
    );

    const plan = planAgentContextBudget(
      records,
      store.sessionId,
      {
        budget: {
          contextLimitTokens: 100,
          reservedOutputTokens: 10,
        },
        estimator: fixedEstimator({
          inputTokens: 200,
        }),
        compaction: validCompaction(artifact),
      },
    );

    expect(plan.decision).toBe(
      "overflow_non_compactable",
    );
    expect(plan.input).toBeUndefined();
    expect(
      plan.provenance
        .latestSafeCompactionBoundarySequence,
    ).toBe(artifact.sourceSequenceEnd);

    await store.close();
  });

  it("requests a new compaction when an existing artifact is insufficient but newer durable history has a safe boundary", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "repeat-compaction",
    });
    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "first task",
    });
    const first = await appendMessageTurn(
      store,
      1,
      "response-1",
      "first answer",
    );
    const firstRecords =
      await store.readAllRecords();
    const artifact = await compactAgentHistory(
      firstRecords,
      store.sessionId,
      summarizer("first summary"),
    );

    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "second task",
    });
    const second = await appendMessageTurn(
      store,
      first.nextEventSequence,
      "response-2",
      "second answer",
    );
    const records = await store.readAllRecords();

    const plan = planAgentContextBudget(
      records,
      store.sessionId,
      {
        budget: {
          contextLimitTokens: 100,
          reservedOutputTokens: 10,
        },
        estimator: fixedEstimator({
          inputTokens: 200,
        }),
        compaction: validCompaction(artifact),
      },
    );

    expect(plan.decision).toBe("needs_compaction");
    expect(
      plan.provenance
        .latestSafeCompactionBoundarySequence,
    ).toBe(second.terminalRecordSequence);
    expect(
      second.terminalRecordSequence,
    ).toBeGreaterThan(artifact.sourceSequenceEnd);

    await store.close();
  });

  it("produces the same structural plan for identical durable state, policy, and estimator results", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "deterministic-plan",
    });
    await store.appendModelInput({
      type: "message",
      role: "system",
      content: "system",
    });
    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "task",
    });
    await appendMessageTurn(
      store,
      1,
      "response-1",
      "answer",
    );
    const records = await store.readAllRecords();
    const options = {
      budget: {
        contextLimitTokens: 1000,
        reservedOutputTokens: 100,
        safetyMarginTokens: 50,
      },
      estimator: fixedEstimator({
        inputTokens: 100,
        toolTokens: 25,
        continuationTokens: 10,
      }),
    } as const;

    const first = planAgentContextBudget(
      records,
      store.sessionId,
      options,
    );
    const second = planAgentContextBudget(
      records,
      store.sessionId,
      options,
    );

    expect(second).toEqual(first);

    await store.close();
  });

  it("reconstructs the same validated budget inputs after restart and can use the persisted PR4 artifact", async () => {
    const root = await makeRoot();
    let store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "restart-budget",
    });
    await store.appendModelInput({
      type: "message",
      role: "system",
      content: "system",
    });
    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "current task",
    });
    await appendMessageTurn(
      store,
      1,
      "response-1",
      "x".repeat(2500),
    );
    const artifact =
      await compactAndPersistAgentHistory(
        store,
        summarizer("durable summary"),
      );
    const records = await store.readAllRecords();
    const estimator = jsonEstimator();
    const rawTokens =
      estimator.estimateInputTokens(
        replayAgentSession(
          records,
          store.sessionId,
        ).input,
      );
    const compactedTokens =
      estimator.estimateInputTokens(
        buildCompactedAgentInput(
          records,
          store.sessionId,
          artifact,
        ),
      );
    const budget = midpointBudget(
      rawTokens,
      compactedTokens,
    );
    await store.close();

    store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "restart-budget",
    });
    const plan =
      await planAgentContextBudgetForStore(
        store,
        {
          budget,
          estimator,
        },
      );

    expect(plan.decision).toBe(
      "fits_with_existing_compaction",
    );
    expect(plan.provenance.compactionStatus).toBe(
      "valid",
    );
    expect(
      plan.provenance.compactionSourceRange,
    ).toEqual({
      startSequence: artifact.sourceSequenceStart,
      endSequence: artifact.sourceSequenceEnd,
    });
    expect(
      plan.provenance.lastDurableSequence,
    ).toBe(store.lastSequence);

    await store.close();
  });
});
