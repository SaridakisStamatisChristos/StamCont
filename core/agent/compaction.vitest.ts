import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
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
  buildCompactedAgentInput,
  compactAgentHistory,
  compactAndPersistAgentHistory,
  findLatestSafeAgentCompactionBoundary,
  getAgentCompactionPath,
  readAgentCompactionArtifact,
  type AgentCompactionError,
  type AgentCompactionSummarizer,
  type AgentCompactionSummarizerRequest,
} from "./compaction";
import {
  AgentSessionStore,
  type AgentPersistedRecord,
} from "./persistence";
import type { AgentRunEvent } from "./protocol";

const temporaryDirectories: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(
      os.tmpdir(),
      "stamcont-agent-compaction-",
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

function summarizer(
  summary: string,
  requests: AgentCompactionSummarizerRequest[] = [],
): AgentCompactionSummarizer {
  return {
    async summarize(request) {
      requests.push(request);
      return summary;
    },
  };
}

async function appendMessageTurn(
  store: AgentSessionStore,
  eventSequence: number,
  responseId: string,
  content: string,
): Promise<{
  nextEventSequence: number;
  completedItemRecordSequence: number;
  terminalRecordSequence: number;
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
  const completed = await store.appendModelEvent(
    event(eventSequence + 2, {
      type: "output_item.completed",
      responseId,
      item: {
        id: responseId + "-message",
        type: "message",
        role: "assistant",
        content,
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
    completedItemRecordSequence: completed.sequence,
    terminalRecordSequence: terminal.sequence,
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

describe("StamCont agent compaction", () => {
  it("selects only completed semantic boundaries and excludes an active response", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "safe-boundary",
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

    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "second task",
    });
    await store.appendModelEvent(
      event(first.nextEventSequence, {
        type: "response.started",
        responseId: "response-2",
      }),
    );
    await store.appendModelEvent(
      event(first.nextEventSequence + 1, {
        type: "output_item.added",
        responseId: "response-2",
        item: {
          id: "response-2-message",
          type: "message",
        },
      }),
    );

    const records = await store.readAllRecords();
    expect(
      findLatestSafeAgentCompactionBoundary(
        records,
        store.sessionId,
      ),
    ).toEqual({
      sequence: first.terminalRecordSequence,
      kind: "completed_turn",
      responseId: "response-1",
      toolCallIds: [],
    });

    await store.close();
  });

  it("rejects compaction when there is no safe completed boundary", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "no-boundary",
    });

    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "unfinished",
    });
    await store.appendModelEvent(
      event(1, {
        type: "response.started",
        responseId: "response-1",
      }),
    );

    await expect(
      compactAgentHistory(
        await store.readAllRecords(),
        store.sessionId,
        summarizer("unused"),
      ),
    ).rejects.toMatchObject({
      code: "no_safe_boundary",
    } satisfies Partial<AgentCompactionError>);

    await store.close();
  });

  it("treats a fully resolved tool round as a safe boundary and retains the call/result pair", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "tool-round",
    });

    const user = await store.appendModelInput({
      type: "message",
      role: "user",
      content: "read the file",
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
          id: "tool-item-1",
          type: "tool_call",
        },
      }),
    );
    const toolCall = await store.appendModelEvent(
      event(3, {
        type: "output_item.completed",
        responseId: "response-1",
        item: {
          id: "tool-item-1",
          type: "tool_call",
          callId: "call-1",
          name: "read_file",
          input: {
            path: "README.md",
          },
        },
      }),
    );
    await store.appendModelEvent(
      event(4, {
        type: "response.completed",
        responseId: "response-1",
        stopReason: "tool_use",
      }),
    );
    const result = await store.appendToolResult({
      type: "tool_result",
      status: "success",
      toolCallItemId: "tool-item-1",
      callId: "call-1",
      name: "read_file",
      output: {
        content: "hello",
      },
    });

    const records = await store.readAllRecords();
    const boundary =
      findLatestSafeAgentCompactionBoundary(
        records,
        store.sessionId,
      );
    expect(boundary).toEqual({
      sequence: result.sequence,
      kind: "resolved_tool_round",
      responseId: "response-1",
      toolCallIds: ["call-1"],
    });

    const artifact = await compactAgentHistory(
      records,
      store.sessionId,
      summarizer("tool summary"),
      { createdAt: 100 },
    );
    expect(
      artifact.protectedSourceSequences,
    ).toEqual([
      user.sequence,
      toolCall.sequence,
      result.sequence,
    ]);

    const compacted = buildCompactedAgentInput(
      records,
      store.sessionId,
      artifact,
    );
    expect(compacted).toContainEqual({
      type: "model_output",
      item: {
        id: "tool-item-1",
        type: "tool_call",
        callId: "call-1",
        name: "read_file",
        input: {
          path: "README.md",
        },
      },
    });
    expect(compacted).toContainEqual({
      type: "tool_result",
      status: "success",
      toolCallItemId: "tool-item-1",
      callId: "call-1",
      name: "read_file",
      output: {
        content: "hello",
      },
    });

    await store.close();
  });

  it("never sends opaque/provider-native payloads to the summarizer but retains them verbatim for continuation", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "opaque-protected",
    });
    const requests: AgentCompactionSummarizerRequest[] = [];

    const system = await store.appendModelInput({
      type: "message",
      role: "system",
      content: "keep this invariant",
    });
    const user = await store.appendModelInput({
      type: "message",
      role: "user",
      content: "continue the task",
    });
    await store.appendModelEvent(
      event(1, {
        type: "response.started",
        responseId: "response-1",
        providerMetadata: {
          responseToken: "opaque-response-token",
        },
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
    const reasoning = await store.appendModelEvent(
      event(3, {
        type: "output_item.completed",
        responseId: "response-1",
        item: {
          id: "reasoning-1",
          type: "reasoning",
          text: "public reasoning summary",
          opaque: {
            encrypted: "ciphertext",
            signature: "sig",
          },
          providerMetadata: {
            continuationToken: "provider-token",
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
          content: "answer",
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
      summarizer("safe summary", requests),
      { createdAt: 200 },
    );

    expect(
      artifact.protectedSourceSequences,
    ).toEqual([
      system.sequence,
      user.sequence,
      reasoning.sequence,
    ]);
    const summaryReasoning = requests[0].input.find(
      (input) =>
        input.type === "model_output" &&
        input.item.type === "reasoning",
    );
    expect(summaryReasoning).toEqual({
      type: "model_output",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        text: "public reasoning summary",
      },
    });
    expect(
      JSON.stringify(requests[0]),
    ).not.toContain("ciphertext");
    expect(
      JSON.stringify(requests[0]),
    ).not.toContain("provider-token");
    expect(
      JSON.stringify(requests[0].input),
    ).not.toContain("keep this invariant");

    const compacted = buildCompactedAgentInput(
      records,
      store.sessionId,
      artifact,
    );
    expect(compacted[0]).toEqual({
      type: "message",
      role: "system",
      content: "keep this invariant",
    });
    expect(compacted[1]).toMatchObject({
      type: "model_output",
      item: {
        type: "message",
        role: "assistant",
        content: "safe summary",
      },
    });
    expect(compacted).toContainEqual({
      type: "model_output",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        text: "public reasoning summary",
        opaque: {
          encrypted: "ciphertext",
          signature: "sig",
        },
        providerMetadata: {
          continuationToken: "provider-token",
        },
      },
    });

    await store.close();
  });

  it("writes an atomic derived checkpoint with provenance and leaves authoritative JSONL unchanged", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "durable-compaction",
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
    const before = await readFile(
      store.paths.log,
      "utf8",
    );

    const artifact =
      await compactAndPersistAgentHistory(
        store,
        summarizer("durable summary"),
        { createdAt: 1234 },
      );

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      sessionId: "durable-compaction",
      sourceSequenceStart: 1,
      sourceSequenceEnd:
        turn.terminalRecordSequence,
      createdAt: 1234,
      retainedTailStartSequence:
        turn.terminalRecordSequence + 1,
      boundary: {
        kind: "completed_turn",
        responseId: "response-1",
      },
      algorithm: {
        id: "stamcont.agent.compaction",
        version: 1,
      },
      summary: "durable summary",
    });
    expect(
      artifact.sourceFingerprint,
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await readFile(store.paths.log, "utf8"),
    ).toBe(before);
    expect(await store.listTemporaryFiles()).toEqual([]);
    expect(
      await readAgentCompactionArtifact(store),
    ).toMatchObject({
      status: "valid",
      artifact: {
        sourceSequenceEnd:
          turn.terminalRecordSequence,
        summary: "durable summary",
      },
    });

    await store.close();
  });

  it("reloads a valid compaction checkpoint after restart and keeps later tail input", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "restart-compaction",
    });

    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "old task",
    });
    await appendMessageTurn(
      store,
      1,
      "response-1",
      "old answer",
    );
    const artifact =
      await compactAndPersistAgentHistory(
        store,
        summarizer("restart summary"),
      );
    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "new tail task",
    });
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "restart-compaction",
    });
    const read =
      await readAgentCompactionArtifact(reopened);
    expect(read.status).toBe("valid");

    const compacted = buildCompactedAgentInput(
      await reopened.readAllRecords(),
      reopened.sessionId,
      read.artifact ?? artifact,
    );
    expect(compacted).toContainEqual({
      type: "message",
      role: "user",
      content: "new tail task",
    });

    await reopened.close();
  });

  it("uses the prior durable summary for repeated compaction instead of reconstructing opaque history", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "repeated-compaction",
    });

    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "task one",
    });
    const firstTurn = await appendMessageTurn(
      store,
      1,
      "response-1",
      "answer one",
    );
    await compactAndPersistAgentHistory(
      store,
      summarizer("summary one"),
      { createdAt: 10 },
    );

    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "task two",
    });
    const secondTurn = await appendMessageTurn(
      store,
      firstTurn.nextEventSequence,
      "response-2",
      "answer two",
    );

    const requests: AgentCompactionSummarizerRequest[] = [];
    const second =
      await compactAndPersistAgentHistory(
        store,
        summarizer("summary two", requests),
        { createdAt: 20 },
      );

    expect(
      second.sourceSequenceEnd,
    ).toBe(secondTurn.terminalRecordSequence);
    expect(requests).toHaveLength(1);
    expect(requests[0].previousSummary).toEqual({
      sourceSequenceEnd:
        firstTurn.terminalRecordSequence,
      summary: "summary one",
    });
    expect(
      requests[0].sourceSequenceStart,
    ).toBe(firstTurn.terminalRecordSequence + 1);
    expect(
      JSON.stringify(requests[0].input),
    ).toContain("task two");
    expect(
      JSON.stringify(requests[0].input),
    ).not.toContain("task one");

    await store.close();
  });

  it("keeps the original durable log valid when summarization fails", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "failed-compaction",
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
    const before = await readFile(
      store.paths.log,
      "utf8",
    );

    await expect(
      compactAndPersistAgentHistory(store, {
        async summarize() {
          throw new Error("summary failed");
        },
      }),
    ).rejects.toThrow("summary failed");

    expect(
      await readFile(store.paths.log, "utf8"),
    ).toBe(before);
    expect(
      await readAgentCompactionArtifact(store),
    ).toEqual({ status: "missing" });
    expect(
      (await store.replay()).input.length,
    ).toBeGreaterThan(0);

    await store.close();
  });

  it("classifies fingerprint mismatch as stale derived state without damaging history", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "stale-compaction",
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
    const artifact =
      await compactAndPersistAgentHistory(
        store,
        summarizer("summary"),
      );
    const logBefore = await readFile(
      store.paths.log,
      "utf8",
    );

    await writeFile(
      getAgentCompactionPath(store),
      JSON.stringify({
        ...artifact,
        sourceFingerprint: "0".repeat(64),
      }) + "\n",
      "utf8",
    );

    expect(
      await readAgentCompactionArtifact(store),
    ).toMatchObject({
      status: "stale",
      error: {
        code: "stale_artifact",
      },
    });
    expect(
      await readFile(store.paths.log, "utf8"),
    ).toBe(logBefore);

    await store.close();
  });

  it("rejects tampered protected references as stale derived state", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "tampered-protection",
    });

    await store.appendModelInput({
      type: "message",
      role: "system",
      content: "protected system",
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
    const artifact =
      await compactAndPersistAgentHistory(
        store,
        summarizer("summary"),
      );

    await writeFile(
      getAgentCompactionPath(store),
      JSON.stringify({
        ...artifact,
        protectedSourceSequences: [],
      }) + "\n",
      "utf8",
    );

    expect(
      await readAgentCompactionArtifact(store),
    ).toMatchObject({
      status: "stale",
      error: {
        code: "stale_artifact",
      },
    });

    await store.close();
  });

  it("classifies malformed checkpoint data as corrupt derived state", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "corrupt-compaction",
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
    await compactAndPersistAgentHistory(
      store,
      summarizer("summary"),
    );
    const recordsBefore:
      readonly AgentPersistedRecord[] =
      await store.readAllRecords();

    await writeFile(
      getAgentCompactionPath(store),
      "{broken",
      "utf8",
    );

    expect(
      await readAgentCompactionArtifact(store),
    ).toMatchObject({
      status: "corrupt",
      error: {
        code: "invalid_artifact",
      },
    });
    expect(
      await store.readAllRecords(),
    ).toEqual(recordsBefore);

    await store.close();
  });
});
