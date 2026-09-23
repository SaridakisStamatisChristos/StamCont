import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as errorOutput } from "node:process";

import type { ModelConfig } from "@continuedev/config-yaml";
import type { CoreAgentToolApprovalHandler } from "core/agent/adapters/coreToolRuntime.js";
import type { BuiltInExecutionProfileId } from "core/agent/capabilities.js";
import type { AgentCompactionSummarizer } from "core/agent/compaction.js";
import type {
  AgentModelDriver,
  AgentModelInputItem,
} from "core/agent/model.js";
import type { AgentRunEvent } from "core/agent/protocol.js";
import { createInitialAgentRunState } from "core/agent/reducer.js";

import { permissionModeToExecutionProfile } from "../agent/cliExecution.js";
import { createCliCoreAgentRuntime } from "../agent/cliCoreRuntime.js";
import {
  resolveCliAgentResumeSessionId,
  runCliAgentRuntime,
} from "../agent/runtime.js";
import { env } from "../env.js";
import { processCommandFlags } from "../flags/flagProcessor.js";
import type { PermissionMode } from "../permissions/types.js";
import {
  initializeServices,
  SERVICE_NAMES,
  serviceContainer,
  services,
} from "../services/index.js";
import type { ModelServiceState } from "../services/types.js";

export interface AgentCommandOptions {
  readonly config?: string;
  readonly org?: string;
  readonly rule?: string[];
  readonly mcp?: string[];
  readonly model?: string[];
  readonly prompt?: string[];
  readonly allow?: string[];
  readonly ask?: string[];
  readonly exclude?: string[];
  readonly agent?: string;
  readonly readonly?: boolean;
  readonly auto?: boolean;
  readonly verbose?: boolean;
  readonly resume?: true | string;
  readonly format?: "text" | "json";
  readonly maxIterations?: number;
}

export async function agent(
  prompt: string | undefined,
  options: AgentCommandOptions,
): Promise<void> {
  if (options.resume && prompt?.trim()) {
    throw new Error(
      "Do not provide a new prompt when resuming a durable agent session",
    );
  }

  const processed = processCommandFlags({
    readonly: options.readonly,
    auto: options.auto,
    allow: options.allow,
    ask: options.ask,
    exclude: options.exclude,
  });
  const mode: PermissionMode = processed.mode ?? "normal";
  const profile = permissionModeToExecutionProfile(mode);

  await initializeServices({
    options,
    headless: true,
    skipOnboarding: true,
    toolPermissionOverrides: {
      allow: options.allow,
      ask: options.ask,
      exclude: options.exclude,
      mode,
    },
  });

  const modelState = await serviceContainer.get<ModelServiceState>(
    SERVICE_NAMES.MODEL,
  );
  if (!modelState.model) {
    throw new Error("Model service is not initialized");
  }

  const rootDirectory = path.join(env.continueHome, "agent-sessions");
  const resumeSessionId = await resolveCliAgentResumeSessionId(
    rootDirectory,
    options.resume,
  );
  const sessionId =
    resumeSessionId ??
    cryptoSessionId();

  const approve = createApprovalHandler(profile);
  const runtime = createCliCoreAgentRuntime({
    model: modelState.model as ModelConfig,
    sessionId,
    profile,
    approve,
  });
  const systemPrompt = resumeSessionId
    ? undefined
    : await services.systemMessage.getSystemMessage(mode);

  const controller = new AbortController();
  const restoreSigint = installAgentSigint(controller);
  const renderer = new CliAgentRenderer(options.format ?? "text");

  try {
    const result = await runCliAgentRuntime({
      rootDirectory,
      sessionId,
      driver: runtime.driver,
      tools: runtime.toolExecutor.description.definitions,
      toolExecutor: runtime.toolExecutor,
      systemPrompt,
      userPrompt: prompt,
      resumeSessionId,
      signal: controller.signal,
      maxIterations: options.maxIterations,
      estimator: runtime.driver.capabilities.estimator,
      contextLimitTokens:
        runtime.driver.capabilities.contextLimitTokens,
      reservedOutputTokens:
        runtime.driver.capabilities.outputLimitTokens ??
        Math.min(
          64_000,
          Math.max(
            1_000,
            Math.floor(
              runtime.driver.capabilities.contextLimitTokens * 0.25,
            ),
          ),
        ),
      safetyMarginTokens: Math.min(
        15_000,
        Math.max(
          1_000,
          Math.floor(
            runtime.driver.capabilities.contextLimitTokens * 0.05,
          ),
        ),
      ),
      compactionSummarizer: createCompactionSummarizer(runtime.driver),
      onEvent: (event) => renderer.onEvent(event),
    });

    renderer.finish(result.sessionId, result.result);
    process.exitCode = exitCodeForStatus(result.result.status);
  } finally {
    restoreSigint();
    await runtime.toolExecutor.close();
  }
}

function cryptoSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `cli-${Date.now()}-${process.pid}`;
}

function createApprovalHandler(
  profile: BuiltInExecutionProfileId,
): CoreAgentToolApprovalHandler | undefined {
  if (profile === "full_access") {
    return undefined;
  }
  if (!input.isTTY || !errorOutput.isTTY) {
    return undefined;
  }

  return async (request) => {
    const rl = createInterface({ input, output: errorOutput });
    try {
      const answer = await rl.question(
        `Allow ${request.toolName} ${JSON.stringify(request.input)}? [y/N] `,
      );
      return /^y(?:es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

function installAgentSigint(
  controller: AbortController,
): () => void {
  const existing = process.listeners("SIGINT");
  process.removeAllListeners("SIGINT");

  const handler = () => {
    if (!controller.signal.aborted) {
      controller.abort("CLI SIGINT");
    }
  };
  process.on("SIGINT", handler);

  return () => {
    process.removeListener("SIGINT", handler);
    for (const listener of existing) {
      process.on("SIGINT", listener as any);
    }
  };
}

function createCompactionSummarizer(
  driver: AgentModelDriver,
): AgentCompactionSummarizer {
  return {
    async summarize(request, signal) {
      const inputItems: AgentModelInputItem[] = [
        {
          type: "message",
          role: "system",
          content:
            "Summarize the supplied agent history for future continuation. Preserve decisions, constraints, file paths, commands, tool outcomes, unresolved work, and user intent. Do not invent provider-native opaque data.",
        },
        {
          type: "message",
          role: "user",
          content: JSON.stringify({
            previousSummary: request.previousSummary?.summary,
            input: request.input,
          }),
        },
      ];
      let summary = "";
      for await (const event of driver.stream(
        {
          runState: createInitialAgentRunState(),
          input: inputItems,
          tools: [],
        },
        signal,
      )) {
        if (
          event.type === "output_item.completed" &&
          event.item.type === "message"
        ) {
          summary = event.item.content;
        }
      }
      if (!summary.trim()) {
        throw new Error("Compaction model returned an empty summary");
      }
      return summary;
    },
  };
}

class CliAgentRenderer {
  private readonly toolCalls: Array<{
    name: string;
    callId: string;
  }> = [];
  private sawContentDelta = false;
  private finalMessage = "";

  constructor(private readonly format: "text" | "json") {}

  onEvent(event: AgentRunEvent): void {
    if (event.type === "content.delta") {
      this.sawContentDelta = true;
      if (this.format === "text") {
        process.stdout.write(event.delta);
      }
      return;
    }

    if (event.type !== "output_item.completed") {
      return;
    }

    if (event.item.type === "message") {
      this.finalMessage = event.item.content;
      return;
    }

    if (event.item.type === "tool_call") {
      this.toolCalls.push({
        name: event.item.name,
        callId: event.item.callId,
      });
      if (this.format === "text") {
        errorOutput.write(
          `\n[tool] ${event.item.name} (${event.item.callId})\n`,
        );
      }
    }
  }

  finish(
    sessionId: string,
    result: {
      status: string;
      stopReason?: string;
      error?: unknown;
      input: readonly AgentModelInputItem[];
      iterations: number;
    },
  ): void {
    const canonicalFinal =
      finalAssistantMessage(result.input) || this.finalMessage;

    if (this.format === "json") {
      process.stdout.write(
        JSON.stringify({
          sessionId,
          status: result.status,
          stopReason: result.stopReason,
          error: result.error,
          iterations: result.iterations,
          output: canonicalFinal,
          toolCalls: this.toolCalls,
        }) + "\n",
      );
      return;
    }

    if (!this.sawContentDelta && canonicalFinal) {
      process.stdout.write(canonicalFinal);
    }
    if (canonicalFinal || this.sawContentDelta) {
      process.stdout.write("\n");
    }
    errorOutput.write(
      `[agent] session=${sessionId} status=${result.status}${
        result.stopReason ? ` stop=${result.stopReason}` : ""
      }\n`,
    );
    if (result.error) {
      errorOutput.write(
        `[agent] failure=${JSON.stringify(result.error)}\n`,
      );
    }
  }
}

function finalAssistantMessage(
  items: readonly AgentModelInputItem[],
): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item.type === "model_output" &&
      item.item.type === "message"
    ) {
      return item.item.content;
    }
  }
  return "";
}

function exitCodeForStatus(status: string): number {
  switch (status) {
    case "completed":
      return 0;
    case "cancelled":
      return 130;
    case "resume_blocked":
      return 3;
    case "max_tokens":
      return 2;
    default:
      return 1;
  }
}
