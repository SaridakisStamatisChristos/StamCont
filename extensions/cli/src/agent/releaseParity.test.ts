import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AgentModelDriver,
  AgentModelRequest,
} from "core/agent/model.js";
import { AgentSessionStore } from "core/agent/persistence.js";
import type { AgentRunEvent } from "core/agent/protocol.js";
import { AgentSurfaceRuntime } from "core/agent/surfaceRuntime.js";
import { describe, expect, it } from "vitest";

import { runCliAgentRuntime } from "./runtime.js";

function parityDriver(
  requests: AgentModelRequest[] = [],
): AgentModelDriver {
  return {
    async *stream(request) {
      requests.push(request);
      let sequence = request.runState.lastSequence;
      const responseId = "parity-response-" + (sequence + 1);
      const messageId = "parity-message-" + (sequence + 1);
      const next = <
        T extends Omit<
          AgentRunEvent,
          "eventId" | "sequence" | "responseId"
        >,
      >(
        value: T,
      ) =>
        ({
          ...value,
          eventId: "parity-event-" + ++sequence,
          sequence,
          responseId,
        }) as AgentRunEvent;

      yield next({ type: "response.started" });
      yield next({
        type: "output_item.added",
        item: {
          id: messageId,
          type: "message",
        },
      });
      yield next({
        type: "output_item.completed",
        item: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: "shared canonical answer",
        },
      });
      yield next({
        type: "response.completed",
        stopReason: "end_turn",
      });
    },
  };
}

describe("PR16 CLI/Core-surface parity", () => {
  it("runs the equivalent task through CLI and IDE surface adapters with the same canonical durable semantics", async () => {
    const cliRoot = await mkdtemp(
      path.join(os.tmpdir(), "stamcont-pr16-cli-parity-"),
    );
    const surfaceRoot = await mkdtemp(
      path.join(os.tmpdir(), "stamcont-pr16-surface-parity-"),
    );
    const cliRequests: AgentModelRequest[] = [];
    const surfaceRequests: AgentModelRequest[] = [];

    try {
      const cli = await runCliAgentRuntime({
        rootDirectory: cliRoot,
        sessionId: "cli-parity",
        driver: parityDriver(cliRequests),
        userPrompt: "same task",
        contextLimitTokens: 100_000,
        reservedOutputTokens: 1_000,
      });

      const surface = new AgentSurfaceRuntime(
        surfaceRoot,
        () => ({
          driver: parityDriver(surfaceRequests),
          tools: [],
          context: {
            budget: {
              contextLimitTokens: 100_000,
              reservedOutputTokens: 1_000,
            },
          },
        }),
      );
      const stream = surface.stream({
        sessionId: "surface-parity",
        profile: "interactive",
        toolNames: [],
        userPrompt: "same task",
      });
      let next = await stream.next();
      while (!next.done) {
        next = await stream.next();
      }

      expect(cli.result).toMatchObject({
        status: "completed",
        stopReason: "end_turn",
      });
      expect(next.value).toMatchObject({
        status: "completed",
        stopReason: "end_turn",
      });
      expect(cliRequests).toHaveLength(1);
      expect(surfaceRequests).toHaveLength(1);
      expect(cliRequests[0].input).toEqual(
        surfaceRequests[0].input,
      );

      const cliStore = await AgentSessionStore.open({
        rootDirectory: cliRoot,
        sessionId: "cli-parity",
      });
      const cliReplay = await cliStore.replay();
      await cliStore.close();

      const surfaceSnapshot = await surface.getSession(
        "surface-parity",
      );
      expect(surfaceSnapshot).toMatchObject({
        status: "completed",
        stopReason: "end_turn",
        timeline: [
          {
            type: "user_message",
            content: "same task",
          },
          {
            type: "assistant_message",
            content: "shared canonical answer",
          },
        ],
      });

      const cliSemanticTimeline = cliReplay.input.flatMap(
        (item) => {
          if (
            item.type === "message" &&
            item.role === "user"
          ) {
            return [
              {
                type: "user_message",
                content: item.content,
              },
            ];
          }
          if (
            item.type === "model_output" &&
            item.item.type === "message"
          ) {
            return [
              {
                type: "assistant_message",
                content: item.item.content,
              },
            ];
          }
          return [];
        },
      );
      const surfaceSemanticTimeline =
        surfaceSnapshot?.timeline.map((item) => {
          if (item.type === "assistant_message") {
            return {
              type: item.type,
              content: item.content,
            };
          }
          if (item.type === "user_message") {
            return item;
          }
          return item;
        });

      expect(cliSemanticTimeline).toEqual(
        surfaceSemanticTimeline,
      );
    } finally {
      await Promise.all([
        rm(cliRoot, { recursive: true, force: true }),
        rm(surfaceRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
