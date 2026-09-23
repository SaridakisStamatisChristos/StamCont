import { createAsyncThunk } from "@reduxjs/toolkit";
import { applyToolOverrides } from "core/tools/applyToolOverrides";

import { selectActiveTools } from "../selectors/selectActiveTools";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  setActive,
  setAgentRuntimeStatus,
  setInlineErrorMessage,
} from "../slices/sessionSlice";
import type { ThunkApiType } from "../store";
import { saveCurrentSession } from "./session";
import {
  applyAgentRunResult,
  applyAgentSurfaceEvent,
} from "./streamAgentInput";

export const resumeAgentSession = createAsyncThunk<
  void,
  void,
  ThunkApiType
>(
  "agent/resumeSession",
  async (_, { dispatch, extra, getState }) => {
    const state = getState();
    const selectedChatModel = selectSelectedChatModel(state);
    if (!selectedChatModel) {
      throw new Error("No chat model selected");
    }
    if (state.session.agentRuntimeStatus !== "resumable") {
      throw new Error(
        "The current durable agent session is not resumable",
      );
    }

    let activeTools = selectActiveTools(state);
    if (selectedChatModel.toolOverrides?.length) {
      activeTools = applyToolOverrides(
        activeTools,
        selectedChatModel.toolOverrides,
      ).tools;
    }

    dispatch(setInlineErrorMessage(undefined));
    dispatch(setActive());
    dispatch(setAgentRuntimeStatus("running"));

    const generator = extra.ideMessenger.streamRequest(
      "agent/run",
      {
        sessionId: state.session.id,
        profile: state.session.executionProfile,
        toolNames: activeTools.map((tool) => tool.function.name),
      },
      state.session.streamAborter.signal,
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

    if (!next.done || !next.value) {
      return;
    }

    applyAgentRunResult(next.value, dispatch);
    if (next.value.status === "completed") {
      await dispatch(
        saveCurrentSession({
          openNewSession: false,
          generateTitle: true,
        }),
      );
      return;
    }

    if (next.value.status !== "cancelled") {
      throw new Error(
        next.value.error?.message ??
          `Agent resume ended with status ${next.value.status}`,
      );
    }
  },
);
