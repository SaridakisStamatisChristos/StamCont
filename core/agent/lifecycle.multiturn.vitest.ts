import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendDurableAgentUserTurn } from "./lifecycle";
import { runAgentLoop } from "./loop";
import type {
  AgentModelDriver,
  AgentModelRequest,
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

function driver(reply: string): AgentModelDriver {
  return {
    async *stream(
      request: AgentModelRequest,
    ): AsyncIterable<AgentRunEvent> {
      let sequence = request.runState.lastSequence;
      const responseId = `r-${sequence + 1}`;
      yield {
        type: "response.started",
        eventId: `e-${++sequence}`,
        sequence,
        responseId,
      };
      yield {
        type: "output_item.added",
        eventId: `e-${++sequence}`,
        sequence,
        responseId,
        item: { id: `m-${sequence}`, type: "message" },
      };
      const itemId = `m-${sequence}`;
      yield {
        type: "output_item.completed",
        eventId: `e-${++sequence}`,
        sequence,
        responseId,
        item: {
          id: itemId,
          type: "message",
          role: "assistant",
          content: reply,
        },
      };
      yield {
        type: "response.completed",
        eventId: `e-${++sequence}`,
        sequence,
        responseId,
        stopReason: "end_turn",
      };
    },
  };
}

describe("durable agent user turns", () => {
  it("reopens only a completed end_turn when explicit user input is appended", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "stamcont-next-turn-"),
    );
    roots.push(root);
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "conversation",
    });

    const first = await runAgentLoop({
      driver: driver("first reply"),
      input: [
        {
          type: "message",
          role: "user",
          content: "first question",
        },
      ],
      durability: {
        store,
        context: {
          budget: {
            contextLimitTokens: 100_000,
            reservedOutputTokens: 1_000,
          },
        },
      },
    });
    expect(first.status).toBe("completed");

    const analysis = await appendDurableAgentUserTurn(
      store,
      "second question",
    );
    expect(analysis.disposition).toBe("resume");
    expect(analysis.replay.input.at(-1)).toEqual({
      type: "message",
      role: "user",
      content: "second question",
    });

    const second = await runAgentLoop({
      driver: driver("second reply"),
      input: [],
      durability: {
        store,
        context: {
          budget: {
            contextLimitTokens: 100_000,
            reservedOutputTokens: 1_000,
          },
        },
      },
    });
    expect(second.status).toBe("completed");
    expect(second.input).toContainEqual({
      type: "message",
      role: "user",
      content: "second question",
    });
    await store.close();
  });
});
