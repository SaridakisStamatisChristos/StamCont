import { describe, expect, it, vi } from "vitest";

import type { ModelDescription } from "core";
import { serializeTool } from "core/tools";
import { grepSearchTool } from "core/tools/definitions";

import {
  createMockStore,
  getEmptyRootState,
} from "../../util/test/mockStore";
import type { RootState } from "../store";
import { streamAgentInput } from "./streamAgentInput";

vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(() => "canonical system"),
}));

describe("streamAgentInput", () => {
  it("projects canonical Core events and propagates profile and tool policy configuration", async () => {
    const initialState = getEmptyRootState();
    const mockModel: ModelDescription = {
      title: "Mock Agent Model",
      model: "mock-agent",
      provider: "mock",
      underlyingProviderName: "mock",
    };
    initialState.config.config.selectedModelByRole.chat = mockModel;
    initialState.config.config.modelsByRole.chat = [mockModel];
    const grepTool = serializeTool(grepSearchTool);
    const grepName = grepTool.function.name;
    initialState.session.mode = "agent";
    initialState.session.executionProfile = "full_access";
    initialState.session.id = "agent-ui-session";
    initialState.session.history = [
      {
        message: {
          id: "user-1",
          role: "user",
          content: "inspect the workspace",
        },
        contextItems: [],
      },
    ];
    initialState.config.config.tools = [grepTool];
    initialState.ui.toolSettings = {
      [grepName]: "allowedWithoutPermission",
    };

    const store = createMockStore(initialState);
    const streamRequest = vi.fn(
      async function* (messageType: string, data: any) {
        expect(messageType).toBe("agent/run");
        expect(data).toMatchObject({
          sessionId: "agent-ui-session",
          profile: "full_access",
          toolNames: [grepName],
          toolPolicies: {
            [grepName]: "allowedWithoutPermission",
          },
          initialInput: [
            {
              type: "message",
              role: "system",
              content: "canonical system",
            },
          ],
          userPrompt: "inspect the workspace",
        });

        yield [
          {
            type: "run_state",
            status: "running",
          },
          {
            type: "assistant_delta",
            responseId: "response-1",
            itemId: "message-1",
            delta: "visible answer",
          },
          {
            type: "assistant_completed",
            responseId: "response-1",
            itemId: "message-1",
            content: "visible answer",
          },
          {
            type: "response_completed",
            responseId: "response-1",
            stopReason: "end_turn",
          },
        ];

        return {
          sessionId: "agent-ui-session",
          resumed: false,
          status: "completed",
          stopReason: "end_turn",
        };
      },
    );
    (store.mockIdeMessenger as any).streamRequest = streamRequest;

    const action = await store.dispatch(streamAgentInput() as any);

    expect(action.type).toBe("chat/streamAgentInput/fulfilled");
    expect(streamRequest).toHaveBeenCalledTimes(1);
    const state = store.getState() as RootState;
    expect(state.session.agentRuntimeStatus).toBe("completed");
    expect(state.session.isStreaming).toBe(false);
    expect(
      state.session.history
        .filter((item) => item.message.role === "assistant")
        .map((item) => item.message.content),
    ).toContain("visible answer");
  });


  it("surfaces canonical Core failure and leaves the GUI inactive", async () => {
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
    initialState.session.executionProfile = "interactive";
    initialState.session.id = "agent-ui-failure";
    initialState.session.history = [
      {
        message: {
          id: "user-failure",
          role: "user",
          content: "fail safely",
        },
        contextItems: [],
      },
    ];

    const store = createMockStore(initialState);
    (store.mockIdeMessenger as any).streamRequest = vi.fn(
      async function* () {
        yield [
          {
            type: "run_state",
            status: "running",
          },
          {
            type: "run_state",
            status: "failed",
            error: {
              code: "provider_error",
              message: "provider unavailable",
            },
          },
        ];
        return {
          sessionId: "agent-ui-failure",
          resumed: false,
          status: "failed",
          error: {
            code: "provider_error",
            message: "provider unavailable",
          },
        };
      },
    );

    const action = await store.dispatch(streamAgentInput() as any);

    expect(action.type).toBe("chat/streamAgentInput/rejected");
    expect(action.error.message).toContain("provider unavailable");
    const state = store.getState() as RootState;
    expect(state.session.agentRuntimeStatus).toBe("failed");
    expect(state.session.isStreaming).toBe(false);
  });

  it("migrates prior supported GUI chat history into canonical bootstrap input", async () => {
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
    initialState.session.executionProfile = "interactive";
    initialState.session.id = "agent-ui-legacy-history";
    initialState.session.history = [
      {
        message: {
          id: "old-user",
          role: "user",
          content: "old question",
        },
        contextItems: [],
      },
      {
        message: {
          id: "old-assistant",
          role: "assistant",
          content: "old answer",
        },
        contextItems: [],
      },
      {
        message: {
          id: "new-user",
          role: "user",
          content: "new question",
        },
        contextItems: [],
      },
    ];

    const store = createMockStore(initialState);
    (store.mockIdeMessenger as any).streamRequest = vi.fn(
      async function* (_messageType: string, data: any) {
        expect(data.userPrompt).toBe("new question");
        expect(data.initialInput).toEqual([
          {
            type: "message",
            role: "system",
            content: "canonical system",
          },
          {
            type: "message",
            role: "user",
            content: "old question",
          },
          {
            type: "model_output",
            item: expect.objectContaining({
              type: "message",
              role: "assistant",
              content: "old answer",
            }),
          },
        ]);
        yield [];
        return {
          sessionId: "agent-ui-legacy-history",
          resumed: false,
          status: "completed",
          stopReason: "end_turn",
        };
      },
    );

    const action = await store.dispatch(streamAgentInput() as any);
    expect(action.type).toBe("chat/streamAgentInput/fulfilled");
  });

});
