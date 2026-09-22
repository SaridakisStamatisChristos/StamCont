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

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const maxIterations =
    options.maxIterations ?? DEFAULT_AGENT_LOOP_MAX_ITERATIONS;
  if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0) {
    throw new RangeError(
      "AgentLoop maxIterations must be a positive safe integer",
    );
  }

  const signal = options.signal ?? new AbortController().signal;
  let state = createInitialAgentRunState();
  const input: AgentModelInputItem[] = [...options.input];
  let iterations = 0;

  const finish = (
    status: AgentLoopStatus,
    stopReason?: AgentStopReason,
    error?: AgentRunError,
  ): AgentLoopResult => ({
    status,
    state,
    input: [...input],
    iterations,
    stopReason,
    error,
  });

  if (signal.aborted) {
    return finish("cancelled", "cancelled");
  }

  while (iterations < maxIterations) {
    if (signal.aborted) {
      return finish("cancelled", "cancelled");
    }

    iterations += 1;
    let sawTerminalEvent = false;
    let responseId: string | undefined;

    try {
      const request = {
        runState: state,
        input: [...input],
        tools: options.tools,
        metadata: options.metadata,
      };

      for await (const event of options.driver.stream(request, signal)) {
        try {
          state = reduceAgentRunEvent(state, event);
        } catch (error) {
          return finish(
            "failed",
            "error",
            loopError(
              "protocol_error",
              error instanceof Error ? error.message : String(error),
            ),
          );
        }

        if (event.type === "response.started") {
          if (responseId && responseId !== event.responseId) {
            return finish(
              "failed",
              "error",
              loopError(
                "protocol_error",
                "A single model driver call attempted to start multiple responses",
              ),
            );
          }
          responseId = event.responseId;
        } else if (responseId && event.responseId !== responseId) {
          return finish(
            "failed",
            "error",
            loopError(
              "protocol_error",
              "A single model driver call emitted events for multiple responses",
            ),
          );
        }

        if (options.onEvent) {
          try {
            await options.onEvent(event, state);
          } catch (error) {
            return finish(
              "failed",
              "error",
              loopError(
                "observer_error",
                error instanceof Error ? error.message : String(error),
              ),
            );
          }
        }

        if (
          event.type === "response.completed" ||
          event.type === "response.aborted" ||
          event.type === "response.failed"
        ) {
          sawTerminalEvent = true;
          break;
        }

        if (signal.aborted) {
          return finish("cancelled", "cancelled");
        }
      }
    } catch (error) {
      if (signal.aborted) {
        return finish("cancelled", "cancelled");
      }
      return finish(
        "failed",
        "error",
        loopError(
          "driver_error",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    if (signal.aborted) {
      return finish("cancelled", "cancelled");
    }

    if (!sawTerminalEvent) {
      return finish(
        "failed",
        "error",
        loopError(
          "driver_ended_without_terminal_event",
          "Model driver stream ended without a terminal canonical response event",
        ),
      );
    }

    const response = getLatestAgentResponse(state);
    if (!response || (responseId && response.responseId !== responseId)) {
      return finish(
        "failed",
        "error",
        loopError(
          "invalid_terminal_state",
          "Terminal model event did not produce the expected canonical response state",
        ),
      );
    }

    if (response.status === "aborted") {
      return finish("cancelled", "cancelled");
    }

    if (response.status === "failed") {
      return finish(
        "failed",
        "error",
        response.error ??
          loopError(
            "model_error",
            "Model response failed without a canonical error payload",
          ),
      );
    }

    if (response.status !== "completed" || !response.stopReason) {
      return finish(
        "failed",
        "error",
        loopError(
          "invalid_terminal_state",
          "Terminal model response did not resolve to a completed stop reason",
        ),
      );
    }

    for (const item of response.outputItems) {
      if (item.status === "completed" && item.completedItem) {
        input.push({
          type: "model_output",
          item: item.completedItem,
        });
      }
    }

    switch (response.stopReason) {
      case "end_turn":
        return finish("completed", "end_turn");

      case "cancelled":
        return finish("cancelled", "cancelled");

      case "error":
        return finish(
          "failed",
          "error",
          loopError("model_error", "Model completed with stop reason error"),
        );

      case "max_tokens":
        return finish("max_tokens", "max_tokens");

      case "unknown":
        return finish(
          "failed",
          "unknown",
          loopError(
            "unknown_stop_reason",
            "Model completed with an unknown normalized stop reason",
          ),
        );

      case "tool_use": {
        const toolCalls = getExecutableToolCalls(state, response.responseId);
        if (toolCalls.length === 0) {
          return finish(
            "failed",
            "tool_use",
            loopError(
              "tool_use_without_executable_calls",
              "Model requested tool use but no canonical completed tool calls were executable",
            ),
          );
        }

        if (!options.toolExecutor) {
          return finish(
            "failed",
            "tool_use",
            loopError(
              "tool_executor_missing",
              "Model requested tool use but no tool execution boundary was provided",
            ),
          );
        }

        for (const toolCall of toolCalls) {
          if (signal.aborted) {
            return finish("cancelled", "cancelled");
          }

          let outcome: AgentToolExecutionOutcome;
          try {
            outcome = await options.toolExecutor.execute(toolCall, {
              signal,
              iteration: iterations,
              state,
            });
          } catch (error) {
            if (signal.aborted) {
              return finish("cancelled", "cancelled");
            }
            return finish(
              "failed",
              "tool_use",
              loopError(
                "tool_executor_error",
                error instanceof Error ? error.message : String(error),
              ),
            );
          }

          input.push(createAgentToolResult(toolCall, outcome));

          if (signal.aborted) {
            return finish("cancelled", "cancelled");
          }
        }

        break;
      }
    }
  }

  return finish("iteration_limit");
}

function loopError(
  code: AgentLoopFailureCode,
  message: string,
): AgentRunError {
  return { code, message };
}
