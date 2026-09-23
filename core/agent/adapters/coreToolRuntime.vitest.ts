import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  Tool,
  ToolExtras,
} from "../..";
import { BuiltInToolNames } from "../../tools/builtIn";
import { runAgentLoop } from "../loop";
import type {
  AgentModelDriver,
  AgentModelRequest,
  AgentToolExecutionContext,
} from "../model";
import type {
  AgentRunEvent,
  AgentToolCallItem,
} from "../protocol";
import { createInitialAgentRunState } from "../reducer";

import { CoreToolKernelBridge } from "./coreToolExecution";
import { CoreAgentToolExecutor } from "./coreToolRuntime";

function tool(
  name = "remote_tool",
  options: Partial<Tool> = {},
): Tool {
  return {
    type: "function",
    function: {
      name,
      description: "Remote test tool",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
    },
    displayTitle: name,
    readonly: true,
    group: "Built-In",
    uri: "https://example.test/tool",
    defaultToolPolicy: "allowedWithPermission",
    ...options,
  };
}

function extras(
  fetchImpl: ToolExtras["fetch"],
): Omit<ToolExtras, "tool" | "toolCallId"> {
  return {
    ide: {} as ToolExtras["ide"],
    llm: {} as ToolExtras["llm"],
    config: {} as ToolExtras["config"],
    fetch: fetchImpl,
  };
}

function jsonResponse(output: unknown): Response {
  return new Response(JSON.stringify({ output }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function call(
  overrides: Partial<AgentToolCallItem> = {},
): AgentToolCallItem {
  return {
    id: "item-1",
    type: "tool_call",
    callId: "call-1",
    name: "remote_tool",
    input: { value: "hello" },
    ...overrides,
  };
}

function executionContext(
  signal = new AbortController().signal,
): AgentToolExecutionContext {
  return {
    signal,
    iteration: 1,
    state: createInitialAgentRunState(),
  };
}

describe("CoreAgentToolExecutor", () => {
  it("describes only Core-executable tools with provider-neutral schemas", () => {
    const fetch = vi.fn(async () => jsonResponse([]));
    const runtime = new CoreAgentToolExecutor({
      tools: [
        tool(),
        {
          ...tool(BuiltInToolNames.EditExistingFile),
          uri: undefined,
          readonly: false,
        },
      ],
      extras: extras(fetch),
      sessionId: "agent-schema",
      profile: "full_access",
    });

    expect(runtime.description.definitions).toEqual([
      {
        name: "remote_tool",
        description: "Remote test tool",
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
        },
      },
    ]);
    expect(runtime.description.unsupportedToolNames).toEqual([
      BuiltInToolNames.EditExistingFile,
    ]);
  });

  it("executes through AgentKernel and preserves canonical input", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse([
        {
          name: "Remote",
          description: "Tool output",
          content: JSON.stringify(body.arguments),
        },
      ]);
    });
    const bridge = new CoreToolKernelBridge();
    const events: string[] = [];
    bridge.kernel.subscribe((event) => {
      events.push(event.type);
    });
    const runtime = new CoreAgentToolExecutor({
      tools: [
        tool("remote_tool", {
          defaultToolPolicy: "allowedWithoutPermission",
        }),
      ],
      extras: extras(fetch as ToolExtras["fetch"]),
      sessionId: "agent-kernel",
      profile: "full_access",
      bridge,
    });

    const result = await runtime.execute(call(), executionContext());

    expect(result).toMatchObject({
      status: "success",
      output: {
        contextItems: [
          {
            content: JSON.stringify({ value: "hello" }),
          },
        ],
      },
    });
    expect(events).toEqual([
      "session.created",
      "tool.requested",
      "tool.started",
      "tool.completed",
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it("fails closed when interactive approval is required but unavailable", async () => {
    const fetch = vi.fn(async () => jsonResponse([]));
    const bridge = new CoreToolKernelBridge();
    const events: string[] = [];
    bridge.kernel.subscribe((event) => {
      events.push(event.type);
    });
    const runtime = new CoreAgentToolExecutor({
      tools: [tool()],
      extras: extras(fetch),
      sessionId: "agent-approval",
      profile: "interactive",
      bridge,
    });

    const result = await runtime.execute(call(), executionContext());

    expect(result).toMatchObject({
      status: "failure",
      error: {
        code: "approval_required",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(events).toEqual([
      "session.created",
      "tool.requested",
      "tool.denied",
    ]);
    await runtime.close();
  });

  it("keeps disabled policy authoritative even in full access", async () => {
    const fetch = vi.fn(async () => jsonResponse([]));
    const runtime = new CoreAgentToolExecutor({
      tools: [
        tool("remote_tool", {
          defaultToolPolicy: "disabled",
        }),
      ],
      extras: extras(fetch),
      sessionId: "agent-disabled",
      profile: "full_access",
    });

    const result = await runtime.execute(call(), executionContext());

    expect(result).toMatchObject({
      status: "failure",
      error: {
        code: "tool_denied",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("uses the surface only to collect a required approval decision", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse([
        {
          name: "Remote",
          description: "Tool output",
          content: "approved",
        },
      ]),
    );
    const approve = vi.fn(async () => true);
    const runtime = new CoreAgentToolExecutor({
      tools: [tool()],
      extras: extras(fetch),
      sessionId: "agent-approved",
      profile: "interactive",
      approve,
    });

    const result = await runtime.execute(call(), executionContext());

    expect(result).toBeDefined();
    expect(approve).toHaveBeenCalledWith({
      sessionId: "agent-approved",
      profile: "interactive",
      itemId: "item-1",
      callId: "call-1",
      toolName: "remote_tool",
      input: { value: "hello" },
      policy: "allowedWithPermission",
    });
    await runtime.close();
  });

  it("applies user base-policy preferences inside the kernel authorization path", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse([
        {
          name: "Remote",
          description: "Tool output",
          content: "configured",
        },
      ]),
    );
    const approve = vi.fn(async () => true);
    const runtime = new CoreAgentToolExecutor({
      tools: [tool()],
      extras: extras(fetch),
      sessionId: "agent-policy-override",
      profile: "interactive",
      policyOverrides: {
        remote_tool: "allowedWithoutPermission",
      },
      approve,
    });

    const result = await runtime.execute(call(), executionContext());

    expect(result.status).toBe("success");
    expect(approve).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it("applies the same approval boundary to MCP tools before dispatch", async () => {
    const fetch = vi.fn(async () => jsonResponse([]));
    const runtime = new CoreAgentToolExecutor({
      tools: [
        tool("mcp_tool", {
          uri: "mcp://server/tool",
        }),
      ],
      extras: extras(fetch),
      sessionId: "agent-mcp",
      profile: "interactive",
    });

    const result = await runtime.execute(
      call({
        name: "mcp_tool",
        input: { query: "value" },
      }),
      executionContext(),
    );

    expect(result).toMatchObject({
      status: "failure",
      error: {
        code: "approval_required",
      },
    });
    await runtime.close();
  });

  it("returns a failing tool as a canonical tool failure", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("remote tool failed");
    });
    const runtime = new CoreAgentToolExecutor({
      tools: [
        tool("remote_tool", {
          defaultToolPolicy: "allowedWithoutPermission",
        }),
      ],
      extras: extras(fetch as ToolExtras["fetch"]),
      sessionId: "agent-tool-failure",
      profile: "full_access",
    });

    const result = await runtime.execute(call(), executionContext());

    expect(result).toMatchObject({
      status: "failure",
      error: {
        code: "tool_failure",
        message: "remote tool failed",
      },
    });
    await runtime.close();
  });

  it("propagates cancellation through the kernel-owned tool signal", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        started();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("request aborted")),
            { once: true },
          );
        });
      },
    );
    const runtime = new CoreAgentToolExecutor({
      tools: [
        tool("remote_tool", {
          defaultToolPolicy: "allowedWithoutPermission",
        }),
      ],
      extras: extras(fetch as ToolExtras["fetch"]),
      sessionId: "agent-cancel",
      profile: "full_access",
    });
    const controller = new AbortController();

    const pending = runtime.execute(
      call(),
      executionContext(controller.signal),
    );
    await didStart;
    controller.abort("user cancelled");

    await expect(pending).rejects.toThrow("cancelled");
    await runtime.close();
  });

  it("feeds exact multi-tool identities and results back into AgentLoop", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse([
        {
          name: "Remote",
          description: "Tool output",
          content: String(body.arguments.value),
        },
      ]);
    });
    const runtime = new CoreAgentToolExecutor({
      tools: [
        tool("remote_tool", {
          defaultToolPolicy: "allowedWithoutPermission",
        }),
      ],
      extras: extras(fetch as ToolExtras["fetch"]),
      sessionId: "agent-loop",
      profile: "full_access",
    });
    const driver = new ScriptedDriver([
      [
        event(1, {
          type: "response.started",
          responseId: "response-1",
        }),
        event(2, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "item-a", type: "tool_call" },
        }),
        event(3, {
          type: "output_item.completed",
          responseId: "response-1",
          item: call({
            id: "item-a",
            callId: "call-a",
            input: { value: "a" },
          }),
        }),
        event(4, {
          type: "output_item.added",
          responseId: "response-1",
          item: { id: "item-b", type: "tool_call" },
        }),
        event(5, {
          type: "output_item.completed",
          responseId: "response-1",
          item: call({
            id: "item-b",
            callId: "call-b",
            input: { value: "b" },
          }),
        }),
        event(6, {
          type: "response.completed",
          responseId: "response-1",
          stopReason: "tool_use",
        }),
      ],
      [
        event(7, {
          type: "response.started",
          responseId: "response-2",
        }),
        event(8, {
          type: "response.completed",
          responseId: "response-2",
          stopReason: "end_turn",
        }),
      ],
    ]);

    const result = await runAgentLoop({
      driver,
      input: [
        {
          type: "message",
          role: "user",
          content: "run both",
        },
      ],
      tools: runtime.description.definitions,
      toolExecutor: runtime,
    });

    expect(result.status).toBe("completed");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      driver.requests[1].input.filter(
        (item) => item.type === "tool_result",
      ),
    ).toEqual([
      {
        type: "tool_result",
        toolCallItemId: "item-a",
        callId: "call-a",
        name: "remote_tool",
        status: "success",
        output: {
          contextItems: [
            {
              name: "Remote",
              description: "Tool output",
              content: "a",
            },
          ],
        },
      },
      {
        type: "tool_result",
        toolCallItemId: "item-b",
        callId: "call-b",
        name: "remote_tool",
        status: "success",
        output: {
          contextItems: [
            {
              name: "Remote",
              description: "Tool output",
              content: "b",
            },
          ],
        },
      },
    ]);
    await runtime.close();
  });
});

type EventBody<T = AgentRunEvent> = T extends AgentRunEvent
  ? Omit<T, "eventId" | "sequence">
  : never;

function event(
  sequence: number,
  body: EventBody,
): AgentRunEvent {
  return {
    ...body,
    eventId: `event-${sequence}`,
    sequence,
  } as AgentRunEvent;
}

class ScriptedDriver implements AgentModelDriver {
  readonly requests: AgentModelRequest[] = [];
  private index = 0;

  constructor(
    private readonly scripts: readonly (readonly AgentRunEvent[])[],
  ) {}

  async *stream(
    request: AgentModelRequest,
    _signal: AbortSignal,
  ): AsyncIterable<AgentRunEvent> {
    this.requests.push(request);
    const script = this.scripts[this.index++];
    if (!script) {
      throw new Error("Unexpected model request");
    }
    for (const item of script) {
      yield item;
    }
  }
}
