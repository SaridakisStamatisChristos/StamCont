import type { ChatMessage } from "../..";
import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../loop";
import type {
  AgentModelInputItem,
  AgentModelRequest,
  AgentModelToolDefinition,
} from "../model";
import {
  createInitialAgentRunState,
} from "../reducer";
import type {
  AgentOutputItem,
  AgentRunEvent,
} from "../protocol";

import {
  ContinueAgentModelDriver,
  agentInputToContinueMessage,
  createContinueAgentContextEstimator,
  describeContinueAgentModel,
  normalizeProviderStopReason,
  type ContinueAgentLlm,
} from "./continueModel";

interface CapturedCall {
  messages: ChatMessage[];
  options: Record<string, unknown> | undefined;
  messageOptions: Record<string, unknown> | undefined;
}

function createScriptedLlm(
  scripts: readonly (readonly ChatMessage[] | Error)[],
  overrides: Partial<ContinueAgentLlm> = {},
): ContinueAgentLlm & {
  readonly calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let scriptIndex = 0;

  const llm = {
    providerName: "openai",
    underlyingProviderName: "openai",
    contextLength: 200_000,
    completionOptions: {
      model: "gpt-5",
      maxTokens: 8_192,
    },
    capabilities: {
      tools: true,
    },
    lastRequestId: "provider-response-1",
    countTokens(text: string) {
      return Math.ceil(text.length / 4);
    },
    async *streamChat(
      messages: ChatMessage[],
      signal: AbortSignal,
      options?: Record<string, unknown>,
      messageOptions?: Record<string, unknown>,
    ): AsyncGenerator<ChatMessage> {
      calls.push({
        messages,
        options,
        messageOptions,
      });
      const script = scripts[scriptIndex];
      scriptIndex += 1;
      if (!script) {
        throw new Error("Unexpected streamChat call");
      }
      if (script instanceof Error) {
        throw script;
      }
      for (const chunk of script) {
        if (signal.aborted) {
          return;
        }
        yield chunk;
      }
    },
    ...overrides,
  } as unknown as ContinueAgentLlm & {
    readonly calls: CapturedCall[];
  };

  Object.defineProperty(llm, "calls", {
    value: calls,
    enumerable: true,
  });
  return llm;
}

function request(
  input: readonly AgentModelInputItem[] = [
    {
      type: "message",
      role: "user",
      content: "hello",
    },
  ],
  tools?: readonly AgentModelToolDefinition[],
): AgentModelRequest {
  return {
    runState: createInitialAgentRunState(),
    input,
    tools,
  };
}

async function collect(
  driver: ContinueAgentModelDriver,
  modelRequest: AgentModelRequest = request(),
  signal: AbortSignal = new AbortController().signal,
): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of driver.stream(modelRequest, signal)) {
    events.push(event);
  }
  return events;
}

function completedItems(
  events: readonly AgentRunEvent[],
): AgentOutputItem[] {
  return events.flatMap((event) =>
    event.type === "output_item.completed" ? [event.item] : [],
  );
}

function finalEvent(
  events: readonly AgentRunEvent[],
): AgentRunEvent | undefined {
  return events.at(-1);
}

describe("Continue AgentModelDriver bridge", () => {
  it("maps a plain Continue text stream into canonical authoritative events", async () => {
    const llm = createScriptedLlm([
      [
        { role: "assistant", content: "hel" },
        { role: "assistant", content: "lo" },
        {
          role: "assistant",
          content: "",
          metadata: { finishReason: "stop" },
        },
      ],
    ]);
    const driver = new ContinueAgentModelDriver(llm);

    const events = await collect(driver);

    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "output_item.added",
      "content.delta",
      "content.delta",
      "output_item.completed",
      "response.completed",
    ]);
    expect(completedItems(events)).toEqual([
      expect.objectContaining({
        type: "message",
        role: "assistant",
        content: "hello",
      }),
    ]);
    expect(finalEvent(events)).toMatchObject({
      type: "response.completed",
      stopReason: "end_turn",
    });
    expect(llm.calls[0].messageOptions).toEqual({
      precompiled: true,
    });
  });

  it("preserves parallel tool identity by provider tool-call index", async () => {
    const llm = createScriptedLlm([
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "first",
                arguments: '{"x":',
              },
            },
          ],
          metadata: { toolCallIndexes: [0] },
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-2",
              type: "function",
              function: {
                name: "second",
                arguments: '{"y":',
              },
            },
          ],
          metadata: { toolCallIndexes: [1] },
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              type: "function",
              function: { arguments: "1}" },
            },
          ],
          metadata: { toolCallIndexes: [0] },
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              type: "function",
              function: { arguments: "2}" },
            },
          ],
          metadata: {
            toolCallIndexes: [1],
            finishReason: "tool_calls",
          },
        },
      ],
    ]);
    const driver = new ContinueAgentModelDriver(llm);

    const events = await collect(driver);
    const tools = completedItems(events).filter(
      (item) => item.type === "tool_call",
    );

    expect(tools).toEqual([
      expect.objectContaining({
        type: "tool_call",
        callId: "call-1",
        name: "first",
        input: { x: 1 },
      }),
      expect.objectContaining({
        type: "tool_call",
        callId: "call-2",
        name: "second",
        input: { y: 2 },
      }),
    ]);
    expect(finalEvent(events)).toMatchObject({
      type: "response.completed",
      stopReason: "tool_use",
    });
  });

  it("treats Responses output_item.done payloads as authoritative and preserves opaque reasoning", async () => {
    const reasoningItem = {
      id: "rs_1",
      type: "reasoning",
      summary: [
        { type: "summary_text", text: "final summary" },
      ],
      content: [
        { type: "reasoning_text", text: "private continuation" },
      ],
      encrypted_content: "ciphertext",
      future_field: { version: 2 },
    };
    const messageItem = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "authoritative answer",
          annotations: [],
        },
      ],
      future_field: true,
    };

    const llm = createScriptedLlm([
      [
        {
          role: "thinking",
          content: "draft",
          reasoning_details: [
            { type: "reasoning_id", id: "rs_1" },
          ],
          metadata: { reasoningId: "rs_1" },
        },
        {
          role: "thinking",
          content: "",
          metadata: {
            reasoningId: "rs_1",
            responsesOutputItemCompleted: reasoningItem,
          },
        },
        {
          role: "assistant",
          content: "draft answer",
          metadata: { responsesOutputItemId: "msg_1" },
        },
        {
          role: "assistant",
          content: "",
          metadata: {
            responsesOutputItemId: "msg_1",
            responsesOutputItemCompleted: messageItem,
          },
        },
        {
          role: "assistant",
          content: "",
          metadata: {
            responsesTerminalEvent: "response.completed",
            responsesStatus: "completed",
          },
        },
      ],
    ]);
    const driver = new ContinueAgentModelDriver(llm);

    const events = await collect(driver);
    const items = completedItems(events);
    const reasoning = items.find(
      (item) => item.type === "reasoning",
    );
    const message = items.find((item) => item.type === "message");

    expect(reasoning).toMatchObject({
      id: "rs_1",
      type: "reasoning",
      text: "private continuation",
      opaque: reasoningItem,
    });
    expect(message).toMatchObject({
      id: "msg_1",
      type: "message",
      content: "authoritative answer",
    });
    expect(finalEvent(events)).toMatchObject({
      type: "response.completed",
      stopReason: "end_turn",
    });

    const roundTripped = agentInputToContinueMessage({
      type: "model_output",
      item: reasoning!,
    });
    expect(roundTripped).toMatchObject({
      role: "thinking",
      metadata: {
        reasoningId: "rs_1",
        encrypted_content: "ciphertext",
      },
    });
    if (roundTripped.role !== "thinking") {
      throw new Error("Expected thinking message");
    }
    expect(roundTripped.reasoning_details).toContainEqual({
      type: "encrypted_content",
      encrypted_content: "ciphertext",
    });
  });

  it("normalizes Anthropic max_tokens without provider logic in AgentLoop", async () => {
    const llm = createScriptedLlm(
      [
        [
          { role: "assistant", content: "partial" },
          {
            role: "assistant",
            content: "",
            metadata: { anthropicStopReason: "max_tokens" },
          },
        ],
      ],
      {
        providerName: "anthropic",
        underlyingProviderName: "anthropic",
        completionOptions: {
          model: "claude-sonnet-4-6",
          maxTokens: 8_192,
        },
      },
    );
    const driver = new ContinueAgentModelDriver(llm);

    const events = await collect(driver);

    expect(finalEvent(events)).toMatchObject({
      type: "response.completed",
      stopReason: "max_tokens",
    });
  });

  it("keeps unknown provider stop values unknown instead of guessing", async () => {
    const llm = createScriptedLlm([
      [
        { role: "assistant", content: "text" },
        {
          role: "assistant",
          content: "",
          metadata: { finishReason: "future_reason" },
        },
      ],
    ]);

    const events = await collect(
      new ContinueAgentModelDriver(llm),
    );

    expect(finalEvent(events)).toMatchObject({
      type: "response.completed",
      stopReason: "unknown",
    });
  });

  it("maps provider exceptions to response.failed", async () => {
    const llm = createScriptedLlm([
      new Error("upstream unavailable"),
    ]);

    const events = await collect(
      new ContinueAgentModelDriver(llm),
    );

    expect(finalEvent(events)).toMatchObject({
      type: "response.failed",
      error: {
        code: "provider_error",
        message: "upstream unavailable",
      },
    });
  });

  it("maps cancellation to response.aborted", async () => {
    const llm = createScriptedLlm([
      [{ role: "assistant", content: "unused" }],
    ]);
    const controller = new AbortController();
    controller.abort("user cancelled");

    const events = await collect(
      new ContinueAgentModelDriver(llm),
      request(),
      controller.signal,
    );

    expect(events).toHaveLength(2);
    expect(finalEvent(events)).toMatchObject({
      type: "response.aborted",
      reason: "user cancelled",
    });
    expect(llm.calls).toHaveLength(0);
  });

  it("fails closed when a completed tool call contains malformed JSON", async () => {
    const llm = createScriptedLlm([
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "broken",
                arguments: '{"x":',
              },
            },
          ],
          metadata: {
            toolCallIndexes: [0],
            finishReason: "tool_calls",
          },
        },
      ],
    ]);

    const events = await collect(
      new ContinueAgentModelDriver(llm),
    );

    expect(
      events.some(
        (event) =>
          event.type === "output_item.completed" &&
          event.item.type === "tool_call",
      ),
    ).toBe(false);
    expect(finalEvent(events)).toMatchObject({
      type: "response.failed",
      error: {
        code: "invalid_tool_arguments",
      },
    });
  });

  it("passes canonical history and tool schemas through the Continue boundary without hidden legacy pruning", async () => {
    const llm = createScriptedLlm([
      [
        {
          role: "assistant",
          content: "",
          metadata: { finishReason: "stop" },
        },
      ],
    ]);
    const driver = new ContinueAgentModelDriver(llm);
    const input: readonly AgentModelInputItem[] = [
      {
        type: "message",
        role: "system",
        content: "system",
      },
      {
        type: "message",
        role: "user",
        content: "task",
      },
      {
        type: "model_output",
        item: {
          id: "tool-item-1",
          type: "tool_call",
          callId: "call-1",
          name: "read_file",
          input: { path: "README.md" },
        },
      },
      {
        type: "tool_result",
        toolCallItemId: "tool-item-1",
        callId: "call-1",
        name: "read_file",
        status: "success",
        output: { content: "README" },
      },
    ];
    const tools: readonly AgentModelToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
      },
    ];

    await collect(driver, request(input, tools));

    expect(llm.calls[0].messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "task" },
      expect.objectContaining({
        role: "assistant",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"README.md"}',
            },
          },
        ],
      }),
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-1",
        content: '{"content":"README"}',
      }),
    ]);
    expect(llm.calls[0].options).toMatchObject({
      stream: true,
      tools: [
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "read_file",
          }),
        }),
      ],
    });
    expect(llm.calls[0].messageOptions).toEqual({
      precompiled: true,
    });
  });

  it("exposes provider-neutral budgeting capabilities from the live Continue model", () => {
    const llm = createScriptedLlm([]);
    const capabilities = describeContinueAgentModel(llm);
    const estimator = createContinueAgentContextEstimator(llm);

    expect(capabilities).toMatchObject({
      providerName: "openai",
      model: "gpt-5",
      contextLimitTokens: 200_000,
      outputLimitTokens: 8_192,
      supportsTools: true,
      supportsStreaming: true,
      reasoningContinuation: "provider_native",
    });
    expect(
      estimator.estimateInputTokens([
        {
          type: "message",
          role: "user",
          content: "hello",
        },
      ]),
    ).toBeGreaterThan(0);
  });

  it("drives the unchanged AgentLoop through the production bridge contract", async () => {
    const llm = createScriptedLlm([
      [
        { role: "assistant", content: "done" },
        {
          role: "assistant",
          content: "",
          metadata: { finishReason: "stop" },
        },
      ],
    ]);

    const result = await runAgentLoop({
      driver: new ContinueAgentModelDriver(llm),
      input: [
        {
          type: "message",
          role: "user",
          content: "hello",
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("end_turn");
    expect(result.input.at(-1)).toMatchObject({
      type: "model_output",
      item: {
        type: "message",
        content: "done",
      },
    });
  });
});

describe("provider stop-reason normalization", () => {
  it("handles known provider values and incomplete Responses termination", () => {
    expect(
      normalizeProviderStopReason({
        rawStopReason: "tool_calls",
        hasToolCalls: true,
      }),
    ).toBe("tool_use");
    expect(
      normalizeProviderStopReason({
        responsesTerminalEvent: "response.incomplete",
        responsesIncompleteReason: "max_output_tokens",
        hasToolCalls: false,
      }),
    ).toBe("max_tokens");
    expect(
      normalizeProviderStopReason({
        rawStopReason: "something_new",
        hasToolCalls: false,
      }),
    ).toBe("unknown");
  });
});
