import { describe, expect, it } from "vitest";

import type { AgentRunEvent } from "./protocol";
import {
  createInitialAgentRunState,
  reduceAgentRunEvent,
  reduceAgentRunEvents,
} from "./reducer";

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function partition(
  text: string,
  random: () => number,
): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const size = 1 + Math.floor(random() * 7);
    chunks.push(text.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
}

function messageEvents(
  caseIndex: number,
  chunks: readonly string[],
): AgentRunEvent[] {
  const responseId = `r-${caseIndex}`;
  const itemId = `m-${caseIndex}`;
  let sequence = 1;
  const out: AgentRunEvent[] = [
    {
      eventId: `e-${caseIndex}-${sequence}`,
      sequence: sequence++,
      responseId,
      type: "response.started",
    },
    {
      eventId: `e-${caseIndex}-${sequence}`,
      sequence: sequence++,
      responseId,
      type: "output_item.added",
      item: { id: itemId, type: "message" },
    },
  ];
  for (const chunk of chunks) {
    out.push({
      eventId: `e-${caseIndex}-${sequence}`,
      sequence: sequence++,
      responseId,
      type: "content.delta",
      itemId,
      delta: chunk,
    });
  }
  out.push({
    eventId: `e-${caseIndex}-${sequence}`,
    sequence: sequence++,
    responseId,
    type: "output_item.completed",
    item: {
      id: itemId,
      type: "message",
      role: "assistant",
      content: chunks.join(""),
    },
  });
  out.push({
    eventId: `e-${caseIndex}-${sequence}`,
    sequence,
    responseId,
    type: "response.completed",
    stopReason: "end_turn",
  });
  return out;
}

describe("PR14 deterministic reducer soak/property checks", () => {
  it("replays seeded randomized chunk boundaries identically", () => {
    const random = rng(7331);

    for (let caseIndex = 0; caseIndex < 64; caseIndex += 1) {
      const text = Array.from(
        { length: 40 + Math.floor(random() * 80) },
        () =>
          "abcdefghijklmnopqrstuvwxyz0123456789"[
            Math.floor(random() * 36)
          ],
      ).join("");
      const events = messageEvents(
        caseIndex,
        partition(text, random),
      );

      const batch = reduceAgentRunEvents(
        createInitialAgentRunState(),
        events,
      );

      let incremental = createInitialAgentRunState();
      for (const serialized of JSON.parse(JSON.stringify(events))) {
        incremental = reduceAgentRunEvent(
          incremental,
          serialized as AgentRunEvent,
        );
      }

      expect(incremental).toEqual(batch);
      expect(batch.responses[0].outputItems[0]).toMatchObject({
        type: "message",
        status: "completed",
        text,
      });
    }
  });
});
