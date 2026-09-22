import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import * as path from "node:path";

import type {
  AgentModelInputItem,
  AgentModelOutputInput,
  AgentToolResult,
} from "./model";
import type {
  AgentPersistedRecord,
  AgentSessionStore,
} from "./persistence";
import { replayAgentSession } from "./persistence";
import type {
  AgentOutputItem,
  AgentRunEvent,
} from "./protocol";
import {
  createInitialAgentRunState,
  getExecutableToolCalls,
  reduceAgentRunEvent,
  type AgentRunState,
} from "./reducer";

export const AGENT_COMPACTION_SCHEMA_VERSION = 1 as const;
export const AGENT_COMPACTION_ALGORITHM_ID =
  "stamcont.agent.compaction" as const;
export const AGENT_COMPACTION_ALGORITHM_VERSION = 1 as const;
export const AGENT_COMPACTION_FILENAME =
  "session.compaction.json" as const;

export type AgentCompactionBoundaryKind =
  | "completed_turn"
  | "resolved_tool_round";

export interface AgentCompactionBoundary {
  readonly sequence: number;
  readonly kind: AgentCompactionBoundaryKind;
  readonly responseId: string;
  readonly toolCallIds: readonly string[];
}

export interface AgentCompactionArtifact {
  readonly schemaVersion: typeof AGENT_COMPACTION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly sourceSequenceStart: number;
  readonly sourceSequenceEnd: number;
  readonly sourceFingerprint: string;
  readonly summaryFingerprint: string;
  readonly createdAt: number;
  readonly createdAtLogSequence: number;
  readonly retainedTailStartSequence: number;
  readonly protectedSourceSequences: readonly number[];
  readonly boundary: AgentCompactionBoundary;
  readonly algorithm: {
    readonly id: typeof AGENT_COMPACTION_ALGORITHM_ID;
    readonly version: typeof AGENT_COMPACTION_ALGORITHM_VERSION;
  };
  readonly summary: string;
}

export interface AgentCompactionPreviousSummary {
  readonly sourceSequenceEnd: number;
  readonly summary: string;
}

export interface AgentCompactionSummarizerRequest {
  readonly sessionId: string;
  readonly sourceSequenceStart: number;
  readonly sourceSequenceEnd: number;
  readonly input: readonly AgentModelInputItem[];
  readonly previousSummary?: AgentCompactionPreviousSummary;
}

export interface AgentCompactionSummarizer {
  summarize(
    request: AgentCompactionSummarizerRequest,
    signal: AbortSignal,
  ): Promise<string>;
}

export type AgentCompactionErrorCode =
  | "no_safe_boundary"
  | "empty_summary"
  | "invalid_artifact"
  | "stale_artifact";

export class AgentCompactionError extends Error {
  constructor(
    readonly code: AgentCompactionErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentCompactionError";
  }
}

export type AgentCompactionArtifactStatus =
  | "missing"
  | "valid"
  | "stale"
  | "corrupt";

export interface AgentCompactionArtifactReadResult {
  readonly status: AgentCompactionArtifactStatus;
  readonly artifact?: AgentCompactionArtifact;
  readonly error?: AgentCompactionError;
}

export interface CompactAgentHistoryOptions {
  readonly targetSequence?: number;
  readonly previousArtifact?: AgentCompactionArtifact;
  readonly createdAt?: number;
  readonly signal?: AbortSignal;
}

export interface CompactAndPersistAgentHistoryOptions
  extends Omit<CompactAgentHistoryOptions, "previousArtifact"> {
  readonly usePreviousArtifact?: boolean;
}

interface ProjectedAgentInput {
  readonly sourceSequence: number;
  readonly responseId?: string;
  readonly input: AgentModelInputItem;
}

interface SafeBoundaryScan {
  readonly boundaries: readonly AgentCompactionBoundary[];
}

let compactionTempCounter = 0;

export function findLatestSafeAgentCompactionBoundary(
  records: readonly AgentPersistedRecord[],
  sessionId: string,
  targetSequence?: number,
): AgentCompactionBoundary | undefined {
  validateTargetSequence(targetSequence);
  replayAgentSession(records, sessionId);

  const scan = scanSafeBoundaries(records);
  const limit = targetSequence ?? Number.POSITIVE_INFINITY;
  return scan.boundaries
    .filter((boundary) => boundary.sequence <= limit)
    .at(-1);
}

export async function compactAgentHistory(
  records: readonly AgentPersistedRecord[],
  sessionId: string,
  summarizer: AgentCompactionSummarizer,
  options: CompactAgentHistoryOptions = {},
): Promise<AgentCompactionArtifact> {
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) {
    throw signal.reason ?? new Error("Agent compaction was aborted");
  }

  replayAgentSession(records, sessionId);
  const boundary = findLatestSafeAgentCompactionBoundary(
    records,
    sessionId,
    options.targetSequence,
  );
  if (!boundary) {
    throw new AgentCompactionError(
      "no_safe_boundary",
      "No semantically safe agent compaction boundary is available",
    );
  }

  const previousArtifact = options.previousArtifact;
  if (previousArtifact) {
    assertArtifactMatchesRecords(
      records,
      sessionId,
      previousArtifact,
    );
    if (previousArtifact.sourceSequenceEnd === boundary.sequence) {
      return previousArtifact;
    }
    if (previousArtifact.sourceSequenceEnd > boundary.sequence) {
      throw new AgentCompactionError(
        "stale_artifact",
        "Previous compaction extends beyond the selected safe boundary",
      );
    }
  }

  const projected = projectAgentInput(records);
  const previousSequenceEnd =
    previousArtifact?.sourceSequenceEnd ?? 0;
  const summaryInput = projected
    .filter(
      (item) =>
        item.sourceSequence > previousSequenceEnd &&
        item.sourceSequence <= boundary.sequence,
    )
    .flatMap((item) => {
      const sanitized = sanitizeInputForSummary(item.input);
      return sanitized ? [sanitized] : [];
    });

  const summary = (
    await summarizer.summarize(
      {
        sessionId,
        sourceSequenceStart: previousSequenceEnd + 1,
        sourceSequenceEnd: boundary.sequence,
        input: summaryInput,
        previousSummary: previousArtifact
          ? {
              sourceSequenceEnd:
                previousArtifact.sourceSequenceEnd,
              summary: previousArtifact.summary,
            }
          : undefined,
      },
      signal,
    )
  ).trim();

  if (!summary) {
    throw new AgentCompactionError(
      "empty_summary",
      "Agent compaction summarizer returned an empty summary",
    );
  }

  if (signal.aborted) {
    throw signal.reason ?? new Error("Agent compaction was aborted");
  }

  const protectedSourceSequences =
    collectProtectedSourceSequences(projected, boundary);
  const sourceRecords = records.filter(
    (record) => record.sequence <= boundary.sequence,
  );
  const lastLogSequence = records.at(-1)?.sequence ?? 0;

  return {
    schemaVersion: AGENT_COMPACTION_SCHEMA_VERSION,
    sessionId,
    sourceSequenceStart: sourceRecords[0]?.sequence ?? 1,
    sourceSequenceEnd: boundary.sequence,
    sourceFingerprint: fingerprintRecords(sourceRecords),
    summaryFingerprint: fingerprintText(summary),
    createdAt: options.createdAt ?? Date.now(),
    createdAtLogSequence: lastLogSequence,
    retainedTailStartSequence: boundary.sequence + 1,
    protectedSourceSequences,
    boundary,
    algorithm: {
      id: AGENT_COMPACTION_ALGORITHM_ID,
      version: AGENT_COMPACTION_ALGORITHM_VERSION,
    },
    summary,
  };
}

export async function compactAndPersistAgentHistory(
  store: AgentSessionStore,
  summarizer: AgentCompactionSummarizer,
  options: CompactAndPersistAgentHistoryOptions = {},
): Promise<AgentCompactionArtifact> {
  const records = await store.readAllRecords();
  let previousArtifact: AgentCompactionArtifact | undefined;

  if (options.usePreviousArtifact !== false) {
    const existing = await readAgentCompactionArtifact(store);
    if (existing.status === "valid") {
      previousArtifact = existing.artifact;
    }
  }

  const artifact = await compactAgentHistory(
    records,
    store.sessionId,
    summarizer,
    {
      targetSequence: options.targetSequence,
      createdAt: options.createdAt,
      signal: options.signal,
      previousArtifact,
    },
  );

  if (artifact !== previousArtifact) {
    await writeAgentCompactionArtifact(store, artifact);
  }
  return artifact;
}

export function buildCompactedAgentInput(
  records: readonly AgentPersistedRecord[],
  sessionId: string,
  artifact: AgentCompactionArtifact,
): readonly AgentModelInputItem[] {
  replayAgentSession(records, sessionId);
  assertArtifactMatchesRecords(records, sessionId, artifact);

  const protectedSequences = new Set(
    artifact.protectedSourceSequences,
  );
  const projected = projectAgentInput(records);
  const protectedPrefix = projected.filter(
    (item) =>
      item.sourceSequence <= artifact.sourceSequenceEnd &&
      protectedSequences.has(item.sourceSequence),
  );
  const leadingSystemItems = protectedPrefix.filter(
    (item) =>
      item.input.type === "message" &&
      item.input.role === "system",
  );
  const otherProtectedItems = protectedPrefix.filter(
    (item) =>
      !(
        item.input.type === "message" &&
        item.input.role === "system"
      ),
  );
  const retainedTail = projected.filter(
    (item) =>
      item.sourceSequence > artifact.sourceSequenceEnd,
  );

  const summaryItem: AgentModelOutputInput = {
    type: "model_output",
    item: {
      id:
        "stamcont-compaction:" +
        artifact.sourceSequenceStart +
        ":" +
        artifact.sourceSequenceEnd,
      type: "message",
      role: "assistant",
      content: artifact.summary,
    },
  };

  return [
    ...leadingSystemItems.map((item) => item.input),
    summaryItem,
    ...otherProtectedItems.map((item) => item.input),
    ...retainedTail.map((item) => item.input),
  ];
}

export function getAgentCompactionPath(
  store: AgentSessionStore,
): string {
  return path.join(
    store.paths.directory,
    AGENT_COMPACTION_FILENAME,
  );
}

export async function writeAgentCompactionArtifact(
  store: AgentSessionStore,
  artifact: AgentCompactionArtifact,
): Promise<void> {
  const records = await store.readAllRecords();
  assertArtifactMatchesRecords(
    records,
    store.sessionId,
    artifact,
  );
  await writeAtomicJson(
    getAgentCompactionPath(store),
    artifact,
  );
}

export async function readAgentCompactionArtifact(
  store: AgentSessionStore,
): Promise<AgentCompactionArtifactReadResult> {
  const filePath = getAgentCompactionPath(store);
  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { status: "missing" };
    }
    throw error;
  }

  let artifact: AgentCompactionArtifact;
  try {
    artifact = validateArtifact(
      JSON.parse(raw) as unknown,
      store.sessionId,
    );
  } catch (error) {
    return {
      status: "corrupt",
      error:
        error instanceof AgentCompactionError
          ? error
          : new AgentCompactionError(
              "invalid_artifact",
              "Agent compaction artifact is not valid JSON",
              error,
            ),
    };
  }

  const records = await store.readAllRecords();
  try {
    assertArtifactMatchesRecords(
      records,
      store.sessionId,
      artifact,
    );
  } catch (error) {
    return {
      status: "stale",
      artifact,
      error:
        error instanceof AgentCompactionError
          ? error
          : new AgentCompactionError(
              "stale_artifact",
              "Agent compaction artifact no longer matches durable history",
              error,
            ),
    };
  }

  return { status: "valid", artifact };
}

function scanSafeBoundaries(
  records: readonly AgentPersistedRecord[],
): SafeBoundaryScan {
  let state: AgentRunState = createInitialAgentRunState();
  let pendingToolCalls = new Set<string>();
  let pendingResponseId: string | undefined;
  let pendingToolCallIds: string[] = [];
  const boundaries: AgentCompactionBoundary[] = [];

  for (const record of records) {
    if (record.kind === "model_event") {
      const event = record.payload as AgentRunEvent;
      state = reduceAgentRunEvent(state, event);

      if (event.type === "response.completed") {
        if (event.stopReason === "tool_use") {
          const calls = getExecutableToolCalls(
            state,
            event.responseId,
          );
          pendingToolCalls = new Set(
            calls.map((call) =>
              toolResultKey(call.callId, call.id),
            ),
          );
          pendingResponseId = event.responseId;
          pendingToolCallIds = [
            ...new Set(
              calls.map((call) => call.callId),
            ),
          ];
        } else if (pendingToolCalls.size === 0) {
          boundaries.push({
            sequence: record.sequence,
            kind: "completed_turn",
            responseId: event.responseId,
            toolCallIds: [],
          });
        }
      }
      continue;
    }

    if (
      record.kind === "tool_result" &&
      pendingToolCalls.size > 0
    ) {
      const result = record.payload as AgentToolResult;
      pendingToolCalls.delete(
        toolResultKey(
          result.callId,
          result.toolCallItemId,
        ),
      );

      if (
        pendingToolCalls.size === 0 &&
        pendingResponseId
      ) {
        boundaries.push({
          sequence: record.sequence,
          kind: "resolved_tool_round",
          responseId: pendingResponseId,
          toolCallIds: [...pendingToolCallIds],
        });
        pendingResponseId = undefined;
        pendingToolCallIds = [];
      }
    }
  }

  return { boundaries };
}

function projectAgentInput(
  records: readonly AgentPersistedRecord[],
): readonly ProjectedAgentInput[] {
  let state = createInitialAgentRunState();
  const completedItemSequences = new Map<string, number>();
  const projected: ProjectedAgentInput[] = [];

  for (const record of records) {
    switch (record.kind) {
      case "model_input":
        projected.push({
          sourceSequence: record.sequence,
          input:
            record.payload as AgentModelInputItem,
        });
        break;

      case "model_event": {
        const event = record.payload as AgentRunEvent;
        state = reduceAgentRunEvent(state, event);

        if (event.type === "output_item.completed") {
          completedItemSequences.set(
            itemSequenceKey(
              event.responseId,
              event.item.id,
            ),
            record.sequence,
          );
        }

        if (event.type === "response.completed") {
          const response = state.responses.find(
            (candidate) =>
              candidate.responseId === event.responseId,
          );
          if (response?.status === "completed") {
            for (const output of response.outputItems) {
              if (
                output.status !== "completed" ||
                !output.completedItem
              ) {
                continue;
              }
              projected.push({
                sourceSequence:
                  completedItemSequences.get(
                    itemSequenceKey(
                      event.responseId,
                      output.id,
                    ),
                  ) ?? record.sequence,
                responseId: event.responseId,
                input: {
                  type: "model_output",
                  item: output.completedItem,
                },
              });
            }
          }
        }
        break;
      }

      case "tool_result":
        projected.push({
          sourceSequence: record.sequence,
          input: record.payload as AgentToolResult,
        });
        break;

      case "lifecycle":
      case "metadata":
        break;
    }
  }

  return projected;
}

function collectProtectedSourceSequences(
  projected: readonly ProjectedAgentInput[],
  boundary: AgentCompactionBoundary,
): readonly number[] {
  const prefix = projected.filter(
    (item) =>
      item.sourceSequence <= boundary.sequence,
  );
  const protectedSequences = new Set<number>();
  const protectedCallIds = new Set<string>();

  for (const item of prefix) {
    if (
      item.input.type === "message" &&
      item.input.role === "system"
    ) {
      protectedSequences.add(item.sourceSequence);
    }

    if (
      item.input.type === "model_output" &&
      hasProviderNativeState(item.input.item)
    ) {
      protectedSequences.add(item.sourceSequence);
      if (item.input.item.type === "tool_call") {
        protectedCallIds.add(item.input.item.callId);
      }
    }
  }

  const latestUser = prefix
    .filter(
      (item) =>
        item.input.type === "message" &&
        item.input.role === "user",
    )
    .at(-1);
  if (latestUser) {
    protectedSequences.add(latestUser.sourceSequence);
  }

  if (boundary.kind === "resolved_tool_round") {
    for (const callId of boundary.toolCallIds) {
      protectedCallIds.add(callId);
    }
  }

  for (const item of prefix) {
    if (
      item.input.type === "model_output" &&
      item.input.item.type === "tool_call" &&
      protectedCallIds.has(item.input.item.callId)
    ) {
      protectedSequences.add(item.sourceSequence);
    }
    if (
      item.input.type === "tool_result" &&
      protectedCallIds.has(item.input.callId)
    ) {
      protectedSequences.add(item.sourceSequence);
    }
  }

  return [...protectedSequences].sort(
    (left, right) => left - right,
  );
}

function hasProviderNativeState(
  item: AgentOutputItem,
): boolean {
  return (
    item.providerMetadata !== undefined ||
    (item.type === "reasoning" &&
      item.opaque !== undefined)
  );
}

function sanitizeInputForSummary(
  input: AgentModelInputItem,
): AgentModelInputItem | undefined {
  if (input.type === "message") {
    return {
      type: "message",
      role: input.role,
      content: input.content,
    };
  }

  if (input.type === "tool_result") {
    return input.status === "success"
      ? {
          type: "tool_result",
          status: "success",
          toolCallItemId: input.toolCallItemId,
          callId: input.callId,
          name: input.name,
          output: input.output,
        }
      : {
          type: "tool_result",
          status: "failure",
          toolCallItemId: input.toolCallItemId,
          callId: input.callId,
          name: input.name,
          error: input.error,
        };
  }

  const item = input.item;
  if (item.type === "message") {
    return {
      type: "model_output",
      item: {
        id: item.id,
        type: "message",
        role: "assistant",
        content: item.content,
      },
    };
  }
  if (item.type === "reasoning") {
    if (!item.text) {
      return undefined;
    }
    return {
      type: "model_output",
      item: {
        id: item.id,
        type: "reasoning",
        text: item.text,
      },
    };
  }
  return {
    type: "model_output",
    item: {
      id: item.id,
      type: "tool_call",
      callId: item.callId,
      name: item.name,
      input: item.input,
    },
  };
}

function assertArtifactMatchesRecords(
  records: readonly AgentPersistedRecord[],
  sessionId: string,
  artifact: AgentCompactionArtifact,
): void {
  validateArtifact(artifact, sessionId);
  replayAgentSession(records, sessionId);

  const firstSequence = records[0]?.sequence;
  const lastSequence = records.at(-1)?.sequence ?? 0;
  if (
    firstSequence === undefined ||
    artifact.sourceSequenceStart !== firstSequence ||
    artifact.sourceSequenceEnd > lastSequence
  ) {
    throw new AgentCompactionError(
      "stale_artifact",
      "Compaction source range is not the durable history prefix",
    );
  }

  const sourceRecords = records.filter(
    (record) =>
      record.sequence >= artifact.sourceSequenceStart &&
      record.sequence <= artifact.sourceSequenceEnd,
  );
  if (
    sourceRecords.length === 0 ||
    sourceRecords[0].sequence !==
      artifact.sourceSequenceStart ||
    sourceRecords.at(-1)?.sequence !==
      artifact.sourceSequenceEnd
  ) {
    throw new AgentCompactionError(
      "stale_artifact",
      "Compaction source range is not present in durable history",
    );
  }

  if (
    fingerprintRecords(sourceRecords) !==
    artifact.sourceFingerprint
  ) {
    throw new AgentCompactionError(
      "stale_artifact",
      "Compaction source fingerprint does not match durable history",
    );
  }

  const expectedBoundary = scanSafeBoundaries(records)
    .boundaries.find(
      (boundary) =>
        boundary.sequence ===
        artifact.sourceSequenceEnd,
    );
  if (
    !expectedBoundary ||
    !sameBoundary(expectedBoundary, artifact.boundary)
  ) {
    throw new AgentCompactionError(
      "stale_artifact",
      "Compaction boundary no longer matches durable history",
    );
  }

  const expectedProtected =
    collectProtectedSourceSequences(
      projectAgentInput(records),
      expectedBoundary,
    );
  if (
    expectedProtected.length !==
      artifact.protectedSourceSequences.length ||
    expectedProtected.some(
      (sequence, index) =>
        sequence !==
        artifact.protectedSourceSequences[index],
    )
  ) {
    throw new AgentCompactionError(
      "stale_artifact",
      "Compaction protected references no longer match durable history",
    );
  }
}

function validateArtifact(
  value: unknown,
  sessionId: string,
): AgentCompactionArtifact {
  if (!isUnknownRecord(value)) {
    throw invalidArtifact(
      "Agent compaction artifact is not an object",
    );
  }
  if (
    value.schemaVersion !==
      AGENT_COMPACTION_SCHEMA_VERSION
  ) {
    throw invalidArtifact(
      "Unsupported agent compaction schema version " +
        String(value.schemaVersion),
    );
  }
  if (value.sessionId !== sessionId) {
    throw invalidArtifact(
      "Agent compaction artifact belongs to another session",
    );
  }
  if (
    !isPositiveSafeInteger(value.sourceSequenceStart) ||
    !isPositiveSafeInteger(value.sourceSequenceEnd) ||
    value.sourceSequenceStart > value.sourceSequenceEnd ||
    typeof value.sourceFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sourceFingerprint) ||
    typeof value.summaryFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.summaryFingerprint) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    !isNonNegativeSafeInteger(
      value.createdAtLogSequence,
    ) ||
    value.createdAtLogSequence <
      value.sourceSequenceEnd ||
    !isPositiveSafeInteger(
      value.retainedTailStartSequence,
    ) ||
    value.retainedTailStartSequence !==
      value.sourceSequenceEnd + 1 ||
    typeof value.summary !== "string" ||
    value.summary.trim().length === 0 ||
    fingerprintText(value.summary) !==
      value.summaryFingerprint
  ) {
    throw invalidArtifact(
      "Agent compaction artifact has an invalid envelope",
    );
  }

  if (!Array.isArray(value.protectedSourceSequences)) {
    throw invalidArtifact(
      "Agent compaction protected source references are invalid",
    );
  }
  let previousSequence = 0;
  for (const sequence of value.protectedSourceSequences) {
    if (
      !isPositiveSafeInteger(sequence) ||
      sequence < value.sourceSequenceStart ||
      sequence > value.sourceSequenceEnd ||
      sequence <= previousSequence
    ) {
      throw invalidArtifact(
        "Agent compaction protected source references are invalid",
      );
    }
    previousSequence = sequence;
  }

  if (
    !isUnknownRecord(value.algorithm) ||
    value.algorithm.id !==
      AGENT_COMPACTION_ALGORITHM_ID ||
    value.algorithm.version !==
      AGENT_COMPACTION_ALGORITHM_VERSION
  ) {
    throw invalidArtifact(
      "Agent compaction algorithm identity is unsupported",
    );
  }

  if (
    !isUnknownRecord(value.boundary) ||
    value.boundary.sequence !==
      value.sourceSequenceEnd ||
    (value.boundary.kind !== "completed_turn" &&
      value.boundary.kind !==
        "resolved_tool_round") ||
    typeof value.boundary.responseId !== "string" ||
    value.boundary.responseId.trim().length === 0 ||
    !Array.isArray(value.boundary.toolCallIds) ||
    !value.boundary.toolCallIds.every(
      (callId) =>
        typeof callId === "string" &&
        callId.trim().length > 0,
    ) ||
    new Set(value.boundary.toolCallIds).size !==
      value.boundary.toolCallIds.length
  ) {
    throw invalidArtifact(
      "Agent compaction boundary provenance is invalid",
    );
  }

  return value as unknown as AgentCompactionArtifact;
}

function fingerprintRecords(
  records: readonly AgentPersistedRecord[],
): string {
  return fingerprintText(JSON.stringify(records));
}

function fingerprintText(value: string): string {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

function sameBoundary(
  left: AgentCompactionBoundary,
  right: AgentCompactionBoundary,
): boolean {
  return (
    left.sequence === right.sequence &&
    left.kind === right.kind &&
    left.responseId === right.responseId &&
    left.toolCallIds.length ===
      right.toolCallIds.length &&
    left.toolCallIds.every(
      (callId, index) =>
        callId === right.toolCallIds[index],
    )
  );
}

function toolResultKey(
  callId: string,
  itemId: string,
): string {
  return callId + "\u0000" + itemId;
}

function itemSequenceKey(
  responseId: string,
  itemId: string,
): string {
  return responseId + "\u0000" + itemId;
}

async function writeAtomicJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const tempPath =
    filePath +
    ".tmp-" +
    process.pid +
    "-" +
    compactionTempCounter++;
  let created = false;

  try {
    const handle = await open(
      tempPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(
        JSON.stringify(value) + "\n",
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    created = false;
    if (process.platform !== "win32") {
      await chmod(filePath, 0o600);
      await syncDirectory(path.dirname(filePath));
    }
  } finally {
    if (created) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

async function syncDirectory(
  directory: string,
): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (
      !isNodeError(
        error,
        "EINVAL",
        "ENOTSUP",
        "EBADF",
        "EPERM",
      )
    ) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function validateTargetSequence(
  value: number | undefined,
): void {
  if (
    value !== undefined &&
    !isPositiveSafeInteger(value)
  ) {
    throw new RangeError(
      "Agent compaction targetSequence must be a positive safe integer",
    );
  }
}

function isPositiveSafeInteger(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function isNonNegativeSafeInteger(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function invalidArtifact(
  message: string,
): AgentCompactionError {
  return new AgentCompactionError(
    "invalid_artifact",
    message,
  );
}

function isUnknownRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isNodeError(
  error: unknown,
  ...codes: string[]
): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as Error & { code?: unknown })
      .code === "string" &&
    codes.includes(
      (error as Error & { code: string }).code,
    )
  );
}
