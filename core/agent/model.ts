import type {
  AgentOutputItem,
  AgentRunError,
  AgentRunEvent,
  AgentToolCallItem,
  JsonObject,
  JsonValue,
} from "./protocol";
import type { AgentRunState } from "./reducer";

export interface AgentModelMessageInput {
  type: "message";
  role: "system" | "user";
  content: string;
}

export interface AgentModelOutputInput {
  type: "model_output";
  item: AgentOutputItem;
}

interface AgentToolResultBase {
  type: "tool_result";
  toolCallItemId: string;
  callId: string;
  name: string;
}

export interface AgentToolSuccessResult extends AgentToolResultBase {
  status: "success";
  output: JsonValue;
}

export interface AgentToolFailureResult extends AgentToolResultBase {
  status: "failure";
  error: AgentRunError;
}

export type AgentToolResult =
  | AgentToolSuccessResult
  | AgentToolFailureResult;

export type AgentModelInputItem =
  | AgentModelMessageInput
  | AgentModelOutputInput
  | AgentToolResult;

export interface AgentModelToolDefinition {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

export interface AgentModelRequest {
  runState: Readonly<AgentRunState>;
  input: readonly AgentModelInputItem[];
  tools?: readonly AgentModelToolDefinition[];
  metadata?: JsonObject;
}

export interface AgentModelDriver {
  stream(
    request: AgentModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentRunEvent>;
}

export interface AgentToolExecutionContext {
  signal: AbortSignal;
  iteration: number;
  state: Readonly<AgentRunState>;
}

export type AgentToolExecutionOutcome =
  | {
      status: "success";
      output: JsonValue;
    }
  | {
      status: "failure";
      error: AgentRunError;
    };

export interface AgentToolExecutor {
  execute(
    toolCall: AgentToolCallItem,
    context: AgentToolExecutionContext,
  ): Promise<AgentToolExecutionOutcome>;
}

export function createAgentToolResult(
  toolCall: AgentToolCallItem,
  outcome: AgentToolExecutionOutcome,
): AgentToolResult {
  const identity = {
    type: "tool_result" as const,
    toolCallItemId: toolCall.id,
    callId: toolCall.callId,
    name: toolCall.name,
  };

  return outcome.status === "success"
    ? {
        ...identity,
        status: "success",
        output: outcome.output,
      }
    : {
        ...identity,
        status: "failure",
        error: outcome.error,
      };
}
