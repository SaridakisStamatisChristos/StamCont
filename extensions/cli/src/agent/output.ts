import type { AgentLoopResult } from "core/agent/loop.js";
import type { AgentModelInputItem } from "core/agent/model.js";

export interface CliAgentToolActivity {
  readonly name: string;
  readonly callId: string;
}

export type CliAgentOutputResult = Pick<
  AgentLoopResult,
  "status" | "stopReason" | "error" | "input" | "iterations"
>;

export function getFinalAssistantMessage(
  items: readonly AgentModelInputItem[],
): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item.type === "model_output" &&
      item.item.type === "message"
    ) {
      return item.item.content;
    }
  }
  return "";
}

export function formatCliAgentJson(
  sessionId: string,
  result: CliAgentOutputResult,
  toolCalls: readonly CliAgentToolActivity[],
  fallbackMessage = "",
): string {
  return (
    JSON.stringify({
      sessionId,
      status: result.status,
      stopReason: result.stopReason,
      error: result.error,
      iterations: result.iterations,
      output: getFinalAssistantMessage(result.input) || fallbackMessage,
      toolCalls,
    }) + "\n"
  );
}
