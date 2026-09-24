import type { ModelDescription } from "core";
import { describe, expect, it, vi } from "vitest";

import {
  createMockStore,
  getEmptyRootState,
} from "../../util/test/mockStore";
import type { RootState } from "../store";
import { cancelStream } from "./cancelStream";
import { resumeAgentSession } from "./resumeAgentSession";

describe("canonical agent surface lifecycle thunks", () => {
  it("delegates GUI cancellation to Core and clears presentation state", async () => {
    const initialState = getEmptyRootState();
    initialState.session.mode = "agent";
    initialState.session.id = "agent-cancel-session";
    initialState.session.isStreaming = true;
    initialState.session.agentRuntimeStatus = "running";

    const store = createMockStore(initialState);
    let cancelRequest:
      | { sessionId: string; reason?: string }
      | undefined;
    store.mockIdeMessenger.responseHandlers["agent/cancel"] = async (data) => {
      cancelRequest = data;
      return { cancelled: true };
    };

    await store.dispatch(cancelStream() as any);

    expect(cancelRequest).toEqual({
      sessionId: "agent-cancel-session",
      reason: "user cancelled from GUI",
    });
    const state = store.getState() as RootState;
    expect(state.session.agentRuntimeStatus).toBe("cancelled");
    expect(state.session.isStreaming).toBe(false);
    expect(state.session.agentApprovals).toEqual({});
  });

  it("resumes through agent/run without rebuilding durable history in the GUI", async () => {
    const initialState = getEmptyRootState();
    const mockModel: ModelDescription = {
      title: "Mock Agent Model",
      model: "mock-agent",
      provider: "mock",
      underlyingProviderName: "mock",
    };
    initialState.config.config.selectedModelByRole.chat = mockModel;
    initialState.config.config.modelsByRole.chat = [mockModel];
    initialState.session.mode = "agent";
    initialState.session.id = "agent-resume-session";
    initialState.session.executionProfile = "interactive";
    initialState.session.agentRuntimeStatus = "resumable";

    const store = createMockStore(initialState);
    const streamRequest = vi.fn(
      async function* (messageType: string, data: any) {
        expect(messageType).toBe("agent/run");
        expect(data).toMatchObject({
          sessionId: "agent-resume-session",
          profile: "interactive",
          toolNames: [],
          toolPolicies: {},
        });
        expect(data.userPrompt).toBeUndefined();
        expect(data.systemPrompt).toBeUndefined();

        yield [
          {
            type: "run_state",
            status: "running",
          },
          {
            type: "assistant_delta",
            responseId: "response-resume",
            itemId: "message-resume",
            delta: "resumed",
          },
          {
            type: "response_completed",
            responseId: "response-resume",
            stopReason: "end_turn",
          },
        ];

        return {
          sessionId: "agent-resume-session",
          resumed: true,
          status: "completed",
          stopReason: "end_turn",
        };
      },
    );
    (store.mockIdeMessenger as any).streamRequest = streamRequest;

    const action = await store.dispatch(resumeAgentSession() as any);

    expect(action.type).toBe("agent/resumeSession/fulfilled");
    expect(streamRequest).toHaveBeenCalledTimes(1);
    const state = store.getState() as RootState;
    expect(state.session.agentRuntimeStatus).toBe("completed");
    expect(state.session.isStreaming).toBe(false);
  });
});
