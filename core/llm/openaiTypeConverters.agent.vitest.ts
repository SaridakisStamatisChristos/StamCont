import { describe, expect, it } from "vitest";

import {
  fromChatCompletionChunk,
  fromResponsesChunk,
} from "./openaiTypeConverters";

describe("agent provider metadata in OpenAI converters", () => {
  it("preserves chat-completions finish reasons without inventing visible content", () => {
    const message = fromChatCompletionChunk({
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    } as any);

    expect(message).toEqual({
      role: "assistant",
      content: "",
      metadata: {
        finishReason: "stop",
      },
    });
  });

  it("preserves streamed tool-call indexes for parallel call association", () => {
    const message = fromChatCompletionChunk({
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: {
            tool_calls: [
              {
                index: 3,
                id: "call-3",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":',
                },
              },
            ],
          },
        },
      ],
    } as any);

    expect(message).toMatchObject({
      role: "assistant",
      metadata: {
        toolCallIndexes: [3],
      },
      toolCalls: [
        {
          id: "call-3",
          function: {
            name: "read_file",
            arguments: '{"path":',
          },
        },
      ],
    });
  });

  it("surfaces Responses output_item.done as metadata-only authoritative state", () => {
    const item = {
      id: "rs_1",
      type: "reasoning",
      summary: [
        {
          type: "summary_text",
          text: "summary",
        },
      ],
      encrypted_content: "ciphertext",
    };

    const message = fromResponsesChunk({
      type: "response.output_item.done",
      item,
    } as any);

    expect(message).toMatchObject({
      role: "thinking",
      content: "",
      metadata: {
        reasoningId: "rs_1",
        encrypted_content: "ciphertext",
        responsesOutputItemId: "rs_1",
        responsesOutputItemCompleted: item,
      },
    });
  });

  it("surfaces Responses terminal status without duplicating answer text", () => {
    const message = fromResponsesChunk({
      type: "response.incomplete",
      response: {
        id: "resp_1",
        status: "incomplete",
        incomplete_details: {
          reason: "max_output_tokens",
        },
      },
    } as any);

    expect(message).toEqual({
      role: "assistant",
      content: "",
      metadata: {
        responsesTerminalEvent: "response.incomplete",
        responsesResponseId: "resp_1",
        responsesStatus: "incomplete",
        responsesIncompleteReason: "max_output_tokens",
        responsesError: undefined,
      },
    });
  });
});
