import type {
  AgentRunError,
  AgentRunEvent,
  AgentStopReason,
  JsonObject,
} from "./protocol";
import {
  createInitialAgentRunState,
  getExecutableToolCalls,
  getLatestAgentResponse,
  reduceAgentRunEvent,
  type AgentRunState,
} from "./reducer";
import {
  createAgentToolResult,
  type AgentModelDriver,
  type AgentModelInputItem,
  type AgentModelRequest,
  type AgentModelToolDefinition,
  type AgentToolExecutionOutcome,
  type AgentToolExecutor,
} from "./model";

export const DEFAULT_AGENT_LOOP_MAX_ITERATIONS = 32;

export type AgentLoopStatus =
  | "completed"
  | "cancelled"
  | "failed"
  | "max_tokens"
  | "iteration_limit";

export type AgentLoopFailureCode =
  | "driver_error"
  | "driver_ended_without_terminal_event"
  | "protocol_error"
  | "observer_error"
  | "invalid_terminal_state"
  | "tool_use_without_executable_calls"
  | "tool_executor_missing"
  | "tool_executor_error"
  | "model_error"
  | "unknown_stop_reason";

export interface AgentLoopResult {
  status: AgentLoopStatus;
  state: AgentRunState;
  input: readonly AgentModelInputItem[];
  iterations: number;
  stopReason?: AgentStopReason;
  error?: AgentRunError;
}

export interface AgentLoopOptions {
  driver: AgentModelDriver;
  input: readonly AgentModelInputItem[];
  toolExecutor?: AgentToolExecutor;
  tools?: readonly AgentModelToolDefinition[];
  metadata?: JsonObject;
  signal?: AbortSignal;
  maxIterations?: number;
  onEvent?: (
    event: AgentRunEvent,
    state: Readonly<AgentRunState>,
  ) => void | Promise<void>;
}

interface StreamTerminalResult {
  kind: "terminal";
  state: AgentRunState;
  responseId?: string;
}

interface StreamCancelledResult {
  kind: "cancelled";
  state: AgentRunState;
}

interface StreamFailedResult {
  kind: "failed";
  state: AgentRunState;
  error: AgentRunError;
}

type StreamResult =
  | StreamTerminalResult
  | StreamCancelledResult
  | StreamFailedResult;

interface ToolContinueResult {
  kind: "continue";
}

interface ToolCancelledResult {
  kind: "cancelled";
}

interface ToolFailedResult {
  kind: "failed";
  error: AgentRunError;
}

type ToolRoundResult =
  | ToolContinueResult
  | ToolCancelledResult
  | ToolFailedResult;

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const maxIterations = resolveMaxIterations(options.maxIterations);
  const signal = options.signal ?? new AbortController().signal;
  let state = createInitialAgentRunState();
  const input: AgentModelInputItem[] = [...options.input];
  let iterations = 0;

  if (signal.aborted) {
    return buildLoopResult(
      "cancelled",
      state,
      input,
      iterations,
      "cancelled",
    );
  }

  while (iterations < maxIterations) {
    if (signal.aborted) {
      return buildLoopResult(
        "cancelled",
        state,
        input,
        iterations,
        "cancelled",
      );
    }

    iterations += 1;
    const streamed = await consumeOneModelResponse(
      options,
      state,
      input,
      signal,
    );
    state = streamed.state;

    if (streamed.kind === "cancelled") {
      return buildLoopResult(
        "cancelled",
        state,
        input,
        iterations,
        "cancelled",
      );
    }
    if (streamed.kind === "failed") {
      return buildLoopResult(
        "failed",
        state,
        input,
        iterations,
        "error",
        streamed.error,
      );
    }

    if (signal.aborted) {
      return buildLoopResult(
        "cancelled",
        state,
        input,
        iterations,
        "cancelled",
      );
    }

    const response = getLatestAgentResponse(state);
    if (
      !response ||
      (streamed.responseId && response.responseId !== streamed.responseId)
    ) {
      return buildLoopResult(
        "failed",
        state,
        input,
        iterations,
        "error",
        loopError(
          "invalid_terminal_state",
          "Terminal model event did not produce the expected canonical response state",
        ),
      );
    }

    if (response.status === "aborted") {
      return buildLoopResult(
        "cancelled",
        state,
        input,
        iterations,
        "cancelled",
      );
    }
    if (response.status === "failed") {
      return buildLoopResult(
        "failed",
        state,
        input,
        iterations,
        "error",
        response.error ??
          loopError(
            "model_error",
            "Model response failed without a canonical error payload",
          ),
      );
    }
    if (response.status !== "completed" || !response.stopReason) {
      return buildLoopResult(
        "failed",
        state,
        input,
        iterations,
        "error",
        loopError(
          "invalid_terminal_state",
          "Terminal model response did not resolve to a completed stop reason",
        ),
      );
    }

    appendCompletedModelOutput(input, response.outputItems);

    if (response.stopReason !== "tool_use") {
      return finishNonToolStop(
        response.stopReason,
        state,
        input,
        iterations,
      );
    }

    const toolRound = await executeToolRound(
      options.toolExecutor,
      state,
      input,
      response.responseId,
      iterations,
      signal,
    );
    if (toolRound.kind === "cancelled") {
      return buildLoopResult(
        "cancelled",
        state,
        input,
        iterations,
        "cancelled",
      );
    }
    if (toolRound.kind === "failed") {
      return buildLoopResult(
        "failed",
        state,
        input,
        iterations,
        "tool_use",
        toolRound.error,
      );
    }
  }

  return buildLoopResult(
    "iteration_limit",
    state,
    input,
    iterations,
  );
}

function resolveMaxIterations(value: number | undefined): number {
  const maxIterations = value ?? DEFAULT_AGENT_LOOP_MAX_ITERATIONS;
  if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0) {
    throw new RangeError(
      "AgentLoop maxIterations must be a positive safe integer",
    );
  }
  return maxIterations;
}

async function consumeOneModelResponse(
  options: AgentLoopOptions,
  initialState: AgentRunState,
  input: readonly AgentModelInputItem[],
  signal: AbortSignal,
): Promise<StreamResult> {
  let state = initialState;
  let responseId: string | undefined;

  const request: AgentModelRequest = {
    runState: state,
    input: [...input],
    tools: options.tools,
    metadata: options.metadata,
  };

  try {
    for await (const event of options.driver.stream(request, signal)) {
      const reduced = applyCanonicalEvent(state, event);
      if (reduced.kind === "failed") {
        return reduced;
      }
      state = reduced.state;

      const envelopeError = validateSingleResponseEvent(responseId, event);
      if (envelopeError) {
        return {
          kind: "failed",
          state,
          error: envelopeError,
        };
      }
      if (event.type === "response.started") {
        responseId = event.responseId;
      }

      const observerError = await publishObservedEvent(
        options.onEvent,
        event,
        state,
      );
      if (observerError) {
        return {
          kind: "failed",
          state,
          error: observerError,
        };
      }

      if (isTerminalEvent(event)) {
        return {
          kind: "terminal",
          state,
          responseId,
        };
      }
      if (signal.aborted) {
        return { kind: "cancelled", state };
      }
    }
  } catch (error) {
    if (signal.aborted) {
      return { kind: "cancelled", state };
    }
    return {
      kind: "failed",
      state,
      error: loopError(
        "driver_error",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }

  if (signal.aborted) {
    return { kind: "cancelled", state };
  }
  return {
    kind: "failed",
    state,
    error: loopError(
      "driver_ended_without_terminal_event",
      "Model driver stream ended without a terminal canonical response event",
    ),
  };
}

function applyCanonicalEvent(
  state: AgentRunState,
  event: AgentRunEvent,
): { kind: "applied"; state: AgentRunState } | StreamFailedResult {
  try {
    return {
      kind: "applied",
      state: reduceAgentRunEvent(state, event),
    };
  } catch (error) {
    return {
      kind: "failed",
      state,
      error: loopError(
        "protocol_error",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

function validateSingleResponseEvent(
  responseId: string | undefined,
  event: AgentRunEvent,
): AgentRunError | undefined {
  if (
    event.type === "response.started" &&
    responseId &&
    responseId !== event.responseId
  ) {
    return loopError(
      "protocol_error",
      "A single model driver call attempted to start multiple responses",
    );
  }
  if (
    event.type !== "response.started" &&
    responseId &&
    event.responseId !== responseId
  ) {
    return loopError(
      "protocol_error",
      "A single model driver call emitted events for multiple responses",
    );
  }
  return undefined;
}

async function publishObservedEvent(
  observer: AgentLoopOptions["onEvent"],
  event: AgentRunEvent,
  state: AgentRunState,
): Promise<AgentRunError | undefined> {
  if (!observer) {
    return undefined;
  }

  try {
    await observer(event, state);
    return undefined;
  } catch (error) {
    return loopError(
      "observer_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function isTerminalEvent(event: AgentRunEvent): boolean {
  return (
    event.type === "response.completed" ||
    event.type === "response.aborted" ||
    event.type === "response.failed"
  );
}

function appendCompletedModelOutput(
  input: AgentModelInputItem[],
  outputItems: AgentRunState["responses"][number]["outputItems"],
): void {
  for (const item of outputItems) {
    if (item.status === "completed" && item.completedItem) {
      input.push({
        type: "model_output",
        item: item.completedItem,
      });
    }
  }
}

function finishNonToolStop(
  stopReason: Exclude<AgentStopReason, "tool_use">,
  state: AgentRunState,
  input: readonly AgentModelInputItem[],
  iterations: number,
): AgentLoopResult {
  switch (stopReason) {
    case "end_turn":
      return buildLoopResult(
        "completed",
        state,
        input,
        iterations,
        "end_turn",
      );
    case "cancelled":
      return buildLoopResult(
        "cancelled",
        state,
        input,
        iterations,
        "cancelled",
      );
    case "error":
      return buildLoopResult(
        "failed",
        state,
        input,
        iterations,
        "error",
        loopError("model_error", "Model completed with stop reason error"),
      );
    case "max_tokens":
      return buildLoopResult(
        "max_tokens",
        state,
        input,
        iterations,
        "max_tokens",
      );
    case "unknown":
      return buildLoopResult(
        "failed",
        state,
        input,
        iterations,
        "unknown",
        loopError(
          "unknown_stop_reason",
          "Model completed with an unknown normalized stop reason",
        ),
      );
  }
}

async function executeToolRound(
  toolExecutor: AgentToolExecutor | undefined,
  state: AgentRunState,
  input: AgentModelInputItem[],
  responseId: string,
  iteration: number,
  signal: AbortSignal,
): Promise<ToolRoundResult> {
  const toolCalls = getExecutableToolCalls(state, responseId);
  if (toolCalls.length === 0) {
    return {
      kind: "failed",
      error: loopError(
        "tool_use_without_executable_calls",
        "Model requested tool use but no canonical completed tool calls were executable",
      ),
    };
  }
  if (!toolExecutor) {
    return {
      kind: "failed",
      error: loopError(
        "tool_executor_missing",
        "Model requested tool use but no tool execution boundary was provided",
      ),
    };
  }

  for (const toolCall of toolCalls) {
    if (signal.aborted) {
      return { kind: "cancelled" };
    }

    let outcome: AgentToolExecutionOutcome;
    try {
      outcome = await toolExecutor.execute(toolCall, {
        signal,
        iteration,
        state,
      });
    } catch (error) {
      if (signal.aborted) {
        return { kind: "cancelled" };
      }
      return {
        kind: "failed",
        error: loopError(
          "tool_executor_error",
          error instanceof Error ? error.message : String(error),
        ),
      };
    }

    input.push(createAgentToolResult(toolCall, outcome));
    if (signal.aborted) {
      return { kind: "cancelled" };
    }
  }

  return { kind: "continue" };
}

function buildLoopResult(
  status: AgentLoopStatus,
  state: AgentRunState,
  input: readonly AgentModelInputItem[],
  iterations: number,
  stopReason?: AgentStopReason,
  error?: AgentRunError,
): AgentLoopResult {
  return {
    status,
    state,
    input: [...input],
    iterations,
    stopReason,
    error,
  };
}

function loopError(
  code: AgentLoopFailureCode,
  message: string,
): AgentRunError {
  return { code, message };
}
