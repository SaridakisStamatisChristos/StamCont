import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentContextEstimator } from "core/agent/budget.js";
import {
  runAgentLoop,
  type AgentLoopResult,
} from "core/agent/loop.js";
import type {
  AgentModelDriver,
  AgentModelInputItem,
  AgentModelToolDefinition,
  AgentToolExecutor,
} from "core/agent/model.js";
import {
  AgentSessionStore,
  validateSessionId,
} from "core/agent/persistence.js";
import type { AgentRunEvent } from "core/agent/protocol.js";

export interface CliAgentRuntimeEvent {
  readonly event: AgentRunEvent;
}

export interface CliAgentRuntimeOptions {
  readonly rootDirectory: string;
  readonly driver: AgentModelDriver;
  readonly tools?: readonly AgentModelToolDefinition[];
  readonly toolExecutor?: AgentToolExecutor;
  readonly systemPrompt?: string;
  readonly userPrompt?: string;
  readonly resumeSessionId?: string;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly maxIterations?: number;
  readonly estimator?: AgentContextEstimator;
  readonly contextLimitTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens?: number;
  readonly compactionSummarizer?: {
    summarize(
      request: {
        readonly sessionId: string;
        readonly sourceSequenceStart: number;
        readonly sourceSequenceEnd: number;
        readonly input: readonly AgentModelInputItem[];
        readonly previousSummary?: {
          readonly sourceSequenceEnd: number;
          readonly summary: string;
        };
      },
      signal: AbortSignal,
    ): Promise<string>;
  };
  readonly onEvent?: (
    event: AgentRunEvent,
  ) => void | Promise<void>;
}

export interface CliAgentRuntimeResult {
  readonly sessionId: string;
  readonly resumed: boolean;
  readonly result: AgentLoopResult;
}

export async function runCliAgentRuntime(
  options: CliAgentRuntimeOptions,
): Promise<CliAgentRuntimeResult> {
  const resumed = Boolean(options.resumeSessionId);
  const sessionId =
    options.resumeSessionId ?? options.sessionId ?? randomUUID();
  const input = resumed
    ? []
    : buildInitialInput(options.systemPrompt, options.userPrompt);

  const store = await AgentSessionStore.open({
    rootDirectory: options.rootDirectory,
    sessionId,
  });

  try {
    const result = await runAgentLoop({
      driver: options.driver,
      input,
      tools: options.tools,
      toolExecutor: options.toolExecutor,
      signal: options.signal,
      maxIterations: options.maxIterations,
      onEvent: options.onEvent
        ? async (event) => {
            await options.onEvent?.(event);
          }
        : undefined,
      durability: {
        store,
        context: {
          budget: {
            contextLimitTokens: options.contextLimitTokens,
            reservedOutputTokens: options.reservedOutputTokens,
            safetyMarginTokens: options.safetyMarginTokens,
          },
          estimator: options.estimator,
          compactionSummarizer: options.compactionSummarizer,
        },
      },
    });

    return { sessionId, resumed, result };
  } finally {
    await store.close();
  }
}

export async function resolveCliAgentResumeSessionId(
  rootDirectory: string,
  requested: true | string | undefined,
): Promise<string | undefined> {
  if (typeof requested === "string") {
    const value = validateSessionId(requested.trim());
    const logPath = path.join(rootDirectory, value, "session.jsonl");
    try {
      const stat = await fs.stat(logPath);
      if (!stat.isFile()) {
        throw new Error("not a file");
      }
    } catch {
      throw new Error(`Durable agent session "${value}" does not exist`);
    }
    return value;
  }
  if (!requested) {
    return undefined;
  }

  let entries;
  try {
    entries = await fs.readdir(rootDirectory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new Error("No durable agent sessions are available to resume");
    }
    throw error;
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => {
        if (!entry.isDirectory()) {
          return false;
        }
        try {
          validateSessionId(entry.name);
          return true;
        } catch {
          return false;
        }
      })
      .map(async (entry) => {
        const logPath = path.join(
          rootDirectory,
          entry.name,
          "session.jsonl",
        );
        try {
          const stat = await fs.stat(logPath);
          return {
            sessionId: entry.name,
            modifiedAt: stat.mtimeMs,
          };
        } catch {
          return undefined;
        }
      }),
  );

  const latest = candidates
    .filter(
      (
        candidate,
      ): candidate is { sessionId: string; modifiedAt: number } =>
        candidate !== undefined,
    )
    .sort(
      (left, right) =>
        right.modifiedAt - left.modifiedAt ||
        left.sessionId.localeCompare(right.sessionId),
    )[0];

  if (!latest) {
    throw new Error("No durable agent sessions are available to resume");
  }
  return latest.sessionId;
}

function buildInitialInput(
  systemPrompt: string | undefined,
  userPrompt: string | undefined,
): AgentModelInputItem[] {
  const prompt = userPrompt?.trim();
  if (!prompt) {
    throw new Error("A prompt is required when starting a new agent session");
  }

  const input: AgentModelInputItem[] = [];
  const system = systemPrompt?.trim();
  if (system) {
    input.push({
      type: "message",
      role: "system",
      content: system,
    });
  }
  input.push({
    type: "message",
    role: "user",
    content: prompt,
  });
  return input;
}
