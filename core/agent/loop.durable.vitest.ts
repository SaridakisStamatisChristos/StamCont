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
  appendAgentLifecycleState,
  appendAgentToolAttempt,
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
  AgentStopReason,
  AgentToolCallItem,
  JsonValue,
} from "./protocol";

const temporaryDirectories: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "stamcont-agent-durable-loop-"),
  );
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

type EventWithoutEnvelope<T> = T extends AgentRunEvent
  ? Omit<T, "eventId" | "sequence">
  : never;
type EventInput = EventWithoutEnvelope<AgentRunEvent>;

function e(
  sequence: number,
  input: EventInput,
): AgentRunEvent {
  return {
    ...input,
    eventId: "event-" + sequence,
    sequence,
  } as AgentRunEvent;
}

function started(
  sequence: number,
  responseId: string,
): AgentRunEvent {
  return e(sequence, {
    type: "response.started",
    responseId,
  });
}

function stopped(
  sequence: number,
  responseId: string,
  stopReason: AgentStopReason,
): AgentRunEvent {
  return e(sequence, {
    type: "response.completed",
    responseId,
    stopReason,
  });
}

const initialInput: readonly AgentModelInputItem[] = [
  {
    type: "message",
    role: "user",
    content: "hello",
  },
];

const toolCall1: AgentToolCallItem = {
  id: "tool-1",
  type: "tool_call",
  callId: "call-1",
  name: "first",
  input: {},
};

const toolCall2: AgentToolCallItem = {
  id: "tool-2",
  type: "tool_call",
  callId: "call-2",
  name: "second",
  input: {},
};

function oneToolResponse(): readonly AgentRunEvent[] {
  return [
    started(1, "response-1"),
    e(2, {
      type: "output_item.added",
      responseId: "response-1",
      item: { id: toolCall1.id, type: "tool_call" },
    }),
    e(3, {
      type: "output_item.completed",
      responseId: "response-1",
      item: toolCall1,
    }),
    stopped(4, "response-1", "tool_use"),
  ];
}

function twoToolResponse(): readonly AgentRunEvent[] {
  return [
    started(1, "response-1"),
    e(2, {
      type: "output_item.added",
      responseId: "response-1",
      item: { id: toolCall1.id, type: "tool_call" },
    }),
    e(3, {
      type: "output_item.completed",
      responseId: "response-1",
      item: toolCall1,
    }),
    e(4, {
      type: "output_item.added",
      responseId: "response-1",
      item: { id: toolCall2.id, type: "tool_call" },
    }),
    e(5, {
      type: "output_item.completed",
      responseId: "response-1",
      item: toolCall2,
    }),
    stopped(6, "response-1", "tool_use"),
  ];
}

type DriverScript =
  | readonly AgentRunEvent[]
  | Error
  | ((
      request: AgentModelRequest,
      signal: AbortSignal,
    ) => AsyncIterable<AgentRunEvent>);

class ScriptedDriver implements AgentModelDriver {
  readonly requests: AgentModelRequest[] = [];
  calls = 0;

  constructor(private readonly scripts: readonly DriverScript[]) {}

  async *stream(
    request: AgentModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentRunEvent> {
    this.requests.push(request);
    const script = this.scripts[this.calls];
    this.calls += 1;
    if (!script) {
      throw new Error(
        "Unexpected model driver call " + this.calls,
      );
    }
    if (script instanceof Error) {
      throw script;
    }
    if (typeof script === "function") {
      for await (const event of script(request, signal)) {
        yield event;
      }
      return;
    }
    for (const event of script) {
      yield event;
    }
  }
}

const generousContext = {
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
  return {
    store,
    context,
  };
}

function successExecutor(
  output: JsonValue = { ok: true },
): AgentToolExecutor & {
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async () => ({
    status: "success" as const,
    output,
  }));
  return { execute };
}

async function seedToolBoundary(
  store: AgentSessionStore,
  events: readonly AgentRunEvent[],
): Promise<void> {
  await initializeDurableAgentSession(store, initialInput);
  await appendAgentLifecycleState(
    store,
    "waiting_for_model",
    1,
  );
  for (const event of events) {
    await store.appendModelEvent(event);
  }
  await appendAgentLifecycleState(
    store,
    "waiting_for_tool",
    1,
  );
}

describe("StamCont durable AgentLoop integration", () => {
  it("persists a live run and refuses to restart a completed session", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "completed-restart",
    });
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        e(2, {
          type: "output_item.added",
          responseId: "response-1",
          item: {
            id: "message-1",
            type: "message",
          },
        }),
        e(3, {
          type: "output_item.completed",
          responseId: "response-1",
          item: {
            id: "message-1",
            type: "message",
            role: "assistant",
            content: "done",
          },
        }),
        stopped(4, "response-1", "end_turn"),
      ],
    ]);

    const result = await runAgentLoop({
      driver,
      input: initialInput,
      durability: durability(store),
    });

    expect(result.status).toBe("completed");
    expect(
      (await store.replay()).lifecycle,
    ).toMatchObject({
      type: "state",
      state: "completed",
      stopReason: "end_turn",
    });
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "completed-restart",
    });
    const shouldNotRun = new ScriptedDriver([]);
    const resumed = await runAgentLoop({
      driver: shouldNotRun,
      input: initialInput,
      durability: durability(reopened),
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.iterations).toBe(0);
    expect(shouldNotRun.calls).toBe(0);
    await reopened.close();
  });

  it("resumes safely when a crash happened before the tool-start marker", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "before-tool-start",
    });
    await seedToolBoundary(store, oneToolResponse());
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "before-tool-start",
    });
    const executor = successExecutor({ value: "result" });
    const driver = new ScriptedDriver([
      [
        started(5, "response-2"),
        stopped(6, "response-2", "end_turn"),
      ],
    ]);

    const result = await runAgentLoop({
      driver,
      input: initialInput,
      toolExecutor: executor,
      durability: durability(reopened),
    });

    expect(result.status).toBe("completed");
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute.mock.calls[0][0]).toMatchObject({
      id: "tool-1",
      callId: "call-1",
    });
    expect(driver.requests[0].input).toContainEqual({
      type: "tool_result",
      toolCallItemId: "tool-1",
      callId: "call-1",
      name: "first",
      status: "success",
      output: { value: "result" },
    });
    await reopened.close();
  });

  it("blocks resume after the tool-start marker when no result was durably recorded", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "after-tool-start",
    });
    await seedToolBoundary(store, oneToolResponse());
    await appendAgentToolAttempt(
      store,
      toolCall1,
      "started",
      1,
    );
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "after-tool-start",
    });
    const executor = successExecutor();
    const driver = new ScriptedDriver([]);

    const result = await runAgentLoop({
      driver,
      input: initialInput,
      toolExecutor: executor,
      durability: durability(reopened),
    });

    expect(result.status).toBe("resume_blocked");
    expect(result.error?.code).toBe(
      "ambiguous_tool_execution",
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(driver.calls).toBe(0);
    await reopened.close();
  });

  it("does not rerun an already persisted tool when resuming a partially completed multi-tool round", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "partial-tool-round",
    });
    await seedToolBoundary(store, twoToolResponse());
    await appendAgentToolAttempt(
      store,
      toolCall1,
      "started",
      1,
    );
    await store.appendToolResult({
      type: "tool_result",
      toolCallItemId: toolCall1.id,
      callId: toolCall1.callId,
      name: toolCall1.name,
      status: "success",
      output: { persisted: true },
    });
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "partial-tool-round",
    });
    const executedNames: string[] = [];
    const executor: AgentToolExecutor = {
      async execute(toolCall) {
        executedNames.push(toolCall.name);
        return {
          status: "success",
          output: { name: toolCall.name },
        };
      },
    };
    const driver = new ScriptedDriver([
      [
        started(7, "response-2"),
        stopped(8, "response-2", "end_turn"),
      ],
    ]);

    const result = await runAgentLoop({
      driver,
      input: initialInput,
      toolExecutor: executor,
      durability: durability(reopened),
    });

    expect(result.status).toBe("completed");
    expect(executedNames).toEqual(["second"]);
    const toolResults = driver.requests[0].input.filter(
      (item) => item.type === "tool_result",
    );
    expect(toolResults).toHaveLength(2);
    expect(
      toolResults.map((item) => item.name),
    ).toEqual(["first", "second"]);
    await reopened.close();
  });

  it("persists external cancellation so an incomplete provider stream never silently resumes", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "cancelled-restart",
    });
    const controller = new AbortController();
    const script: DriverScript = async function* () {
      yield started(1, "response-1");
      controller.abort("user cancelled");
      yield e(2, {
        type: "output_item.added",
        responseId: "response-1",
        item: {
          id: "message-1",
          type: "message",
        },
      });
    };
    const driver = new ScriptedDriver([script]);

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
      sessionId: "cancelled-restart",
    });
    const shouldNotRun = new ScriptedDriver([]);
    const resumed = await runAgentLoop({
      driver: shouldNotRun,
      input: initialInput,
      durability: durability(reopened),
    });

    expect(resumed.status).toBe("cancelled");
    expect(shouldNotRun.calls).toBe(0);
    await reopened.close();
  });

  it("reconstructs from the authoritative log even when a derived snapshot is stale", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "stale-snapshot",
    });
    await initializeDurableAgentSession(store, initialInput);
    await store.writeSnapshot({
      marker: "before waiting state",
    });
    await appendAgentLifecycleState(
      store,
      "waiting_for_model",
      1,
    );
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "stale-snapshot",
    });
    expect(
      (await reopened.readSnapshot()).status,
    ).toBe("stale");

    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        stopped(2, "response-1", "end_turn"),
      ],
    ]);
    const result = await runAgentLoop({
      driver,
      input: initialInput,
      durability: durability(reopened),
    });

    expect(result.status).toBe("completed");
    expect(driver.calls).toBe(1);
    await reopened.close();
  });

  it("surfaces non-compactable context overflow before the model call and can resume later under a larger budget", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "context-overflow",
    });
    const shouldNotRun = new ScriptedDriver([]);

    const overflow = await runAgentLoop({
      driver: shouldNotRun,
      input: initialInput,
      durability: durability(store, {
        budget: {
          contextLimitTokens: 4,
          reservedOutputTokens: 3,
        },
      }),
    });

    expect(overflow.status).toBe("failed");
    expect(overflow.error?.code).toBe("context_overflow");
    expect(shouldNotRun.calls).toBe(0);
    expect(
      (await store.replay()).lifecycle,
    ).toMatchObject({
      type: "state",
      state: "interrupted",
    });
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "context-overflow",
    });
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        stopped(2, "response-1", "end_turn"),
      ],
    ]);
    const recovered = await runAgentLoop({
      driver,
      input: initialInput,
      durability: durability(reopened),
    });

    expect(recovered.status).toBe("completed");
    expect(driver.calls).toBe(1);
    await reopened.close();
  });

  it("blocks restart after a cancelled tool attempt when no durable result or terminal cancellation was persisted", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "cancelled-tool-crash-window",
    });
    await seedToolBoundary(store, oneToolResponse());
    await appendAgentToolAttempt(
      store,
      toolCall1,
      "started",
      1,
    );
    await appendAgentToolAttempt(
      store,
      toolCall1,
      "cancelled",
      1,
      "abort observed before terminal lifecycle persistence",
    );
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "cancelled-tool-crash-window",
    });
    const executor = successExecutor();
    const driver = new ScriptedDriver([]);

    const result = await runAgentLoop({
      driver,
      input: initialInput,
      toolExecutor: executor,
      durability: durability(reopened),
    });

    expect(result.status).toBe("resume_blocked");
    expect(result.error?.code).toBe(
      "ambiguous_tool_execution",
    );
    expect(executor.execute).not.toHaveBeenCalled();
    expect(driver.calls).toBe(0);
    expect(
      (await reopened.replay()).lifecycle,
    ).toMatchObject({
      type: "state",
      state: "interrupted",
    });
    await reopened.close();
  });

  it("fails a persisted tool_use response with zero executable calls instead of issuing another model request", async () => {
    const root = await makeRoot();
    const store = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "persisted-empty-tool-use",
    });
    await initializeDurableAgentSession(store, initialInput);
    await appendAgentLifecycleState(
      store,
      "waiting_for_model",
      1,
    );
    await store.appendModelEvent(
      started(1, "response-empty"),
    );
    await store.appendModelEvent(
      stopped(2, "response-empty", "tool_use"),
    );
    await store.close();

    const reopened = await AgentSessionStore.open({
      rootDirectory: root,
      sessionId: "persisted-empty-tool-use",
    });
    const driver = new ScriptedDriver([]);
    const executor = successExecutor();

    const result = await runAgentLoop({
      driver,
      input: initialInput,
      toolExecutor: executor,
      durability: durability(reopened),
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(
      "tool_use_without_executable_calls",
    );
    expect(driver.calls).toBe(0);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(
      (await reopened.replay()).lifecycle,
    ).toMatchObject({
      type: "state",
      state: "failed",
    });
    await reopened.close();
  });

});
