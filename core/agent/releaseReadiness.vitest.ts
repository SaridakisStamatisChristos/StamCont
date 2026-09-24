import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  readAgentCompactionArtifact,
  type AgentCompactionSummarizer,
} from "./compaction";
import { AgentKernel } from "./kernel";
import {
  appendAgentLifecycleState,
  appendAgentToolAttempt,
  appendDurableAgentUserTurn,
  initializeDurableAgentSession,
} from "./lifecycle";
import {
  runAgentLoop,
  type AgentLoopDurabilityOptions,
} from "./loop";
import type {
  AgentModelDriver,
  AgentModelInputItem,
  AgentModelRequest,
  AgentToolExecutor,
} from "./model";
import { AgentSessionStore } from "./persistence";
import type {
  AgentRunEvent,
  AgentToolCallItem,
  JsonValue,
} from "./protocol";
import type { AgentTool } from "./tools";

const temporaryDirectories: string[] = [];

async function makeRoot(label: string): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "stamcont-pr16-" + label + "-"),
  );
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
  );
});

type EventWithoutEnvelope<T> = T extends AgentRunEvent
  ? Omit<T, "eventId" | "sequence">
  : never;
type EventInput = EventWithoutEnvelope<AgentRunEvent>;

function event(
  sequence: number,
  value: EventInput,
  eventPrefix = "release",
): AgentRunEvent {
  return {
    ...value,
    eventId: eventPrefix + "-event-" + sequence,
    sequence,
  } as AgentRunEvent;
}

function dynamicMessageDriver(
  content: string,
  requests: AgentModelRequest[] = [],
): AgentModelDriver {
  return {
    async *stream(request) {
      requests.push(request);
      let sequence = request.runState.lastSequence;
      const responseId = "release-response-" + (sequence + 1);
      const messageId = responseId + "-message";
      yield event(
        ++sequence,
        {
          type: "response.started",
          responseId,
        },
        responseId,
      );
      yield event(
        ++sequence,
        {
          type: "output_item.added",
          responseId,
          item: { id: messageId, type: "message" },
        },
        responseId,
      );
      yield event(
        ++sequence,
        {
          type: "output_item.completed",
          responseId,
          item: {
            id: messageId,
            type: "message",
            role: "assistant",
            content,
          },
        },
        responseId,
      );
      yield event(
        ++sequence,
        {
          type: "response.completed",
          responseId,
          stopReason: "end_turn",
        },
        responseId,
      );
    },
  };
}

const initialInput: readonly AgentModelInputItem[] = [
  {
    type: "message",
    role: "user",
    content: "release readiness request",
  },
];

const generousContext: AgentLoopDurabilityOptions["context"] = {
  budget: {
    contextLimitTokens: 1_000_000,
    reservedOutputTokens: 1_000,
    safetyMarginTokens: 1_000,
  },
};

function durability(
  store: AgentSessionStore,
  context: AgentLoopDurabilityOptions["context"] = generousContext,
): AgentLoopDurabilityOptions {
  return { store, context };
}

const recoveryToolCall: AgentToolCallItem = {
  id: "recovery-tool-item",
  type: "tool_call",
  callId: "recovery-call",
  name: "release.inspect",
  input: { target: "workspace" },
};

async function seedPendingToolBoundary(
  store: AgentSessionStore,
): Promise<void> {
  await initializeDurableAgentSession(store, initialInput);
  await appendAgentLifecycleState(
    store,
    "waiting_for_model",
    1,
  );

  for (const runEvent of [
    event(1, {
      type: "response.started",
      responseId: "recovery-response",
    }),
    event(2, {
      type: "output_item.added",
      responseId: "recovery-response",
      item: {
        id: recoveryToolCall.id,
        type: "tool_call",
      },
    }),
    event(3, {
      type: "output_item.completed",
      responseId: "recovery-response",
      item: recoveryToolCall,
    }),
    event(4, {
      type: "response.completed",
      responseId: "recovery-response",
      stopReason: "tool_use",
    }),
  ]) {
    await store.appendModelEvent(runEvent);
  }

  await appendAgentLifecycleState(
    store,
    "waiting_for_tool",
    1,
  );
}

describe("PR16 release-readiness full flows", () => {
  it("Flow A: persists a plain response and reopens as completed without rerunning the provider", async () => {
    const root = await makeRoot("plain");
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "plain-flow",
    });

    const result = await runAgentLoop({
      driver: dynamicMessageDriver("release answer"),
      input: initialInput,
      durability: durability(store),
    });

    expect(result).toMatchObject({
      status: "completed",
      stopReason: "end_turn",
    });
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "plain-flow",
    });
    const stream = vi.fn();
    const resumed = await runAgentLoop({
      driver: { stream } as unknown as AgentModelDriver,
      input: initialInput,
      durability: durability(reopened),
    });

    expect(resumed).toMatchObject({
      status: "completed",
      stopReason: "end_turn",
      iterations: 0,
    });
    expect(stream).not.toHaveBeenCalled();
    expect(
      (await reopened.replay()).input,
    ).toContainEqual({
      type: "model_output",
      item: expect.objectContaining({
        type: "message",
        role: "assistant",
        content: "release answer",
      }),
    });
    await reopened.close();
  });

  it("Flow B: executes only a completed canonical tool call through AgentKernel authorization and continues", async () => {
    const root = await makeRoot("tool");
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "tool-flow",
    });

    const authorize = vi.fn(async () => ({
      allowed: true,
    }));
    const execute = vi.fn(async (input: JsonValue) => ({
      inspected: input,
    }));
    const kernelTool: AgentTool<JsonValue, JsonValue> = {
      name: "release.inspect",
      description: "Release-readiness kernel-path fixture",
      requiredCapabilities: {
        filesystemRead: "workspace",
      },
      authorize,
      execute,
    };
    const kernel = new AgentKernel({
      tools: [kernelTool],
      idFactory: () => "release-kernel-session",
    });
    const kernelSession = await kernel.createSession({
      id: "release-kernel-session",
      profile: "interactive",
    });

    const requests: AgentModelRequest[] = [];
    let call = 0;
    const driver: AgentModelDriver = {
      async *stream(request) {
        requests.push(request);
        let sequence = request.runState.lastSequence;
        const responseId = "tool-response-" + (sequence + 1);

        yield event(
          ++sequence,
          {
            type: "response.started",
            responseId,
          },
          responseId,
        );

        if (call++ === 0) {
          yield event(
            ++sequence,
            {
              type: "output_item.added",
              responseId,
              item: {
                id: "tool-item",
                type: "tool_call",
              },
            },
            responseId,
          );
          yield event(
            ++sequence,
            {
              type: "output_item.completed",
              responseId,
              item: {
                id: "tool-item",
                type: "tool_call",
                callId: "tool-call",
                name: "release.inspect",
                input: { path: "README.md" },
              },
            },
            responseId,
          );
          yield event(
            ++sequence,
            {
              type: "response.completed",
              responseId,
              stopReason: "tool_use",
            },
            responseId,
          );
          return;
        }

        const messageId = "tool-final-message";
        yield event(
          ++sequence,
          {
            type: "output_item.added",
            responseId,
            item: {
              id: messageId,
              type: "message",
            },
          },
          responseId,
        );
        yield event(
          ++sequence,
          {
            type: "output_item.completed",
            responseId,
            item: {
              id: messageId,
              type: "message",
              role: "assistant",
              content: "tool flow complete",
            },
          },
          responseId,
        );
        yield event(
          ++sequence,
          {
            type: "response.completed",
            responseId,
            stopReason: "end_turn",
          },
          responseId,
        );
      },
    };

    const toolExecutor: AgentToolExecutor = {
      async execute(toolCall) {
        try {
          const output = await kernel.executeTool<JsonValue, JsonValue>(
            kernelSession,
            toolCall.name,
            toolCall.input,
          );
          return {
            status: "success",
            output,
          };
        } catch (error) {
          return {
            status: "failure",
            error: {
              code: "kernel_execution_failed",
              message:
                error instanceof Error
                  ? error.message
                  : String(error),
            },
          };
        }
      },
    };

    const result = await runAgentLoop({
      driver,
      input: initialInput,
      tools: [
        {
          name: "release.inspect",
          inputSchema: { type: "object" },
        },
      ],
      toolExecutor,
      durability: durability(store),
    });

    expect(result).toMatchObject({
      status: "completed",
      stopReason: "end_turn",
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].input).toContainEqual({
      type: "tool_result",
      toolCallItemId: "tool-item",
      callId: "tool-call",
      name: "release.inspect",
      status: "success",
      output: {
        inspected: { path: "README.md" },
      },
    });
    expect(
      (await store.readAllRecords()).some(
        (record) => record.kind === "tool_result",
      ),
    ).toBe(true);

    await kernel.closeSession(kernelSession);
    await store.close();
  });

  it("Flow C: persists cancellation and never silently resumes the cancelled session", async () => {
    const root = await makeRoot("cancel");
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "cancel-flow",
    });
    const controller = new AbortController();

    const driver: AgentModelDriver = {
      async *stream(request) {
        let sequence = request.runState.lastSequence;
        const responseId = "cancel-response";
        yield event(
          ++sequence,
          {
            type: "response.started",
            responseId,
          },
          responseId,
        );
        controller.abort("release cancellation");
        yield event(
          ++sequence,
          {
            type: "output_item.added",
            responseId,
            item: {
              id: "cancel-message",
              type: "message",
            },
          },
          responseId,
        );
      },
    };

    const result = await runAgentLoop({
      driver,
      input: initialInput,
      signal: controller.signal,
      durability: durability(store),
    });
    expect(result.status).toBe("cancelled");
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "cancel-flow",
    });
    const stream = vi.fn();
    const resumed = await runAgentLoop({
      driver: { stream } as unknown as AgentModelDriver,
      input: initialInput,
      durability: durability(reopened),
    });

    expect(resumed.status).toBe("cancelled");
    expect(stream).not.toHaveBeenCalled();
    expect(
      (await reopened.replay()).lifecycle,
    ).toMatchObject({
      type: "state",
      state: "cancelled",
    });
    await reopened.close();
  });

  it("Flow D: resumes a pre-execution crash safely and blocks an ambiguous post-start crash", async () => {
    const root = await makeRoot("recovery");

    const safeStore = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "safe-recovery",
    });
    await seedPendingToolBoundary(safeStore);
    await safeStore.close();

    const safeReopen = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "safe-recovery",
    });
    const safeExecutor = vi.fn(async () => ({
      status: "success" as const,
      output: { recovered: true },
    }));
    const safeResult = await runAgentLoop({
      driver: dynamicMessageDriver("recovered"),
      input: initialInput,
      toolExecutor: { execute: safeExecutor },
      durability: durability(safeReopen),
    });

    expect(safeResult.status).toBe("completed");
    expect(safeExecutor).toHaveBeenCalledTimes(1);
    await safeReopen.close();

    const ambiguousStore = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "ambiguous-recovery",
    });
    await seedPendingToolBoundary(ambiguousStore);
    await appendAgentToolAttempt(
      ambiguousStore,
      recoveryToolCall,
      "started",
      1,
    );
    await ambiguousStore.close();

    const ambiguousReopen = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "ambiguous-recovery",
    });
    const shouldNotExecute = vi.fn(async () => ({
      status: "success" as const,
      output: { unsafe: true },
    }));
    const stream = vi.fn();
    const blocked = await runAgentLoop({
      driver: { stream } as unknown as AgentModelDriver,
      input: initialInput,
      toolExecutor: { execute: shouldNotExecute },
      durability: durability(ambiguousReopen),
    });

    expect(blocked.status).toBe("resume_blocked");
    expect(blocked.error?.code).toBe(
      "ambiguous_tool_execution",
    );
    expect(shouldNotExecute).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    await ambiguousReopen.close();
  });

  it("Flow E: compacts long history before the next provider request while preserving semantic continuation", async () => {
    const root = await makeRoot("context");
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "long-context",
    });

    const first = await runAgentLoop({
      driver: dynamicMessageDriver(
        "historical implementation detail ".repeat(400),
      ),
      input: [
        {
          type: "message",
          role: "user",
          content: "Remember project alpha and invariant X.",
        },
      ],
      durability: durability(store),
    });
    expect(first.status).toBe("completed");

    await appendDurableAgentUserTurn(
      store,
      "Continue project alpha while preserving invariant X.",
    );

    const secondRequests: AgentModelRequest[] = [];
    const summarizer: AgentCompactionSummarizer = {
      async summarize() {
        return "Project alpha is active; invariant X must remain preserved.";
      },
    };
    const second = await runAgentLoop({
      driver: dynamicMessageDriver(
        "continued safely",
        secondRequests,
      ),
      input: [],
      durability: durability(store, {
        budget: {
          contextLimitTokens: 1_500,
          reservedOutputTokens: 200,
          safetyMarginTokens: 100,
        },
        compactionSummarizer: summarizer,
      }),
    });

    expect(second.status).toBe("completed");
    expect(secondRequests).toHaveLength(1);
    expect(
      secondRequests[0].input.some(
        (item) =>
          item.type === "model_output" &&
          item.item.id.startsWith(
            "stamcont-compaction:",
          ),
      ),
    ).toBe(true);
    expect(secondRequests[0].input).toContainEqual({
      type: "message",
      role: "user",
      content:
        "Continue project alpha while preserving invariant X.",
    });

    const artifact = await readAgentCompactionArtifact(store);
    expect(artifact.status).toBe("valid");
    expect(artifact.artifact?.summary).toContain(
      "invariant X",
    );
    await store.close();
  });
});
