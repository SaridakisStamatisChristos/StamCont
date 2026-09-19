import type { ToolCall } from "core";
import { describe, expect, it } from "vitest";

import { buildCoreToolCallRequest } from "./callToolById";

describe("buildCoreToolCallRequest", () => {
  it("propagates the IDE chat session and selected execution profile", () => {
    const toolCall: ToolCall = {
      id: "call-1",
      type: "function",
      function: {
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
    };

    expect(
      buildCoreToolCallRequest(toolCall, "chat-123", "full_access"),
    ).toEqual({
      toolCall,
      sessionId: "chat-123",
      executionProfile: "full_access",
    });
  });
});
