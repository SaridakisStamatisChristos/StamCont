import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentToolResult } from "./model";
import {
  AgentPersistenceError,
  AgentSessionStore,
  replayAgentSession,
} from "./persistence";
import type { AgentRunEvent } from "./protocol";

const temporaryDirectories: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "stamcont-agent-persistence-"));
  temporaryDirectories.push(root);
  return root;
}

type EventWithoutEnvelope<T> = T extends AgentRunEvent
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

function responseEvents(): readonly AgentRunEvent[] {
  return [
    event(1, {
      type: "response.started",
      responseId: "response-1",
      providerMetadata: { provider: "fixture" },
    }),
    event(2, {
      type: "output_item.added",
      responseId: "response-1",
      item: { id: "reasoning-1", type: "reasoning" },
    }),
    event(3, {
      type: "output_item.completed",
      responseId: "response-1",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        text: "final reasoning",
        opaque: {
          encrypted: "ciphertext",
          signature: "signature",
        },
        providerMetadata: {
          providerItemId: "provider-item-1",
        },
      },
    }),
    event(4, {
      type: "output_item.added",
      responseId: "response-1",
      item: { id: "message-1", type: "message" },
    }),
    event(5, {
      type: "content.delta",
      responseId: "response-1",
      itemId: "message-1",
      delta: "draft",
    }),
    event(6, {
      type: "output_item.completed",
      responseId: "response-1",
      item: {
        id: "message-1",
        type: "message",
        role: "assistant",
        content: "authoritative answer",
        providerMetadata: {
          providerItemId: "provider-message-1",
        },
      },
    }),
    event(7, {
      type: "response.completed",
      responseId: "response-1",
      stopReason: "end_turn",
    }),
  ];
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("StamCont durable agent persistence", () => {
  it("opens and reopens an empty session", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "empty-session",
    });

    expect(store.lastSequence).toBe(0);
    expect(await store.readAllRecords()).toEqual([]);
    expect((await store.readSnapshot()).status).toBe("missing");
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "empty-session",
    });
    expect(reopened.lastSequence).toBe(0);
    expect(reopened.recovery.indexStatus).toBe("valid");
    await reopened.close();
  });

  it("persists canonical events and replays authoritative completed output", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "replay-session",
    });

    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "hello",
    });
    for (const item of responseEvents()) {
      await store.appendModelEvent(item);
    }
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "replay-session",
    });
    const replay = await reopened.replay();

    expect(replay.runState.responses).toHaveLength(1);
    expect(replay.runState.responses[0]).toMatchObject({
      status: "completed",
      stopReason: "end_turn",
    });
    expect(replay.input[0]).toEqual({
      type: "message",
      role: "user",
      content: "hello",
    });
    expect(replay.input.at(-1)).toEqual({
      type: "model_output",
      item: {
        id: "message-1",
        type: "message",
        role: "assistant",
        content: "authoritative answer",
        providerMetadata: {
          providerItemId: "provider-message-1",
        },
      },
    });
    await reopened.close();
  });

  it("round-trips opaque provider data and unknown permitted fields exactly", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "opaque-session",
    });

    const completed = {
      type: "output_item.completed",
      eventId: "event-3",
      sequence: 3,
      responseId: "response-1",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        text: "visible",
        opaque: {
          encrypted: "abc123",
          signature: "sig123",
          nested: [1, true, null, { future: "field" }],
        },
        providerMetadata: {
          provider: "future-provider",
          continuationToken: "token-1",
        },
        futureItemField: {
          preserved: true,
        },
      },
      futureEventField: {
        preserved: true,
      },
    } as unknown as AgentRunEvent;

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
        item: { id: "reasoning-1", type: "reasoning" },
      }),
    );
    await store.appendModelEvent(completed);
    await store.appendModelEvent(
      event(4, {
        type: "response.completed",
        responseId: "response-1",
        stopReason: "end_turn",
      }),
    );
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "opaque-session",
    });
    const records = await reopened.readAllRecords();

    expect(records[2].payload).toEqual(completed);
    const replay = await reopened.replay();
    expect(replay.runState.responses[0].outputItems[0]).toMatchObject({
      completedItem: {
        opaque: {
          encrypted: "abc123",
          signature: "sig123",
          nested: [1, true, null, { future: "field" }],
        },
        providerMetadata: {
          provider: "future-provider",
          continuationToken: "token-1",
        },
        futureItemField: {
          preserved: true,
        },
      },
    });
    await reopened.close();
  });

  it("continues sequence ordering across repeated reopen and append cycles", async () => {
    const root = await makeRoot();

    for (let index = 0; index < 3; index += 1) {
      const store = await AgentSessionStore.open({
        rootDirectory: root,
        sessionId: "cycle-session",
      });
      const record = await store.appendMetadata({
        cycle: index,
      });
      expect(record.sequence).toBe(index + 1);
      await store.close();
    }

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "cycle-session",
    });
    expect(
      (await reopened.readAllRecords()).map((record) => record.sequence),
    ).toEqual([1, 2, 3]);
    await reopened.close();
  });

  it("serializes concurrent appends through one authoritative writer", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "serialized-session",
    });

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.appendMetadata({ index }),
      ),
    );

    expect(
      (await store.readAllRecords()).map((record) => record.sequence),
    ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    await store.close();
  });

  it("rejects a second active writer for the same session in-process", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "single-writer",
    });

    await expect(
      AgentSessionStore.open({
        rootDirectory: root,
        sessionId: "single-writer",
      }),
    ).rejects.toMatchObject({
      code: "session_writer_active",
    });

    await store.close();
  });

  it("rebuilds a missing index from the authoritative log", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "missing-index",
    });
    await store.appendMetadata({ value: 1 });
    const indexPath = store.paths.index;
    await store.close();

    await unlink(indexPath);

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "missing-index",
    });
    expect(reopened.recovery.indexStatus).toBe("missing");
    expect((await reopened.readRecord(1))?.payload).toEqual({ value: 1 });
    await reopened.close();
  });

  it("rebuilds corrupt and stale indexes without changing valid log data", async () => {
    const root = await makeRoot();
    const corrupt = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "corrupt-index",
    });
    await corrupt.appendMetadata({ value: "kept" });
    const corruptIndexPath = corrupt.paths.index;
    await corrupt.close();
    await writeFile(corruptIndexPath, "{not-json", "utf8");

    const corruptReopen = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "corrupt-index",
    });
    expect(corruptReopen.recovery.indexStatus).toBe("corrupt");
    expect((await corruptReopen.readRecord(1))?.payload).toEqual({
      value: "kept",
    });
    await corruptReopen.close();

    const stale = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "stale-index",
    });
    await stale.appendMetadata({ value: 1 });
    const oldIndex = await readFile(stale.paths.index, "utf8");
    await stale.appendMetadata({ value: 2 });
    const staleIndexPath = stale.paths.index;
    await stale.close();
    await writeFile(staleIndexPath, oldIndex, "utf8");

    const staleReopen = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "stale-index",
    });
    expect(staleReopen.recovery.indexStatus).toBe("stale");
    expect((await staleReopen.readRecord(2))?.payload).toEqual({ value: 2 });
    await staleReopen.close();
  });

  it("uses atomic derived snapshots and detects stale snapshots", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "snapshot-session",
    });

    expect((await store.readSnapshot()).status).toBe("missing");

    await store.appendMetadata({ value: 1 });
    const written = await store.writeSnapshot(
      { state: "derived" },
      { createdAt: 1234 },
    );
    expect(written).toMatchObject({
      logSequence: 1,
      createdAt: 1234,
      state: { state: "derived" },
    });
    expect(await store.readSnapshot()).toMatchObject({
      status: "fresh",
      snapshot: {
        logSequence: 1,
        state: { state: "derived" },
      },
    });
    expect(await store.listTemporaryFiles()).toEqual([]);

    await store.appendMetadata({ value: 2 });
    expect(await store.readSnapshot()).toMatchObject({
      status: "stale",
      snapshot: {
        logSequence: 1,
      },
    });
    await store.close();
  });

  it("treats a corrupt snapshot as derived damage while preserving the log", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "corrupt-snapshot",
    });
    await store.appendMetadata({ value: "authoritative" });
    await store.writeSnapshot({ state: "derived" });
    const snapshotPath = store.paths.snapshot;
    await store.close();

    await writeFile(snapshotPath, "{broken", "utf8");

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "corrupt-snapshot",
    });
    expect(await reopened.readSnapshot()).toMatchObject({
      status: "corrupt",
      error: {
        code: "corrupt_snapshot",
      },
    });
    expect((await reopened.readAllRecords())[0].payload).toEqual({
      value: "authoritative",
    });
    await reopened.close();
  });

  it("recovers by discarding only an incomplete final JSONL record", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "partial-tail",
    });
    await store.appendMetadata({ value: "valid" });
    const logPath = store.paths.log;
    await store.close();

    await writeFile(
      logPath,
      (await readFile(logPath, "utf8")) +
        "{\"schemaVersion\":1,\"sessionId\":\"partial-tail\"",
      "utf8",
    );

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "partial-tail",
    });
    expect(reopened.recovery.truncatedTailBytes).toBeGreaterThan(0);
    expect((await reopened.readAllRecords()).map((record) => record.payload)).toEqual([
      { value: "valid" },
    ]);
    expect((await reopened.appendMetadata({ value: "next" })).sequence).toBe(2);
    await reopened.close();
  });

  it("fails on corrupt complete history instead of silently rewriting it", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "complete-corruption",
    });
    const logPath = store.paths.log;
    await store.close();

    await writeFile(logPath, "{not-json}\n", "utf8");

    await expect(
      AgentSessionStore.open({
        rootDirectory: root,
        sessionId: "complete-corruption",
      }),
    ).rejects.toMatchObject({
      code: "corrupt_log",
    });
  });

  it("replays tool results after authoritative completed tool calls", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "tool-result-session",
    });

    await store.appendModelInput({
      type: "message",
      role: "user",
      content: "read it",
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
        item: { id: "tool-1", type: "tool_call" },
      }),
    );
    await store.appendModelEvent(
      event(3, {
        type: "output_item.completed",
        responseId: "response-1",
        item: {
          id: "tool-1",
          type: "tool_call",
          callId: "call-1",
          name: "read_file",
          input: { path: "README.md" },
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
    const result: AgentToolResult = {
      type: "tool_result",
      status: "success",
      toolCallItemId: "tool-1",
      callId: "call-1",
      name: "read_file",
      output: { content: "hello" },
    };
    await store.appendToolResult(result);

    const replay = replayAgentSession(
      await store.readAllRecords(),
      "tool-result-session",
    );
    expect(replay.input).toEqual([
      {
        type: "message",
        role: "user",
        content: "read it",
      },
      {
        type: "model_output",
        item: {
          id: "tool-1",
          type: "tool_call",
          callId: "call-1",
          name: "read_file",
          input: { path: "README.md" },
        },
      },
      result,
    ]);
    await store.close();
  });

  it("isolates multiple sessions under one root", async () => {
    const root = await makeRoot();
    const first = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "session-a",
    });
    const second = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "session-b",
    });

    await first.appendMetadata({ session: "a" });
    await second.appendMetadata({ session: "b" });

    expect((await first.readRecord(1))?.payload).toEqual({ session: "a" });
    expect((await second.readRecord(1))?.payload).toEqual({ session: "b" });

    await first.close();
    await second.close();
  });

  it("rejects path traversal session ids before touching storage", async () => {
    const root = await makeRoot();

    for (const sessionId of ["../escape", "nested/session", "..", ""]) {
      await expect(
        AgentSessionStore.open({
          rootDirectory: root,
          sessionId,
        }),
      ).rejects.toMatchObject({
        code: "invalid_session_id",
      });
    }
  });

  it("rejects values that JSON would silently coerce or discard", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "lossless-json",
    });

    await expect(
      store.appendMetadata({
        invalid: Number.NaN,
      }),
    ).rejects.toMatchObject({
      code: "invalid_json_value",
    });

    await expect(
      store.append("metadata", {
        invalid: undefined,
      }),
    ).rejects.toMatchObject({
      code: "invalid_json_value",
    });

    await store.close();
  });

  it("does not leave temporary files after index and snapshot replacement", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "atomic-files",
    });

    await store.appendMetadata({ value: 1 });
    await store.appendMetadata({ value: 2 });
    await store.writeSnapshot({ value: 2 });
    await store.writeSnapshot({ value: 3 });

    expect(await store.listTemporaryFiles()).toEqual([]);
    await store.close();
  });

  it("reports unsupported durable schemas explicitly", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "schema-session",
    });
    const logPath = store.paths.log;
    await store.close();

    await writeFile(
      logPath,
      JSON.stringify({
        schemaVersion: 999,
        sessionId: "schema-session",
        sequence: 1,
        kind: "metadata",
        payload: {},
      }) + "\n",
      "utf8",
    );

    await expect(
      AgentSessionStore.open({
        rootDirectory: root,
        sessionId: "schema-session",
      }),
    ).rejects.toMatchObject({
      code: "unsupported_schema",
    });
  });

  it("uses AgentPersistenceError for validation failures", () => {
    expect(
      () =>
        replayAgentSession(
          [
            {
              schemaVersion: 1,
              sessionId: "session-a",
              sequence: 2,
              kind: "metadata",
              payload: {},
            },
          ],
          "session-a",
        ),
    ).toThrow(AgentPersistenceError);
  });

  it("rejects unsupported authoritative log schema with actionable migration guidance", async () => {
    const root = await makeRoot();
    const sessionId = "unsupported-schema";
    const directory = path.join(root, sessionId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "session.jsonl"),
      JSON.stringify({
        schemaVersion: 999,
        sessionId,
        sequence: 1,
        kind: "metadata",
        payload: {},
      }) + "\n",
      "utf8",
    );

    await expect(
      AgentSessionStore.open({
        rootDirectory: root,
        sessionId,
      }),
    ).rejects.toMatchObject({
      code: "unsupported_schema",
      message: expect.stringContaining(
        "migrate this durable session before resuming it",
      ),
    });
  });

});
