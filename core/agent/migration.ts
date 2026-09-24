import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  analyzeDurableAgentSession,
  appendAgentLifecycleState,
  appendDurableAgentUserTurn,
  initializeDurableAgentSession,
} from "./lifecycle";
import type {
  AgentModelInputItem,
  AgentModelMessageInput,
  AgentModelOutputInput,
  AgentToolResult,
} from "./model";
import {
  AgentSessionStore,
  validateSessionId,
} from "./persistence";
import type {
  AgentOutputItem,
  AgentRunEvent,
  AgentStopReason,
  JsonObject,
} from "./protocol";

export const AGENT_LEGACY_HISTORY_MIGRATION_VERSION = 1 as const;

export type AgentLegacyHistoryMigrationErrorCode =
  | "invalid_history"
  | "unsafe_boundary"
  | "publish_conflict";

export class AgentLegacyHistoryMigrationError extends Error {
  constructor(
    readonly code: AgentLegacyHistoryMigrationErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentLegacyHistoryMigrationError";
  }
}

export interface AgentLegacyHistoryMigrationOptions {
  readonly rootDirectory: string;
  readonly sessionId: string;
  readonly input: readonly AgentModelInputItem[];
}

interface LegacyResponseStep {
  readonly type: "response";
  readonly output: readonly AgentModelOutputInput[];
  readonly stopReason: Extract<AgentStopReason, "tool_use" | "end_turn">;
  readonly toolResults: readonly AgentToolResult[];
}

interface LegacyUserStep {
  readonly type: "user";
  readonly message: AgentModelMessageInput & { readonly role: "user" };
}

interface LegacyMigrationPlan {
  readonly initialInput: readonly AgentModelMessageInput[];
  readonly steps: readonly (LegacyResponseStep | LegacyUserStep)[];
}

export async function migrateLegacyAgentHistoryAtomically(
  options: AgentLegacyHistoryMigrationOptions,
): Promise<boolean> {
  const sessionId = validateSessionId(options.sessionId);
  const rootDirectory = path.resolve(options.rootDirectory);
  const targetDirectory = path.join(rootDirectory, sessionId);
  const targetLog = path.join(targetDirectory, "session.jsonl");

  // Durable state is authoritative. Once the canonical log exists, stale or
  // malformed surface history must never block or reinterpret resume.
  if (await fileExists(targetLog)) {
    return false;
  }

  const plan = buildLegacyMigrationPlan(options.input);
  if (!plan) {
    return false;
  }

  await fs.mkdir(rootDirectory, { recursive: true });
  const temporaryRoot = path.join(
    rootDirectory,
    ".compat-migration-" + randomUUID(),
  );
  const temporaryLog = path.join(
    temporaryRoot,
    sessionId,
    "session.jsonl",
  );
  let store: AgentSessionStore | undefined;

  try {
    store = await AgentSessionStore.open({
      rootDirectory: temporaryRoot,
      sessionId,
    });
    await importLegacyMigrationPlan(store, plan);
    await store.close();
    store = undefined;

    await fs.mkdir(targetDirectory, {
      recursive: true,
      mode: 0o700,
    });
    try {
      // The fully validated log is published with one filesystem operation.
      // A hard-link cannot overwrite an existing authoritative log, so a
      // concurrent winner is preserved rather than silently replaced.
      await fs.link(temporaryLog, targetLog);
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        return false;
      }
      throw new AgentLegacyHistoryMigrationError(
        "publish_conflict",
        "Failed to atomically publish migrated legacy agent history",
        error,
      );
    }
    return true;
  } finally {
    await store?.close().catch(() => undefined);
    await fs.rm(temporaryRoot, {
      recursive: true,
      force: true,
    });
  }
}

function buildLegacyMigrationPlan(
  input: readonly AgentModelInputItem[],
): LegacyMigrationPlan | undefined {
  const firstExecutionIndex = input.findIndex(
    (item) => item.type !== "message",
  );
  if (firstExecutionIndex < 0) {
    return undefined;
  }

  const initialInput = input.slice(
    0,
    firstExecutionIndex,
  ) as readonly AgentModelMessageInput[];
  if (
    initialInput.length === 0 ||
    !initialInput.some(
      (item) => item.role === "user",
    )
  ) {
    throw new AgentLegacyHistoryMigrationError(
      "invalid_history",
      "Legacy agent history must begin with supported system/user input before imported model execution",
    );
  }
  if (
    initialInput.some(
      (item) =>
        item.type !== "message" ||
        (item.role !== "system" && item.role !== "user"),
    )
  ) {
    throw new AgentLegacyHistoryMigrationError(
      "invalid_history",
      "Legacy agent history contains unsupported initial input",
    );
  }

  const steps: (LegacyResponseStep | LegacyUserStep)[] = [];
  let cursor = firstExecutionIndex;
  let lastStopReason: LegacyResponseStep["stopReason"] | undefined;

  while (cursor < input.length) {
    const current = input[cursor];
    if (current.type === "message") {
      if (current.role !== "user") {
        throw new AgentLegacyHistoryMigrationError(
          "invalid_history",
          "Legacy system messages are only supported before imported execution history",
        );
      }
      if (lastStopReason !== "end_turn") {
        throw new AgentLegacyHistoryMigrationError(
          "unsafe_boundary",
          "A legacy user turn may only follow a completed assistant end turn",
        );
      }
      steps.push({
        type: "user",
        message: current as AgentModelMessageInput & {
          readonly role: "user";
        },
      });
      cursor += 1;
      lastStopReason = undefined;
      continue;
    }

    if (current.type !== "model_output") {
      throw new AgentLegacyHistoryMigrationError(
        "invalid_history",
        "Legacy tool results must follow the imported tool-call response that produced them",
      );
    }

    const output: AgentModelOutputInput[] = [];
    while (
      cursor < input.length &&
      input[cursor].type === "model_output"
    ) {
      output.push(
        input[cursor] as AgentModelOutputInput,
      );
      cursor += 1;
    }

    const calls = output
      .map((item) => item.item)
      .filter(
        (item): item is Extract<AgentOutputItem, { type: "tool_call" }> =>
          item.type === "tool_call",
      );
    const callKeys = new Set(
      calls.map((call) => toolPairKey(call.id, call.callId)),
    );
    if (callKeys.size !== calls.length) {
      throw new AgentLegacyHistoryMigrationError(
        "invalid_history",
        "Legacy tool-call history contains duplicate canonical call identity",
      );
    }

    const toolResults: AgentToolResult[] = [];
    while (
      cursor < input.length &&
      input[cursor].type === "tool_result"
    ) {
      toolResults.push(input[cursor] as AgentToolResult);
      cursor += 1;
    }

    if (calls.length === 0) {
      if (toolResults.length > 0) {
        throw new AgentLegacyHistoryMigrationError(
          "invalid_history",
          "Legacy tool results are present without a completed imported tool call",
        );
      }
      lastStopReason = "end_turn";
      steps.push({
        type: "response",
        output,
        stopReason: "end_turn",
        toolResults: [],
      });
      continue;
    }

    const resultKeys = new Set(
      toolResults.map((result) =>
        toolPairKey(result.toolCallItemId, result.callId),
      ),
    );
    if (
      resultKeys.size !== toolResults.length ||
      resultKeys.size !== callKeys.size ||
      [...callKeys].some((key) => !resultKeys.has(key))
    ) {
      throw new AgentLegacyHistoryMigrationError(
        "unsafe_boundary",
        "Legacy tool-use history must contain exactly one resolved result for every imported tool call",
      );
    }
    if (
      cursor >= input.length ||
      input[cursor].type !== "model_output"
    ) {
      throw new AgentLegacyHistoryMigrationError(
        "unsafe_boundary",
        "Legacy history ends inside a tool-use round; refusing to make historical tool calls executable on resume",
      );
    }

    lastStopReason = "tool_use";
    steps.push({
      type: "response",
      output,
      stopReason: "tool_use",
      toolResults,
    });
  }

  if (lastStopReason !== "end_turn") {
    throw new AgentLegacyHistoryMigrationError(
      "unsafe_boundary",
      "Legacy history must end at a completed assistant end-turn boundary before a new durable user turn is appended",
    );
  }

  return { initialInput, steps };
}

async function importLegacyMigrationPlan(
  store: AgentSessionStore,
  plan: LegacyMigrationPlan,
): Promise<void> {
  let analysis = await initializeDurableAgentSession(
    store,
    plan.initialInput,
    [
      {
        compatibilityMigration: {
          schemaVersion: AGENT_LEGACY_HISTORY_MIGRATION_VERSION,
          source: "continue_chat_history",
        },
      },
    ],
  );
  let iteration = analysis.lastIteration;
  let eventSequence = analysis.replay.runState.lastSequence;

  for (const step of plan.steps) {
    if (step.type === "user") {
      await appendDurableAgentUserTurn(
        store,
        step.message.content,
      );
      await appendAgentLifecycleState(
        store,
        "running",
        iteration,
        { reason: "continue legacy history migration" },
      );
      analysis = analyzeDurableAgentSession(
        await store.readAllRecords(),
        store.sessionId,
      );
      continue;
    }

    iteration += 1;
    await appendAgentLifecycleState(
      store,
      "waiting_for_model",
      iteration,
      { reason: "continue legacy history migration" },
    );

    const responseId =
      "compat-migration-response-" + String(iteration);
    const appendEvent = async <
      T extends AgentRunEvent,
    >(
      event: Omit<T, "eventId" | "sequence" | "responseId">,
    ) => {
      eventSequence += 1;
      await store.appendModelEvent({
        ...event,
        responseId,
        eventId:
          "compat-migration-event-" + String(eventSequence),
        sequence: eventSequence,
      } as AgentRunEvent);
    };

    await appendEvent({ type: "response.started" });
    for (const item of step.output) {
      await appendEvent({
        type: "output_item.added",
        item: {
          id: item.item.id,
          type: item.item.type,
        },
      });
      await appendEvent({
        type: "output_item.completed",
        item: item.item,
      });
    }
    await appendEvent({
      type: "response.completed",
      stopReason: step.stopReason,
    });

    if (step.stopReason === "tool_use") {
      await appendAgentLifecycleState(
        store,
        "waiting_for_tool",
        iteration,
        { reason: "continue legacy history migration" },
      );
      for (const result of step.toolResults) {
        await store.appendToolResult(result);
      }
      await appendAgentLifecycleState(
        store,
        "running",
        iteration,
        { reason: "continue legacy history migration" },
      );
    } else {
      await appendAgentLifecycleState(
        store,
        "completed",
        iteration,
        { stopReason: "end_turn" },
      );
    }
  }

  analysis = analyzeDurableAgentSession(
    await store.readAllRecords(),
    store.sessionId,
  );
  if (
    analysis.disposition !== "terminal" ||
    analysis.terminalKind !== "completed" ||
    analysis.stopReason !== "end_turn"
  ) {
    throw new AgentLegacyHistoryMigrationError(
      "unsafe_boundary",
      "Migrated legacy history did not validate as a completed durable end turn",
    );
  }
}

function toolPairKey(itemId: string, callId: string): string {
  return itemId + "\u0000" + callId;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
