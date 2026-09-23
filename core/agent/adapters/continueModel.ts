import type {
  ChatMessage,
  ILLM,
  Tool,
} from "../..";

import type { AgentContextEstimator } from "../budget";
import type {
  AgentModelDriver,
  AgentModelInputItem,
  AgentModelRequest,
  AgentModelToolDefinition,
} from "../model";
import {
  isAgentStopReason,
  type AgentOutputItem,
  type AgentRunEvent,
  type AgentStopReason,
  type JsonObject,
  type JsonValue,
} from "../protocol";

export type ContinueAgentLlm = Pick<
  ILLM,
  | "providerName"
  | "underlyingProviderName"
  | "contextLength"
  | "completionOptions"
  | "capabilities"
  | "lastRequestId"
  | "countTokens"
  | "streamChat"
>;

export type ContinueReasoningContinuation =
  | "provider_native"
  | "unknown";

export interface ContinueAgentModelCapabilities {
  readonly providerName: string;
  readonly model: string;
  readonly contextLimitTokens: number;
  readonly outputLimitTokens?: number;
  readonly supportsTools: boolean;
  readonly supportsStreaming: true;
  readonly reasoningContinuation: ContinueReasoningContinuation;
  readonly estimator: AgentContextEstimator;
}

interface BufferedBase {
  readonly id: string;
  readonly type: "message" | "reasoning" | "tool_call";
  metadata: Record<string, unknown>;
  authoritative?: Record<string, unknown>;
}

interface BufferedMessage extends BufferedBase {
  readonly type: "message";
  text: string;
}

interface BufferedReasoning extends BufferedBase {
  readonly type: "reasoning";
  text: string;
  signature: string;
  redactedThinking?: string;
  reasoningDetails: Record<string, unknown>[];
}

interface BufferedToolCall extends BufferedBase {
  readonly type: "tool_call";
  callId: string;
  name: string;
  argumentsText: string;
  providerIndex?: number;
}

type BufferedItem =
  | BufferedMessage
  | BufferedReasoning
  | BufferedToolCall;

type EventWithoutEnvelope<T> = T extends AgentRunEvent
  ? Omit<T, "eventId" | "sequence" | "responseId">
  : never;
type AgentRunEventInput = EventWithoutEnvelope<AgentRunEvent>;

interface CanonicalCompletionResult {
  readonly item?: AgentOutputItem;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

const CONTINUE_METADATA_KEY = "continue";
const CONTINUE_ESTIMATOR_VERSION = 1 as const;

export class ContinueAgentModelDriver implements AgentModelDriver {
  readonly capabilities: ContinueAgentModelCapabilities;

  constructor(private readonly llm: ContinueAgentLlm) {
    this.capabilities = describeContinueAgentModel(llm);
  }

  async *stream(
    request: AgentModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentRunEvent> {
    const translator = new ContinueAgentStreamTranslator(
      request,
      this.llm,
    );

    yield translator.started();

    if (signal.aborted) {
      yield translator.aborted(signal);
      return;
    }

    const messages = request.input.map(agentInputToContinueMessage);
    const tools = (request.tools ?? []).map(agentToolToContinueTool);

    try {
      const stream = this.llm.streamChat(
        messages,
        signal,
        {
          tools,
          stream: true,
        },
        {
          precompiled: true,
        },
      );

      for await (const chunk of stream) {
        if (signal.aborted) {
          yield translator.aborted(signal);
          return;
        }
        for (const translated of translator.observe(chunk)) {
          yield translated;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        yield translator.aborted(signal);
        return;
      }
      yield translator.failed(error);
      return;
    }

    if (signal.aborted) {
      yield translator.aborted(signal);
      return;
    }

    const completed = translator.completeItems();
    for (const completedEvent of completed.events) {
      yield completedEvent;
    }
    if (completed.error) {
      yield translator.failedCanonical(completed.error);
      return;
    }

    yield translator.terminal();
  }
}

interface CompletedItemEvents {
  readonly events: AgentRunEvent[];
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

type ContinueAssistantMessage = Extract<
  ChatMessage,
  { role: "assistant" }
>;
type ContinueThinkingMessage = Extract<
  ChatMessage,
  { role: "thinking" }
>;
type ContinueToolCallDelta = NonNullable<
  ContinueAssistantMessage["toolCalls"]
>[number];

class ContinueAgentStreamTranslator {
  readonly responseId: string;

  private sequence: number;
  private readonly items = new Map<string, BufferedItem>();
  private readonly order: string[] = [];
  private readonly toolByCallId = new Map<string, string>();
  private readonly toolByProviderIndex = new Map<number, string>();
  private activeMessageId: string | undefined;
  private activeReasoningId: string | undefined;
  private localItemSequence = 0;
  private rawStopReason: string | undefined;
  private responsesTerminalEvent: string | undefined;
  private responsesIncompleteReason: string | undefined;
  private responsesError: unknown;

  constructor(
    request: AgentModelRequest,
    private readonly llm: ContinueAgentLlm,
  ) {
    this.sequence = request.runState.lastSequence;
    this.responseId = `continue-response-${this.sequence + 1}`;
  }

  started(): AgentRunEvent {
    return this.event({
      type: "response.started",
      providerMetadata: {
        provider: effectiveProviderName(this.llm),
        model: this.llm.completionOptions.model,
      },
    });
  }

  aborted(signal: AbortSignal): AgentRunEvent {
    return this.event({
      type: "response.aborted",
      reason: abortReason(signal),
    });
  }

  failed(error: unknown): AgentRunEvent {
    return this.event({
      type: "response.failed",
      error: {
        code: "provider_error",
        message: errorMessage(error),
      },
    });
  }

  failedCanonical(error: {
    readonly code: string;
    readonly message: string;
  }): AgentRunEvent {
    return this.event({
      type: "response.failed",
      error,
    });
  }

  observe(chunk: ChatMessage): AgentRunEvent[] {
    const events: AgentRunEvent[] = [];
    const metadata = chunk.metadata ?? {};

    this.captureTerminalMetadata(metadata);
    events.push(...this.observeAuthoritative(metadata));

    if (chunk.role === "assistant") {
      events.push(...this.observeAssistant(chunk, metadata));
    } else if (chunk.role === "thinking") {
      events.push(...this.observeThinking(chunk, metadata));
    }

    return events;
  }

  completeItems(): CompletedItemEvents {
    const events: AgentRunEvent[] = [];

    for (const id of this.order) {
      const buffered = this.items.get(id);
      if (!buffered) {
        continue;
      }
      const completed = completeBufferedItem(buffered, this.llm);
      if (completed.error) {
        return {
          events,
          error: completed.error,
        };
      }
      if (completed.item) {
        events.push(
          this.event({
            type: "output_item.completed",
            item: completed.item,
          }),
        );
      }
    }

    return { events };
  }

  terminal(): AgentRunEvent {
    if (this.responsesTerminalEvent === "response.failed") {
      const details = toJsonValue(this.responsesError);
      return this.event({
        type: "response.failed",
        error: {
          code: "provider_error",
          message: providerFailureMessage(this.responsesError),
          ...(details !== undefined ? { details } : {}),
        },
      });
    }

    if (
      this.responsesTerminalEvent === "response.cancelled" ||
      this.responsesTerminalEvent === "response.canceled"
    ) {
      return this.event({
        type: "response.aborted",
        reason: "provider cancelled the response",
      });
    }

    return this.event({
      type: "response.completed",
      stopReason: normalizeProviderStopReason({
        rawStopReason: this.rawStopReason,
        responsesTerminalEvent: this.responsesTerminalEvent,
        responsesIncompleteReason:
          this.responsesIncompleteReason,
        hasToolCalls: this.order.some(
          (id) => this.items.get(id)?.type === "tool_call",
        ),
      }),
    });
  }

  private event(value: AgentRunEventInput): AgentRunEvent {
    this.sequence += 1;
    return {
      ...value,
      eventId: `${this.responseId}:event:${this.sequence}`,
      sequence: this.sequence,
      responseId: this.responseId,
    } as AgentRunEvent;
  }

  private captureTerminalMetadata(
    metadata: Record<string, unknown>,
  ): void {
    const genericStopReason = readString(metadata.agentStopReason);
    const anthropicStopReason = readString(
      metadata.anthropicStopReason,
    );
    const finishReason = readString(metadata.finishReason);

    if (genericStopReason) {
      this.rawStopReason = genericStopReason;
    } else if (anthropicStopReason) {
      this.rawStopReason = anthropicStopReason;
    } else if (finishReason) {
      this.rawStopReason = finishReason;
    }

    const terminalEvent = readString(
      metadata.responsesTerminalEvent,
    );
    if (terminalEvent) {
      this.responsesTerminalEvent = terminalEvent;
    }
    const incompleteReason = readString(
      metadata.responsesIncompleteReason,
    );
    if (incompleteReason) {
      this.responsesIncompleteReason = incompleteReason;
    }
    if (metadata.responsesError !== undefined) {
      this.responsesError = metadata.responsesError;
    }
  }

  private observeAuthoritative(
    metadata: Record<string, unknown>,
  ): AgentRunEvent[] {
    const authoritative = readRecord(
      metadata.responsesOutputItemCompleted,
    );
    if (!authoritative) {
      return [];
    }

    const authoritativeType = readString(authoritative.type);
    const canonicalType =
      authoritativeType === "function_call"
        ? "tool_call"
        : authoritativeType;
    if (
      canonicalType !== "message" &&
      canonicalType !== "reasoning" &&
      canonicalType !== "tool_call"
    ) {
      return [];
    }

    const ensured = this.ensureItem(
      canonicalType,
      readString(authoritative.id),
    );
    ensured.item.authoritative = authoritative;
    mergeMetadata(ensured.item.metadata, metadata);
    this.updateAuthoritativeIdentity(
      ensured.item,
      authoritative,
    );

    return ensured.added ? [ensured.added] : [];
  }

  private updateAuthoritativeIdentity(
    item: BufferedItem,
    authoritative: Record<string, unknown>,
  ): void {
    if (item.type === "message") {
      this.activeMessageId = item.id;
      return;
    }
    if (item.type === "reasoning") {
      this.activeReasoningId = item.id;
      return;
    }

    const callId = readString(authoritative.call_id);
    if (callId) {
      item.callId = callId;
      this.toolByCallId.set(callId, item.id);
    }
    const name = readString(authoritative.name);
    if (name) {
      item.name = name;
    }
  }

  private observeAssistant(
    chunk: ContinueAssistantMessage,
    metadata: Record<string, unknown>,
  ): AgentRunEvent[] {
    const events = this.observeAssistantText(chunk, metadata);
    const indexes = readNumberArray(metadata.toolCallIndexes);
    const responseOutputItemId = readString(
      metadata.responsesOutputItemId,
    );

    for (
      let index = 0;
      index < (chunk.toolCalls?.length ?? 0);
      index += 1
    ) {
      const toolCall = chunk.toolCalls![index];
      events.push(
        ...this.observeToolCall(
          toolCall,
          indexes[index],
          responseOutputItemId,
          metadata,
        ),
      );
    }

    return events;
  }

  private observeAssistantText(
    chunk: ContinueAssistantMessage,
    metadata: Record<string, unknown>,
  ): AgentRunEvent[] {
    const responseOutputItemId = readString(
      metadata.responsesOutputItemId,
    );
    const preferredId = responseOutputItemId?.startsWith("msg_")
      ? responseOutputItemId
      : this.activeMessageId;
    const text = messageText(chunk);

    if (!preferredId && !text) {
      return [];
    }

    const ensured = this.ensureItem("message", preferredId);
    const item = ensured.item as BufferedMessage;
    this.activeMessageId = item.id;
    mergeMetadata(item.metadata, metadata);

    const events = ensured.added ? [ensured.added] : [];
    const delta = appendDelta(item.text, text);
    if (delta) {
      item.text += delta;
      events.push(
        this.event({
          type: "content.delta",
          itemId: item.id,
          delta,
        }),
      );
    }
    return events;
  }

  private observeToolCall(
    toolCall: ContinueToolCallDelta,
    providerIndex: number | undefined,
    responseOutputItemId: string | undefined,
    metadata: Record<string, unknown>,
  ): AgentRunEvent[] {
    const incomingCallId = toolCall.id?.trim() ?? "";
    const existingId =
      this.toolItemId(providerIndex, incomingCallId);
    const preferredId =
      responseOutputItemId?.startsWith("fc_")
        ? responseOutputItemId
        : existingId;
    const ensured = this.ensureItem("tool_call", preferredId);
    const item = ensured.item as BufferedToolCall;
    mergeMetadata(item.metadata, metadata);
    this.rememberToolProviderIndex(item, providerIndex);

    const callIdDelta = appendDelta(
      item.callId,
      incomingCallId,
    );
    if (callIdDelta) {
      item.callId += callIdDelta;
      this.toolByCallId.set(item.callId, item.id);
    }

    const incomingName = toolCall.function?.name?.trim() ?? "";
    const nameDelta = appendDelta(item.name, incomingName);
    if (nameDelta) {
      item.name += nameDelta;
    }

    const argumentsDelta =
      toolCall.function?.arguments ?? "";
    if (argumentsDelta) {
      item.argumentsText += argumentsDelta;
    }

    const events = ensured.added ? [ensured.added] : [];
    if (callIdDelta || nameDelta || argumentsDelta) {
      events.push(
        this.event({
          type: "tool_call.delta",
          itemId: item.id,
          ...(callIdDelta ? { callIdDelta } : {}),
          ...(nameDelta ? { nameDelta } : {}),
          ...(argumentsDelta ? { argumentsDelta } : {}),
        }),
      );
    }
    return events;
  }

  private toolItemId(
    providerIndex: number | undefined,
    incomingCallId: string,
  ): string | undefined {
    if (providerIndex !== undefined) {
      const byIndex = this.toolByProviderIndex.get(providerIndex);
      if (byIndex) {
        return byIndex;
      }
    }
    return incomingCallId
      ? this.toolByCallId.get(incomingCallId)
      : undefined;
  }

  private rememberToolProviderIndex(
    item: BufferedToolCall,
    providerIndex: number | undefined,
  ): void {
    if (providerIndex === undefined) {
      return;
    }
    item.providerIndex = providerIndex;
    this.toolByProviderIndex.set(providerIndex, item.id);
  }

  private observeThinking(
    chunk: ContinueThinkingMessage,
    metadata: Record<string, unknown>,
  ): AgentRunEvent[] {
    const reasoningId =
      readString(metadata.reasoningId) ??
      reasoningIdFromDetails(chunk.reasoning_details);
    const text = messageText(chunk);
    const hasOpaque =
      Boolean(chunk.signature) ||
      Boolean(chunk.redactedThinking) ||
      Boolean(chunk.reasoning_details?.length) ||
      Object.keys(metadata).length > 0;

    if (!reasoningId && !text && !hasOpaque) {
      return [];
    }

    const ensured = this.ensureItem(
      "reasoning",
      reasoningId ?? this.activeReasoningId,
    );
    const item = ensured.item as BufferedReasoning;
    this.activeReasoningId = item.id;
    mergeMetadata(item.metadata, metadata);

    const events = ensured.added ? [ensured.added] : [];
    const delta = appendDelta(item.text, text);
    if (delta) {
      item.text += delta;
      events.push(
        this.event({
          type: "reasoning.delta",
          itemId: item.id,
          delta,
        }),
      );
    }

    this.mergeThinkingContinuation(item, chunk);
    return events;
  }

  private mergeThinkingContinuation(
    item: BufferedReasoning,
    chunk: ContinueThinkingMessage,
  ): void {
    if (chunk.signature) {
      item.signature += appendDelta(
        item.signature,
        chunk.signature,
      );
    }
    if (chunk.redactedThinking) {
      item.redactedThinking = chunk.redactedThinking;
    }
    mergeReasoningDetails(
      item.reasoningDetails,
      chunk.reasoning_details,
    );
  }

  private ensureItem(
    type: BufferedItem["type"],
    preferredId?: string,
  ): { item: BufferedItem; added?: AgentRunEvent } {
    let id = preferredId?.trim() || this.createLocalId(type);
    const existing = this.items.get(id);
    if (existing?.type === type) {
      return { item: existing };
    }
    if (existing) {
      id = this.createLocalId(type);
    }

    const item = createBufferedItem(type, id);
    this.items.set(id, item);
    this.order.push(id);
    return {
      item,
      added: this.event({
        type: "output_item.added",
        item: { id, type },
      }),
    };
  }

  private createLocalId(type: BufferedItem["type"]): string {
    this.localItemSequence += 1;
    return `continue-${type}-${this.sequence + 1}-${this.localItemSequence}`;
  }
}

function createBufferedItem(
  type: BufferedItem["type"],
  id: string,
): BufferedItem {
  if (type === "message") {
    return {
      id,
      type,
      text: "",
      metadata: {},
    };
  }
  if (type === "reasoning") {
    return {
      id,
      type,
      text: "",
      signature: "",
      reasoningDetails: [],
      metadata: {},
    };
  }
  return {
    id,
    type,
    callId: "",
    name: "",
    argumentsText: "",
    metadata: {},
  };
}

export function describeContinueAgentModel(
  llm: ContinueAgentLlm,
): ContinueAgentModelCapabilities {
  const providerName = effectiveProviderName(llm);
  const normalizedProvider = providerName.toLowerCase();
  return {
    providerName,
    model: llm.completionOptions.model,
    contextLimitTokens: llm.contextLength,
    outputLimitTokens: llm.completionOptions.maxTokens,
    supportsTools: llm.capabilities?.tools !== false,
    supportsStreaming: true,
    reasoningContinuation:
      normalizedProvider === "openai" ||
      normalizedProvider === "azure" ||
      normalizedProvider === "anthropic"
        ? "provider_native"
        : "unknown",
    estimator: createContinueAgentContextEstimator(llm),
  };
}

export function createContinueAgentContextEstimator(
  llm: ContinueAgentLlm,
): AgentContextEstimator {
  return {
    id: `continue:${effectiveProviderName(llm)}:${llm.completionOptions.model}`,
    version: CONTINUE_ESTIMATOR_VERSION,
    accuracy: "estimated",
    estimateInputTokens(input) {
      return llm.countTokens(JSON.stringify(input));
    },
    estimateToolDefinitionTokens(tools) {
      return tools.length === 0
        ? 0
        : llm.countTokens(JSON.stringify(tools));
    },
    estimateContinuationOverheadTokens() {
      return 0;
    },
  };
}

export function agentInputToContinueMessage(
  input: AgentModelInputItem,
): ChatMessage {
  if (input.type === "message") {
    return {
      role: input.role,
      content: input.content,
    };
  }

  if (input.type === "tool_result") {
    return {
      role: "tool",
      toolCallId: input.callId,
      content:
        input.status === "success"
          ? JSON.stringify(input.output)
          : JSON.stringify({ error: input.error }),
      metadata: {
        agentToolCallItemId: input.toolCallItemId,
        agentToolName: input.name,
        agentToolResultStatus: input.status,
      },
    };
  }

  const item = input.item;
  const metadata = continueMetadataFromProviderMetadata(
    item.providerMetadata,
  );

  if (item.type === "message") {
    return {
      role: "assistant",
      content: item.content,
      ...(metadata ? { metadata } : {}),
    };
  }

  if (item.type === "tool_call") {
    return {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: item.callId,
          type: "function",
          function: {
            name: item.name,
            arguments: JSON.stringify(item.input),
          },
        },
      ],
      ...(metadata ? { metadata } : {}),
    };
  }

  const opaque = readRecord(item.opaque);
  const continuation = opaque
    ? readRecord(opaque[CONTINUE_METADATA_KEY])
    : undefined;
  const signature = readString(continuation?.signature);
  const redactedThinking = readString(
    continuation?.redactedThinking,
  );
  let reasoningDetails = readRecordArray(
    continuation?.reasoningDetails,
  );
  const opaqueMetadata = readRecord(continuation?.metadata);
  const authoritative =
    authoritativeItemFromProviderMetadata(item.providerMetadata) ??
    (readString(opaque?.type) === "reasoning" ? opaque : undefined);

  if (reasoningDetails.length === 0 && authoritative) {
    reasoningDetails =
      reasoningDetailsFromAuthoritative(authoritative);
  }

  const authoritativeMetadata = authoritative
    ? {
        ...(readString(authoritative.id)
          ? { reasoningId: readString(authoritative.id) }
          : {}),
        ...(readString(authoritative.encrypted_content)
          ? {
              encrypted_content: readString(
                authoritative.encrypted_content,
              ),
            }
          : {}),
      }
    : undefined;

  return {
    role: "thinking",
    content: item.text ?? "",
    ...(signature ? { signature } : {}),
    ...(redactedThinking ? { redactedThinking } : {}),
    ...(reasoningDetails.length > 0
      ? { reasoning_details: reasoningDetails }
      : {}),
    ...(opaqueMetadata || metadata || authoritativeMetadata
      ? {
          metadata: {
            ...(metadata ?? {}),
            ...(opaqueMetadata ?? {}),
            ...(authoritativeMetadata ?? {}),
          },
        }
      : {}),
  };
}

export function agentToolToContinueTool(
  tool: AgentModelToolDefinition,
): Tool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters:
        cloneRecord(tool.inputSchema) ?? {
          type: "object",
          properties: {},
        },
    },
    displayTitle: tool.name,
    readonly: false,
    group: "agent",
  };
}

interface NormalizeStopReasonOptions {
  readonly rawStopReason?: string;
  readonly responsesTerminalEvent?: string;
  readonly responsesIncompleteReason?: string;
  readonly hasToolCalls: boolean;
}

export function normalizeProviderStopReason(
  options: NormalizeStopReasonOptions,
): AgentStopReason {
  if (options.responsesTerminalEvent === "response.failed") {
    return "error";
  }
  if (
    options.responsesTerminalEvent === "response.cancelled" ||
    options.responsesTerminalEvent === "response.canceled"
  ) {
    return "cancelled";
  }
  if (options.responsesTerminalEvent === "response.incomplete") {
    return options.responsesIncompleteReason === "max_output_tokens"
      ? "max_tokens"
      : "unknown";
  }

  const raw = options.rawStopReason?.trim();
  if (raw && isAgentStopReason(raw)) {
    return raw;
  }

  switch (raw) {
    case "stop":
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_calls":
    case "function_call":
    case "tool_use":
      return "tool_use";
    case "length":
    case "max_tokens":
    case "max_output_tokens":
      return "max_tokens";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "error":
      return "error";
    case "completed":
      return options.hasToolCalls ? "tool_use" : "end_turn";
    default:
      if (
        options.responsesTerminalEvent === "response.completed"
      ) {
        return options.hasToolCalls ? "tool_use" : "end_turn";
      }
      return "unknown";
  }
}

function completeBufferedItem(
  buffered: BufferedItem,
  llm: ContinueAgentLlm,
): CanonicalCompletionResult {
  if (buffered.authoritative) {
    return completeAuthoritativeItem(buffered, llm);
  }

  const providerMetadata = buildProviderMetadata(
    llm,
    buffered.metadata,
  );

  if (buffered.type === "message") {
    return {
      item: {
        id: buffered.id,
        type: "message",
        role: "assistant",
        content: buffered.text,
        ...(providerMetadata ? { providerMetadata } : {}),
      },
    };
  }

  if (buffered.type === "reasoning") {
    const opaquePayload: Record<string, unknown> = {};
    if (buffered.signature) {
      opaquePayload.signature = buffered.signature;
    }
    if (buffered.redactedThinking) {
      opaquePayload.redactedThinking =
        buffered.redactedThinking;
    }
    if (buffered.reasoningDetails.length > 0) {
      opaquePayload.reasoningDetails =
        buffered.reasoningDetails;
    }
    if (Object.keys(buffered.metadata).length > 0) {
      opaquePayload.metadata = buffered.metadata;
    }
    const opaque = toJsonValue({
      [CONTINUE_METADATA_KEY]: opaquePayload,
    });

    return {
      item: {
        id: buffered.id,
        type: "reasoning",
        ...(buffered.text ? { text: buffered.text } : {}),
        ...(opaque !== undefined ? { opaque } : {}),
        ...(providerMetadata ? { providerMetadata } : {}),
      },
    };
  }

  const parsed = parseToolArguments(buffered.argumentsText);
  if (parsed.error) {
    return { error: parsed.error };
  }

  return {
    item: {
      id: buffered.id,
      type: "tool_call",
      callId: buffered.callId,
      name: buffered.name,
      input: parsed.value ?? {},
      ...(providerMetadata ? { providerMetadata } : {}),
    },
  };
}

function completeAuthoritativeItem(
  buffered: BufferedItem,
  llm: ContinueAgentLlm,
): CanonicalCompletionResult {
  const raw = buffered.authoritative!;
  const rawType = readString(raw.type);
  const id = readString(raw.id) ?? buffered.id;
  const providerMetadata = buildProviderMetadata(
    llm,
    buffered.metadata,
    raw,
  );

  if (rawType === "message") {
    return {
      item: {
        id,
        type: "message",
        role: "assistant",
        content: textFromResponseMessage(raw),
        ...(providerMetadata ? { providerMetadata } : {}),
      },
    };
  }

  if (rawType === "reasoning") {
    const text = textFromResponseReasoning(raw);
    const opaque = toJsonValue(raw);
    return {
      item: {
        id,
        type: "reasoning",
        ...(text ? { text } : {}),
        ...(opaque !== undefined ? { opaque } : {}),
        ...(providerMetadata ? { providerMetadata } : {}),
      },
    };
  }

  if (rawType === "function_call") {
    const callId =
      readString(raw.call_id) ??
      (buffered.type === "tool_call"
        ? buffered.callId
        : "");
    const name =
      readString(raw.name) ??
      (buffered.type === "tool_call" ? buffered.name : "");
    const rawArguments = raw.arguments;
    const argumentsText =
      typeof rawArguments === "string"
        ? rawArguments
        : JSON.stringify(rawArguments ?? {});
    const parsed = parseToolArguments(argumentsText);
    if (parsed.error) {
      return { error: parsed.error };
    }
    return {
      item: {
        id,
        type: "tool_call",
        callId,
        name,
        input: parsed.value ?? {},
        ...(providerMetadata ? { providerMetadata } : {}),
      },
    };
  }

  return {
    error: {
      code: "unsupported_provider_output_item",
      message: `Unsupported completed provider output item type: ${rawType ?? "unknown"}`,
    },
  };
}

function parseToolArguments(
  argumentsText: string,
): {
  value?: JsonValue;
  error?: { code: string; message: string };
} {
  if (!argumentsText.trim()) {
    return { value: {} };
  }
  try {
    return {
      value: JSON.parse(argumentsText) as JsonValue,
    };
  } catch {
    return {
      error: {
        code: "invalid_tool_arguments",
        message:
          "Provider completed a tool call with invalid JSON arguments",
      },
    };
  }
}

function buildProviderMetadata(
  llm: ContinueAgentLlm,
  metadata: Record<string, unknown>,
  authoritative?: Record<string, unknown>,
): JsonObject | undefined {
  const payload: Record<string, unknown> = {
    provider: effectiveProviderName(llm),
  };
  if (llm.lastRequestId) {
    payload.responseId = llm.lastRequestId;
  }
  if (Object.keys(metadata).length > 0) {
    payload.metadata = metadata;
  }
  if (authoritative) {
    payload.authoritativeItem = authoritative;
  }
  const safe = toJsonValue({
    [CONTINUE_METADATA_KEY]: payload,
  });
  return isJsonObject(safe) ? safe : undefined;
}

function continueMetadataFromProviderMetadata(
  metadata: JsonObject | undefined,
): Record<string, unknown> | undefined {
  const bridge = metadata
    ? readRecord(metadata[CONTINUE_METADATA_KEY])
    : undefined;
  return readRecord(bridge?.metadata);
}

function authoritativeItemFromProviderMetadata(
  metadata: JsonObject | undefined,
): Record<string, unknown> | undefined {
  const bridge = metadata
    ? readRecord(metadata[CONTINUE_METADATA_KEY])
    : undefined;
  return readRecord(bridge?.authoritativeItem);
}

function reasoningDetailsFromAuthoritative(
  item: Record<string, unknown>,
): Record<string, unknown>[] {
  const details: Record<string, unknown>[] = [];
  const id = readString(item.id);
  if (id) {
    details.push({ type: "reasoning_id", id });
  }
  const encrypted = readString(item.encrypted_content);
  if (encrypted) {
    details.push({
      type: "encrypted_content",
      encrypted_content: encrypted,
    });
  }
  if (Array.isArray(item.summary)) {
    for (const part of item.summary) {
      const record = readRecord(part);
      const text = readString(record?.text);
      if (record?.type === "summary_text" && text) {
        details.push({ type: "summary_text", text });
      }
    }
  }
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      const record = readRecord(part);
      const text = readString(record?.text);
      if (record?.type === "reasoning_text" && text) {
        details.push({ type: "reasoning_text", text });
      }
    }
  }
  return details;
}

function effectiveProviderName(
  llm: ContinueAgentLlm,
): string {
  return (
    llm.underlyingProviderName?.trim() ||
    llm.providerName.trim() ||
    "unknown"
  );
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function textFromResponseMessage(
  item: Record<string, unknown>,
): string {
  const content = item.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const record = readRecord(part);
      return readString(record?.text) ?? "";
    })
    .join("");
}

function textFromResponseReasoning(
  item: Record<string, unknown>,
): string {
  const contentText = textFromResponseMessage(item);
  if (contentText) {
    return contentText;
  }
  const summary = item.summary;
  if (!Array.isArray(summary)) {
    return "";
  }
  return summary
    .map((part) => {
      const record = readRecord(part);
      return readString(record?.text) ?? "";
    })
    .join("");
}

function appendDelta(existing: string, incoming: string): string {
  if (!incoming) {
    return "";
  }
  if (!existing) {
    return incoming;
  }
  if (incoming === existing || existing.endsWith(incoming)) {
    return "";
  }
  if (incoming.startsWith(existing)) {
    return incoming.slice(existing.length);
  }
  return incoming;
}

function mergeReasoningDetails(
  target: Record<string, unknown>[],
  incoming:
    | {
        signature?: string;
        [key: string]: unknown;
      }[]
    | undefined,
): void {
  if (!incoming) {
    return;
  }

  for (const detail of incoming) {
    const type = readString(detail.type);
    if (!type) {
      target.push({ ...detail });
      continue;
    }
    const existing = target.find(
      (candidate) => readString(candidate.type) === type,
    );
    if (!existing) {
      target.push({ ...detail });
      continue;
    }

    for (const [key, value] of Object.entries(detail)) {
      if (value === undefined || value === null || key === "type") {
        continue;
      }
      if (
        typeof value === "string" &&
        (key === "text" ||
          key === "signature" ||
          key === "summary")
      ) {
        const current =
          typeof existing[key] === "string"
            ? (existing[key] as string)
            : "";
        existing[key] = current + appendDelta(current, value);
      } else {
        existing[key] = value;
      }
    }
  }
}

function reasoningIdFromDetails(
  details:
    | {
        signature?: string;
        [key: string]: unknown;
      }[]
    | undefined,
): string | undefined {
  for (const detail of details ?? []) {
    if (detail.type === "reasoning_id") {
      const id = readString(detail.id);
      if (id) {
        return id;
      }
    }
  }
  return undefined;
}

function mergeMetadata(
  target: Record<string, unknown>,
  metadata: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

function readRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRecordArray(
  value: unknown,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(readRecord)
    .filter(
      (
        record,
      ): record is Record<string, unknown> => record !== undefined,
    );
}

function readNumberArray(value: unknown): (number | undefined)[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) =>
    Number.isSafeInteger(item) ? (item as number) : undefined,
  );
}

function cloneRecord(
  value: JsonObject | undefined,
): Record<string, unknown> | undefined {
  const cloned = toJsonValue(value);
  return isJsonObject(cloned)
    ? ({ ...cloned } as Record<string, unknown>)
    : undefined;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? undefined
      : (JSON.parse(serialized) as JsonValue);
  } catch {
    return undefined;
  }
}

function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerFailureMessage(error: unknown): string {
  const record = readRecord(error);
  const nested = readRecord(record?.error);
  return (
    readString(record?.message) ??
    readString(nested?.message) ??
    "Provider reported a failed response"
  );
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : signal.reason !== undefined
      ? String(signal.reason)
      : "cancelled";
}
