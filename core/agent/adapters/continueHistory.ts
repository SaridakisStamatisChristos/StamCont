import type { ChatMessage, ToolCallDelta } from "../..";

import type { AgentModelInputItem } from "../model";
import type { JsonObject, JsonValue } from "../protocol";

const CONTINUE_METADATA_KEY = "continue";

export type ContinueHistoryCompatibilityErrorCode =
  | "invalid_tool_call"
  | "orphan_tool_result";

export class ContinueHistoryCompatibilityError extends Error {
  constructor(
    readonly code: ContinueHistoryCompatibilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContinueHistoryCompatibilityError";
  }
}

/**
 * Convert supported Continue chat history into canonical agent context once.
 * This adapter never executes historical tool calls.
 */
export function continueChatMessagesToAgentInput(
  messages: readonly ChatMessage[],
): readonly AgentModelInputItem[] {
  const input: AgentModelInputItem[] = [];
  const toolCalls = new Map<
    string,
    { readonly itemId: string; readonly name: string }
  >();

  messages.forEach((message, messageIndex) => {
    if (message.role === "system" || message.role === "user") {
      const content = messageText(message);
      if (content) {
        input.push({
          type: "message",
          role: message.role,
          content,
        });
      }
      return;
    }

    if (message.role === "thinking") {
      const continuation: Record<string, unknown> = {};
      if (message.signature) continuation.signature = message.signature;
      if (message.redactedThinking) {
        continuation.redactedThinking = message.redactedThinking;
      }
      if (message.reasoning_details?.length) {
        continuation.reasoningDetails = message.reasoning_details;
      }
      const opaque = toJsonValue({
        [CONTINUE_METADATA_KEY]: continuation,
      });
      const providerMetadata = continueProviderMetadata(message.metadata);
      const text = messageText(message);
      input.push({
        type: "model_output",
        item: {
          id: compatibilityItemId("reasoning", messageIndex),
          type: "reasoning",
          ...(text ? { text } : {}),
          ...(opaque !== undefined ? { opaque } : {}),
          ...(providerMetadata ? { providerMetadata } : {}),
        },
      });
      return;
    }

    if (message.role === "assistant") {
      const providerMetadata = continueProviderMetadata(message.metadata);
      const content = messageText(message);
      if (content) {
        input.push({
          type: "model_output",
          item: {
            id: compatibilityItemId("message", messageIndex),
            type: "message",
            role: "assistant",
            content,
            ...(providerMetadata ? { providerMetadata } : {}),
          },
        });
      }

      for (const [toolIndex, toolCall] of (message.toolCalls ?? []).entries()) {
        const converted = convertToolCall(
          toolCall,
          messageIndex,
          toolIndex,
          providerMetadata,
        );
        input.push({ type: "model_output", item: converted });
        toolCalls.set(converted.callId, {
          itemId: converted.id,
          name: converted.name,
        });
      }
      return;
    }

    const call = toolCalls.get(message.toolCallId);
    if (!call) {
      throw new ContinueHistoryCompatibilityError(
        "orphan_tool_result",
        `Legacy tool result at message ${messageIndex} references unknown call "${message.toolCallId}". Refuse to silently reinterpret the history.`,
      );
    }

    input.push({
      type: "tool_result",
      toolCallItemId: call.itemId,
      callId: message.toolCallId,
      name: call.name,
      status: "success",
      output: parseLegacyToolOutput(message.content),
      providerMetadata: continueToolResultMetadata(
        message.content,
        message.metadata,
      ),
    });
  });

  return input;
}

function convertToolCall(
  toolCall: ToolCallDelta,
  messageIndex: number,
  toolIndex: number,
  providerMetadata: JsonObject | undefined,
) {
  const callId = toolCall.id?.trim();
  const name = toolCall.function?.name?.trim();
  if (!callId || !name) {
    throw new ContinueHistoryCompatibilityError(
      "invalid_tool_call",
      `Legacy assistant tool call at message ${messageIndex} is missing a stable call id or tool name.`,
    );
  }

  const rawArguments = toolCall.function?.arguments ?? "";
  let parsed: JsonValue;
  try {
    parsed = rawArguments.trim()
      ? (JSON.parse(rawArguments) as JsonValue)
      : {};
  } catch {
    throw new ContinueHistoryCompatibilityError(
      "invalid_tool_call",
      `Legacy assistant tool call "${callId}" at message ${messageIndex} has invalid JSON arguments.`,
    );
  }

  return {
    id: compatibilityItemId(`tool-${toolIndex}`, messageIndex),
    type: "tool_call" as const,
    callId,
    name,
    input: parsed,
    ...(providerMetadata ? { providerMetadata } : {}),
  };
}

function continueProviderMetadata(
  metadata: Record<string, unknown> | undefined,
): JsonObject | undefined {
  const safe = toJsonObject(metadata);
  return safe
    ? { [CONTINUE_METADATA_KEY]: { metadata: safe } }
    : undefined;
}

function continueToolResultMetadata(
  rawToolContent: string,
  metadata: Record<string, unknown> | undefined,
): JsonObject {
  const safeMetadata = toJsonObject(metadata);
  return {
    [CONTINUE_METADATA_KEY]: {
      rawToolContent,
      ...(safeMetadata ? { metadata: safeMetadata } : {}),
    },
  };
}

function parseLegacyToolOutput(content: string): JsonValue {
  try {
    const parsed = JSON.parse(content) as JsonValue;
    return parsed === undefined ? content : parsed;
  } catch {
    return content;
  }
}

function compatibilityItemId(kind: string, messageIndex: number): string {
  return `compat-${kind}-${messageIndex}`;
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function toJsonObject(value: unknown): JsonObject | undefined {
  const safe = toJsonValue(value);
  return safe !== null &&
    typeof safe === "object" &&
    !Array.isArray(safe)
    ? (safe as JsonObject)
    : undefined;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? undefined
      : (JSON.parse(serialized) as JsonValue);
  } catch {
    return undefined;
  }
}
