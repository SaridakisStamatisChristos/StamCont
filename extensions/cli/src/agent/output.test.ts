import { describe, expect, it } from "vitest";

import { formatCliAgentJson } from "./output.js";

describe("CLI agent scriptable output", () => {
  it("emits one parseable JSON record from canonical completed output", () => {
    const line = formatCliAgentJson(
      "session-json",
      {
        status: "completed",
        stopReason: "end_turn",
        iterations: 1,
        input: [
          {
            type: "model_output",
            item: {
              id: "message-1",
              type: "message",
              role: "assistant",
              content: "canonical answer",
            },
          },
        ],
      },
      [{ name: "read_file", callId: "call-1" }],
      "stream draft",
    );

    expect(line.endsWith("\n")).toBe(true);
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toEqual({
      sessionId: "session-json",
      status: "completed",
      stopReason: "end_turn",
      iterations: 1,
      output: "canonical answer",
      toolCalls: [{ name: "read_file", callId: "call-1" }],
    });
  });

  it("falls back to the final streamed message only when canonical output is absent", () => {
    const parsed = JSON.parse(
      formatCliAgentJson(
        "session-stream",
        {
          status: "cancelled",
          iterations: 1,
          input: [],
        },
        [],
        "partial output",
      ),
    );

    expect(parsed.output).toBe("partial output");
    expect(parsed.status).toBe("cancelled");
  });
});
