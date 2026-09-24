import type { ChatMessage } from "../..";
import { describe, expect, it } from "vitest";

import type {
  AgentModelRequest,
} from "../model";
import { createInitialAgentRunState } from "../reducer";
import type { AgentRunEvent } from "../protocol";

import {
  ContinueAgentModelDriver,
  type ContinueAgentLlm,
} from "./continueModel";

function request(): AgentModelRequest {
  return {
    runState: createInitialAgentRunState(),
    input: [
      {
        type: "message",
        role: "user",
        content: "hello",
      },
    ],
  };
}

function llm(
  streamChat: ContinueAgentLlm["streamChat"],
): ContinueAgentLlm {
  return {
    providerName: "openai",
    underlyingProviderName: "openai",
    contextLength: 200_000,
    completionOptions: {
      model: "gpt-5",
      maxTokens: 8_192,
    },
    capabilities: { tools: true },
    lastRequestId: "provider-request-1",
    countTokens(text: string) {
      return Math.ceil(text.length / 4);
    },
    streamChat,
  } as ContinueAgentLlm;
}

async function collect(
  driver: ContinueAgentModelDriver,
  signal = new AbortController().signal,
): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of driver.stream(request(), signal)) {
    events.push(event);
  }
  return events;
}

describe("PR14 provider bridge adversarial behavior", () => {
  it("turns a stream disconnect after partial output into one canonical failure", async () => {
    const driver = new ContinueAgentModelDriver(
      llm(async function* (): AsyncGenerator<ChatMessage> {
        yield { role: "assistant", content: "partial" };
        throw new Error("socket disconnected");
      }),
    );

    const events = await collect(driver);

    expect(events.at(-1)).toMatchObject({
      type: "response.failed",
      error: {
        code: "provider_error",
        message: "socket disconnected",
      },
    });
    expect(
      events.filter((event) => event.type === "response.completed"),
    ).toHaveLength(0);
  });

  it("coalesces duplicate authoritative provider completion for one item", async () => {
    const authoritative = {
      id: "rs_dup",
      type: "reasoning",
      summary: [],
      content: [],
      encrypted_content: "cipher",
    };
    const driver = new ContinueAgentModelDriver(
      llm(async function* (): AsyncGenerator<ChatMessage> {
        yield {
          role: "thinking",
          content: "",
          metadata: {
            responsesOutputItemCompleted: authoritative,
          },
        };
        yield {
          role: "thinking",
          content: "",
          metadata: {
            responsesOutputItemCompleted: authoritative,
          },
        };
        yield {
          role: "assistant",
          content: "",
          metadata: {
            responsesTerminalEvent: "response.completed",
          },
        };
      }),
    );

    const events = await collect(driver);

    expect(
      events.filter((event) => event.type === "output_item.added"),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === "output_item.completed" &&
          event.item.id === "rs_dup",
      ),
    ).toHaveLength(1);
  });

  it("accepts authoritative reasoning completion without requiring a reasoning delta", async () => {
    const authoritative = {
      id: "rs_done",
      type: "reasoning",
      summary: [
        { type: "summary_text", text: "summary" },
      ],
      content: [
        { type: "reasoning_text", text: "continuation" },
      ],
      encrypted_content: "opaque-cipher",
    };
    const driver = new ContinueAgentModelDriver(
      llm(async function* (): AsyncGenerator<ChatMessage> {
        yield {
          role: "thinking",
          content: "",
          metadata: {
            responsesOutputItemCompleted: authoritative,
          },
        };
        yield {
          role: "assistant",
          content: "",
          metadata: {
            responsesTerminalEvent: "response.completed",
          },
        };
      }),
    );

    const events = await collect(driver);
    const completed = events.find(
      (event) =>
        event.type === "output_item.completed" &&
        event.item.id === "rs_done",
    );

    expect(completed).toMatchObject({
      type: "output_item.completed",
      item: {
        type: "reasoning",
        text: "continuation",
        opaque: authoritative,
      },
    });
  });

  it("honors cancellation that races with an active provider stream and emits no later completion", async () => {
    const controller = new AbortController();
    const driver = new ContinueAgentModelDriver(
      llm(async function* (): AsyncGenerator<ChatMessage> {
        yield { role: "assistant", content: "partial" };
        controller.abort("race cancelled");
        yield { role: "assistant", content: "must be ignored" };
      }),
    );

    const events = await collect(driver, controller.signal);

    expect(events.at(-1)).toMatchObject({
      type: "response.aborted",
      reason: "race cancelled",
    });
    expect(
      events.some(
        (event) =>
          event.type === "content.delta" &&
          event.delta.includes("must be ignored"),
      ),
    ).toBe(false);
    expect(
      events.some((event) => event.type === "output_item.completed"),
    ).toBe(false);
  });

  it("handles a terminal marker arriving after ordinary deltas without losing completed content", async () => {
    const driver = new ContinueAgentModelDriver(
      llm(async function* (): AsyncGenerator<ChatMessage> {
        yield { role: "assistant", content: "hello" };
        yield {
          role: "assistant",
          content: "",
          metadata: {
            responsesTerminalEvent: "response.completed",
            responsesStatus: "completed",
          },
        };
      }),
    );

    const events = await collect(driver);

    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      stopReason: "end_turn",
    });
    expect(
      events.find(
        (event) =>
          event.type === "output_item.completed" &&
          event.item.type === "message",
      ),
    ).toMatchObject({
      item: {
        content: "hello",
      },
    });
  });
});
