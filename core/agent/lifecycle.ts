import {
  compactAndPersistAgentHistory,
  type AgentCompactionSummarizer,
} from "./compaction";
import {
  planAgentContextBudgetForStore,
  type AgentContextBudgetConfig,
  type AgentContextBudgetPlan,
  type AgentContextEstimator,
  type AgentContextBudgetPhase,
} from "./budget";
import type {
  AgentModelInputItem,
  AgentModelToolDefinition,
  AgentToolResult,
} from "./model";
import {
  replayAgentSession,
  type AgentPersistedRecord,
  type AgentSessionReplay,
  type AgentSessionStore,
} from "./persistence";
import type {
  AgentRunError,
  AgentStopReason,
  AgentToolCallItem,
  JsonObject,
} from "./protocol";
import {
  getExecutableToolCalls,
  getLatestAgentResponse,
} from "./reducer";

export const AGENT_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export type AgentDurableLifecycleState =
  | "created"
  | "running"
  | "waiting_for_model"
  | "waiting_for_tool"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted"
  | "resumable"
  | "closed";

export type AgentDurableToolAttemptStatus =
  | "started"
  | "completed"
  | "executor_failed"
  | "cancelled";

export type AgentDurableResumeDisposition =
  | "new"
  | "resume"
  | "terminal"
  | "blocked";

export type AgentDurableResumeBlockReason =
  | "ambiguous_tool_execution"
  | "incomplete_model_response"
  | "session_closed";

export type AgentDurableTerminalKind =
  | "completed"
  | "cancelled"
  | "failed"
  | "max_tokens"
  | "closed";

export interface AgentDurableLifecycleStateRecord {
  readonly schemaVersion: typeof AGENT_LIFECYCLE_SCHEMA_VERSION;
  readonly type: "state";
  readonly state: AgentDurableLifecycleState;
  readonly iteration: number;
  readonly stopReason?: AgentStopReason;
  readonly reason?: string;
  readonly error?: AgentRunError;
}

export interface AgentDurableToolAttemptRecord {
  readonly schemaVersion: typeof AGENT_LIFECYCLE_SCHEMA_VERSION;
  readonly type: "tool_attempt";
  readonly attemptId: string;
  readonly status: AgentDurableToolAttemptStatus;
  readonly iteration: number;
  readonly toolCallItemId: string;
  readonly callId: string;
  readonly name: string;
  readonly reason?: string;
}

export type AgentDurableLifecycleRecord =
  | AgentDurableLifecycleStateRecord
  | AgentDurableToolAttemptRecord;

export interface AgentDurableAmbiguousToolAttempt {
  readonly attemptId: string;
  readonly toolCallItemId: string;
  readonly callId: string;
  readonly name: string;
  readonly iteration: number;
  readonly status: "started" | "executor_failed";
}

export interface AgentDurableResumeAnalysis {
  readonly disposition: AgentDurableResumeDisposition;
  readonly replay: AgentSessionReplay;
  readonly lifecycleState?: AgentDurableLifecycleState;
  readonly lastLifecycleSequence?: number;
  readonly lastIteration: number;
  readonly pendingToolResponseId?: string;
  readonly ambiguousToolAttempts: readonly AgentDurableAmbiguousToolAttempt[];
  readonly blockReason?: AgentDurableResumeBlockReason;
  readonly terminalKind?: AgentDurableTerminalKind;
  readonly stopReason?: AgentStopReason;
  readonly error?: AgentRunError;
}

export interface AgentDurableContextOptions {
  readonly budget: AgentContextBudgetConfig;
  readonly estimator?: AgentContextEstimator;
  readonly compactionSummarizer?: AgentCompactionSummarizer;
}

export type AgentLifecycleErrorCode =
  | "invalid_initial_input"
  | "context_compaction_required"
  | "context_overflow"
  | "invalid_lifecycle";

export class AgentLifecycleError extends Error {
  constructor(
    readonly code: AgentLifecycleErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentLifecycleError";
  }
}

export function createAgentToolAttemptId(
  toolCall: Pick<AgentToolCallItem, "id" | "callId">,
): string {
  return "tool:" + toolCall.id + ":" + toolCall.callId;
}

export async function appendAgentLifecycleState(
  store: AgentSessionStore,
  state: AgentDurableLifecycleState,
  iteration: number,
  details: {
    readonly stopReason?: AgentStopReason;
    readonly reason?: string;
    readonly error?: AgentRunError;
  } = {},
): Promise<AgentPersistedRecord> {
  const payload: JsonObject = {
    schemaVersion: AGENT_LIFECYCLE_SCHEMA_VERSION,
    type: "state",
    state,
    iteration: validateIteration(iteration),
    ...(details.stopReason ? { stopReason: details.stopReason } : {}),
    ...(details.reason ? { reason: details.reason } : {}),
    ...(details.error ? { error: details.error } : {}),
  };
  return store.appendLifecycle(payload);
}

export async function appendAgentToolAttempt(
  store: AgentSessionStore,
  toolCall: AgentToolCallItem,
  status: AgentDurableToolAttemptStatus,
  iteration: number,
  reason?: string,
): Promise<AgentPersistedRecord> {
  const payload: JsonObject = {
    schemaVersion: AGENT_LIFECYCLE_SCHEMA_VERSION,
    type: "tool_attempt",
    attemptId: createAgentToolAttemptId(toolCall),
    status,
    iteration: validateIteration(iteration),
    toolCallItemId: toolCall.id,
    callId: toolCall.callId,
    name: toolCall.name,
    ...(reason ? { reason } : {}),
  };
  return store.appendLifecycle(payload);
}

export async function initializeDurableAgentSession(
  store: AgentSessionStore,
  initialInput: readonly AgentModelInputItem[],
): Promise<AgentDurableResumeAnalysis> {
  const existing = await store.readAllRecords();
  if (existing.length > 0) {
    return analyzeDurableAgentSession(existing, store.sessionId);
  }

  await appendAgentLifecycleState(store, "created", 0);
  for (const input of initialInput) {
    if (input.type !== "message") {
      throw new AgentLifecycleError(
        "invalid_initial_input",
        "A new durable agent session accepts only initial system/user message input; canonical model output and tool results must come from persisted execution",
      );
    }
    await store.appendModelInput(input);
  }
  await appendAgentLifecycleState(store, "running", 0);
  return analyzeDurableAgentSession(
    await store.readAllRecords(),
    store.sessionId,
  );
}

export function analyzeDurableAgentSession(
  records: readonly AgentPersistedRecord[],
  sessionId: string,
): AgentDurableResumeAnalysis {
  const replay = replayAgentSession(records, sessionId);
  if (records.length === 0) {
    return {
      disposition: "new",
      replay,
      lastIteration: 0,
      ambiguousToolAttempts: [],
    };
  }

  const lifecycleEntries = records.flatMap((record) => {
    if (record.kind !== "lifecycle") {
      return [];
    }
    const parsed = parseLifecycleRecord(record.payload);
    return parsed ? [{ sequence: record.sequence, payload: parsed }] : [];
  });
  const stateEntries = lifecycleEntries.filter(
    (
      entry,
    ): entry is {
      sequence: number;
      payload: AgentDurableLifecycleStateRecord;
    } => entry.payload.type === "state",
  );
  const lastStateEntry = stateEntries.at(-1);
  const lastIteration = lifecycleEntries.reduce(
    (maximum, entry) => Math.max(maximum, entry.payload.iteration),
    0,
  );

  const resultKeys = new Set<string>();
  for (const record of records) {
    if (record.kind !== "tool_result") {
      continue;
    }
    const result = record.payload as Partial<AgentToolResult>;
    if (
      typeof result.toolCallItemId === "string" &&
      typeof result.callId === "string"
    ) {
      resultKeys.add(toolPairKey(result.toolCallItemId, result.callId));
    }
  }

  const latestAttempts = new Map<string, AgentDurableToolAttemptRecord>();
  for (const entry of lifecycleEntries) {
    if (entry.payload.type !== "tool_attempt") {
      continue;
    }
    latestAttempts.set(
      toolPairKey(
        entry.payload.toolCallItemId,
        entry.payload.callId,
      ),
      entry.payload,
    );
  }

  const ambiguousToolAttempts = [...latestAttempts.values()]
    .filter(
      (
        attempt,
      ): attempt is AgentDurableToolAttemptRecord & {
        status: "started" | "executor_failed";
      } =>
        (attempt.status === "started" ||
          attempt.status === "executor_failed") &&
        !resultKeys.has(
          toolPairKey(attempt.toolCallItemId, attempt.callId),
        ),
    )
    .map((attempt) => ({
      attemptId: attempt.attemptId,
      toolCallItemId: attempt.toolCallItemId,
      callId: attempt.callId,
      name: attempt.name,
      iteration: attempt.iteration,
      status: attempt.status,
    }));

  const common = {
    replay,
    lifecycleState: lastStateEntry?.payload.state,
    lastLifecycleSequence: lastStateEntry?.sequence,
    lastIteration,
    ambiguousToolAttempts,
  };

  if (lastStateEntry) {
    const terminal = terminalFromLifecycle(lastStateEntry.payload);
    if (terminal) {
      return {
        disposition: "terminal",
        ...common,
        ...terminal,
      };
    }
    if (lastStateEntry.payload.state === "closed") {
      return {
        disposition: "blocked",
        ...common,
        blockReason: "session_closed",
        terminalKind: "closed",
      };
    }
  }

  const response = getLatestAgentResponse(replay.runState);
  if (replay.runState.activeResponseId || response?.status === "streaming") {
    return {
      disposition: "blocked",
      ...common,
      blockReason: "incomplete_model_response",
    };
  }

  if (ambiguousToolAttempts.length > 0) {
    return {
      disposition: "blocked",
      ...common,
      blockReason: "ambiguous_tool_execution",
    };
  }

  if (!response) {
    return {
      disposition: "resume",
      ...common,
    };
  }

  if (response.status === "aborted") {
    return {
      disposition: "terminal",
      ...common,
      terminalKind: "cancelled",
      stopReason: "cancelled",
    };
  }
  if (response.status === "failed") {
    return {
      disposition: "terminal",
      ...common,
      terminalKind: "failed",
      stopReason: "error",
      error: response.error,
    };
  }

  if (response.status === "completed" && response.stopReason) {
    switch (response.stopReason) {
      case "end_turn":
        return {
          disposition: "terminal",
          ...common,
          terminalKind: "completed",
          stopReason: "end_turn",
        };
      case "max_tokens":
        return {
          disposition: "terminal",
          ...common,
          terminalKind: "max_tokens",
          stopReason: "max_tokens",
        };
      case "cancelled":
        return {
          disposition: "terminal",
          ...common,
          terminalKind: "cancelled",
          stopReason: "cancelled",
        };
      case "error":
      case "unknown":
        return {
          disposition: "terminal",
          ...common,
          terminalKind: "failed",
          stopReason: response.stopReason,
          error:
            response.error ??
            {
              code:
                response.stopReason === "unknown"
                  ? "unknown_stop_reason"
                  : "model_error",
              message:
                response.stopReason === "unknown"
                  ? "Persisted model response completed with an unknown normalized stop reason"
                  : "Persisted model response completed with stop reason error",
            },
        };
      case "tool_use": {
        const calls = getExecutableToolCalls(
          replay.runState,
          response.responseId,
        );
        const unresolved = calls.filter(
          (call) =>
            !resultKeys.has(toolPairKey(call.id, call.callId)),
        );
        return {
          disposition: "resume",
          ...common,
          pendingToolResponseId:
            unresolved.length > 0 ? response.responseId : undefined,
        };
      }
    }
  }

  return {
    disposition: "resume",
    ...common,
  };
}

export async function prepareDurableAgentContext(
  store: AgentSessionStore,
  options: AgentDurableContextOptions,
  tools: readonly AgentModelToolDefinition[],
  phase: AgentContextBudgetPhase,
  signal: AbortSignal,
): Promise<AgentContextBudgetPlan> {
  let plan = await planAgentContextBudgetForStore(store, {
    budget: options.budget,
    estimator: options.estimator,
    tools,
    phase,
  });

  if (plan.decision === "needs_compaction") {
    if (!options.compactionSummarizer) {
      throw new AgentLifecycleError(
        "context_compaction_required",
        "Agent context exceeds the configured budget and requires durable compaction before the next model request",
      );
    }
    await compactAndPersistAgentHistory(
      store,
      options.compactionSummarizer,
      { signal },
    );
    plan = await planAgentContextBudgetForStore(store, {
      budget: options.budget,
      estimator: options.estimator,
      tools,
      phase,
    });
  }

  if (plan.decision === "needs_compaction") {
    throw new AgentLifecycleError(
      "context_compaction_required",
      "Agent context still requires compaction after the available durable compaction pass",
    );
  }
  if (plan.decision === "overflow_non_compactable") {
    throw new AgentLifecycleError(
      "context_overflow",
      "Agent context exceeds the configured limit and has no safe compactable boundary",
    );
  }
  if (!plan.input) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "A fitting context budget plan did not produce model input",
    );
  }

  return plan;
}

function terminalFromLifecycle(
  record: AgentDurableLifecycleStateRecord,
):
  | {
      readonly terminalKind: AgentDurableTerminalKind;
      readonly stopReason?: AgentStopReason;
      readonly error?: AgentRunError;
    }
  | undefined {
  switch (record.state) {
    case "completed":
      return {
        terminalKind:
          record.stopReason === "max_tokens"
            ? "max_tokens"
            : "completed",
        ...(record.stopReason
          ? { stopReason: record.stopReason }
          : {}),
      };
    case "cancelled":
      return {
        terminalKind: "cancelled",
        stopReason: record.stopReason ?? "cancelled",
      };
    case "failed":
      return {
        terminalKind: "failed",
        stopReason: record.stopReason ?? "error",
        ...(record.error ? { error: record.error } : {}),
      };
    default:
      return undefined;
  }
}

function parseLifecycleRecord(
  value: unknown,
): AgentDurableLifecycleRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.schemaVersion !== AGENT_LIFECYCLE_SCHEMA_VERSION ||
    (value.type !== "state" && value.type !== "tool_attempt")
  ) {
    return undefined;
  }

  if (
    typeof value.iteration !== "number" ||
    !Number.isSafeInteger(value.iteration) ||
    value.iteration < 0
  ) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Persisted agent lifecycle record has an invalid iteration",
    );
  }

  if (value.type === "state") {
    if (!isDurableLifecycleState(value.state)) {
      throw new AgentLifecycleError(
        "invalid_lifecycle",
        "Persisted agent lifecycle state is invalid",
      );
    }
    return value as unknown as AgentDurableLifecycleStateRecord;
  }

  if (
    typeof value.attemptId !== "string" ||
    typeof value.toolCallItemId !== "string" ||
    typeof value.callId !== "string" ||
    typeof value.name !== "string" ||
    !isToolAttemptStatus(value.status)
  ) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Persisted agent tool-attempt record is invalid",
    );
  }
  return value as unknown as AgentDurableToolAttemptRecord;
}

function isDurableLifecycleState(
  value: unknown,
): value is AgentDurableLifecycleState {
  return (
    typeof value === "string" &&
    [
      "created",
      "running",
      "waiting_for_model",
      "waiting_for_tool",
      "completed",
      "cancelled",
      "failed",
      "interrupted",
      "resumable",
      "closed",
    ].includes(value)
  );
}

function isToolAttemptStatus(
  value: unknown,
): value is AgentDurableToolAttemptStatus {
  return (
    value === "started" ||
    value === "completed" ||
    value === "executor_failed" ||
    value === "cancelled"
  );
}

function validateIteration(iteration: number): number {
  if (!Number.isSafeInteger(iteration) || iteration < 0) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Agent lifecycle iteration must be a non-negative safe integer",
    );
  }
  return iteration;
}

function toolPairKey(
  toolCallItemId: string,
  callId: string,
): string {
  return toolCallItemId + "\u0000" + callId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
