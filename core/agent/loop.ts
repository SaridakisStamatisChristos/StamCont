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
import {
  AgentLifecycleError,
  appendAgentLifecycleState,
  appendAgentToolAttempt,
  initializeDurableAgentSession,
  prepareDurableAgentContext,
  type AgentDurableContextOptions,
  type AgentDurableResumeAnalysis,
} from "./lifecycle";
import type { AgentSessionStore } from "./persistence";

export const DEFAULT_AGENT_LOOP_MAX_ITERATIONS = 32;

export type AgentLoopStatus =
  | "completed"
  | "cancelled"
  | "failed"
  | "max_tokens"
  | "iteration_limit"
  | "resume_blocked";

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
  | "unknown_stop_reason"
  | "durability_error"
  | "context_compaction_required"
  | "context_overflow"
  | "ambiguous_tool_execution"
  | "incomplete_model_response"
  | "session_closed";

export interface AgentLoopResult {
  status: AgentLoopStatus;
  state: AgentRunState;
  input: readonly AgentModelInputItem[];
  iterations: number;
  stopReason?: AgentStopReason;
  error?: AgentRunError;
}

export interface AgentLoopDurabilityOptions {
  readonly store: AgentSessionStore;
  readonly context: AgentDurableContextOptions;
  readonly initialMetadata?: readonly JsonObject[];
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
  durability?: AgentLoopDurabilityOptions;
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

interface PreparedLoopRuntime {
  readonly state: AgentRunState;
  readonly input: AgentModelInputItem[];
  readonly logicalIteration: number;
  readonly pendingToolResponseId?: string;
  readonly immediateResult?: AgentLoopResult;
}

interface LoopExecutionResult {
  readonly result: AgentLoopResult;
  readonly logicalIteration: number;
}

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const prepared = await prepareLoopRuntime(options);
  if (prepared.immediateResult) {
    return prepared.immediateResult;
  }

  const executed = await runPreparedAgentLoop(options, prepared);
  return finalizeDurableLoopResult(
    options,
    executed.result,
    executed.logicalIteration,
  );
}

async function prepareLoopRuntime(
  options: AgentLoopOptions,
): Promise<PreparedLoopRuntime> {
  if (!options.durability) {
    return {
      state: createInitialAgentRunState(),
      input: [...options.input],
      logicalIteration: 0,
    };
  }

  const wasEmpty = options.durability.store.lastSequence === 0;
  let analysis: AgentDurableResumeAnalysis;
  try {
    analysis = await initializeDurableAgentSession(
      options.durability.store,
      options.input,
      options.durability.initialMetadata,
    );
  } catch (error) {
    const state = createInitialAgentRunState();
    return {
      state,
      input: [...options.input],
      logicalIteration: 0,
      immediateResult: buildLoopResult(
        "failed",
        state,
        options.input,
        0,
        "error",
        durabilityError(error),
      ),
    };
  }

  if (analysis.disposition === "terminal") {
    const result = resultFromDurableTerminal(analysis);
    if (!isPersistedTerminalState(analysis.lifecycleState)) {
      try {
        await persistTerminalAnalysis(
          options.durability.store,
          analysis,
        );
      } catch (error) {
        return {
          state: analysis.replay.runState,
          input: [...analysis.replay.input],
          logicalIteration: analysis.lastIteration,
          immediateResult: buildLoopResult(
            "failed",
            analysis.replay.runState,
            analysis.replay.input,
            0,
            "error",
            durabilityError(error),
          ),
        };
      }
    }
    return {
      state: analysis.replay.runState,
      input: [...analysis.replay.input],
      logicalIteration: analysis.lastIteration,
      immediateResult: result,
    };
  }

  if (analysis.disposition === "blocked") {
    if (
      analysis.lifecycleState !== "interrupted" &&
      analysis.lifecycleState !== "closed"
    ) {
      try {
        await appendAgentLifecycleState(
          options.durability.store,
          "interrupted",
          analysis.lastIteration,
          {
            reason:
              analysis.blockReason ??
              "durable resume requires reconciliation",
          },
        );
      } catch (error) {
        return {
          state: analysis.replay.runState,
          input: [...analysis.replay.input],
          logicalIteration: analysis.lastIteration,
          immediateResult: buildLoopResult(
            "failed",
            analysis.replay.runState,
            analysis.replay.input,
            0,
            "error",
            durabilityError(error),
          ),
        };
      }
    }
    return {
      state: analysis.replay.runState,
      input: [...analysis.replay.input],
      logicalIteration: analysis.lastIteration,
      immediateResult: buildLoopResult(
        "resume_blocked",
        analysis.replay.runState,
        analysis.replay.input,
        0,
        undefined,
        resumeBlockError(analysis),
      ),
    };
  }

  if (!wasEmpty) {
    try {
      if (analysis.lifecycleState !== "resumable") {
        await appendAgentLifecycleState(
          options.durability.store,
          "resumable",
          analysis.lastIteration,
        );
      }
      await appendAgentLifecycleState(
        options.durability.store,
        "running",
        analysis.lastIteration,
      );
    } catch (error) {
      return {
        state: analysis.replay.runState,
        input: [...analysis.replay.input],
        logicalIteration: analysis.lastIteration,
        immediateResult: buildLoopResult(
          "failed",
          analysis.replay.runState,
          analysis.replay.input,
          0,
          "error",
          durabilityError(error),
        ),
      };
    }
  }

  return {
    state: analysis.replay.runState,
    input: [...analysis.replay.input],
    logicalIteration: analysis.lastIteration,
    pendingToolResponseId: analysis.pendingToolResponseId,
  };
}

async function runPreparedAgentLoop(
  options: AgentLoopOptions,
  prepared: PreparedLoopRuntime,
): Promise<LoopExecutionResult> {
  const maxIterations = resolveMaxIterations(options.maxIterations);
  const signal = options.signal ?? new AbortController().signal;
  let state = prepared.state;
  const input: AgentModelInputItem[] = [...prepared.input];
  let iterations = 0;
  let logicalIteration = prepared.logicalIteration;

  if (signal.aborted) {
    return {
      result: buildLoopResult(
        "cancelled",
        state,
        input,
        iterations,
        "cancelled",
      ),
      logicalIteration,
    };
  }

  if (prepared.pendingToolResponseId) {
    const resumedToolRound = await executeToolRound(
      options,
      state,
      input,
      prepared.pendingToolResponseId,
      Math.max(logicalIteration, 1),
      signal,
    );
    if (resumedToolRound.kind === "cancelled") {
      return {
        result: buildLoopResult(
          "cancelled",
          state,
          input,
          iterations,
          "cancelled",
        ),
        logicalIteration,
      };
    }
    if (resumedToolRound.kind === "failed") {
      return {
        result: buildLoopResult(
          "failed",
          state,
          input,
          iterations,
          "tool_use",
          resumedToolRound.error,
        ),
        logicalIteration,
      };
    }
  }

  while (iterations < maxIterations) {
    if (signal.aborted) {
      return {
        result: buildLoopResult(
          "cancelled",
          state,
          input,
          iterations,
          "cancelled",
        ),
        logicalIteration,
      };
    }

    iterations += 1;
    logicalIteration += 1;

    if (options.durability) {
      try {
        await appendAgentLifecycleState(
          options.durability.store,
          "waiting_for_model",
          logicalIteration,
        );
      } catch (error) {
        return {
          result: buildLoopResult(
            "failed",
            state,
            input,
            iterations,
            "error",
            durabilityError(error),
          ),
          logicalIteration,
        };
      }
    }

    const streamed = await consumeOneModelResponse(
      options,
      state,
      input,
      signal,
    );
    state = streamed.state;

    if (streamed.kind === "cancelled") {
      return {
        result: buildLoopResult(
          "cancelled",
          state,
          input,
          iterations,
          "cancelled",
        ),
        logicalIteration,
      };
    }
    if (streamed.kind === "failed") {
      return {
        result: buildLoopResult(
          "failed",
          state,
          input,
          iterations,
          "error",
          streamed.error,
        ),
        logicalIteration,
      };
    }

    if (signal.aborted) {
      return {
        result: buildLoopResult(
          "cancelled",
          state,
          input,
          iterations,
          "cancelled",
        ),
        logicalIteration,
      };
    }

    const response = getLatestAgentResponse(state);
    if (
      !response ||
      (streamed.responseId && response.responseId !== streamed.responseId)
    ) {
      return {
        result: buildLoopResult(
          "failed",
          state,
          input,
          iterations,
          "error",
          loopError(
            "invalid_terminal_state",
            "Terminal model event did not produce the expected canonical response state",
          ),
        ),
        logicalIteration,
      };
    }

    if (response.status === "aborted") {
      return {
        result: buildLoopResult(
          "cancelled",
          state,
          input,
          iterations,
          "cancelled",
        ),
        logicalIteration,
      };
    }
    if (response.status === "failed") {
      return {
        result: buildLoopResult(
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
        ),
        logicalIteration,
      };
    }
    if (response.status !== "completed" || !response.stopReason) {
      return {
        result: buildLoopResult(
          "failed",
          state,
          input,
          iterations,
          "error",
          loopError(
            "invalid_terminal_state",
            "Terminal model response did not resolve to a completed stop reason",
          ),
        ),
        logicalIteration,
      };
    }

    appendCompletedModelOutput(input, response.outputItems);

    if (response.stopReason !== "tool_use") {
      return {
        result: finishNonToolStop(
          response.stopReason,
          state,
          input,
          iterations,
        ),
        logicalIteration,
      };
    }

    const toolRound = await executeToolRound(
      options,
      state,
      input,
      response.responseId,
      logicalIteration,
      signal,
    );
    if (toolRound.kind === "cancelled") {
      return {
        result: buildLoopResult(
          "cancelled",
          state,
          input,
          iterations,
          "cancelled",
        ),
        logicalIteration,
      };
    }
    if (toolRound.kind === "failed") {
      return {
        result: buildLoopResult(
          "failed",
          state,
          input,
          iterations,
          "tool_use",
          toolRound.error,
        ),
        logicalIteration,
      };
    }
  }

  return {
    result: buildLoopResult(
      "iteration_limit",
      state,
      input,
      iterations,
    ),
    logicalIteration,
  };
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
  let requestInput = input;

  if (options.durability) {
    try {
      const plan = await prepareDurableAgentContext(
        options.durability.store,
        options.durability.context,
        options.tools ?? [],
        "pre_request",
        signal,
      );
      requestInput = plan.input ?? input;
    } catch (error) {
      return {
        kind: "failed",
        state,
        error: durabilityError(error),
      };
    }
  }

  const request: AgentModelRequest = {
    runState: state,
    input: [...requestInput],
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

      if (options.durability) {
        try {
          await options.durability.store.appendModelEvent(event);
        } catch (error) {
          return {
            kind: "failed",
            state,
            error: durabilityError(error),
          };
        }
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
  options: AgentLoopOptions,
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
  if (!options.toolExecutor) {
    return {
      kind: "failed",
      error: loopError(
        "tool_executor_missing",
        "Model requested tool use but no tool execution boundary was provided",
      ),
    };
  }

  if (options.durability) {
    try {
      await appendAgentLifecycleState(
        options.durability.store,
        "waiting_for_tool",
        iteration,
      );
    } catch (error) {
      return {
        kind: "failed",
        error: durabilityError(error),
      };
    }
  }

  const completedToolResults = new Set(
    input.flatMap((item) =>
      item.type === "tool_result"
        ? [toolPairKey(item.toolCallItemId, item.callId)]
        : [],
    ),
  );
  const pendingToolCalls = toolCalls.filter(
    (toolCall) =>
      !completedToolResults.has(
        toolPairKey(toolCall.id, toolCall.callId),
      ),
  );

  for (const toolCall of pendingToolCalls) {
    if (signal.aborted) {
      return { kind: "cancelled" };
    }

    if (options.durability) {
      try {
        await appendAgentToolAttempt(
          options.durability.store,
          toolCall,
          "started",
          iteration,
        );
      } catch (error) {
        return {
          kind: "failed",
          error: durabilityError(error),
        };
      }
    }

    let outcome: AgentToolExecutionOutcome;
    try {
      outcome = await options.toolExecutor.execute(toolCall, {
        signal,
        iteration,
        state,
      });
    } catch (error) {
      if (options.durability) {
        try {
          await appendAgentToolAttempt(
            options.durability.store,
            toolCall,
            signal.aborted ? "cancelled" : "executor_failed",
            iteration,
            error instanceof Error ? error.message : String(error),
          );
        } catch (persistenceError) {
          return {
            kind: "failed",
            error: durabilityError(persistenceError),
          };
        }
      }
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

    const result = createAgentToolResult(toolCall, outcome);
    if (options.durability) {
      try {
        await options.durability.store.appendToolResult(result);
        await appendAgentToolAttempt(
          options.durability.store,
          toolCall,
          "completed",
          iteration,
        );
      } catch (error) {
        return {
          kind: "failed",
          error: durabilityError(error),
        };
      }
    }

    input.push(result);
    if (signal.aborted) {
      return { kind: "cancelled" };
    }
  }

  if (options.durability) {
    try {
      await prepareDurableAgentContext(
        options.durability.store,
        options.durability.context,
        options.tools ?? [],
        "post_tool",
        signal,
      );
      await appendAgentLifecycleState(
        options.durability.store,
        "running",
        iteration,
      );
    } catch (error) {
      return {
        kind: "failed",
        error: durabilityError(error),
      };
    }
  }

  return { kind: "continue" };
}

async function finalizeDurableLoopResult(
  options: AgentLoopOptions,
  result: AgentLoopResult,
  logicalIteration: number,
): Promise<AgentLoopResult> {
  if (!options.durability) {
    return result;
  }

  let state:
    | "completed"
    | "cancelled"
    | "failed"
    | "interrupted";
  if (result.status === "completed" || result.status === "max_tokens") {
    state = "completed";
  } else if (result.status === "cancelled") {
    state = "cancelled";
  } else if (
    result.status === "iteration_limit" ||
    result.status === "resume_blocked" ||
    result.error?.code === "context_compaction_required" ||
    result.error?.code === "context_overflow"
  ) {
    state = "interrupted";
  } else {
    state = "failed";
  }

  try {
    await appendAgentLifecycleState(
      options.durability.store,
      state,
      logicalIteration,
      {
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.status === "iteration_limit"
          ? { reason: "iteration limit reached" }
          : {}),
      },
    );
  } catch (error) {
    return buildLoopResult(
      "failed",
      result.state,
      result.input,
      result.iterations,
      "error",
      durabilityError(error),
    );
  }

  return result;
}

function resultFromDurableTerminal(
  analysis: AgentDurableResumeAnalysis,
): AgentLoopResult {
  switch (analysis.terminalKind) {
    case "completed":
      return buildLoopResult(
        "completed",
        analysis.replay.runState,
        analysis.replay.input,
        0,
        analysis.stopReason ?? "end_turn",
        analysis.error,
      );
    case "max_tokens":
      return buildLoopResult(
        "max_tokens",
        analysis.replay.runState,
        analysis.replay.input,
        0,
        "max_tokens",
        analysis.error,
      );
    case "cancelled":
      return buildLoopResult(
        "cancelled",
        analysis.replay.runState,
        analysis.replay.input,
        0,
        "cancelled",
        analysis.error,
      );
    case "failed":
      return buildLoopResult(
        "failed",
        analysis.replay.runState,
        analysis.replay.input,
        0,
        analysis.stopReason ?? "error",
        analysis.error ??
          loopError(
            "model_error",
            "Persisted durable session is terminally failed",
          ),
      );
    case "closed":
    default:
      return buildLoopResult(
        "resume_blocked",
        analysis.replay.runState,
        analysis.replay.input,
        0,
        undefined,
        loopError(
          "session_closed",
          "Persisted durable agent session is closed",
        ),
      );
  }
}

async function persistTerminalAnalysis(
  store: AgentSessionStore,
  analysis: AgentDurableResumeAnalysis,
): Promise<void> {
  switch (analysis.terminalKind) {
    case "completed":
    case "max_tokens":
      await appendAgentLifecycleState(
        store,
        "completed",
        analysis.lastIteration,
        {
          ...(analysis.stopReason
            ? { stopReason: analysis.stopReason }
            : {}),
        },
      );
      return;
    case "cancelled":
      await appendAgentLifecycleState(
        store,
        "cancelled",
        analysis.lastIteration,
        { stopReason: "cancelled" },
      );
      return;
    case "failed":
      await appendAgentLifecycleState(
        store,
        "failed",
        analysis.lastIteration,
        {
          ...(analysis.stopReason
            ? { stopReason: analysis.stopReason }
            : {}),
          ...(analysis.error ? { error: analysis.error } : {}),
        },
      );
      return;
    default:
      return;
  }
}

function isPersistedTerminalState(
  state: AgentDurableResumeAnalysis["lifecycleState"],
): boolean {
  return (
    state === "completed" ||
    state === "cancelled" ||
    state === "failed" ||
    state === "closed"
  );
}

function resumeBlockError(
  analysis: AgentDurableResumeAnalysis,
): AgentRunError {
  switch (analysis.blockReason) {
    case "ambiguous_tool_execution":
      return loopError(
        "ambiguous_tool_execution",
        "Durable resume is blocked because a side-effecting tool attempt started without a persisted result; explicit reconciliation is required",
      );
    case "incomplete_model_response":
      return loopError(
        "incomplete_model_response",
        "Durable resume is blocked because the persisted model response is incomplete",
      );
    case "session_closed":
      return loopError(
        "session_closed",
        "Durable agent session is closed and cannot resume",
      );
    default:
      return loopError(
        "durability_error",
        "Durable agent session cannot resume safely",
      );
  }
}

function durabilityError(error: unknown): AgentRunError {
  if (error instanceof AgentLifecycleError) {
    const code: AgentLoopFailureCode =
      error.code === "context_compaction_required"
        ? "context_compaction_required"
        : error.code === "context_overflow"
          ? "context_overflow"
          : "durability_error";
    return loopError(code, error.message);
  }
  return loopError(
    "durability_error",
    error instanceof Error ? error.message : String(error),
  );
}

function toolPairKey(
  toolCallItemId: string,
  callId: string,
): string {
  return toolCallItemId + "\u0000" + callId;
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
