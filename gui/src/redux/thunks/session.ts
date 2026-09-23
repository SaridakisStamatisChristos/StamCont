import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import {
  BaseSessionMetadata,
  ChatHistoryItem,
  ChatMessage,
  ContextItem,
  Session,
  ToolCallState,
} from "core";
import type {
  AgentSurfaceSessionSnapshot,
  AgentSurfaceTimelineItem,
} from "core/agent/surface";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { v4 as uuidv4 } from "uuid";
import { renderChatMessage } from "core/util/messageContent";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { selectSelectedChatModel } from "../slices/configSlice";
import { selectSelectedProfile } from "../slices/profilesSlice";
import {
  deleteSessionMetadata,
  newSession,
  setAgentHydratedHistory,
  setAgentRuntimeStatus,
  setAllSessionMetadata,
  setIsSessionMetadataLoading,
  updateSessionMetadata,
} from "../slices/sessionSlice";
import type { AppDispatch, RootState, ThunkApiType } from "../store";
import { updateSelectedModelByRole } from "../thunks/updateSelectedModelByRole";

const MAX_TITLE_LENGTH = 100;

// Async session functions live in thunks (because of IDE messaging mostly)
// see sessionSlice for sync redux session functions

export async function closeCoreAgentSession(
  ideMessenger: IIdeMessenger,
  sessionId: string,
): Promise<boolean> {
  if (!sessionId.trim()) {
    return false;
  }

  const result = await ideMessenger.request("agent/closeSession", {
    sessionId,
  });
  if (result.status === "error") {
    console.warn(
      `Failed to close Core agent session ${sessionId}: ${result.error}`,
    );
    return false;
  }
  return result.content.closed;
}

export async function getSession(
  ideMessenger: IIdeMessenger,
  id: string,
): Promise<Session> {
  const result = await ideMessenger.request("history/load", { id });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.content;
}

export const refreshSessionMetadata = createAsyncThunk<
  BaseSessionMetadata[],
  {
    offset?: number;
    limit?: number;
  },
  ThunkApiType
>("session/refreshMetadata", async ({ offset, limit }, { dispatch, extra }) => {
  const result = await extra.ideMessenger.request("history/list", {
    limit,
    offset,
  });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  dispatch(setIsSessionMetadataLoading(false));
  dispatch(setAllSessionMetadata(result.content));
  return result.content;
});

export const deleteSession = createAsyncThunk<void, string, ThunkApiType>(
  "session/delete",
  async (id, { getState, dispatch, extra }) => {
    dispatch(deleteSessionMetadata(id)); // optimistic
    const state = getState();
    if (id === state.session.id) {
      await dispatch(loadLastSession());
    }
    const result = await extra.ideMessenger.request("history/delete", { id });
    if (result.status === "error") {
      throw new Error(result.error);
    }
    void dispatch(refreshSessionMetadata({}));
  },
);

export const updateSession = createAsyncThunk<void, Session, ThunkApiType>(
  "session/update",
  async (session, { extra, dispatch }) => {
    dispatch(
      updateSessionMetadata({
        sessionId: session.sessionId,
        title: session.title,
      }),
    ); // optimistic session metadata update
    await extra.ideMessenger.request("history/save", session);
    await dispatch(refreshSessionMetadata({}));
  },
);

/*
 this is only used for the custom focusContinueSessionId command at the moment
*/
export const loadSession = createAsyncThunk<
  void,
  {
    sessionId: string;
    saveCurrentSession: boolean;
  },
  ThunkApiType
>(
  "session/load",
  async (
    { sessionId, saveCurrentSession: save },
    { extra, dispatch, getState },
  ) => {
    const currentSessionId = getState().session.id;
    if (save) {
      // save the session in the background
      void dispatch(
        saveCurrentSession({
          openNewSession: false,
          generateTitle: true,
        }),
      );
    }
    const session = await getSession(extra.ideMessenger, sessionId);
    if (currentSessionId !== session.sessionId) {
      await closeCoreAgentSession(extra.ideMessenger, currentSessionId);
    }
    dispatch(newSession(session));
    await syncCoreAgentSnapshot(
      extra.ideMessenger,
      dispatch,
      getState,
    );

    // Restore selected chat model from session, if present
    if (session.chatModelTitle) {
      void dispatch(selectChatModelForProfile(session.chatModelTitle));
    }
  },
);

export const selectChatModelForProfile = createAsyncThunk<
  void,
  string,
  ThunkApiType
>(
  "session/selectModelForCurrentProfile",
  async (modelTitle, { extra, dispatch, getState }) => {
    const state = getState();
    const modelMatch = state.config.config?.modelsByRole?.chat?.find(
      (m) => m.title === modelTitle,
    );
    const selectedProfile = selectSelectedProfile(state);
    if (selectedProfile && modelMatch) {
      await dispatch(
        updateSelectedModelByRole({
          role: "chat",
          modelTitle: modelTitle,
          selectedProfile,
        }),
      );
    }
  },
);

export const loadLastSession = createAsyncThunk<void, void, ThunkApiType>(
  "session/loadLast",
  async (_, { extra, dispatch, getState }) => {
    const currentSessionId = getState().session.id;
    let lastSessionId = getState().session.lastSessionId;

    // const lastSessionResult = await extra.ideMessenger.request("history/list", {
    //   limit: 1,
    // });
    // if (lastSessionResult.status === "success") {
    //   lastSessionId = lastSessionResult.content.at(0)?.sessionId;
    // }

    if (!lastSessionId) {
      await closeCoreAgentSession(extra.ideMessenger, currentSessionId);
      dispatch(newSession());
      return;
    }

    let session: Session;
    try {
      session = await getSession(extra.ideMessenger, lastSessionId);
    } catch {
      // retry again after 1 sec
      await new Promise((resolve) => setTimeout(resolve, 1000));
      session = await getSession(extra.ideMessenger, lastSessionId);
    }
    if (currentSessionId !== session.sessionId) {
      await closeCoreAgentSession(extra.ideMessenger, currentSessionId);
    }
    dispatch(newSession(session));
    await syncCoreAgentSnapshot(
      extra.ideMessenger,
      dispatch,
      getState,
    );
    if (session.chatModelTitle) {
      dispatch(selectChatModelForProfile(session.chatModelTitle));
    }
  },
);

async function syncCoreAgentSnapshot(
  ideMessenger: IIdeMessenger,
  dispatch: AppDispatch,
  getState: () => RootState,
): Promise<void> {
  const state = getState();
  if (
    state.session.mode !== "agent" &&
    state.session.mode !== "plan"
  ) {
    dispatch(setAgentRuntimeStatus(undefined));
    return;
  }

  const response = await ideMessenger.request("agent/session", {
    sessionId: state.session.id,
  });
  if (response.status === "error") {
    console.warn(
      `Failed to load durable agent session ${state.session.id}: ${response.error}`,
    );
    return;
  }

  const snapshot = response.content;
  if (!snapshot) {
    dispatch(setAgentRuntimeStatus(undefined));
    return;
  }

  dispatch(setAgentRuntimeStatus(snapshot.status));
  if (snapshot.timeline.length > 0) {
    dispatch(
      setAgentHydratedHistory(
        hydrateAgentHistory(
          state.session.history,
          snapshot,
        ),
      ),
    );
  }
}

function hydrateAgentHistory(
  existing: ChatHistoryItem[],
  snapshot: AgentSurfaceSessionSnapshot,
): any[] {
  const existingUsers = existing.filter(
    (item) => item.message.role === "user",
  );
  let userIndex = 0;
  const history: any[] = [];
  const toolStates = new Map<string, ToolCallState>();

  const ensureAssistant = () => {
    const last = history.at(-1);
    if (last?.message.role === "assistant") {
      return last;
    }
    const assistant = {
      message: {
        id: uuidv4(),
        role: "assistant",
        content: "",
      },
      contextItems: [],
      toolCallStates: [],
    };
    history.push(assistant);
    return assistant;
  };

  for (const item of snapshot.timeline) {
    if (item.type === "user_message") {
      const preserved = existingUsers[userIndex];
      userIndex += 1;
      history.push(
        preserved
          ? {
              ...preserved,
              message: {
                ...preserved.message,
                id: (preserved.message as any).id ?? uuidv4(),
              },
            }
          : {
              message: {
                id: uuidv4(),
                role: "user",
                content: item.content,
              },
              contextItems: [],
            },
      );
      continue;
    }

    if (item.type === "assistant_message") {
      history.push({
        message: {
          id: uuidv4(),
          role: "assistant",
          content: item.content,
        },
        contextItems: [],
        toolCallStates: [],
      });
      continue;
    }

    if (item.type === "tool_call") {
      const assistant = ensureAssistant();
      const toolCallState: ToolCallState = {
        toolCallId: item.callId,
        toolCall: {
          id: item.callId,
          type: "function",
          function: {
            name: item.name,
            arguments: JSON.stringify(item.input),
          },
        },
        status: "generated",
        parsedArgs: item.input,
      };
      assistant.toolCallStates ??= [];
      assistant.toolCallStates.push(toolCallState);
      toolStates.set(item.callId, toolCallState);
      continue;
    }

    const toolCallState = toolStates.get(item.callId);
    if (!toolCallState) {
      continue;
    }
    if (item.status === "success") {
      toolCallState.status = "done";
      const projected = timelineToolOutput(item);
      toolCallState.output = projected.contextItems;
      toolCallState.mcpUiState = projected.mcpUiState;
    } else {
      toolCallState.status = "errored";
      toolCallState.output = [
        {
          icon: "problems",
          name: "Tool Error",
          description: item.name,
          content:
            item.error?.message ?? "Tool execution failed",
        },
      ];
    }
  }

  return history;
}

function timelineToolOutput(
  item: Extract<AgentSurfaceTimelineItem, { type: "tool_result" }>,
): {
  contextItems: ContextItem[];
  mcpUiState?: any;
} {
  const output = item.output;
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

function getChatTitleFromMessage(message: ChatMessage) {
  const text =
    renderChatMessage(message)
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-1)[0] || "";

  // Truncate
  if (text.length > MAX_TITLE_LENGTH) {
    return text.slice(0, MAX_TITLE_LENGTH - 3) + "...";
  }
  return text;
}

export const saveCurrentSession = createAsyncThunk<
  void,
  { openNewSession: boolean; generateTitle: boolean },
  ThunkApiType
>(
  "session/saveCurrent",
  async ({ openNewSession, generateTitle }, { dispatch, extra, getState }) => {
    const session = getState().session; // assign to a variable so that even when current session changes, we have the reference to the old session
    if (session.history.length === 0) {
      return;
    }

    if (openNewSession) {
      await closeCoreAgentSession(extra.ideMessenger, session.id);
      dispatch(newSession());
    }

    const selectedChatModel = selectSelectedChatModel(getState());

    // New session has already been dispatched
    // Now save previous session and update chat title if relevant
    let title = session.title;
    if (title === NEW_SESSION_TITLE) {
      if (
        !getState().config.config?.disableSessionTitles &&
        selectedChatModel
      ) {
        let assistantResponse = session.history
          ?.filter((h) => h.message.role === "assistant")[0]
          ?.message?.content?.toString();

        if (assistantResponse && generateTitle) {
          try {
            const result = await extra.ideMessenger.request(
              "chatDescriber/describe",
              {
                text: assistantResponse,
              },
            );
            if (result.status === "success" && result.content) {
              title = result.content;
            }
          } catch (e) {
            console.error("Error generating chat title", e);
          }
        }
      }
      // Fallbacks if above doesn't work out or session titles disabled
      if (title === NEW_SESSION_TITLE) {
        title = getChatTitleFromMessage(session.history[0].message);
      }
    }
    // More fallbacks in case of no title
    if (!title.length) {
      const metadata = session.allSessionMetadata.find(
        (m) => m.sessionId === session.id,
      );
      if (metadata?.title) {
        title = metadata.title;
      }
    }
    if (!title.length) {
      title = NEW_SESSION_TITLE;
    }

    const updatedSession: Session = {
      sessionId: session.id,
      title,
      workspaceDirectory: window.workspacePaths?.[0] || "",
      history: session.history,
      mode: session.mode,
      executionProfile: session.executionProfile,
      chatModelTitle: selectedChatModel?.title ?? null,
    };

    const result = await dispatch(updateSession(updatedSession));
    unwrapResult(result);
  },
);
