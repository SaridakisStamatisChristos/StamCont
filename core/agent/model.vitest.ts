import { describe, expect, it } from "vitest";

import { createAgentToolResult } from "./model";
import type { AgentToolCallItem } from "./protocol";

const toolCall: AgentToolCallItem = {
  id: "tool-item-1",
  type: "tool_call",
  callId: "call-1",
  name: "read_file",
  input: { path: "README.md" },
};

describe("StamCont provider-neutral model contracts", () => {
  it("binds successful host results to the canonical completed tool identity", () => {
    expect(
      createAgentToolResult(toolCall, {
        status: "success",
        output: { content: "hello" },
      }),
    ).toEqual({
      type: "tool_result",
      toolCallItemId: "tool-item-1",
      callId: "call-1",
      name: "read_file",
      status: "success",
      output: { content: "hello" },
    });
  });

  it("keeps tool-level failures explicit without turning them into model events", () => {
    expect(
      createAgentToolResult(toolCall, {
        status: "failure",
        error: {
          code: "not_found",
          message: "README.md was not found",
        },
      }),
    ).toEqual({
      type: "tool_result",
      toolCallItemId: "tool-item-1",
      callId: "call-1",
      name: "read_file",
      status: "failure",
      error: {
        code: "not_found",
        message: "README.md was not found",
      },
    });
  });
});
