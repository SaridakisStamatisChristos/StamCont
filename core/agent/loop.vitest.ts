import { describe, expect, it, vi } from "vitest";

import {
  runAgentLoop,
  type AgentLoopOptions,
} from "./loop";
import type {
  AgentModelDriver,
  AgentModelInputItem,
  AgentModelRequest,
  AgentToolExecutor,
} from "./model";
import type {
  AgentRunEvent,
  AgentStopReason,
  JsonValue,
} from "./protocol";

type EventWithoutEnvelope<T> = T extends AgentRunEvent
  ? Omit<T, "eventId" | "sequence">
  : never;
type EventInput = EventWithoutEnvelope<AgentRunEvent>;

function e(
  sequence: number,
  input: EventInput,
  eventId = "event-" + sequence,
): AgentRunEvent {
  return { ...input, eventId, sequence } as AgentRunEvent;
}

function started(sequence: number, responseId: string): AgentRunEvent {
  return e(sequence, { type: "response.started", responseId });
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

function toolResponse(
  startSequence: number,
  responseId: string,
  itemId: string,
  callId: string,
  name = "read_file",
): readonly AgentRunEvent[] {
  return [
    started(startSequence, responseId),
    e(startSequence + 1, {
      type: "output_item.added",
      responseId,
      item: { id: itemId, type: "tool_call" },
    }),
    e(startSequence + 2, {
      type: "output_item.completed",
      responseId,
      item: {
        id: itemId,
        type: "tool_call",
        callId,
        name,
        input: { path: callId + ".txt" },
      },
    }),
    stopped(startSequence + 3, responseId, "tool_use"),
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
      throw new Error("Unexpected model driver call " + this.calls);
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

const initialInput: readonly AgentModelInputItem[] = [
  {
    type: "message",
    role: "user",
    content: "hello",
  },
];

function successExecutor(
  output: JsonValue = { content: "ok" },
): AgentToolExecutor & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => ({
    status: "success" as const,
    output,
  }));
  return { execute };
}

async function run(
  driver: AgentModelDriver,
  overrides: Partial<Omit<AgentLoopOptions, "driver" | "input">> = {},
) {
  return runAgentLoop({
    driver,
    input: initialInput,
    ...overrides,
  });
}

describe("StamCont AgentLoop MVP", () => {
  it("returns completed for a single end_turn response", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        e(2, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "message-1", type: "message" },
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

    const result = await run(driver);

    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("end_turn");
    expect(result.iterations).toBe(1);
    expect(result.state.responses).toHaveLength(1);
    expect(result.input.at(-1)).toEqual({
      type: "model_output",
      item: {
        id: "message-1",
        type: "message",
        role: "assistant",
        content: "done",
      },
    });
  });

  it("performs a provider-neutral tool round trip using only completed canonical tool state", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        e(2, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "message-1", type: "message" },
        }),
        e(3, {
          type: "content.delta",
          responseId: "response-1",
          itemId: "message-1",
          delta: "draft",
        }),
        e(4, {
          type: "output_item.completed",
          responseId: "response-1",
          item: {
            id: "message-1",
            type: "message",
            role: "assistant",
            content: "authoritative",
          },
        }),
        e(5, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "tool-1", type: "tool_call" },
        }),
        e(6, {
          type: "tool_call.delta",
          responseId: "response-1",
          itemId: "tool-1",
          callIdDelta: "wrong",
          nameDelta: "wrong",
          argumentsDelta: "{}",
        }),
        e(7, {
          type: "output_item.completed",
          responseId: "response-1",
          item: {
            id: "tool-1",
            type: "tool_call",
            callId: "call-1",
            name: "read_file",
            input: { path: "README.md" },
          },
        }),
        stopped(8, "response-1", "tool_use"),
      ],
      [
        started(9, "response-2"),
        e(10, {
          type: "output_item.added",
          responseId: "response-2",
          item: { id: "message-2", type: "message" },
        }),
        e(11, {
          type: "output_item.completed",
          responseId: "response-2",
          item: {
            id: "message-2",
            type: "message",
            role: "assistant",
            content: "finished",
          },
        }),
        stopped(12, "response-2", "end_turn"),
      ],
    ]);
    const toolExecutor = successExecutor({ content: "README" });

    const result = await run(driver, { toolExecutor });

    expect(result.status).toBe("completed");
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);
    expect(toolExecutor.execute.mock.calls[0][0]).toMatchObject({
      id: "tool-1",
      callId: "call-1",
      name: "read_file",
      input: { path: "README.md" },
    });
    expect(driver.requests).toHaveLength(2);
    expect(driver.requests[1].input).toEqual([
      initialInput[0],
      {
        type: "model_output",
        item: {
          id: "message-1",
          type: "message",
          role: "assistant",
          content: "authoritative",
        },
      },
      {
        type: "model_output",
        item: {
          id: "tool-1",
          type: "tool_call",
          callId: "call-1",
          name: "read_file",
          input: { path: "README.md" },
        },
      },
      {
        type: "tool_result",
        toolCallItemId: "tool-1",
        callId: "call-1",
        name: "read_file",
        status: "success",
        output: { content: "README" },
      },
    ]);
    expect(result.state.responses.map((response) => response.responseId)).toEqual([
      "response-1",
      "response-2",
    ]);
  });

  it("never executes partial tool deltas without output_item.completed", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        e(2, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "tool-1", type: "tool_call" },
        }),
        e(3, {
          type: "tool_call.delta",
          responseId: "response-1",
          itemId: "tool-1",
          callIdDelta: "call-1",
          nameDelta: "read_file",
          argumentsDelta: '{"path":"README.md"}',
        }),
        stopped(4, "response-1", "tool_use"),
      ],
    ]);
    const toolExecutor = successExecutor();

    const result = await run(driver, { toolExecutor });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("tool_use_without_executable_calls");
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it("never executes a completed tool item when the response later aborts", async () => {
    const driver = new ScriptedDriver([
      [
        ...toolResponse(1, "response-1", "tool-1", "call-1").slice(0, 3),
        e(4, {
          type: "response.aborted",
          responseId: "response-1",
          reason: "user cancelled",
        }),
      ],
    ]);
    const toolExecutor = successExecutor();

    const result = await run(driver, { toolExecutor });

    expect(result.status).toBe("cancelled");
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it("never executes a completed tool item when the response later fails", async () => {
    const driver = new ScriptedDriver([
      [
        ...toolResponse(1, "response-1", "tool-1", "call-1").slice(0, 3),
        e(4, {
          type: "response.failed",
          responseId: "response-1",
          error: {
            code: "provider_error",
            message: "upstream failed",
          },
        }),
      ],
    ]);
    const toolExecutor = successExecutor();

    const result = await run(driver, { toolExecutor });

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "provider_error",
      message: "upstream failed",
    });
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it("never executes a completed tool item under end_turn", async () => {
    const driver = new ScriptedDriver([
      [
        ...toolResponse(1, "response-1", "tool-1", "call-1").slice(0, 3),
        stopped(4, "response-1", "end_turn"),
      ],
    ]);
    const toolExecutor = successExecutor();

    const result = await run(driver, { toolExecutor });

    expect(result.status).toBe("completed");
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it("executes multiple actionable tool calls in canonical order", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        e(2, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "tool-1", type: "tool_call" },
        }),
        e(3, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "tool-2", type: "tool_call" },
        }),
        e(4, {
          type: "output_item.completed",
          responseId: "response-1",
          item: {
            id: "tool-2",
            type: "tool_call",
            callId: "call-2",
            name: "second",
            input: {},
          },
        }),
        e(5, {
          type: "output_item.completed",
          responseId: "response-1",
          item: {
            id: "tool-1",
            type: "tool_call",
            callId: "call-1",
            name: "first",
            input: {},
          },
        }),
        stopped(6, "response-1", "tool_use"),
      ],
      [
        started(7, "response-2"),
        stopped(8, "response-2", "end_turn"),
      ],
    ]);
    const order: string[] = [];
    const toolExecutor: AgentToolExecutor = {
      async execute(toolCall) {
        order.push(toolCall.name);
        return {
          status: "success",
          output: { name: toolCall.name },
        };
      },
    };

    const result = await run(driver, { toolExecutor });

    expect(result.status).toBe("completed");
    expect(order).toEqual(["first", "second"]);
    expect(
      driver.requests[1].input
        .filter((item) => item.type === "tool_result")
        .map((item) => item.name),
    ).toEqual(["first", "second"]);
  });

  it("feeds a tool-level failure back to the next model response instead of crashing", async () => {
    const driver = new ScriptedDriver([
      toolResponse(1, "response-1", "tool-1", "call-1"),
      [
        started(5, "response-2"),
        stopped(6, "response-2", "end_turn"),
      ],
    ]);
    const toolExecutor: AgentToolExecutor = {
      async execute() {
        return {
          status: "failure",
          error: {
            code: "not_found",
            message: "file missing",
          },
        };
      },
    };

    const result = await run(driver, { toolExecutor });

    expect(result.status).toBe("completed");
    expect(driver.requests[1].input.at(-1)).toEqual({
      type: "tool_result",
      toolCallItemId: "tool-1",
      callId: "call-1",
      name: "read_file",
      status: "failure",
      error: {
        code: "not_found",
        message: "file missing",
      },
    });
  });

  it("fails explicitly when tool_use contains zero executable calls", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        stopped(2, "response-1", "tool_use"),
      ],
    ]);

    const result = await run(driver, {
      toolExecutor: successExecutor(),
    });

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("tool_use");
    expect(result.error?.code).toBe("tool_use_without_executable_calls");
    expect(driver.calls).toBe(1);
  });

  it("fails explicitly when tool execution is requested without an injected executor", async () => {
    const driver = new ScriptedDriver([
      toolResponse(1, "response-1", "tool-1", "call-1"),
    ]);

    const result = await run(driver);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("tool_executor_missing");
  });

  it("treats an executor throw as infrastructure failure", async () => {
    const driver = new ScriptedDriver([
      toolResponse(1, "response-1", "tool-1", "call-1"),
    ]);
    const toolExecutor: AgentToolExecutor = {
      async execute() {
        throw new Error("bridge unavailable");
      },
    };

    const result = await run(driver, { toolExecutor });

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "tool_executor_error",
      message: "bridge unavailable",
    });
    expect(driver.calls).toBe(1);
  });

  it("terminates on max_tokens without automatic continuation", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        e(2, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "message-1", type: "message" },
        }),
        e(3, {
          type: "content.delta",
          responseId: "response-1",
          itemId: "message-1",
          delta: "truncated",
        }),
        stopped(4, "response-1", "max_tokens"),
      ],
    ]);

    const result = await run(driver);

    expect(result.status).toBe("max_tokens");
    expect(result.stopReason).toBe("max_tokens");
    expect(result.state.responses[0].outputItems[0]).toMatchObject({
      type: "message",
      status: "interrupted",
      text: "truncated",
    });
    expect(driver.calls).toBe(1);
  });

  it("returns cancelled and preserves partial text on response.aborted", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        e(2, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "message-1", type: "message" },
        }),
        e(3, {
          type: "content.delta",
          responseId: "response-1",
          itemId: "message-1",
          delta: "partial",
        }),
        e(4, {
          type: "response.aborted",
          responseId: "response-1",
          reason: "cancelled",
        }),
      ],
    ]);

    const result = await run(driver);

    expect(result.status).toBe("cancelled");
    expect(result.state.responses[0].outputItems[0]).toMatchObject({
      type: "message",
      status: "interrupted",
      text: "partial",
    });
  });

  it("returns cancelled for the normalized cancelled stop reason", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        stopped(2, "response-1", "cancelled"),
      ],
    ]);

    const result = await run(driver);

    expect(result.status).toBe("cancelled");
    expect(result.stopReason).toBe("cancelled");
  });

  it("returns the canonical response.failed error", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        e(2, {
          type: "response.failed",
          responseId: "response-1",
          error: {
            code: "rate_limit",
            message: "slow down",
            retryable: true,
          },
        }),
      ],
    ]);

    const result = await run(driver);

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "rate_limit",
      message: "slow down",
      retryable: true,
    });
  });

  it("fails safely on normalized error and unknown stop reasons", async () => {
    const errorDriver = new ScriptedDriver([
      [
        started(1, "response-1"),
        stopped(2, "response-1", "error"),
      ],
    ]);
    const unknownDriver = new ScriptedDriver([
      [
        started(1, "response-1"),
        stopped(2, "response-1", "unknown"),
      ],
    ]);

    const errorResult = await run(errorDriver);
    const unknownResult = await run(unknownDriver);

    expect(errorResult.status).toBe("failed");
    expect(errorResult.error?.code).toBe("model_error");
    expect(unknownResult.status).toBe("failed");
    expect(unknownResult.stopReason).toBe("unknown");
    expect(unknownResult.error?.code).toBe("unknown_stop_reason");
  });

  it("converts an unexpected driver throw into an explicit failure", async () => {
    const driver = new ScriptedDriver([new Error("provider exploded")]);

    const result = await run(driver);

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "driver_error",
      message: "provider exploded",
    });
  });

  it("fails if a driver stream ends without a terminal canonical event", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        e(2, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "message-1", type: "message" },
        }),
      ],
    ]);

    const result = await run(driver);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("driver_ended_without_terminal_event");
    expect(result.state.activeResponseId).toBe("response-1");
  });

  it("stops on an external AbortSignal while retaining reducer state", async () => {
    const controller = new AbortController();
    const script: DriverScript = async function* () {
      yield started(1, "response-1");
      yield e(2, {
        type: "output_item.added",
        responseId: "response-1",
        item: { id: "message-1", type: "message" },
      });
      controller.abort("user cancelled");
      yield e(3, {
        type: "content.delta",
        responseId: "response-1",
        itemId: "message-1",
        delta: "partial",
      });
    };
    const driver = new ScriptedDriver([script]);

    const result = await run(driver, { signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(result.iterations).toBe(1);
    expect(result.state.responses[0].outputItems[0]).toMatchObject({
      type: "message",
      status: "in_progress",
      text: "partial",
    });
    expect(result.state.activeResponseId).toBe("response-1");
  });

  it("does not start the driver when the external signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("already cancelled");
    const driver = new ScriptedDriver([]);

    const result = await run(driver, { signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(result.iterations).toBe(0);
    expect(driver.calls).toBe(0);
  });

  it("contains a broken tool-use loop with maxIterations", async () => {
    const driver = new ScriptedDriver([
      toolResponse(1, "response-1", "tool-1", "call-1"),
      toolResponse(5, "response-2", "tool-2", "call-2"),
    ]);
    const toolExecutor = successExecutor();

    const result = await run(driver, {
      toolExecutor,
      maxIterations: 2,
    });

    expect(result.status).toBe("iteration_limit");
    expect(result.iterations).toBe(2);
    expect(result.state.responses).toHaveLength(2);
    expect(toolExecutor.execute).toHaveBeenCalledTimes(2);
    expect(driver.calls).toBe(2);
  });

  it("rejects an invalid iteration guard configuration", async () => {
    const driver = new ScriptedDriver([]);

    await expect(
      run(driver, {
        maxIterations: 0,
      }),
    ).rejects.toThrow(RangeError);
    expect(driver.calls).toBe(0);
  });

  it("publishes canonical events and post-reducer state to the observer", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        stopped(2, "response-1", "end_turn"),
      ],
    ]);
    const observed: Array<[string, number]> = [];

    const result = await run(driver, {
      onEvent(event, state) {
        observed.push([event.type, state.lastSequence]);
      },
    });

    expect(result.status).toBe("completed");
    expect(observed).toEqual([
      ["response.started", 1],
      ["response.completed", 2],
    ]);
  });

  it("keeps applied state when an observer itself fails", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        stopped(2, "response-1", "end_turn"),
      ],
    ]);

    const result = await run(driver, {
      onEvent() {
        throw new Error("surface failed");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "observer_error",
      message: "surface failed",
    });
    expect(result.state.lastSequence).toBe(1);
  });

  it("preserves reducer idempotency when a canonical event is repeated", async () => {
    const duplicate = e(
      3,
      {
        type: "content.delta",
        responseId: "response-1",
        itemId: "message-1",
        delta: "x",
      },
      "duplicate-delta",
    );
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        e(2, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "message-1", type: "message" },
        }),
        duplicate,
        duplicate,
        e(4, {
          type: "output_item.completed",
          responseId: "response-1",
          item: {
            id: "message-1",
            type: "message",
            role: "assistant",
            content: "x",
          },
        }),
        stopped(5, "response-1", "end_turn"),
      ],
    ]);

    const result = await run(driver);

    expect(result.status).toBe("completed");
    expect(result.state.appliedEvents).toHaveLength(5);
    expect(result.state.responses[0].outputItems[0]).toMatchObject({
      text: "x",
    });
  });

  it("surfaces out-of-order canonical events as a protocol failure", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        e(3, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "message-1", type: "message" },
        }),
        e(2, {
          type: "content.delta",
          responseId: "response-1",
          itemId: "message-1",
          delta: "late",
        }),
      ],
    ]);

    const result = await run(driver);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("protocol_error");
    expect(result.state.lastSequence).toBe(3);
  });

  it("passes provider-neutral tool definitions and metadata through to the driver", async () => {
    const driver = new ScriptedDriver([
      [
        started(1, "response-1"),
        stopped(2, "response-1", "end_turn"),
      ],
    ]);

    const result = await run(driver, {
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
          },
        },
      ],
      metadata: {
        surface: "test",
      },
    });

    expect(result.status).toBe("completed");
    expect(driver.requests[0]).toMatchObject({
      tools: [
        {
          name: "read_file",
          description: "Read a file",
        },
      ],
      metadata: {
        surface: "test",
      },
    });
    expect(driver.requests[0].runState.responses).toHaveLength(0);
  });
});
