import { createAsyncThunk } from "@reduxjs/toolkit";

import {
  clearAgentApproval,
} from "../slices/sessionSlice";
import type { ThunkApiType } from "../store";

export const resolveAgentApproval = createAsyncThunk<
  boolean,
  {
    callId: string;
    approved: boolean;
  },
  ThunkApiType
>(
  "agent/resolveApproval",
  async ({ callId, approved }, { dispatch, extra, getState }) => {
    const state = getState();
    const approval = state.session.agentApprovals[callId];
    if (!approval) {
      return false;
    }

    const result = await extra.ideMessenger.request("agent/approve", {
      sessionId: state.session.id,
      approvalId: approval.approvalId,
      approved,
    });
    if (result.status === "error") {
      throw new Error(result.error);
    }
    if (result.content.resolved) {
      dispatch(clearAgentApproval({ callId }));
    }
    return result.content.resolved;
  },
);
