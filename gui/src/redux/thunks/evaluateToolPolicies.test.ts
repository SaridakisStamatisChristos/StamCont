import type { Tool, ToolCallState } from "core";
import { describe, expect, it, vi } from "vitest";

import type { IIdeMessenger } from "../../context/IdeMessenger";
import type { AppThunkDispatch } from "../store";
import { evaluateToolPolicies } from "./evaluateToolPolicies";

function tool(name: string): Tool {
  return {
    type: "function",
    function: {
      name,
      description: name,
    },
    displayTitle: name,
    readonly: false,
    group: "Built-In",
  };
}

function toolCallState(name: string): ToolCallState {
  return {
    status: "generated",
    toolCallId: "call-1",
    toolCall: {
      id: "call-1",
      type: "function",
      function: {
        name,
        arguments: "{}",
      },
    },
    parsedArgs: {},
  };
}

describe("evaluateToolPolicies execution profiles", () => {
  it("auto-approves active tools in Full Access without a policy round trip", async () => {
    const request = vi.fn();
    const messenger = { request } as unknown as IIdeMessenger;
    const dispatch = vi.fn() as unknown as AppThunkDispatch;
    const state = toolCallState("run_terminal_command");

    const result = await evaluateToolPolicies(
      dispatch,
      messenger,
      [tool("run_terminal_command")],
      [state],
      {},
      "full_access",
    );

    expect(result).toEqual([
      {
        policy: "allowedWithoutPermission",
        toolCallState: state,
      },
    ]);
    expect(request).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps inactive tools blocked in Full Access", async () => {
    const request = vi.fn();
    const messenger = { request } as unknown as IIdeMessenger;
    const dispatch = vi.fn() as unknown as AppThunkDispatch;
    const state = toolCallState("disabled_tool");

    const result = await evaluateToolPolicies(
      dispatch,
      messenger,
      [],
      [state],
      {},
      "full_access",
    );

    expect(result[0]?.policy).toBe("disabled");
    expect(request).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalled();
  });
});
