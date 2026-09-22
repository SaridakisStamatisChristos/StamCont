import {
  buildCompactedAgentInput,
  findLatestSafeAgentCompactionBoundary,
  readAgentCompactionArtifact,
  AgentCompactionError,
  type AgentCompactionArtifact,
  type AgentCompactionArtifactReadResult,
  type AgentCompactionArtifactStatus,
} from "./compaction";
import type {
  AgentModelInputItem,
  AgentModelToolDefinition,
} from "./model";
import {
  replayAgentSession,
  type AgentPersistedRecord,
  type AgentSessionStore,
} from "./persistence";
import type { AgentRunEvent } from "./protocol";

export const AGENT_CONTEXT_BUDGET_POLICY_VERSION = 1 as const;

export type AgentContextBudgetDecision =
  | "fits_raw"
  | "fits_with_existing_compaction"
  | "needs_compaction"
  | "overflow_non_compactable";

export type AgentContextBudgetPhase =
  | "pre_request"
  | "post_tool";

export type AgentContextEstimatorAccuracy =
  | "exact"
  | "estimated";

export interface AgentContextEstimator {
  readonly id: string;
  readonly version: string | number;
  readonly accuracy: AgentContextEstimatorAccuracy;
  estimateInputTokens(
    input: readonly AgentModelInputItem[],
  ): number;
  estimateToolDefinitionTokens(
    tools: readonly AgentModelToolDefinition[],
  ): number;
  estimateContinuationOverheadTokens?(
    input: readonly AgentModelInputItem[],
    tools: readonly AgentModelToolDefinition[],
  ): number;
}

export interface AgentContextBudgetConfig {
  readonly contextLimitTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens?: number;
}

export interface AgentContextBudgetSourceRange {
  readonly startSequence: number;
  readonly endSequence: number;
}

export interface AgentContextBudgetProvenance {
  readonly policyVersion: typeof AGENT_CONTEXT_BUDGET_POLICY_VERSION;
  readonly phase: AgentContextBudgetPhase;
  readonly decision: AgentContextBudgetDecision;
  readonly estimator: {
    readonly id: string;
    readonly version: string | number;
    readonly accuracy: AgentContextEstimatorAccuracy;
  };
  readonly contextLimitTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly toolDefinitionTokens: number;
  readonly baseInputAllowanceTokens: number;
  readonly rawInputTokens: number;
  readonly rawContinuationOverheadTokens: number;
  readonly rawTotalRequiredTokens: number;
  readonly selectedInputTokens?: number;
  readonly selectedContinuationOverheadTokens?: number;
  readonly selectedTotalRequiredTokens?: number;
  readonly compactionStatus: AgentCompactionArtifactStatus;
  readonly compactionUsed: boolean;
  readonly compactionSourceRange?: AgentContextBudgetSourceRange;
  readonly protectedSourceSequences: readonly number[];
  readonly retainedTailStartSequence?: number;
  readonly requiredSourceSequences: readonly number[];
  readonly latestSafeCompactionBoundarySequence?: number;
  readonly lastDurableSequence: number;
}

export interface AgentContextBudgetPlan {
  readonly decision: AgentContextBudgetDecision;
  readonly input?: readonly AgentModelInputItem[];
  readonly provenance: AgentContextBudgetProvenance;
}

export interface PlanAgentContextBudgetOptions {
  readonly budget: AgentContextBudgetConfig;
  readonly estimator?: AgentContextEstimator;
  readonly tools?: readonly AgentModelToolDefinition[];
  readonly compaction?: AgentCompactionArtifactReadResult;
  readonly phase?: AgentContextBudgetPhase;
}

export interface PlanAgentContextBudgetForStoreOptions
  extends Omit<PlanAgentContextBudgetOptions, "compaction"> {
  readonly useExistingCompaction?: boolean;
}

export type AgentContextBudgetErrorCode =
  | "invalid_budget"
  | "invalid_estimate";

export class AgentContextBudgetError extends Error {
  constructor(
    readonly code: AgentContextBudgetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentContextBudgetError";
  }
}

const FALLBACK_ESTIMATOR_ID =
  "stamcont.agent.context-budget.utf8-bytes";
const FALLBACK_ESTIMATOR_VERSION = 1 as const;

/**
 * Provider-neutral fallback used only when a provider-specific counter is
 * unavailable. One UTF-8 byte is treated as one token unit, making the
 * estimate deliberately conservative for normal text/JSON payloads rather
 * than pretending to be an exact provider tokenizer.
 */
export function createFallbackAgentContextEstimator(): AgentContextEstimator {
  return {
    id: FALLBACK_ESTIMATOR_ID,
    version: FALLBACK_ESTIMATOR_VERSION,
    accuracy: "estimated",
    estimateInputTokens(input) {
      return estimateJsonBytes(input);
    },
    estimateToolDefinitionTokens(tools) {
      return tools.length === 0
        ? 0
        : estimateJsonBytes(tools);
    },
    estimateContinuationOverheadTokens() {
      return 0;
    },
  };
}

export function planAgentContextBudget(
  records: readonly AgentPersistedRecord[],
  sessionId: string,
  options: PlanAgentContextBudgetOptions,
): AgentContextBudgetPlan {
  const budget = validateBudget(options.budget);
  const estimator =
    options.estimator ?? createFallbackAgentContextEstimator();
  validateEstimator(estimator);

  const tools = options.tools ?? [];
  const phase = options.phase ?? "pre_request";
  const replay = replayAgentSession(records, sessionId);
  const rawInput = replay.input;
  const toolDefinitionTokens = estimate(
    estimator.estimateToolDefinitionTokens(tools),
    "tool definition",
  );
  const rawCost = estimateCandidate(
    estimator,
    rawInput,
    tools,
    toolDefinitionTokens,
    budget,
  );
  const baseInputAllowanceTokens =
    budget.contextLimitTokens -
    budget.reservedOutputTokens -
    budget.safetyMarginTokens -
    toolDefinitionTokens;
  const requiredSourceSequences =
    collectRequiredSourceSequences(records);
  const suppliedCompaction = options.compaction ?? {
    status: "missing" as const,
  };

  if (rawCost.totalRequiredTokens <= budget.contextLimitTokens) {
    return buildPlan({
      decision: "fits_raw",
      input: rawInput,
      budget,
      estimator,
      phase,
      toolDefinitionTokens,
      baseInputAllowanceTokens,
      rawCost,
      selectedCost: rawCost,
      compactionStatus: suppliedCompaction.status,
      compactionUsed: false,
      requiredSourceSequences,
      lastDurableSequence: replay.lastSequence,
    });
  }

  let effectiveCompactionStatus = suppliedCompaction.status;
  let artifact: AgentCompactionArtifact | undefined;
  let compactedInput: readonly AgentModelInputItem[] | undefined;
  let compactedCost: CandidateCost | undefined;

  if (
    suppliedCompaction.status === "valid" &&
    suppliedCompaction.artifact
  ) {
    try {
      artifact = suppliedCompaction.artifact;
      compactedInput = buildCompactedAgentInput(
        records,
        sessionId,
        artifact,
      );
      compactedCost = estimateCandidate(
        estimator,
        compactedInput,
        tools,
        toolDefinitionTokens,
        budget,
      );
    } catch (error) {
      if (!(error instanceof AgentCompactionError)) {
        throw error;
      }
      effectiveCompactionStatus = "stale";
      artifact = undefined;
      compactedInput = undefined;
      compactedCost = undefined;
    }
  }

  if (
    artifact &&
    compactedInput &&
    compactedCost &&
    compactedCost.totalRequiredTokens <=
      budget.contextLimitTokens
  ) {
    return buildPlan({
      decision: "fits_with_existing_compaction",
      input: compactedInput,
      budget,
      estimator,
      phase,
      toolDefinitionTokens,
      baseInputAllowanceTokens,
      rawCost,
      selectedCost: compactedCost,
      compactionStatus: effectiveCompactionStatus,
      compactionUsed: true,
      artifact,
      requiredSourceSequences,
      lastDurableSequence: replay.lastSequence,
    });
  }

  const latestBoundary = findLatestSafeAgentCompactionBoundary(
    records,
    sessionId,
  );
  const canCompactFurther =
    latestBoundary !== undefined &&
    (artifact === undefined ||
      latestBoundary.sequence > artifact.sourceSequenceEnd);

  const decision: AgentContextBudgetDecision =
    canCompactFurther
      ? "needs_compaction"
      : "overflow_non_compactable";

  return buildPlan({
    decision,
    budget,
    estimator,
    phase,
    toolDefinitionTokens,
    baseInputAllowanceTokens,
    rawCost,
    selectedCost: compactedCost,
    compactionStatus: effectiveCompactionStatus,
    compactionUsed: false,
    artifact,
    requiredSourceSequences,
    latestSafeCompactionBoundarySequence:
      latestBoundary?.sequence,
    lastDurableSequence: replay.lastSequence,
  });
}

export async function planAgentContextBudgetForStore(
  store: AgentSessionStore,
  options: PlanAgentContextBudgetForStoreOptions,
): Promise<AgentContextBudgetPlan> {
  const records = await store.readAllRecords();
  const compaction =
    options.useExistingCompaction === false
      ? ({ status: "missing" } as const)
      : await readAgentCompactionArtifact(store);

  return planAgentContextBudget(records, store.sessionId, {
    budget: options.budget,
    estimator: options.estimator,
    tools: options.tools,
    phase: options.phase,
    compaction,
  });
}

interface NormalizedBudget {
  readonly contextLimitTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
}

interface CandidateCost {
  readonly inputTokens: number;
  readonly continuationOverheadTokens: number;
  readonly totalRequiredTokens: number;
}

interface BuildPlanOptions {
  readonly decision: AgentContextBudgetDecision;
  readonly input?: readonly AgentModelInputItem[];
  readonly budget: NormalizedBudget;
  readonly estimator: AgentContextEstimator;
  readonly phase: AgentContextBudgetPhase;
  readonly toolDefinitionTokens: number;
  readonly baseInputAllowanceTokens: number;
  readonly rawCost: CandidateCost;
  readonly selectedCost?: CandidateCost;
  readonly compactionStatus: AgentCompactionArtifactStatus;
  readonly compactionUsed: boolean;
  readonly artifact?: AgentCompactionArtifact;
  readonly requiredSourceSequences: readonly number[];
  readonly latestSafeCompactionBoundarySequence?: number;
  readonly lastDurableSequence: number;
}

function buildPlan(options: BuildPlanOptions): AgentContextBudgetPlan {
  return {
    decision: options.decision,
    input: options.input ? [...options.input] : undefined,
    provenance: {
      policyVersion: AGENT_CONTEXT_BUDGET_POLICY_VERSION,
      phase: options.phase,
      decision: options.decision,
      estimator: {
        id: options.estimator.id,
        version: options.estimator.version,
        accuracy: options.estimator.accuracy,
      },
      contextLimitTokens: options.budget.contextLimitTokens,
      reservedOutputTokens: options.budget.reservedOutputTokens,
      safetyMarginTokens: options.budget.safetyMarginTokens,
      toolDefinitionTokens: options.toolDefinitionTokens,
      baseInputAllowanceTokens:
        options.baseInputAllowanceTokens,
      rawInputTokens: options.rawCost.inputTokens,
      rawContinuationOverheadTokens:
        options.rawCost.continuationOverheadTokens,
      rawTotalRequiredTokens:
        options.rawCost.totalRequiredTokens,
      selectedInputTokens:
        options.selectedCost?.inputTokens,
      selectedContinuationOverheadTokens:
        options.selectedCost?.continuationOverheadTokens,
      selectedTotalRequiredTokens:
        options.selectedCost?.totalRequiredTokens,
      compactionStatus: options.compactionStatus,
      compactionUsed: options.compactionUsed,
      compactionSourceRange: options.artifact
        ? {
            startSequence:
              options.artifact.sourceSequenceStart,
            endSequence:
              options.artifact.sourceSequenceEnd,
          }
        : undefined,
      protectedSourceSequences:
        options.artifact?.protectedSourceSequences ?? [],
      retainedTailStartSequence:
        options.artifact?.retainedTailStartSequence,
      requiredSourceSequences:
        options.requiredSourceSequences,
      latestSafeCompactionBoundarySequence:
        options.latestSafeCompactionBoundarySequence,
      lastDurableSequence: options.lastDurableSequence,
    },
  };
}

function estimateCandidate(
  estimator: AgentContextEstimator,
  input: readonly AgentModelInputItem[],
  tools: readonly AgentModelToolDefinition[],
  toolDefinitionTokens: number,
  budget: NormalizedBudget,
): CandidateCost {
  const inputTokens = estimate(
    estimator.estimateInputTokens(input),
    "input",
  );
  const continuationOverheadTokens = estimate(
    estimator.estimateContinuationOverheadTokens?.(
      input,
      tools,
    ) ?? 0,
    "continuation overhead",
  );

  return {
    inputTokens,
    continuationOverheadTokens,
    totalRequiredTokens:
      inputTokens +
      toolDefinitionTokens +
      continuationOverheadTokens +
      budget.reservedOutputTokens +
      budget.safetyMarginTokens,
  };
}

function validateBudget(
  budget: AgentContextBudgetConfig,
): NormalizedBudget {
  const contextLimitTokens = validateWholeNumber(
    budget.contextLimitTokens,
    "contextLimitTokens",
    true,
  );
  const reservedOutputTokens = validateWholeNumber(
    budget.reservedOutputTokens,
    "reservedOutputTokens",
    false,
  );
  const safetyMarginTokens = validateWholeNumber(
    budget.safetyMarginTokens ?? 0,
    "safetyMarginTokens",
    false,
  );

  return {
    contextLimitTokens,
    reservedOutputTokens,
    safetyMarginTokens,
  };
}

function validateEstimator(estimator: AgentContextEstimator): void {
  if (!estimator.id.trim()) {
    throw new AgentContextBudgetError(
      "invalid_estimate",
      "Agent context estimator id must not be empty",
    );
  }
  if (
    estimator.accuracy !== "exact" &&
    estimator.accuracy !== "estimated"
  ) {
    throw new AgentContextBudgetError(
      "invalid_estimate",
      "Agent context estimator accuracy must be exact or estimated",
    );
  }
}

function validateWholeNumber(
  value: number,
  name: string,
  positive: boolean,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (positive ? value <= 0 : value < 0)
  ) {
    throw new AgentContextBudgetError(
      "invalid_budget",
      name +
        (positive
          ? " must be a positive safe integer"
          : " must be a non-negative safe integer"),
    );
  }
  return value;
}

function estimate(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new AgentContextBudgetError(
      "invalid_estimate",
      "Agent context " + label + " estimate must be finite and non-negative",
    );
  }
  return Math.ceil(value);
}

function estimateJsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return 0;
  }
  return Buffer.byteLength(serialized, "utf8");
}

function collectRequiredSourceSequences(
  records: readonly AgentPersistedRecord[],
): readonly number[] {
  const required = new Set<number>();
  let latestUserSequence: number | undefined;
  const toolCalls = new Map<string, number>();

  for (const record of records) {
    if (record.kind === "model_input") {
      const input = record.payload as AgentModelInputItem;
      if (
        input.type === "message" &&
        input.role === "system"
      ) {
        required.add(record.sequence);
      }
      if (
        input.type === "message" &&
        input.role === "user"
      ) {
        latestUserSequence = record.sequence;
      }
      continue;
    }

    if (record.kind === "model_event") {
      const event = record.payload as AgentRunEvent;
      if (event.type !== "output_item.completed") {
        continue;
      }

      if (
        event.item.providerMetadata !== undefined ||
        (event.item.type === "reasoning" &&
          event.item.opaque !== undefined)
      ) {
        required.add(record.sequence);
      }

      if (event.item.type === "tool_call") {
        toolCalls.set(
          toolPairKey(
            event.item.callId,
            event.item.id,
          ),
          record.sequence,
        );
      }
      continue;
    }

    if (record.kind === "tool_result") {
      const result = record.payload as {
        readonly callId?: unknown;
        readonly toolCallItemId?: unknown;
      };
      if (
        typeof result.callId !== "string" ||
        typeof result.toolCallItemId !== "string"
      ) {
        continue;
      }
      const callSequence = toolCalls.get(
        toolPairKey(
          result.callId,
          result.toolCallItemId,
        ),
      );
      if (callSequence !== undefined) {
        required.add(callSequence);
        required.add(record.sequence);
      }
    }
  }

  if (latestUserSequence !== undefined) {
    required.add(latestUserSequence);
  }

  return [...required].sort((left, right) => left - right);
}

function toolPairKey(
  callId: string,
  itemId: string,
): string {
  return callId + "\u0000" + itemId;
}
