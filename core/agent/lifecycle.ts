import { isDeepStrictEqual } from "node:util";

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
  | "cancelled"
  | "reconciled_not_executed";

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
  readonly status: "started" | "executor_failed" | "cancelled";
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
  | "unsupported_lifecycle_schema"
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

const ALLOWED_LIFECYCLE_TRANSITIONS: Readonly<
  Record<AgentDurableLifecycleState, readonly AgentDurableLifecycleState[]>
> = {
  created: ["running", "cancelled", "failed", "closed"],
  running: [
    "waiting_for_model",
    "resumable",
    "interrupted",
    "cancelled",
    "failed",
    "closed",
  ],
  waiting_for_model: [
    "waiting_for_tool",
    "resumable",
    "completed",
    "cancelled",
    "failed",
    "interrupted",
  ],
  waiting_for_tool: [
    "running",
    "resumable",
    "cancelled",
    "failed",
    "interrupted",
  ],
  resumable: ["running", "cancelled", "failed", "interrupted"],
  interrupted: ["resumable", "cancelled", "failed", "closed"],
  completed: ["closed"],
  cancelled: ["closed"],
  failed: ["closed"],
  closed: [],
};

export function assertAgentLifecycleTransition(
  previous: AgentDurableLifecycleState | undefined,
  next: AgentDurableLifecycleState,
): void {
  if (previous === undefined) {
    if (next !== "created") {
      throw new AgentLifecycleError(
        "invalid_lifecycle",
        "A durable agent lifecycle must begin in the created state",
      );
    }
    return;
  }

  if (!ALLOWED_LIFECYCLE_TRANSITIONS[previous].includes(next)) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Invalid durable agent lifecycle transition: " +
        previous +
        " -> " +
        next,
    );
  }
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
  const records = await store.readAllRecords();
  const previousState = findLastLifecycleState(records);
  assertAgentLifecycleTransition(previousState, state);

  const payload: JsonObject = {
    schemaVersion: AGENT_LIFECYCLE_SCHEMA_VERSION,
    type: "state",
    state,
    iteration: validateIteration(iteration),
    ...(details.stopReason ? { stopReason: details.stopReason } : {}),
    ...(details.reason ? { reason: details.reason } : {}),
    ...(details.error ? { error: toJsonRunError(details.error) } : {}),
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
  if (
    status === "reconciled_not_executed" &&
    (typeof reason !== "string" || !reason.trim())
  ) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "A reconciled tool attempt requires a non-empty audit reason",
    );
  }

  const records = await store.readAllRecords();
  const lifecycleState = findLastLifecycleState(records);
  const allowedLifecycleStates =
    status === "reconciled_not_executed"
      ? ["waiting_for_tool", "interrupted"]
      : ["waiting_for_tool"];
  if (
    lifecycleState === undefined ||
    !allowedLifecycleStates.includes(lifecycleState)
  ) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Durable tool-attempt state " +
        status +
        " is not valid while lifecycle is " +
        String(lifecycleState),
    );
  }

  const previousAttemptStatus = findLatestToolAttemptStatus(
    records,
    toolCall,
  );
  assertToolAttemptTransition(previousAttemptStatus, status);

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

export async function reconcileDurableAgentToolAttempt(
  store: AgentSessionStore,
  toolCall: AgentToolCallItem,
  options: {
    readonly iteration: number;
    readonly reason: string;
  },
): Promise<AgentPersistedRecord> {
  if (!options.reason.trim()) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Tool-attempt reconciliation requires a non-empty audit reason",
    );
  }

  const records = await store.readAllRecords();
  const analysis = analyzeDurableAgentSession(records, store.sessionId);
  const matching = analysis.ambiguousToolAttempts.find(
    (attempt) =>
      attempt.toolCallItemId === toolCall.id &&
      attempt.callId === toolCall.callId,
  );
  if (!matching) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Only an ambiguous durable tool attempt can be reconciled as not executed",
    );
  }

  return appendAgentToolAttempt(
    store,
    toolCall,
    "reconciled_not_executed",
    options.iteration,
    options.reason,
  );
}

export async function initializeDurableAgentSession(
  store: AgentSessionStore,
  initialInput: readonly AgentModelInputItem[],
): Promise<AgentDurableResumeAnalysis> {
  const existing = await store.readAllRecords();
  if (existing.length > 0) {
    const analysis = analyzeDurableAgentSession(existing, store.sessionId);
    if (analysis.lifecycleState === "created") {
      return repairCreatedDurableAgentSession(
        store,
        existing,
        initialInput,
      );
    }
    return analysis;
  }

  validateInitialInput(initialInput);
  await appendAgentLifecycleState(store, "created", 0);
  for (const input of initialInput) {
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
    return [
      {
        sequence: record.sequence,
        payload: parseLifecycleRecord(record.payload),
      },
    ];
  });
  validateLifecycleHistory(records, lifecycleEntries);
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
        status: "started" | "executor_failed" | "cancelled";
      } =>
        (attempt.status === "started" ||
          attempt.status === "executor_failed" ||
          attempt.status === "cancelled") &&
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
        if (calls.length === 0) {
          return {
            disposition: "terminal",
            ...common,
            terminalKind: "failed",
            stopReason: "error",
            error: {
              code: "tool_use_without_executable_calls",
              message:
                "Persisted model response requested tool use without any canonical completed executable tool calls",
            },
          };
        }
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
): AgentDurableLifecycleRecord {
  if (!isRecord(value)) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Persisted agent lifecycle payload must be an object",
    );
  }
  if (value.schemaVersion !== AGENT_LIFECYCLE_SCHEMA_VERSION) {
    throw new AgentLifecycleError(
      "unsupported_lifecycle_schema",
      "Unsupported persisted agent lifecycle schema version: " +
        String(value.schemaVersion),
    );
  }
  if (value.type !== "state" && value.type !== "tool_attempt") {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Persisted agent lifecycle record has an unknown type",
    );
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
    if (
      value.stopReason !== undefined &&
      !isAgentStopReason(value.stopReason)
    ) {
      throw new AgentLifecycleError(
        "invalid_lifecycle",
        "Persisted agent lifecycle stop reason is invalid",
      );
    }
    if (
      value.reason !== undefined &&
      (typeof value.reason !== "string" || !value.reason.trim())
    ) {
      throw new AgentLifecycleError(
        "invalid_lifecycle",
        "Persisted agent lifecycle reason must be a non-empty string",
      );
    }
    if (value.error !== undefined) {
      validatePersistedRunError(value.error);
    }
    return value as unknown as AgentDurableLifecycleStateRecord;
  }

  if (
    typeof value.attemptId !== "string" ||
    !value.attemptId ||
    typeof value.toolCallItemId !== "string" ||
    !value.toolCallItemId ||
    typeof value.callId !== "string" ||
    !value.callId ||
    typeof value.name !== "string" ||
    !value.name ||
    !isToolAttemptStatus(value.status)
  ) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Persisted agent tool-attempt record is invalid",
    );
  }
  const expectedAttemptId =
    "tool:" + value.toolCallItemId + ":" + value.callId;
  if (value.attemptId !== expectedAttemptId) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Persisted agent tool-attempt identity does not match its tool-call identity",
    );
  }
  if (
    value.reason !== undefined &&
    (typeof value.reason !== "string" || !value.reason.trim())
  ) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Persisted agent tool-attempt reason must be a non-empty string",
    );
  }
  if (
    value.status === "reconciled_not_executed" &&
    (typeof value.reason !== "string" || !value.reason.trim())
  ) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "A reconciled durable tool attempt requires an audit reason",
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
    value === "cancelled" ||
    value === "reconciled_not_executed"
  );
}

function isAgentStopReason(value: unknown): value is AgentStopReason {
  return (
    value === "tool_use" ||
    value === "end_turn" ||
    value === "max_tokens" ||
    value === "cancelled" ||
    value === "error" ||
    value === "unknown"
  );
}

function validatePersistedRunError(value: unknown): void {
  if (
    !isRecord(value) ||
    typeof value.message !== "string" ||
    !value.message.trim() ||
    (value.code !== undefined && typeof value.code !== "string") ||
    (value.retryable !== undefined &&
      typeof value.retryable !== "boolean")
  ) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Persisted agent lifecycle error payload is invalid",
    );
  }
}

function findLastLifecycleState(
  records: readonly AgentPersistedRecord[],
): AgentDurableLifecycleState | undefined {
  const lifecycleEntries = records.flatMap((record) => {
    if (record.kind !== "lifecycle") {
      return [];
    }
    return [
      {
        sequence: record.sequence,
        payload: parseLifecycleRecord(record.payload),
      },
    ];
  });
  validateLifecycleHistory(records, lifecycleEntries);
  return lifecycleEntries
    .filter(
      (
        entry,
      ): entry is {
        sequence: number;
        payload: AgentDurableLifecycleStateRecord;
      } => entry.payload.type === "state",
    )
    .at(-1)?.payload.state;
}

function findLatestToolAttemptStatus(
  records: readonly AgentPersistedRecord[],
  toolCall: Pick<AgentToolCallItem, "id" | "callId">,
): AgentDurableToolAttemptStatus | undefined {
  let status: AgentDurableToolAttemptStatus | undefined;
  for (const record of records) {
    if (record.kind !== "lifecycle") {
      continue;
    }
    const parsed = parseLifecycleRecord(record.payload);
    if (
      parsed.type === "tool_attempt" &&
      parsed.toolCallItemId === toolCall.id &&
      parsed.callId === toolCall.callId
    ) {
      status = parsed.status;
    }
  }
  return status;
}

function assertToolAttemptTransition(
  previous: AgentDurableToolAttemptStatus | undefined,
  next: AgentDurableToolAttemptStatus,
): void {
  const valid =
    previous === undefined
      ? next === "started"
      : previous === "started"
        ? next === "completed" ||
          next === "executor_failed" ||
          next === "cancelled"
        : previous === "executor_failed" || previous === "cancelled"
          ? next === "reconciled_not_executed"
          : previous === "reconciled_not_executed"
            ? next === "started"
            : false;

  if (!valid) {
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Invalid durable tool-attempt transition: " +
        String(previous) +
        " -> " +
        next,
    );
  }
}

function validateLifecycleHistory(
  records: readonly AgentPersistedRecord[],
  lifecycleEntries: readonly {
    readonly sequence: number;
    readonly payload: AgentDurableLifecycleRecord;
  }[],
): void {
  let previousState: AgentDurableLifecycleState | undefined;
  let terminalSequence: number | undefined;

  for (const entry of lifecycleEntries) {
    if (entry.payload.type !== "state") {
      if (terminalSequence !== undefined) {
        throw new AgentLifecycleError(
          "invalid_lifecycle",
          "Persisted tool-attempt activity exists after a terminal durable lifecycle state",
        );
      }
      continue;
    }

    assertAgentLifecycleTransition(previousState, entry.payload.state);
    previousState = entry.payload.state;
    if (
      entry.payload.state === "completed" ||
      entry.payload.state === "cancelled" ||
      entry.payload.state === "failed" ||
      entry.payload.state === "closed"
    ) {
      terminalSequence ??= entry.sequence;
    }
  }

  if (terminalSequence === undefined) {
    return;
  }

  for (const record of records) {
    if (record.sequence <= terminalSequence || record.kind === "metadata") {
      continue;
    }
    if (record.kind === "lifecycle") {
      const parsed = parseLifecycleRecord(record.payload);
      if (parsed.type === "state" && parsed.state === "closed") {
        continue;
      }
    }
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "Persisted execution activity exists after a terminal durable lifecycle state",
    );
  }
}

async function repairCreatedDurableAgentSession(
  store: AgentSessionStore,
  records: readonly AgentPersistedRecord[],
  initialInput: readonly AgentModelInputItem[],
): Promise<AgentDurableResumeAnalysis> {
  validateInitialInput(initialInput);

  const persistedInput: AgentModelInputItem[] = [];
  for (const record of records) {
    if (record.kind === "model_input") {
      persistedInput.push(record.payload as AgentModelInputItem);
      continue;
    }
    if (record.kind === "lifecycle") {
      const parsed = parseLifecycleRecord(record.payload);
      if (parsed.type === "state" && parsed.state === "created") {
        continue;
      }
    }
    throw new AgentLifecycleError(
      "invalid_lifecycle",
      "A created durable session contains execution records before initialization completed",
    );
  }

  if (persistedInput.length > initialInput.length) {
    throw new AgentLifecycleError(
      "invalid_initial_input",
      "Persisted initial input is longer than the supplied durable session input",
    );
  }
  for (let index = 0; index < persistedInput.length; index += 1) {
    if (!isDeepStrictEqual(persistedInput[index], initialInput[index])) {
      throw new AgentLifecycleError(
        "invalid_initial_input",
        "Persisted initial input does not match the supplied durable session input",
      );
    }
  }

  for (let index = persistedInput.length; index < initialInput.length; index += 1) {
    await store.appendModelInput(initialInput[index]);
  }
  await appendAgentLifecycleState(store, "running", 0);
  return analyzeDurableAgentSession(
    await store.readAllRecords(),
    store.sessionId,
  );
}

function validateInitialInput(
  initialInput: readonly AgentModelInputItem[],
): void {
  for (const input of initialInput) {
    if (input.type !== "message") {
      throw new AgentLifecycleError(
        "invalid_initial_input",
        "A new durable agent session accepts only initial system/user message input; canonical model output and tool results must come from persisted execution",
      );
    }
  }
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

function toJsonRunError(error: AgentRunError): JsonObject {
  return {
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
  };
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
