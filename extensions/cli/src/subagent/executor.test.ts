import { beforeEach, describe, expect, it, vi } from "vitest";

import { cliAgentKernelBridge } from "../agent/CliAgentKernelBridge.js";
import { services } from "../services/index.js";
import { streamChatResponse } from "../stream/streamChatResponse.js";

import { executeSubAgent } from "./executor.js";

vi.mock("../agent/CliAgentKernelBridge.js", () => ({
  cliAgentKernelBridge: {
    forkSession: vi.fn().mockResolvedValue({}),
    cancelSession: vi.fn().mockResolvedValue(true),
    closeSession: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("../services/index.js", () => ({
  services: {
    toolPermissions: {
      getState: vi.fn().mockReturnValue({ currentMode: "normal" }),
    },
    systemMessage: {
      getSystemMessage: vi.fn().mockResolvedValue("base-system"),
    },
  },
}));

vi.mock("../stream/streamChatResponse.js", () => ({
  streamChatResponse: vi.fn(),
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

describe("executeSubAgent kernel isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(services.toolPermissions.getState).mockReturnValue({
      currentMode: "normal",
    } as any);
    vi.mocked(services.systemMessage.getSystemMessage).mockResolvedValue(
      "base-system",
    );
    vi.mocked(cliAgentKernelBridge.forkSession).mockResolvedValue({} as any);
    vi.mocked(cliAgentKernelBridge.closeSession).mockResolvedValue(true);
  });

  it("runs the child with isolated full-access execution context", async () => {
    vi.mocked(streamChatResponse).mockImplementation(
      async (history: any[]) => {
        history.push({
          message: {
            role: "assistant",
            content: "child-result",
          },
          contextItems: [],
        });
        return "child-result";
      },
    );

    const result = await executeSubAgent({
      agent: {
        model: {
          name: "child-model",
          chatOptions: {
            baseSystemMessage: "child-system",
          },
        },
        llmApi: {},
      } as any,
      prompt: "do work",
      parentSessionId: "parent-session",
      abortController: new AbortController(),
    });

    expect(result).toEqual({
      success: true,
      response: "child-result",
    });
    expect(cliAgentKernelBridge.forkSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "parent-session",
        parentMode: "normal",
        childMode: "auto",
      }),
    );

    const streamCall = vi.mocked(streamChatResponse).mock.calls[0];
    expect(streamCall[6]).toEqual(
      expect.objectContaining({
        permissionMode: "auto",
        permissions: {
          policies: [{ tool: "*", permission: "allow" }],
        },
        systemMessage: "base-system\n\nchild-system",
        useChatHistoryService: false,
        isHeadless: false,
      }),
    );
    expect(String(streamCall[6]?.sessionId)).toContain(
      "parent-session:subagent:",
    );
    expect(cliAgentKernelBridge.closeSession).toHaveBeenCalledWith(
      expect.stringContaining("parent-session:subagent:"),
      "auto",
    );
  });

  it("closes a forked child when setup fails after the fork", async () => {
    vi.mocked(services.systemMessage.getSystemMessage).mockRejectedValue(
      new Error("system message failed"),
    );

    const result = await executeSubAgent({
      agent: {
        model: {
          name: "child-model",
        },
        llmApi: {},
      } as any,
      prompt: "do work",
      parentSessionId: "parent-session",
      abortController: new AbortController(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("system message failed");
    expect(cliAgentKernelBridge.forkSession).toHaveBeenCalledTimes(1);
    expect(cliAgentKernelBridge.closeSession).toHaveBeenCalledWith(
      expect.stringContaining("parent-session:subagent:"),
      "auto",
    );
  });
});
