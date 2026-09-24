import { describe, expect, it } from "vitest";

import { runAgentLoop } from "./loop";
import type {
  AgentModelDriver,
  AgentToolExecutor,
} from "./model";
import type { AgentRunEvent } from "./protocol";

function events(): readonly AgentRunEvent[] {
  return [
    {
      eventId: "e1",
      sequence: 1,
      responseId: "r1",
      type: "response.started",
    },
    {
      eventId: "e2",
      sequence: 2,
      responseId: "r1",
      type: "output_item.added",
      item: { id: "t1", type: "tool_call" },
    },
    {
      eventId: "e3",
      sequence: 3,
      responseId: "r1",
      type: "output_item.completed",
      item: {
        id: "t1",
        type: "tool_call",
        callId: "c1",
        name: "slow_tool",
        input: {},
      },
    },
    {
      eventId: "e4",
      sequence: 4,
      responseId: "r1",
      type: "response.completed",
      stopReason: "tool_use",
    },
  ];
}

describe("PR14 tool/runtime adversarial behavior", () => {
  it("cancels a hanging cooperative executor through the canonical tool signal", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });

    const driver: AgentModelDriver = {
      async *stream() {
        for (const event of events()) {
          yield event;
        }
      },
    };
    const executor: AgentToolExecutor = {
      async execute(_toolCall, context) {
        started();
        return await new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("tool observed cancellation")),
            { once: true },
          );
        });
      },
    };

    const pending = runAgentLoop({
      driver,
      input: [
        {
          type: "message",
          role: "user",
          content: "run it",
        },
      ],
      toolExecutor: executor,
      signal: controller.signal,
    });

    await didStart;
    controller.abort("user cancelled");

    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.stopReason).toBe("cancelled");
  });

  it("fails closed when tool_use contains a completed but non-executable tool identity", async () => {
    const malformed = events().map((event) => {
      if (
        event.type === "output_item.completed" &&
        event.item.type === "tool_call"
      ) {
        return {
          ...event,
          item: {
            ...event.item,
            name: "",
          },
        } as AgentRunEvent;
      }
      return event;
    });
    const driver: AgentModelDriver = {
      async *stream() {
        for (const event of malformed) {
          yield event;
        }
      },
    };

    const result = await runAgentLoop({
      driver,
      input: [
        {
          type: "message",
          role: "user",
          content: "run it",
        },
      ],
      toolExecutor: {
        async execute() {
          throw new Error("must not execute");
        },
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(
      "tool_use_without_executable_calls",
    );
  });
});
