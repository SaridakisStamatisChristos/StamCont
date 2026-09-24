import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  CoreAgentToolApprovalHandler,
  CoreAgentToolApprovalRequest,
} from "./adapters/coreToolRuntime";
import type { AgentCompactionSummarizer } from "./compaction";
import { emitAgentCompatibilityFailureDiagnostic } from "./compatibility";
import { migrateLegacyAgentHistoryAtomically } from "./migration";
import {
  AgentDiagnosticsBuffer,
  type AgentDebugBundle,
  type AgentDiagnosticEvent,
} from "./diagnostics";
import type { BuiltInExecutionProfileId } from "./capabilities";
import {
  analyzeDurableAgentSession,
  appendDurableAgentUserTurn,
  type AgentDurableContextOptions,
} from "./lifecycle";
import {
  runAgentLoop,
  type AgentLoopResult,
} from "./loop";
import type {
  AgentModelDriver,
  AgentModelInputItem,
  AgentModelToolDefinition,
  AgentToolExecutionContext,
  AgentToolExecutionOutcome,
  AgentToolExecutor,
} from "./model";
import {
  AgentSessionStore,
  validateSessionId,
} from "./persistence";
import type {
  AgentRunEvent,
  AgentToolCallItem,
} from "./protocol";
import { createInitialAgentRunState } from "./reducer";
import type {
  AgentSurfaceApproval,
  AgentSurfaceEvent,
  AgentSurfaceRunRequest,
  AgentSurfaceRunResult,
  AgentSurfaceSessionMetadata,
  AgentSurfaceSessionSnapshot,
  AgentSurfaceTimelineItem,
} from "./surface";

export interface AgentSurfaceResolvedRuntime {
  readonly driver: AgentModelDriver;
  readonly tools: readonly AgentModelToolDefinition[];
  readonly toolExecutor?: AgentToolExecutor & {
    cancel?(reason?: string): Promise<boolean>;
    close?(): Promise<boolean>;
  };
  readonly context: AgentDurableContextOptions;
  close?(): Promise<void>;
}

export interface AgentSurfaceRuntimeFactoryRequest {
  readonly request: AgentSurfaceRunRequest;
  readonly approve: CoreAgentToolApprovalHandler;
  readonly onToolRunning: (request: {
    readonly itemId: string;
    readonly callId: string;
    readonly toolName: string;
  }) => void;
}

export type AgentSurfaceRuntimeFactory = (
  request: AgentSurfaceRuntimeFactoryRequest,
) => Promise<AgentSurfaceResolvedRuntime> | AgentSurfaceResolvedRuntime;

interface ActiveSurfaceRun {
  readonly controller: AbortController;
  readonly approvals: Map<
    string,
    {
      readonly resolve: (approved: boolean) => void;
      readonly abort: () => void;
    }
  >;
  toolExecutor?: AgentSurfaceResolvedRuntime["toolExecutor"];
}

export class AgentSurfaceRuntime {
  private readonly activeRuns = new Map<string, ActiveSurfaceRun>();
  readonly diagnostics: AgentDiagnosticsBuffer;

  constructor(
    readonly rootDirectory: string,
    private readonly createRuntime: AgentSurfaceRuntimeFactory,
    diagnostics: AgentDiagnosticsBuffer = new AgentDiagnosticsBuffer(),
  ) {
    this.diagnostics = diagnostics;
  }

  getDiagnostics(
    sessionId?: string,
  ): readonly AgentDiagnosticEvent[] {
    return this.diagnostics.list(sessionId);
  }

  getDebugBundle(
    sessionId: string,
    version?: string,
  ): AgentDebugBundle {
    return this.diagnostics.buildDebugBundle({
      sessionId: validateSessionId(sessionId),
      ...(version ? { version } : {}),
    });
  }

  async *stream(
    request: AgentSurfaceRunRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentSurfaceEvent, AgentSurfaceRunResult> {
    const sessionId = validateSessionId(request.sessionId);
    if (this.activeRuns.has(sessionId)) {
      throw new Error(
        `Agent session "${sessionId}" already has an active run`,
      );
    }

    const queue = new AsyncResultQueue<
      AgentSurfaceEvent,
      AgentSurfaceRunResult
    >();
    let settled = false;
    void this.execute(request, signal, (event) => queue.push(event))
      .then((result) => {
        settled = true;
        queue.finish(result);
      })
      .catch((error) => {
        settled = true;
        queue.fail(error);
      });

    try {
      while (true) {
        const next = await queue.next();
        if (next.done) {
          return next.value;
        }
        yield next.value;
      }
    } finally {
      if (!settled) {
        await this.cancel(sessionId, "surface stream closed");
      }
    }
  }

  async approve(
    sessionId: string,
    approvalId: string,
    approved: boolean,
  ): Promise<boolean> {
    const run = this.activeRuns.get(sessionId);
    const pending = run?.approvals.get(approvalId);
    if (!run || !pending) {
      return false;
    }
    run.approvals.delete(approvalId);
    pending.abort();
    pending.resolve(approved);
    return true;
  }

  async cancel(
    sessionId: string,
    reason = "agent run cancelled",
  ): Promise<boolean> {
    const run = this.activeRuns.get(sessionId);
    if (!run) {
      return false;
    }

    if (!run.controller.signal.aborted) {
      run.controller.abort(reason);
    }
    this.resolveAllApprovals(run, false);
    await run.toolExecutor?.cancel?.(reason);
    return true;
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const run = this.activeRuns.get(sessionId);
    if (!run) {
      return false;
    }
    await this.cancel(sessionId, "agent surface closed");
    await run.toolExecutor?.close?.();
    return true;
  }

  async closeAllSessions(): Promise<number> {
    const sessionIds = [...this.activeRuns.keys()];
    const results = await Promise.all(
      sessionIds.map((sessionId) => this.closeSession(sessionId)),
    );
    return results.filter(Boolean).length;
  }

  async getSession(
    requestedSessionId: string,
  ): Promise<AgentSurfaceSessionSnapshot | undefined> {
    const sessionId = validateSessionId(requestedSessionId);
    if (this.activeRuns.has(sessionId)) {
      return undefined;
    }
    const logPath = path.join(
      this.rootDirectory,
      sessionId,
      "session.jsonl",
    );
    try {
      const stat = await fs.stat(logPath);
      if (!stat.isFile()) {
        return undefined;
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }

    const store = await AgentSessionStore.open({
      rootDirectory: this.rootDirectory,
      sessionId,
    });
    try {
      const records = await store.readAllRecords();
      if (records.length === 0) {
        return undefined;
      }
      const analysis = analyzeDurableAgentSession(records, sessionId);
      return {
        sessionId,
        status: surfaceStatus(analysis),
        lifecycleState: analysis.lifecycleState,
        stopReason: analysis.stopReason,
        error: analysis.error,
        blockReason: analysis.blockReason,
        timeline: projectTimeline(analysis.replay.input),
      };
    } finally {
      await store.close();
    }
  }

  async listSessions(): Promise<readonly AgentSurfaceSessionMetadata[]> {
    let entries;
    try {
      entries = await fs.readdir(this.rootDirectory, {
        withFileTypes: true,
      });
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            validateSessionId(entry.name);
          } catch {
            return undefined;
          }
          const logPath = path.join(
            this.rootDirectory,
            entry.name,
            "session.jsonl",
          );
          try {
            const stat = await fs.stat(logPath);
            if (!stat.isFile()) {
              return undefined;
            }
            return {
              sessionId: entry.name,
              modifiedAt: stat.mtimeMs,
            } satisfies AgentSurfaceSessionMetadata;
          } catch {
            return undefined;
          }
        }),
    );

    return sessions
      .filter(
        (
          session,
        ): session is AgentSurfaceSessionMetadata =>
          session !== undefined,
      )
      .sort(
        (left, right) =>
          right.modifiedAt - left.modifiedAt ||
          left.sessionId.localeCompare(right.sessionId),
      );
  }

  private async execute(
    request: AgentSurfaceRunRequest,
    externalSignal: AbortSignal | undefined,
    emit: (event: AgentSurfaceEvent) => void,
  ): Promise<AgentSurfaceRunResult> {
    const sessionId = validateSessionId(request.sessionId);
    const controller = new AbortController();
    const run: ActiveSurfaceRun = {
      controller,
      approvals: new Map(),
    };
    this.activeRuns.set(sessionId, run);

    const abortFromExternal = () => {
      if (!controller.signal.aborted) {
        controller.abort(
          externalSignal?.reason ?? "surface request aborted",
        );
      }
    };
    externalSignal?.addEventListener("abort", abortFromExternal, {
      once: true,
    });
    if (externalSignal?.aborted) {
      abortFromExternal();
    }

    let store: AgentSessionStore | undefined;
    let runtime: AgentSurfaceResolvedRuntime | undefined;
    try {
      const migrated = await migrateLegacyAgentHistoryAtomically({
        rootDirectory: this.rootDirectory,
        sessionId,
        input: request.initialInput ?? [],
      });
      store = await AgentSessionStore.open({
        rootDirectory: this.rootDirectory,
        sessionId,
      });
      const resumed = store.lastSequence > 0 && !migrated;
      const input = await prepareSurfaceInput(store, request);

      const approve: CoreAgentToolApprovalHandler = (approvalRequest) =>
        this.waitForApproval(run, approvalRequest, emit);
      runtime = await this.createRuntime({
        request,
        approve,
        onToolRunning: (toolRequest) => {
          emit({
            type: "tool_running",
            itemId: toolRequest.itemId,
            callId: toolRequest.callId,
            name: toolRequest.toolName,
          });
        },
      });
      run.toolExecutor = runtime.toolExecutor;

      emit({ type: "run_state", status: "running" });

      const assistantDeltaItems = new Set<string>();
      const observableExecutor = runtime.toolExecutor
        ? createObservableToolExecutor(
            runtime.toolExecutor,
            emit,
          )
        : undefined;

      const result = await runAgentLoop({
        driver: runtime.driver,
        input,
        tools: runtime.tools,
        toolExecutor: observableExecutor,
        signal: controller.signal,
        maxIterations: request.maxIterations,
        onEvent: async (event) => {
          for (const projected of projectModelEvent(
            event,
            assistantDeltaItems,
          )) {
            emit(projected);
          }
        },
        diagnostics: this.diagnostics.sink,
        diagnosticContext: {
          sessionId,
          executionProfile: request.profile,
        },
        durability: {
          store,
          context: runtime.context,
        },
      });

      emit({
        type: "run_state",
        status: result.status,
        stopReason: result.stopReason,
        error: result.error,
      });
      return surfaceResult(sessionId, resumed, result);
    } catch (error) {
      await emitAgentCompatibilityFailureDiagnostic(
        this.diagnostics.sink,
        {
          sessionId,
          executionProfile: request.profile,
        },
        error,
      );
      throw error;
    } finally {
      externalSignal?.removeEventListener(
        "abort",
        abortFromExternal,
      );
      this.resolveAllApprovals(run, false);
      this.activeRuns.delete(sessionId);
      try {
        await runtime?.close?.();
      } finally {
        await store?.close();
      }
    }
  }

  private waitForApproval(
    run: ActiveSurfaceRun,
    request: CoreAgentToolApprovalRequest,
    emit: (event: AgentSurfaceEvent) => void,
  ): Promise<boolean> {
    if (run.controller.signal.aborted) {
      return Promise.resolve(false);
    }

    const approvalId = [
      "approval",
      encodeURIComponent(request.itemId),
      encodeURIComponent(request.callId),
    ].join(":");
    if (run.approvals.has(approvalId)) {
      throw new Error(
        `Duplicate pending agent approval "${approvalId}"`,
      );
    }

    const approval: AgentSurfaceApproval = {
      approvalId,
      sessionId: request.sessionId,
      profile: request.profile,
      itemId: request.itemId,
      callId: request.callId,
      toolName: request.toolName,
      input: request.input,
    };
    emit({ type: "approval_required", approval });

    return new Promise<boolean>((resolve) => {
      const onAbort = () => {
        const pending = run.approvals.get(approvalId);
        if (!pending) {
          return;
        }
        run.approvals.delete(approvalId);
        resolve(false);
      };
      run.controller.signal.addEventListener("abort", onAbort, {
        once: true,
      });
      run.approvals.set(approvalId, {
        resolve,
        abort: () =>
          run.controller.signal.removeEventListener(
            "abort",
            onAbort,
          ),
      });
    });
  }

  private resolveAllApprovals(
    run: ActiveSurfaceRun,
    approved: boolean,
  ): void {
    for (const [approvalId, pending] of run.approvals) {
      run.approvals.delete(approvalId);
      pending.abort();
      pending.resolve(approved);
    }
  }
}

async function prepareSurfaceInput(
  store: AgentSessionStore,
  request: AgentSurfaceRunRequest,
): Promise<readonly AgentModelInputItem[]> {
  if (store.lastSequence === 0) {
    const bootstrap = request.initialInput ?? [];
    const unsupported = bootstrap.find(
      (item) => item.type !== "message",
    );
    if (unsupported) {
      throw new Error(
        "Compatibility history containing canonical model output or tool results must be migrated before durable session initialization",
      );
    }
    const input: AgentModelInputItem[] = [...bootstrap];
    const systemPrompt = request.systemPrompt?.trim();
    if (systemPrompt && !hasSystemMessage(input)) {
      input.unshift({
        type: "message",
        role: "system",
        content: systemPrompt,
      });
    }

    const userPrompt = request.userPrompt?.trim();
    if (userPrompt) {
      input.push({
        type: "message",
        role: "user",
        content: userPrompt,
      });
    }
    if (!input.some((item) => item.type === "message" && item.role === "user")) {
      throw new Error(
        "A user prompt is required when starting a new durable agent session",
      );
    }
    return input;
  }

  // Compatibility bootstrap input is deliberately one-shot. Once the durable
  // log exists, replay is authoritative and stale surface history is ignored.
  const userPrompt = request.userPrompt?.trim();
  if (userPrompt) {
    await appendDurableAgentUserTurn(store, userPrompt);
  }
  return [];
}

function hasSystemMessage(
  input: readonly AgentModelInputItem[],
): boolean {
  return input.some(
    (item) => item.type === "message" && item.role === "system",
  );
}

function createObservableToolExecutor(
  executor: AgentToolExecutor,
  emit: (event: AgentSurfaceEvent) => void,
): AgentToolExecutor {
  return {
    async execute(
      toolCall: AgentToolCallItem,
      context: AgentToolExecutionContext,
    ): Promise<AgentToolExecutionOutcome> {
      try {
        const outcome = await executor.execute(toolCall, context);
        emit({
          type: "tool_result",
          itemId: toolCall.id,
          callId: toolCall.callId,
          name: toolCall.name,
          status: outcome.status,
          ...(outcome.status === "success"
            ? { output: outcome.output }
            : { error: outcome.error }),
        });
        return outcome;
      } catch (error) {
        emit({
          type: "tool_result",
          itemId: toolCall.id,
          callId: toolCall.callId,
          name: toolCall.name,
          status: "failure",
          error: {
            code: "tool_executor_error",
            message:
              error instanceof Error
                ? error.message
                : String(error),
          },
        });
        throw error;
      }
    },
  };
}

function projectModelEvent(
  event: AgentRunEvent,
  assistantDeltaItems: Set<string>,
): AgentSurfaceEvent[] {
  switch (event.type) {
    case "content.delta":
      assistantDeltaItems.add(event.itemId);
      return [
        {
          type: "assistant_delta",
          responseId: event.responseId,
          itemId: event.itemId,
          delta: event.delta,
        },
      ];
    case "output_item.completed":
      if (event.item.type === "reasoning") {
        return [];
      }
      if (event.item.type === "message") {
        const projected: AgentSurfaceEvent[] = [];
        if (
          event.item.content &&
          !assistantDeltaItems.has(event.item.id)
        ) {
          projected.push({
            type: "assistant_delta",
            responseId: event.responseId,
            itemId: event.item.id,
            delta: event.item.content,
          });
        }
        projected.push({
          type: "assistant_completed",
          responseId: event.responseId,
          itemId: event.item.id,
          content: event.item.content,
        });
        return projected;
      }
      return [
        {
          type: "tool_requested",
          responseId: event.responseId,
          itemId: event.item.id,
          callId: event.item.callId,
          name: event.item.name,
          input: event.item.input,
        },
      ];
    case "response.completed":
      return [
        {
          type: "response_completed",
          responseId: event.responseId,
          stopReason: event.stopReason,
        },
      ];
    default:
      // Reasoning deltas and provider metadata are intentionally not
      // surfaced. The UI receives only presentation-safe canonical data.
      return [];
  }
}

function surfaceResult(
  sessionId: string,
  resumed: boolean,
  result: AgentLoopResult,
): AgentSurfaceRunResult {
  return {
    sessionId,
    resumed,
    status: result.status,
    stopReason: result.stopReason,
    error: result.error,
  };
}

function surfaceStatus(
  analysis: ReturnType<typeof analyzeDurableAgentSession>,
): AgentSurfaceSessionSnapshot["status"] {
  if (analysis.disposition === "resume") {
    return "resumable";
  }
  if (analysis.disposition === "blocked") {
    return "resume_blocked";
  }
  switch (analysis.terminalKind) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "max_tokens":
      return "max_tokens";
    case "closed":
    default:
      return "resume_blocked";
  }
}

function projectTimeline(
  input: readonly AgentModelInputItem[],
): readonly AgentSurfaceTimelineItem[] {
  const timeline: AgentSurfaceTimelineItem[] = [];
  for (const item of input) {
    if (item.type === "message") {
      if (item.role === "user") {
        timeline.push({
          type: "user_message",
          content: item.content,
        });
      }
      continue;
    }

    if (item.type === "tool_result") {
      timeline.push({
        type: "tool_result",
        itemId: item.toolCallItemId,
        callId: item.callId,
        name: item.name,
        status: item.status,
        ...(item.status === "success"
          ? { output: item.output }
          : { error: item.error }),
      });
      continue;
    }

    if (item.item.type === "message") {
      timeline.push({
        type: "assistant_message",
        itemId: item.item.id,
        content: item.item.content,
      });
    } else if (item.item.type === "tool_call") {
      timeline.push({
        type: "tool_call",
        itemId: item.item.id,
        callId: item.item.callId,
        name: item.item.name,
        input: item.item.input,
      });
    }
  }
  return timeline;
}

export function createAgentDriverCompactionSummarizer(
  driver: AgentModelDriver,
): AgentCompactionSummarizer {
  return {
    async summarize(request, signal) {
      const input: AgentModelInputItem[] = [
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
          input,
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

class AsyncResultQueue<T, R> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<T, R>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private done = false;
  private failed = false;
  private result: R | undefined;
  private error: unknown;

  push(value: T): void {
    if (this.done || this.failed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  finish(result: R): void {
    if (this.done || this.failed) {
      return;
    }
    this.done = true;
    this.result = result;
    this.flush();
  }

  fail(error: unknown): void {
    if (this.done || this.failed) {
      return;
    }
    this.failed = true;
    this.error = error;
    this.flush();
  }

  next(): Promise<IteratorResult<T, R>> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve({ done: false, value });
    }
    if (this.failed) {
      return Promise.reject(this.error);
    }
    if (this.done) {
      return Promise.resolve({
        done: true,
        value: this.result as R,
      });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private flush(): void {
    if (this.values.length > 0) {
      return;
    }
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (this.failed) {
        waiter.reject(this.error);
      } else {
        waiter.resolve({
          done: true,
          value: this.result as R,
        });
      }
    }
  }
}
