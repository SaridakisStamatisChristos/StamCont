import type { Session } from "core";
import { describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import type { RootState } from "../store";
import { loadSession, saveCurrentSession } from "./session";

function storedSession(sessionId: string): Session {
  return {
    sessionId,
    title: "Stored session",
    workspaceDirectory: "",
    history: [],
    mode: "agent",
    executionProfile: "interactive",
  };
}

describe("session Core agent lifecycle", () => {
  it("closes the outgoing Core agent session before switching chats", async () => {
    const initialState = getEmptyRootState();
    initialState.session.id = "chat-current";

    const messenger = new MockIdeMessenger();
    messenger.responses["history/load"] = storedSession("chat-next");
    messenger.responses["agent/closeSession"] = { closed: true };
    const requestSpy = vi.spyOn(messenger, "request");
    const store = createMockStore(initialState, messenger);

    await store.dispatch(
      loadSession({
        sessionId: "chat-next",
        saveCurrentSession: false,
      }) as any,
    );

    expect(requestSpy).toHaveBeenCalledWith("agent/closeSession", {
      sessionId: "chat-current",
    });
    expect((store.getState() as RootState).session.id).toBe("chat-next");
  });

  it("closes the outgoing Core agent session before opening a new chat", async () => {
    const initialState = getEmptyRootState();
    initialState.session.id = "chat-current";
    initialState.session.history = [
      {
        message: {
          id: "user-1",
          role: "user",
          content: "Start a new session",
        },
        contextItems: [],
      },
    ];

    const messenger = new MockIdeMessenger();
    messenger.responses["agent/closeSession"] = { closed: true };
    const requestSpy = vi.spyOn(messenger, "request");
    const store = createMockStore(initialState, messenger);

    await store.dispatch(
      saveCurrentSession({
        openNewSession: true,
        generateTitle: false,
      }) as any,
    );

    expect(requestSpy).toHaveBeenCalledWith("agent/closeSession", {
      sessionId: "chat-current",
    });
    expect((store.getState() as RootState).session.id).not.toBe(
      "chat-current",
    );
  });
});
