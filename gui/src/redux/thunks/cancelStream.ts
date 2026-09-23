import { createAsyncThunk } from "@reduxjs/toolkit";
import {
  abortStream,
  clearAgentApprovals,
  clearDanglingMessages,
  setAgentRuntimeStatus,
  setInactive,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";

export const cancelStream = createAsyncThunk<void, undefined, ThunkApiType>(
  "chat/cancelStream",
  async (_messages, { dispatch, extra, getState }) => {
    const state = getState();
    const isCanonicalAgentRun =
      (state.session.mode === "agent" ||
        state.session.mode === "plan") &&
      state.session.agentRuntimeStatus === "running";
    const sessionId = state.session.id;

    dispatch(setInactive());
    dispatch(abortStream());

    if (isCanonicalAgentRun) {
      dispatch(setAgentRuntimeStatus("cancelled"));
      dispatch(clearAgentApprovals());
      const result = await extra.ideMessenger.request(
        "agent/cancel",
        {
          sessionId,
          reason: "user cancelled from GUI",
        },
      );
      if (result.status === "error") {
        console.warn(
          `Failed to cancel Core agent session ${sessionId}: ${result.error}`,
        );
      }
    }

    // Clear any dangling incomplete tool calls, thinking messages, etc.
    dispatch(clearDanglingMessages());
  },
);
