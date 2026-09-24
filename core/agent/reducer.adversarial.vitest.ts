import { describe, expect, it } from "vitest";

import type { AgentRunEvent } from "./protocol";
import {
  AgentProtocolError,
  createInitialAgentRunState,
  getExecutableToolCalls,
  reduceAgentRunEvent,
  reduceAgentRunEvents,
} from "./reducer";

function event(
  sequence: number,
  value: Omit<AgentRunEvent, "eventId" | "sequence">,
  eventId = `event-${sequence}`,
): AgentRunEvent {
  return {
    ...value,
    eventId,
    sequence,
  } as AgentRunEvent;
}

function started(
  sequence = 1,
  responseId = "response-1",
): AgentRunEvent {
  return event(sequence, {
    type: "response.started",
    responseId,
  });
}

describe("PR14 reducer adversarial invariants", () => {
  it("keeps an exact duplicate event idempotent", () => {
    const terminal = event(2, {
      type: "response.completed",
      responseId: "response-1",
      stopReason: "end_turn",
    });
    const state = reduceAgentRunEvents(
      createInitialAgentRunState(),
      [started(), terminal, terminal],
    );

    expect(state.lastSequence).toBe(2);
    expect(state.appliedEvents).toHaveLength(2);
  });

  it("rejects sequence rollback", () => {
    const state = reduceAgentRunEvents(
      createInitialAgentRunState(),
      [
        started(),
        event(3, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "m1", type: "message" },
        }),
      ],
    );

    expect(() =>
      reduceAgentRunEvent(
        state,
        event(2, {
          type: "content.delta",
          responseId: "response-1",
          itemId: "m1",
          delta: "late",
        }),
      ),
    ).toThrow(AgentProtocolError);
  });

  it("rejects cross-response event injection", () => {
    const state = reduceAgentRunEvents(
      createInitialAgentRunState(),
      [started()],
    );

    expect(() =>
      reduceAgentRunEvent(
        state,
        event(2, {
          type: "output_item.added",
          responseId: "attacker-response",
          item: { id: "m1", type: "message" },
        }),
      ),
    ).toThrow(/targets response attacker-response/);
  });

  it("rejects a runtime stop reason outside the canonical enum", () => {
    const malformed = {
      eventId: "event-2",
      sequence: 2,
      responseId: "response-1",
      type: "response.completed",
      stopReason: "future-provider-value",
    } as unknown as AgentRunEvent;

    expect(() =>
      reduceAgentRunEvents(
        createInitialAgentRunState(),
        [started(), malformed],
      ),
    ).toThrow(/unsupported stop reason/i);
  });

  it("rejects a runtime event type outside the canonical protocol", () => {
    const malformed = {
      eventId: "event-2",
      sequence: 2,
      responseId: "response-1",
      type: "response.teleported",
    } as unknown as AgentRunEvent;

    expect(() =>
      reduceAgentRunEvents(
        createInitialAgentRunState(),
        [started(), malformed],
      ),
    ).toThrow(/Unsupported agent event type/);
  });

  it("rejects completed item type mutation", () => {
    expect(() =>
      reduceAgentRunEvents(
        createInitialAgentRunState(),
        [
          started(),
          event(2, {
            type: "output_item.added",
            responseId: "response-1",
            item: { id: "same-id", type: "message" },
          }),
          event(3, {
            type: "output_item.completed",
            responseId: "response-1",
            item: {
              id: "same-id",
              type: "reasoning",
              text: "mutated",
            },
          }),
        ],
      ),
    ).toThrow(/changed type/);
  });

  it("never makes a tool delta executable without authoritative completion", () => {
    const state = reduceAgentRunEvents(
      createInitialAgentRunState(),
      [
        started(),
        event(2, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "tool-1", type: "tool_call" },
        }),
        event(3, {
          type: "tool_call.delta",
          responseId: "response-1",
          itemId: "tool-1",
          callIdDelta: "call-1",
          nameDelta: "write_file",
          argumentsDelta: '{"path":"x"}',
        }),
        event(4, {
          type: "response.completed",
          responseId: "response-1",
          stopReason: "tool_use",
        }),
      ],
    );

    expect(getExecutableToolCalls(state)).toEqual([]);
  });

  it("rejects completion after abort and any later event after terminal state", () => {
    const aborted = reduceAgentRunEvents(
      createInitialAgentRunState(),
      [
        started(),
        event(2, {
          type: "response.aborted",
          responseId: "response-1",
          reason: "cancelled",
        }),
      ],
    );

    expect(() =>
      reduceAgentRunEvent(
        aborted,
        event(3, {
          type: "response.completed",
          responseId: "response-1",
          stopReason: "end_turn",
        }),
      ),
    ).toThrow(/without an active response/);

    expect(() =>
      reduceAgentRunEvent(
        aborted,
        event(4, {
          type: "content.delta",
          responseId: "response-1",
          itemId: "m1",
          delta: "late",
        }),
      ),
    ).toThrow(/without an active response/);
  });
});
