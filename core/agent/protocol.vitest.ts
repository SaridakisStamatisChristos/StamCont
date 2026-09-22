import { describe, expect, it } from "vitest";

import {
  AGENT_STOP_REASONS,
  AgentOutputItem,
  isAgentStopReason,
  isExecutableToolCallItem,
} from "./protocol";

describe("StamCont canonical agent protocol", () => {
  it("defines the normalized provider-neutral stop reasons", () => {
    expect(AGENT_STOP_REASONS).toEqual([
      "tool_use",
      "end_turn",
      "max_tokens",
      "cancelled",
      "error",
      "unknown",
    ]);

    for (const reason of AGENT_STOP_REASONS) {
      expect(isAgentStopReason(reason)).toBe(true);
    }
    expect(isAgentStopReason("stop_sequence")).toBe(false);
    expect(isAgentStopReason(undefined)).toBe(false);
  });

  it("only treats completed tool items with stable identity as executable", () => {
    const valid: AgentOutputItem = {
      id: "item-1",
      type: "tool_call",
      callId: "call-1",
      name: "read_file",
      input: { path: "README.md" },
    };
    const missingName: AgentOutputItem = {
      ...valid,
      name: "   ",
    };
    const missingCallId: AgentOutputItem = {
      ...valid,
      callId: "",
    };

    expect(isExecutableToolCallItem(valid)).toBe(true);
    expect(isExecutableToolCallItem(missingName)).toBe(false);
    expect(isExecutableToolCallItem(missingCallId)).toBe(false);
  });
});
