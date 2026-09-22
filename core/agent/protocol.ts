export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export const AGENT_STOP_REASONS = [
  "tool_use",
  "end_turn",
  "max_tokens",
  "cancelled",
  "error",
  "unknown",
] as const;

export type AgentStopReason = (typeof AGENT_STOP_REASONS)[number];

export function isAgentStopReason(value: unknown): value is AgentStopReason {
  return (
    typeof value === "string" &&
    (AGENT_STOP_REASONS as readonly string[]).includes(value)
  );
}

export type AgentOutputItemType = "message" | "reasoning" | "tool_call";

interface AgentOutputItemBase {
  id: string;
  providerMetadata?: JsonObject;
}

export interface AgentMessageItem extends AgentOutputItemBase {
  type: "message";
  role: "assistant";
  content: string;
}

export interface AgentReasoningItem extends AgentOutputItemBase {
  type: "reasoning";
  text?: string;
  opaque?: JsonValue;
}

export interface AgentToolCallItem extends AgentOutputItemBase {
  type: "tool_call";
  callId: string;
  name: string;
  input: JsonValue;
}

export type AgentOutputItem =
  | AgentMessageItem
  | AgentReasoningItem
  | AgentToolCallItem;

export interface AgentOutputItemDescriptor {
  id: string;
  type: AgentOutputItemType;
}

export interface AgentRunError {
  message: string;
  code?: string;
  retryable?: boolean;
  details?: JsonValue;
}

interface AgentRunEventBase {
  eventId: string;
  sequence: number;
  responseId: string;
}

export interface ResponseStartedEvent extends AgentRunEventBase {
  type: "response.started";
  providerMetadata?: JsonObject;
}

export interface OutputItemAddedEvent extends AgentRunEventBase {
  type: "output_item.added";
  item: AgentOutputItemDescriptor;
}

export interface ContentDeltaEvent extends AgentRunEventBase {
  type: "content.delta";
  itemId: string;
  delta: string;
}

export interface ReasoningDeltaEvent extends AgentRunEventBase {
  type: "reasoning.delta";
  itemId: string;
  delta: string;
}

export interface ToolCallDeltaEvent extends AgentRunEventBase {
  type: "tool_call.delta";
  itemId: string;
  callIdDelta?: string;
  nameDelta?: string;
  argumentsDelta?: string;
}

export interface OutputItemCompletedEvent extends AgentRunEventBase {
  type: "output_item.completed";
  item: AgentOutputItem;
}

export interface ResponseCompletedEvent extends AgentRunEventBase {
  type: "response.completed";
  stopReason: AgentStopReason;
}

export interface ResponseAbortedEvent extends AgentRunEventBase {
  type: "response.aborted";
  reason?: string;
}

export interface ResponseFailedEvent extends AgentRunEventBase {
  type: "response.failed";
  error: AgentRunError;
}

export type AgentRunEvent =
  | ResponseStartedEvent
  | OutputItemAddedEvent
  | ContentDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallDeltaEvent
  | OutputItemCompletedEvent
  | ResponseCompletedEvent
  | ResponseAbortedEvent
  | ResponseFailedEvent;

export function isExecutableToolCallItem(
  item: AgentOutputItem,
): item is AgentToolCallItem {
  return (
    item.type === "tool_call" &&
    item.callId.trim().length > 0 &&
    item.name.trim().length > 0
  );
}
