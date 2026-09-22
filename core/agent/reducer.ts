import {
  AgentMessageItem,
  AgentOutputItem,
  AgentOutputItemType,
  AgentReasoningItem,
  AgentRunError,
  AgentRunEvent,
  AgentStopReason,
  AgentToolCallItem,
  isExecutableToolCallItem,
} from "./protocol";

export type AgentOutputItemStateStatus =
  | "in_progress"
  | "completed"
  | "interrupted";

interface AgentOutputItemStateBase {
  id: string;
  status: AgentOutputItemStateStatus;
}

export interface AgentMessageItemState extends AgentOutputItemStateBase {
  type: "message";
  text: string;
  completedItem?: AgentMessageItem;
}

export interface AgentReasoningItemState extends AgentOutputItemStateBase {
  type: "reasoning";
  text: string;
  completedItem?: AgentReasoningItem;
}

export interface AgentToolCallItemState extends AgentOutputItemStateBase {
  type: "tool_call";
  callId: string;
  name: string;
  argumentsText: string;
  completedItem?: AgentToolCallItem;
}

export type AgentOutputItemState =
  | AgentMessageItemState
  | AgentReasoningItemState
  | AgentToolCallItemState;

export type AgentResponseStatus =
  | "streaming"
  | "completed"
  | "aborted"
  | "failed";

export interface AgentResponseState {
  responseId: string;
  status: AgentResponseStatus;
  stopReason?: AgentStopReason;
  abortReason?: string;
  error?: AgentRunError;
  outputItems: readonly AgentOutputItemState[];
}

export interface AppliedAgentEventRef {
  eventId: string;
  sequence: number;
}

export interface AgentRunState {
  responses: readonly AgentResponseState[];
  activeResponseId?: string;
  lastSequence: number;
  appliedEvents: readonly AppliedAgentEventRef[];
}

export class AgentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

export function createInitialAgentRunState(): AgentRunState {
  return {
    responses: [],
    lastSequence: 0,
    appliedEvents: [],
  };
}

export function reduceAgentRunEvents(
  initialState: AgentRunState,
  events: readonly AgentRunEvent[],
): AgentRunState {
  return events.reduce(reduceAgentRunEvent, initialState);
}

export function reduceAgentRunEvent(
  state: AgentRunState,
  event: AgentRunEvent,
): AgentRunState {
  validateBasicEventEnvelope(event);

  const duplicate = state.appliedEvents.find(
    (applied) => applied.eventId === event.eventId,
  );
  if (duplicate) {
    if (duplicate.sequence !== event.sequence) {
      throw new AgentProtocolError(
        `Duplicate event id ${event.eventId} changed sequence from ${duplicate.sequence} to ${event.sequence}`,
      );
    }
    return state;
  }

  if (event.sequence <= state.lastSequence) {
    throw new AgentProtocolError(
      `Out-of-order event ${event.eventId}: sequence ${event.sequence} must be greater than ${state.lastSequence}`,
    );
  }

  validateEventLifecycle(state, event);

  let nextState: AgentRunState;

  if (event.type === "response.started") {
    nextState = reduceResponseStarted(state, event);
  } else {
    nextState = reduceActiveResponseEvent(state, event);
  }

  return {
    ...nextState,
    lastSequence: event.sequence,
    appliedEvents: [
      ...nextState.appliedEvents,
      { eventId: event.eventId, sequence: event.sequence },
    ],
  };
}

export function getLatestAgentResponse(
  state: AgentRunState,
): AgentResponseState | undefined {
  return state.responses.at(-1);
}

export function getExecutableToolCalls(
  state: AgentRunState,
  responseId?: string,
): readonly AgentToolCallItem[] {
  const response = responseId
    ? state.responses.find((candidate) => candidate.responseId === responseId)
    : getLatestAgentResponse(state);

  if (!response) {
    return [];
  }

  return response.outputItems.flatMap((item) => {
    if (
      item.type !== "tool_call" ||
      item.status !== "completed" ||
      !item.completedItem ||
      !isExecutableToolCallItem(item.completedItem)
    ) {
      return [];
    }
    return [item.completedItem];
  });
}

function validateBasicEventEnvelope(event: AgentRunEvent): void {
  if (!event.eventId.trim()) {
    throw new AgentProtocolError("Agent event id must be non-empty");
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
    throw new AgentProtocolError(
      `Agent event sequence must be a positive safe integer: ${event.sequence}`,
    );
  }
  if (!event.responseId.trim()) {
    throw new AgentProtocolError("Agent response id must be non-empty");
  }
}

function validateEventLifecycle(
  state: AgentRunState,
  event: AgentRunEvent,
): void {
  if (event.type === "response.started") {
    if (state.activeResponseId) {
      throw new AgentProtocolError(
        `Cannot start response ${event.responseId} while ${state.activeResponseId} is still streaming`,
      );
    }
    if (
      state.responses.some((response) => response.responseId === event.responseId)
    ) {
      throw new AgentProtocolError(
        `Response ${event.responseId} has already been started`,
      );
    }
    return;
  }

  if (!state.activeResponseId) {
    throw new AgentProtocolError(
      `Event ${event.type} arrived without an active response`,
    );
  }
  if (event.responseId !== state.activeResponseId) {
    throw new AgentProtocolError(
      `Event ${event.type} targets response ${event.responseId}, but ${state.activeResponseId} is active`,
    );
  }
}

function reduceResponseStarted(
  state: AgentRunState,
  event: Extract<AgentRunEvent, { type: "response.started" }>,
): AgentRunState {
  return {
    ...state,
    responses: [
      ...state.responses,
      {
        responseId: event.responseId,
        status: "streaming",
        outputItems: [],
      },
    ],
    activeResponseId: event.responseId,
  };
}

function reduceActiveResponseEvent(
  state: AgentRunState,
  event: Exclude<AgentRunEvent, { type: "response.started" }>,
): AgentRunState {
  const responseIndex = state.responses.findIndex(
    (response) => response.responseId === event.responseId,
  );
  if (responseIndex < 0) {
    throw new AgentProtocolError(
      `Active response ${event.responseId} is missing from run state`,
    );
  }

  const response = state.responses[responseIndex];
  if (response.status !== "streaming") {
    throw new AgentProtocolError(
      `Response ${event.responseId} is already ${response.status}`,
    );
  }

  let nextResponse = response;
  let activeResponseId = state.activeResponseId;

  switch (event.type) {
    case "output_item.added":
      nextResponse = {
        ...response,
        outputItems: addOutputItem(response.outputItems, event.item),
      };
      break;

    case "content.delta":
      nextResponse = {
        ...response,
        outputItems: updateItem(
          response.outputItems,
          event.itemId,
          "message",
          (item) => ({ ...item, text: item.text + event.delta }),
        ),
      };
      break;

    case "reasoning.delta":
      nextResponse = {
        ...response,
        outputItems: updateItem(
          response.outputItems,
          event.itemId,
          "reasoning",
          (item) => ({ ...item, text: item.text + event.delta }),
        ),
      };
      break;

    case "tool_call.delta":
      nextResponse = {
        ...response,
        outputItems: updateItem(
          response.outputItems,
          event.itemId,
          "tool_call",
          (item) => ({
            ...item,
            callId: item.callId + (event.callIdDelta ?? ""),
            name: item.name + (event.nameDelta ?? ""),
            argumentsText:
              item.argumentsText + (event.argumentsDelta ?? ""),
          }),
        ),
      };
      break;

    case "output_item.completed":
      nextResponse = {
        ...response,
        outputItems: completeOutputItem(response.outputItems, event.item),
      };
      break;

    case "response.completed":
      nextResponse = {
        ...response,
        status: "completed",
        stopReason: event.stopReason,
        outputItems: interruptIncompleteItems(response.outputItems),
      };
      activeResponseId = undefined;
      break;

    case "response.aborted":
      nextResponse = {
        ...response,
        status: "aborted",
        stopReason: "cancelled",
        abortReason: event.reason,
        outputItems: interruptIncompleteItems(response.outputItems),
      };
      activeResponseId = undefined;
      break;

    case "response.failed":
      nextResponse = {
        ...response,
        status: "failed",
        stopReason: "error",
        error: event.error,
        outputItems: interruptIncompleteItems(response.outputItems),
      };
      activeResponseId = undefined;
      break;
  }

  const responses = [...state.responses];
  responses[responseIndex] = nextResponse;

  return {
    ...state,
    responses,
    activeResponseId,
  };
}

function addOutputItem(
  items: readonly AgentOutputItemState[],
  descriptor: { id: string; type: AgentOutputItemType },
): readonly AgentOutputItemState[] {
  if (!descriptor.id.trim()) {
    throw new AgentProtocolError("Output item id must be non-empty");
  }
  if (items.some((item) => item.id === descriptor.id)) {
    throw new AgentProtocolError(
      `Output item ${descriptor.id} has already been added`,
    );
  }

  const item: AgentOutputItemState = createOutputItemState(descriptor);
  return [...items, item];
}

function createOutputItemState(descriptor: {
  id: string;
  type: AgentOutputItemType;
}): AgentOutputItemState {
  switch (descriptor.type) {
    case "message":
      return {
        id: descriptor.id,
        type: "message",
        status: "in_progress",
        text: "",
      };
    case "reasoning":
      return {
        id: descriptor.id,
        type: "reasoning",
        status: "in_progress",
        text: "",
      };
    case "tool_call":
      return {
        id: descriptor.id,
        type: "tool_call",
        status: "in_progress",
        callId: "",
        name: "",
        argumentsText: "",
      };
  }
}

function updateItem<T extends AgentOutputItemType>(
  items: readonly AgentOutputItemState[],
  itemId: string,
  expectedType: T,
  updater: (
    item: Extract<AgentOutputItemState, { type: T }>,
  ) => Extract<AgentOutputItemState, { type: T }>,
): readonly AgentOutputItemState[] {
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) {
    throw new AgentProtocolError(`Output item ${itemId} has not been added`);
  }

  const item = items[index];
  if (item.type !== expectedType) {
    throw new AgentProtocolError(
      `Output item ${itemId} is ${item.type}, not ${expectedType}`,
    );
  }
  if (item.status !== "in_progress") {
    throw new AgentProtocolError(
      `Output item ${itemId} is already ${item.status}`,
    );
  }

  const next = [...items];
  next[index] = updater(
    item as Extract<AgentOutputItemState, { type: T }>,
  );
  return next;
}

function completeOutputItem(
  items: readonly AgentOutputItemState[],
  completedItem: AgentOutputItem,
): readonly AgentOutputItemState[] {
  const index = items.findIndex((item) => item.id === completedItem.id);
  if (index < 0) {
    throw new AgentProtocolError(
      `Completed output item ${completedItem.id} has not been added`,
    );
  }

  const draft = items[index];
  if (draft.type !== completedItem.type) {
    throw new AgentProtocolError(
      `Completed output item ${completedItem.id} changed type from ${draft.type} to ${completedItem.type}`,
    );
  }
  if (draft.status !== "in_progress") {
    throw new AgentProtocolError(
      `Output item ${completedItem.id} is already ${draft.status}`,
    );
  }

  let nextItem: AgentOutputItemState;
  switch (completedItem.type) {
    case "message":
      nextItem = {
        id: completedItem.id,
        type: "message",
        status: "completed",
        text: completedItem.content,
        completedItem,
      };
      break;
    case "reasoning":
      nextItem = {
        id: completedItem.id,
        type: "reasoning",
        status: "completed",
        text: completedItem.text ?? "",
        completedItem,
      };
      break;
    case "tool_call":
      nextItem = {
        id: completedItem.id,
        type: "tool_call",
        status: "completed",
        callId: completedItem.callId,
        name: completedItem.name,
        argumentsText: JSON.stringify(completedItem.input),
        completedItem,
      };
      break;
  }

  const next = [...items];
  next[index] = nextItem;
  return next;
}

function interruptIncompleteItems(
  items: readonly AgentOutputItemState[],
): readonly AgentOutputItemState[] {
  return items.map((item) =>
    item.status === "in_progress"
      ? { ...item, status: "interrupted" as const }
      : item,
  );
}
