import type { ChatHistoryItem } from "core";
import { randomUUID } from "node:crypto";

import { cliAgentKernelBridge } from "../agent/CliAgentKernelBridge.js";
import type { PermissionMode } from "../permissions/types.js";
import { services } from "../services/index.js";
import type { ModelServiceState } from "../services/types.js";
import { streamChatResponse } from "../stream/streamChatResponse.js";
import { escapeEvents } from "../util/cli.js";
import { logger } from "../util/logger.js";

/**
 * Options for executing a subagent
 */
export interface SubAgentExecutionOptions {
  agent: ModelServiceState;
  prompt: string;
  parentSessionId: string;
  abortController: AbortController;
  onOutputUpdate?: (output: string) => void;
}

/**
 * Result from executing a subagent
 */
export interface SubAgentResult {
  success: boolean;
  response: string;
  error?: string;
}

/**
 * Build an invocation-scoped system message for the child agent.
 */
async function buildAgentSystemMessage(
  agent: ModelServiceState,
  mode: PermissionMode,
): Promise<string> {
  const baseMessage = services.systemMessage
    ? await services.systemMessage.getSystemMessage(mode)
    : "";

  const agentPrompt = agent.model?.chatOptions?.baseSystemMessage || "";

  if (agentPrompt) {
    return `${baseMessage}\n\n${agentPrompt}`;
  }

  return baseMessage;
}

function createChildSessionId(parentSessionId: string): string {
  return `${parentSessionId}:subagent:${randomUUID()}`;
}

/**
 * Execute a subagent in an isolated kernel child session.
 */
export async function executeSubAgent(
  options: SubAgentExecutionOptions,
): Promise<SubAgentResult> {
  const {
    agent: subAgent,
    prompt,
    parentSessionId,
    abortController,
    onOutputUpdate,
  } = options;

  const parentMode = services.toolPermissions.getState().currentMode;
  const childMode: PermissionMode = "auto";
  const childSessionId = createChildSessionId(parentSessionId);

  try {
    logger.debug("Starting isolated subagent execution", {
      agent: subAgent.model?.name,
      parentSessionId,
      childSessionId,
    });

    const { model, llmApi } = subAgent;
    if (!model || !llmApi) {
      throw new Error("Model or LLM API not available");
    }

    await cliAgentKernelBridge.forkSession({
      parentSessionId,
      parentMode,
      childSessionId,
      childMode,
    });

    const systemMessage = await buildAgentSystemMessage(
      subAgent,
      childMode,
    );

    const chatHistory = [
      {
        message: {
          role: "user",
          content: prompt,
        },
        contextItems: [],
      },
    ] as ChatHistoryItem[];

    const escapeHandler = () => {
      abortController.abort();
      void cliAgentKernelBridge.cancelSession(
        childSessionId,
        childMode,
        "subagent execution cancelled by user",
      );
      chatHistory.push({
        message: {
          role: "user",
          content: "Subagent execution was cancelled by the user.",
        },
        contextItems: [],
      });
    };

    escapeEvents.on("user-escape", escapeHandler);

    try {
      let accumulatedOutput = "";

      await streamChatResponse(
        chatHistory,
        model,
        llmApi,
        abortController,
        {
          onContent: (content: string) => {
            accumulatedOutput += content;
            onOutputUpdate?.(accumulatedOutput);
          },
          onToolResult: (result: string) => {
            accumulatedOutput += `\n\n${result}`;
            onOutputUpdate?.(accumulatedOutput);
          },
        },
        false,
        {
          permissionMode: childMode,
          permissions: {
            policies: [{ tool: "*", permission: "allow" }],
          },
          systemMessage,
          useChatHistoryService: false,
          sessionId: childSessionId,
          isHeadless: false,
        },
      );

      const lastMessage = chatHistory.at(-1);
      const response =
        typeof lastMessage?.message?.content === "string"
          ? lastMessage.message.content
          : "";

      logger.debug("Subagent execution completed", {
        agent: model.name,
        parentSessionId,
        childSessionId,
        responseLength: response.length,
      });

      return {
        success: true,
        response,
      };
    } finally {
      escapeEvents.removeListener("user-escape", escapeHandler);
      await cliAgentKernelBridge.closeSession(
        childSessionId,
        childMode,
      );
    }
  } catch (error: any) {
    logger.error("Subagent execution failed", {
      agent: subAgent.model?.name,
      parentSessionId,
      childSessionId,
      error: error.message,
    });

    return {
      success: false,
      response: "",
      error: error.message,
    };
  }
}
