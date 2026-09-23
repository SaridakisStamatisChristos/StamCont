import { createAsyncThunk } from "@reduxjs/toolkit";
import type { ChatMessage, ContextItem, Tool } from "core";
import type {
  AgentSurfaceEvent,
  AgentSurfaceRunResult,
} from "core/agent/surface";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { renderChatMessage } from "core/util/messageContent";

import { selectActiveTools } from "../selectors/selectActiveTools";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  acceptToolCall,
  clearAgentApproval,
  errorToolCall,
  setActive,
  setAgentApproval,
  setAgentRuntimeStatus,
  setAppliedRulesAtIndex,
  setInactive,
  setInlineErrorMessage,
  setToolCallCalling,
  setToolGenerated,
  streamUpdate,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import type { ThunkApiType } from "../store";
import { constructMessages } from "../util/constructMessages";
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";

export const streamAgentInput = createAsyncThunk<
  void,
  void,
  ThunkApiType
>(
  "chat/streamAgentInput",
  async (_, { dispatch, extra, getState }) => {
    const state = getState();
    const selectedChatModel = selectSelectedChatModel(state);
    if (!selectedChatModel) {
      throw new Error("No chat model selected");
    }

    let activeTools = selectActiveTools(state);
    if (selectedChatModel.toolOverrides?.length) {
      const overridden = applyToolOverrides(
        activeTools,
        selectedChatModel.toolOverrides,
      );
      activeTools = overridden.tools;
      for (const error of overridden.errors) {
        if (!error.fatal) {
          console.warn(`Tool override warning: ${error.message}`);
        }
      }
    }

    const withoutMessageIds = state.session.history.map((item) => {
      const { id, ...messageWithoutId } = item.message;
      return { ...item, message: messageWithoutId };
    });
    const baseSystemMessage = getBaseSystemMessage(
      state.session.mode,
      selectedChatModel,
      activeTools,
    );
    const { messages, appliedRules, appliedRuleIndex } = constructMessages(
      withoutMessageIds,
      baseSystemMessage,
      state.config.config.rules,
      state.ui.ruleSettings,
    );

    if (appliedRuleIndex >= 0) {
      dispatch(
        setAppliedRulesAtIndex({
          index: appliedRuleIndex,
          appliedRules,
        }),
      );
    }

    const systemPrompt = messages.find(
      (message) => message.role === "system",
    );
    const userMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    if (!userMessage) {
      throw new Error("Canonical agent run requires a user message");
    }

    const userPrompt = renderChatMessage(userMessage).trim();
    if (!userPrompt) {
      throw new Error("Canonical agent run requires non-empty user input");
    }

    dispatch(setInlineErrorMessage(undefined));
    dispatch(setActive());
    dispatch(setAgentRuntimeStatus("running"));

    const streamAborter = state.session.streamAborter;
    const generator = extra.ideMessenger.streamRequest(
      "agent/run",
      {
        sessionId: state.session.id,
        profile: state.session.executionProfile,
        toolNames: activeTools.map((tool) => tool.function.name),
        systemPrompt: systemPrompt
          ? renderChatMessage(systemPrompt)
          : undefined,
        userPrompt,
      },
      streamAborter.signal,
    );

    let next = await generator.next();
    while (!next.done) {
      if (!getState().session.isStreaming) {
        break;
      }
      for (const event of next.value) {
        applyAgentSurfaceEvent(
          event,
          activeTools,
          dispatch,
        );
      }
      next = await generator.next();
    }

    if (!next.done) {
      return;
    }

    const result = next.value;
    if (!result) {
      throw new Error("Canonical agent run ended without a result");
    }
    applyAgentRunResult(result, dispatch);

    if (
      result.status === "failed" ||
      result.status === "resume_blocked" ||
      result.status === "iteration_limit" ||
      result.status === "max_tokens"
    ) {
      throw new Error(
        result.error?.message ??
          `Agent run ended with status ${result.status}`,
      );
    }
  },
);

function applyAgentSurfaceEvent(
  event: AgentSurfaceEvent,
  activeTools: Tool[],
  dispatch: ThunkApiType["dispatch"],
): void {
  switch (event.type) {
    case "run_state":
      dispatch(setAgentRuntimeStatus(event.status));
      if (event.status === "running") {
        dispatch(setActive());
      } else {
        dispatch(setInactive());
      }
      return;

    case "assistant_delta":
      if (event.delta) {
        dispatch(
          streamUpdate([
            {
              role: "assistant",
              content: event.delta,
            },
          ]),
        );
      }
      return;

    case "assistant_completed":
    case "response_completed":
      return;

    case "tool_requested": {
      dispatch(
        streamUpdate([
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: event.callId,
                type: "function",
                function: {
                  name: event.name,
                  arguments: JSON.stringify(event.input),
                },
              },
            ],
          },
        ]),
      );
      dispatch(
        setToolGenerated({
          toolCallId: event.callId,
          tools: activeTools,
        }),
      );
      return;
    }

    case "approval_required":
      dispatch(setAgentApproval(event.approval));
      dispatch(
        setToolGenerated({
          toolCallId: event.approval.callId,
          tools: activeTools,
        }),
      );
      dispatch(setAgentRuntimeStatus("running"));
      return;

    case "tool_running":
      dispatch(
        clearAgentApproval({ callId: event.callId }),
      );
      dispatch(
        setToolCallCalling({ toolCallId: event.callId }),
      );
      return;

    case "tool_result": {
      dispatch(
        clearAgentApproval({ callId: event.callId }),
      );
      if (event.status === "success") {
        const projected = projectToolOutput(event.output);
        dispatch(
          updateToolCallOutput({
            toolCallId: event.callId,
            contextItems: projected.contextItems,
            mcpUiState: projected.mcpUiState,
          }),
        );
        dispatch(
          acceptToolCall({ toolCallId: event.callId }),
        );
      } else {
        const message =
          event.error?.message ?? "Tool execution failed";
        dispatch(
          errorToolCall({
            toolCallId: event.callId,
            output: [
              {
                icon: "problems",
                name: "Tool Error",
                description: event.name,
                content: message,
              },
            ],
          }),
        );
      }
      return;
    }
  }
}

function applyAgentRunResult(
  result: AgentSurfaceRunResult,
  dispatch: ThunkApiType["dispatch"],
): void {
  dispatch(setAgentRuntimeStatus(result.status));
  dispatch(setInactive());
}

function projectToolOutput(output: unknown): {
  contextItems: ContextItem[];
  mcpUiState?: any;
} {
  if (
    output &&
    typeof output === "object" &&
    !Array.isArray(output)
  ) {
    const record = output as Record<string, unknown>;
    if (Array.isArray(record.contextItems)) {
      return {
        contextItems: record.contextItems as ContextItem[],
        ...(record.mcpUiState
          ? { mcpUiState: record.mcpUiState }
          : {}),
      };
    }
  }

  if (output === undefined) {
    return { contextItems: [] };
  }
  return {
    contextItems: [
      {
        name: "Tool Output",
        description: "",
        content:
          typeof output === "string"
            ? output
            : JSON.stringify(output),
        hidden: true,
      },
    ],
  };
}
