import type { ChatMessage } from "../..";
import { describe, expect, it } from "vitest";

import { agentInputToContinueMessage } from "./continueModel";
import {
  continueChatMessagesToAgentInput,
} from "./continueHistory";

describe("Continue legacy history compatibility", () => {
  it("migrates supported history without re-executing historical tools", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "inspect" },
      {
        role: "thinking",
        content: "private continuation",
        signature: "sig-1",
        reasoning_details: [
          { type: "reasoning_id", id: "rs_1" },
        ],
        metadata: { reasoningId: "rs_1" },
      },
      {
        role: "assistant",
        content: "I will read it.",
        metadata: { responsesOutputItemId: "msg_1" },
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
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: "README body",
        metadata: { source: "legacy-gui" },
      },
    ];

    const input = continueChatMessagesToAgentInput(messages);
    expect(input).toEqual(
      expect.arrayContaining([
        { type: "message", role: "system", content: "system" },
        { type: "message", role: "user", content: "inspect" },
        expect.objectContaining({
          type: "model_output",
          item: expect.objectContaining({
            type: "tool_call",
            callId: "call-1",
            name: "read_file",
            input: { path: "README.md" },
          }),
        }),
        expect.objectContaining({
          type: "tool_result",
          callId: "call-1",
          name: "read_file",
          status: "success",
          output: "README body",
        }),
      ]),
    );

    const roundTripped = input.map(agentInputToContinueMessage);
    expect(roundTripped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "thinking",
          signature: "sig-1",
          metadata: expect.objectContaining({
            reasoningId: "rs_1",
          }),
        }),
        expect.objectContaining({
          role: "assistant",
          content: "I will read it.",
          metadata: expect.objectContaining({
            responsesOutputItemId: "msg_1",
          }),
        }),
        expect.objectContaining({
          role: "tool",
          toolCallId: "call-1",
          content: "README body",
          metadata: expect.objectContaining({
            source: "legacy-gui",
          }),
        }),
      ]),
    );
  });

  it("fails loudly rather than guessing malformed legacy tool arguments", () => {
    try {
      continueChatMessagesToAgentInput([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-bad",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":',
              },
            },
          ],
        },
      ]);
      throw new Error("expected compatibility failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_tool_call" });
    }
  });

  it("fails loudly on orphaned legacy tool results", () => {
    try {
      continueChatMessagesToAgentInput([
        {
          role: "tool",
          toolCallId: "missing-call",
          content: "orphan",
        },
      ]);
      throw new Error("expected compatibility failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "orphan_tool_result" });
    }
  });
});
