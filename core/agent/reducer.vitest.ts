import { describe, expect, it } from "vitest";

import {
  AgentProtocolError,
  createInitialAgentRunState,
  getExecutableToolCalls,
  getLatestAgentResponse,
  reduceAgentRunEvent,
  reduceAgentRunEvents,
} from "./reducer";
import type { AgentRunEvent } from "./protocol";

type EventWithoutEnvelope<T> = T extends AgentRunEvent
  ? Omit<T, "eventId" | "sequence">
  : never;
type EventInput = EventWithoutEnvelope<AgentRunEvent>;

function e(sequence: number, input: EventInput, eventId = `event-${sequence}`): AgentRunEvent {
  return { ...input, eventId, sequence } as AgentRunEvent;
}

function started(sequence = 1, responseId = "response-1"): AgentRunEvent {
  return e(sequence, { type: "response.started", responseId });
}

function reduce(events: readonly AgentRunEvent[]) {
  return reduceAgentRunEvents(createInitialAgentRunState(), events);
}

describe("StamCont canonical agent reducer", () => {
  it("reduces text deltas into an authoritative completed response", () => {
    const state = reduce([
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "message-1", type: "message" } }),
      e(3, { type: "content.delta", responseId: "response-1", itemId: "message-1", delta: "hel" }),
      e(4, { type: "content.delta", responseId: "response-1", itemId: "message-1", delta: "lo" }),
      e(5, { type: "output_item.completed", responseId: "response-1", item: { id: "message-1", type: "message", role: "assistant", content: "hello" } }),
      e(6, { type: "response.completed", responseId: "response-1", stopReason: "end_turn" }),
    ]);

    expect(getLatestAgentResponse(state)).toMatchObject({
      status: "completed",
      stopReason: "end_turn",
      outputItems: [{ id: "message-1", type: "message", status: "completed", text: "hello" }],
    });
  });

  it("preserves partial text on abort", () => {
    const state = reduce([
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "message-1", type: "message" } }),
      e(3, { type: "content.delta", responseId: "response-1", itemId: "message-1", delta: "partial answer" }),
      e(4, { type: "response.aborted", responseId: "response-1", reason: "user cancelled" }),
    ]);

    expect(getLatestAgentResponse(state)).toMatchObject({
      status: "aborted",
      stopReason: "cancelled",
      abortReason: "user cancelled",
      outputItems: [{ type: "message", status: "interrupted", text: "partial answer" }],
    });
  });

  it("preserves partial text on provider failure", () => {
    const state = reduce([
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "message-1", type: "message" } }),
      e(3, { type: "content.delta", responseId: "response-1", itemId: "message-1", delta: "useful prefix" }),
      e(4, { type: "response.failed", responseId: "response-1", error: { code: "provider_error", message: "upstream disconnected" } }),
    ]);

    expect(getLatestAgentResponse(state)).toMatchObject({
      status: "failed",
      stopReason: "error",
      error: { code: "provider_error", message: "upstream disconnected" },
      outputItems: [{ type: "message", status: "interrupted", text: "useful prefix" }],
    });
  });

  it("uses the completed reasoning item as authoritative over deltas", () => {
    const state = reduce([
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "reasoning-1", type: "reasoning" } }),
      e(3, { type: "reasoning.delta", responseId: "response-1", itemId: "reasoning-1", delta: "streamed reasoning" }),
      e(4, { type: "output_item.completed", responseId: "response-1", item: { id: "reasoning-1", type: "reasoning", text: "authoritative reasoning" } }),
      e(5, { type: "response.completed", responseId: "response-1", stopReason: "end_turn" }),
    ]);

    expect(getLatestAgentResponse(state)?.outputItems[0]).toMatchObject({
      type: "reasoning",
      status: "completed",
      text: "authoritative reasoning",
      completedItem: { text: "authoritative reasoning" },
    });
  });

  it("accepts opaque reasoning metadata only via the completed item", () => {
    const before = reduce([
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "reasoning-1", type: "reasoning" } }),
      e(3, { type: "reasoning.delta", responseId: "response-1", itemId: "reasoning-1", delta: "visible" }),
    ]);
    expect(getLatestAgentResponse(before)?.outputItems[0]).not.toHaveProperty("completedItem");

    const after = reduceAgentRunEvents(before, [
      e(4, {
        type: "output_item.completed",
        responseId: "response-1",
        item: {
          id: "reasoning-1",
          type: "reasoning",
          text: "visible",
          opaque: { encrypted: "ciphertext", signature: "sig" },
        },
      }),
    ]);
    expect(getLatestAgentResponse(after)?.outputItems[0]).toMatchObject({
      completedItem: { opaque: { encrypted: "ciphertext", signature: "sig" } },
    });
  });

  it("never exposes partial tool arguments as executable after abort", () => {
    const before = reduce([
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "tool-1", type: "tool_call" } }),
      e(3, {
        type: "tool_call.delta",
        responseId: "response-1",
        itemId: "tool-1",
        callIdDelta: "call-1",
        nameDelta: "read_file",
        argumentsDelta: '{"path":',
      }),
    ]);
    expect(getExecutableToolCalls(before)).toEqual([]);

    const state = reduceAgentRunEvent(
      before,
      e(4, { type: "response.aborted", responseId: "response-1" }),
    );
    expect(getExecutableToolCalls(state)).toEqual([]);
    expect(getLatestAgentResponse(state)?.outputItems[0]).toMatchObject({
      type: "tool_call",
      status: "interrupted",
      argumentsText: '{"path":',
    });
  });

  it("never exposes partial tool arguments as executable after error", () => {
    const state = reduce([
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "tool-1", type: "tool_call" } }),
      e(3, { type: "tool_call.delta", responseId: "response-1", itemId: "tool-1", nameDelta: "write_file", argumentsDelta: '{"path":"a"' }),
      e(4, { type: "response.failed", responseId: "response-1", error: { message: "stream failed" } }),
    ]);

    expect(getExecutableToolCalls(state)).toEqual([]);
    expect(getLatestAgentResponse(state)?.outputItems[0]).toMatchObject({
      type: "tool_call",
      status: "interrupted",
    });
  });

  it("makes a tool executable only after the completed item establishes canonical input", () => {
    const before = reduce([
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "tool-1", type: "tool_call" } }),
      e(3, { type: "tool_call.delta", responseId: "response-1", itemId: "tool-1", callIdDelta: "wrong", nameDelta: "wrong", argumentsDelta: "{}" }),
    ]);
    expect(getExecutableToolCalls(before)).toEqual([]);

    const state = reduceAgentRunEvents(before, [
      e(4, { type: "output_item.completed", responseId: "response-1", item: { id: "tool-1", type: "tool_call", callId: "call-1", name: "read_file", input: { path: "README.md" } } }),
      e(5, { type: "response.completed", responseId: "response-1", stopReason: "tool_use" }),
    ]);

    expect(getExecutableToolCalls(state)).toEqual([
      { id: "tool-1", type: "tool_call", callId: "call-1", name: "read_file", input: { path: "README.md" } },
    ]);
  });

  it("handles parallel tool calls with interleaved deltas", () => {
    const state = reduce([
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "tool-1", type: "tool_call" } }),
      e(3, { type: "output_item.added", responseId: "response-1", item: { id: "tool-2", type: "tool_call" } }),
      e(4, { type: "tool_call.delta", responseId: "response-1", itemId: "tool-2", nameDelta: "read_file", argumentsDelta: '{"path":"b"}' }),
      e(5, { type: "tool_call.delta", responseId: "response-1", itemId: "tool-1", nameDelta: "read_file", argumentsDelta: '{"path":"a"}' }),
      e(6, { type: "output_item.completed", responseId: "response-1", item: { id: "tool-2", type: "tool_call", callId: "call-2", name: "read_file", input: { path: "b" } } }),
      e(7, { type: "output_item.completed", responseId: "response-1", item: { id: "tool-1", type: "tool_call", callId: "call-1", name: "read_file", input: { path: "a" } } }),
      e(8, { type: "response.completed", responseId: "response-1", stopReason: "tool_use" }),
    ]);

    expect(getExecutableToolCalls(state).map((call) => call.callId)).toEqual(["call-1", "call-2"]);
  });

  it("preserves output item order", () => {
    const state = reduce([
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "reasoning-1", type: "reasoning" } }),
      e(3, { type: "output_item.completed", responseId: "response-1", item: { id: "reasoning-1", type: "reasoning", text: "analysis" } }),
      e(4, { type: "output_item.added", responseId: "response-1", item: { id: "message-1", type: "message" } }),
      e(5, { type: "output_item.completed", responseId: "response-1", item: { id: "message-1", type: "message", role: "assistant", content: "answer" } }),
      e(6, { type: "response.completed", responseId: "response-1", stopReason: "end_turn" }),
    ]);

    expect(getLatestAgentResponse(state)?.outputItems.map((item) => item.type)).toEqual([
      "reasoning",
      "message",
    ]);
  });

  it("normalizes max_tokens while preserving an interrupted final fragment", () => {
    const state = reduce([
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "message-1", type: "message" } }),
      e(3, { type: "content.delta", responseId: "response-1", itemId: "message-1", delta: "truncated" }),
      e(4, { type: "response.completed", responseId: "response-1", stopReason: "max_tokens" }),
    ]);

    expect(getLatestAgentResponse(state)).toMatchObject({
      status: "completed",
      stopReason: "max_tokens",
      outputItems: [{ type: "message", status: "interrupted", text: "truncated" }],
    });
  });

  it("is idempotent for duplicate events, including terminal events", () => {
    const terminal = e(2, {
      type: "response.completed",
      responseId: "response-1",
      stopReason: "end_turn",
    });
    const state = reduce([started(), terminal, terminal]);

    expect(state.lastSequence).toBe(2);
    expect(state.appliedEvents).toHaveLength(2);
    expect(getLatestAgentResponse(state)?.status).toBe("completed");
  });

  it("rejects a reused event id with a different sequence", () => {
    const state = reduce([started()]);
    expect(() =>
      reduceAgentRunEvent(
        state,
        e(2, { type: "response.completed", responseId: "response-1", stopReason: "end_turn" }, "event-1"),
      ),
    ).toThrow(AgentProtocolError);
  });

  it("replays the same canonical event log deterministically", () => {
    const events = [
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "message-1", type: "message" } }),
      e(3, { type: "content.delta", responseId: "response-1", itemId: "message-1", delta: "hello" }),
      e(4, { type: "output_item.completed", responseId: "response-1", item: { id: "message-1", type: "message", role: "assistant", content: "hello" } }),
      e(5, { type: "response.completed", responseId: "response-1", stopReason: "end_turn" }),
    ] as const;

    expect(reduce(events)).toEqual(reduce(events));
  });

  it("rejects genuinely out-of-order new events", () => {
    const state = reduce([
      started(),
      e(3, { type: "output_item.added", responseId: "response-1", item: { id: "message-1", type: "message" } }),
    ]);

    expect(() =>
      reduceAgentRunEvent(
        state,
        e(2, { type: "content.delta", responseId: "response-1", itemId: "message-1", delta: "late" }),
      ),
    ).toThrow(AgentProtocolError);
  });

  it("lets a completed item supersede conflicting streamed deltas", () => {
    const state = reduce([
      started(),
      e(2, { type: "output_item.added", responseId: "response-1", item: { id: "message-1", type: "message" } }),
      e(3, { type: "content.delta", responseId: "response-1", itemId: "message-1", delta: "draft text" }),
      e(4, { type: "output_item.completed", responseId: "response-1", item: { id: "message-1", type: "message", role: "assistant", content: "final authoritative text" } }),
    ]);

    expect(getLatestAgentResponse(state)?.outputItems[0]).toMatchObject({
      text: "final authoritative text",
      completedItem: { content: "final authoritative text" },
    });
  });

  it("supports sequential model responses in one run after tool_use", () => {
    const first = reduce([
      started(),
      e(2, { type: "response.completed", responseId: "response-1", stopReason: "tool_use" }),
    ]);
    const state = reduceAgentRunEvents(first, [
      e(3, { type: "response.started", responseId: "response-2" }),
      e(4, { type: "response.completed", responseId: "response-2", stopReason: "end_turn" }),
    ]);

    expect(state.responses.map((response) => response.responseId)).toEqual([
      "response-1",
      "response-2",
    ]);
    expect(getLatestAgentResponse(state)).toMatchObject({
      responseId: "response-2",
      status: "completed",
      stopReason: "end_turn",
    });
  });

  it("rejects deltas with no active response", () => {
    expect(() =>
      reduce([
        e(1, { type: "content.delta", responseId: "response-1", itemId: "message-1", delta: "invalid" }),
      ]),
    ).toThrow(AgentProtocolError);
  });
});
