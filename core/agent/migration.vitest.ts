import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeDurableAgentSession } from "./lifecycle";
import {
  AgentLegacyHistoryMigrationError,
  migrateLegacyAgentHistoryAtomically,
} from "./migration";
import type { AgentModelInputItem } from "./model";
import { AgentSessionStore } from "./persistence";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "stamcont-legacy-migration-"),
  );
  roots.push(root);
  return root;
}

describe("legacy agent history migration", () => {
  it("atomically imports a completed legacy end turn into canonical durability", async () => {
    const root = await makeRoot();
    const sessionId = "legacy-completed";
    const input: readonly AgentModelInputItem[] = [
      {
        type: "message",
        role: "system",
        content: "system",
      },
      {
        type: "message",
        role: "user",
        content: "old question",
      },
      {
        type: "model_output",
        item: {
          id: "legacy-answer",
          type: "message",
          role: "assistant",
          content: "old answer",
        },
      },
    ];

    await expect(
      migrateLegacyAgentHistoryAtomically({
        rootDirectory: root,
        sessionId,
        input,
      }),
    ).resolves.toBe(true);

    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId,
    });
    try {
      const analysis = analyzeDurableAgentSession(
        await store.readAllRecords(),
        sessionId,
      );
      expect(analysis).toMatchObject({
        disposition: "terminal",
        terminalKind: "completed",
        stopReason: "end_turn",
      });
      expect(analysis.replay.input).toEqual(
        expect.arrayContaining([
          {
            type: "message",
            role: "user",
            content: "old question",
          },
          expect.objectContaining({
            type: "model_output",
            item: expect.objectContaining({
              id: "legacy-answer",
              content: "old answer",
            }),
          }),
        ]),
      );
    } finally {
      await store.close();
    }
  });

  it("imports resolved historical tool use without making the old call executable", async () => {
    const root = await makeRoot();
    const sessionId = "legacy-tool-round";
    const input: readonly AgentModelInputItem[] = [
      {
        type: "message",
        role: "user",
        content: "read the file",
      },
      {
        type: "model_output",
        item: {
          id: "tool-item",
          type: "tool_call",
          callId: "call-1",
          name: "read_file",
          input: { path: "README.md" },
        },
      },
      {
        type: "tool_result",
        toolCallItemId: "tool-item",
        callId: "call-1",
        name: "read_file",
        status: "success",
        output: "historical contents",
      },
      {
        type: "model_output",
        item: {
          id: "legacy-answer",
          type: "message",
          role: "assistant",
          content: "done",
        },
      },
    ];

    await expect(
      migrateLegacyAgentHistoryAtomically({
        rootDirectory: root,
        sessionId,
        input,
      }),
    ).resolves.toBe(true);

    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId,
    });
    try {
      const analysis = analyzeDurableAgentSession(
        await store.readAllRecords(),
        sessionId,
      );
      expect(analysis).toMatchObject({
        disposition: "terminal",
        terminalKind: "completed",
        stopReason: "end_turn",
        ambiguousToolAttempts: [],
      });
      expect(analysis.replay.input).toContainEqual({
        type: "tool_result",
        toolCallItemId: "tool-item",
        callId: "call-1",
        name: "read_file",
        status: "success",
        output: "historical contents",
      });
    } finally {
      await store.close();
    }
  });

  it("rejects an incomplete historical tool round without publishing a partial durable log", async () => {
    const root = await makeRoot();
    const sessionId = "legacy-incomplete-tool";
    const input: readonly AgentModelInputItem[] = [
      {
        type: "message",
        role: "user",
        content: "write something",
      },
      {
        type: "model_output",
        item: {
          id: "tool-item",
          type: "tool_call",
          callId: "call-1",
          name: "write_file",
          input: { path: "a.txt" },
        },
      },
    ];

    await expect(
      migrateLegacyAgentHistoryAtomically({
        rootDirectory: root,
        sessionId,
        input,
      }),
    ).rejects.toMatchObject<
      Partial<AgentLegacyHistoryMigrationError>
    >({
      code: "unsafe_boundary",
    });

    await expect(
      readFile(
        path.join(root, sessionId, "session.jsonl"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives an existing durable log precedence over stale malformed surface history", async () => {
    const root = await makeRoot();
    const sessionId = "durable-wins";
    const canonicalInput: readonly AgentModelInputItem[] = [
      {
        type: "message",
        role: "user",
        content: "canonical question",
      },
      {
        type: "model_output",
        item: {
          id: "canonical-answer",
          type: "message",
          role: "assistant",
          content: "canonical answer",
        },
      },
    ];
    await migrateLegacyAgentHistoryAtomically({
      rootDirectory: root,
      sessionId,
      input: canonicalInput,
    });

    const staleMalformedInput: readonly AgentModelInputItem[] = [
      {
        type: "tool_result",
        toolCallItemId: "orphan",
        callId: "orphan",
        name: "dangerous_tool",
        status: "success",
        output: "stale",
      },
    ];

    await expect(
      migrateLegacyAgentHistoryAtomically({
        rootDirectory: root,
        sessionId,
        input: staleMalformedInput,
      }),
    ).resolves.toBe(false);

    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId,
    });
    try {
      const analysis = analyzeDurableAgentSession(
        await store.readAllRecords(),
        sessionId,
      );
      expect(analysis.replay.input).toEqual(
        expect.arrayContaining([
          {
            type: "message",
            role: "user",
            content: "canonical question",
          },
          expect.objectContaining({
            type: "model_output",
            item: expect.objectContaining({
              id: "canonical-answer",
              content: "canonical answer",
            }),
          }),
        ]),
      );
      expect(
        analysis.replay.input.some(
          (item) =>
            item.type === "tool_result" &&
            item.callId === "orphan",
        ),
      ).toBe(false);
    } finally {
      await store.close();
    }
  });
});
