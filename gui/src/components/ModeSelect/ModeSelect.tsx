import {
  CheckIcon,
  ChevronDownIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from "@heroicons/react/24/outline";
import type { ExecutionProfileId, MessageModes } from "core";
import { isRecommendedAgentModel } from "core/llm/toolSupport";
import { useCallback, useEffect, useMemo } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import {
  setExecutionProfile,
  setMode,
} from "../../redux/slices/sessionSlice";
import { getFontSize, getMetaKeyLabel } from "../../util";
import { ToolTip } from "../gui/Tooltip";
import { useMainEditor } from "../mainInput/TipTapEditor";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "../ui";
import { ModeIcon } from "./ModeIcon";

type ModeSelection = "chat" | ExecutionProfileId;

const MODE_SELECTIONS: readonly ModeSelection[] = [
  "chat",
  "plan",
  "interactive",
  "full_access",
];

const MODE_LABELS: Record<ModeSelection, string> = {
  chat: "Chat",
  plan: "Plan",
  interactive: "Interactive",
  full_access: "Full Access",
};

export function getModeSelection(
  mode: MessageModes,
  executionProfile: ExecutionProfileId,
): ModeSelection {
  if (mode === "chat") {
    return "chat";
  }
  if (mode === "plan") {
    return "plan";
  }
  return executionProfile === "full_access" ? "full_access" : "interactive";
}

export function ModeSelect() {
  const dispatch = useAppDispatch();
  const mode = useAppSelector((store) => store.session.mode);
  const executionProfile = useAppSelector(
    (store) => store.session.executionProfile,
  );
  const selectedModel = useAppSelector(selectSelectedChatModel);
  const selection = getModeSelection(mode, executionProfile);

  const isGoodAtAgentMode = useMemo(() => {
    if (!selectedModel) {
      return undefined;
    }
    return isRecommendedAgentModel(selectedModel.model);
  }, [selectedModel]);

  const { mainEditor } = useMainEditor();
  const metaKeyLabel = useMemo(() => {
    return getMetaKeyLabel();
  }, []);

  const selectMode = useCallback(
    (newSelection: ModeSelection) => {
      if (newSelection === selection) {
        return;
      }

      if (newSelection === "chat") {
        dispatch(setMode("chat"));
      } else if (newSelection === "plan") {
        dispatch(setExecutionProfile("plan"));
      } else {
        dispatch(setMode("agent"));
        dispatch(setExecutionProfile(newSelection));
      }

      mainEditor?.commands.focus();
    },
    [dispatch, mainEditor, selection],
  );

  const cycleMode = useCallback(() => {
    const currentIndex = MODE_SELECTIONS.indexOf(selection);
    const nextIndex = (currentIndex + 1) % MODE_SELECTIONS.length;
    selectMode(MODE_SELECTIONS[nextIndex]);

    if (!document.activeElement?.classList?.contains("ProseMirror")) {
      mainEditor?.commands.focus();
    }
  }, [mainEditor, selectMode, selection]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "." && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        cycleMode();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [cycleMode]);

  const notGreatAtAgent = (label: string) => (
    <ToolTip
      style={{
        zIndex: 200001,
      }}
      className="flex items-center gap-1"
      content={`${label} might not work well with this model.`}
    >
      <ExclamationTriangleIcon className="text-warning h-2.5 w-2.5" />
    </ToolTip>
  );

  return (
    <Listbox value={selection} onChange={selectMode}>
      <div className="relative">
        <ListboxButton
          data-testid="mode-select-button"
          className="xs:px-2 text-description bg-lightgray/20 gap-1 rounded-full border-none px-1.5 py-0.5 transition-colors duration-200 hover:brightness-110"
        >
          <ModeIcon mode={selection} />
          <span className="hidden sm:block">{MODE_LABELS[selection]}</span>
          <ChevronDownIcon
            className="h-2 w-2 flex-shrink-0"
            aria-hidden="true"
          />
        </ListboxButton>
        <ListboxOptions className="min-w-40 max-w-64">
          <ListboxOption value="chat">
            <div className="flex flex-row items-center gap-1.5">
              <ModeIcon mode="chat" />
              <span>Chat</span>
              <ToolTip
                style={{
                  zIndex: 200001,
                }}
                content="All tools disabled"
              >
                <InformationCircleIcon
                  data-tooltip-id="chat-tip"
                  className="h-2.5 w-2.5 flex-shrink-0"
                />
              </ToolTip>
              <span
                className={`text-description-muted text-[${getFontSize() - 3}px] mr-auto`}
              >
                {getMetaKeyLabel()}L
              </span>
            </div>
            {selection === "chat" && (
              <CheckIcon className="ml-auto h-3 w-3" />
            )}
          </ListboxOption>

          <ListboxOption value="plan" className="gap-1">
            <div className="flex flex-row items-center gap-1.5">
              <ModeIcon mode="plan" />
              <span>Plan</span>
              <ToolTip
                style={{
                  zIndex: 200001,
                }}
                content="Read-only workspace and MCP tools; filesystem writes are blocked"
              >
                <InformationCircleIcon className="h-2.5 w-2.5 flex-shrink-0" />
              </ToolTip>
            </div>
            {!isGoodAtAgentMode && notGreatAtAgent("Plan")}
            <CheckIcon
              className={`ml-auto h-3 w-3 ${
                selection === "plan" ? "" : "opacity-0"
              }`}
            />
          </ListboxOption>

          <ListboxOption value="interactive" className="gap-1">
            <div className="flex flex-row items-center gap-1.5">
              <ModeIcon mode="interactive" />
              <span>Interactive</span>
              <ToolTip
                style={{
                  zIndex: 200001,
                }}
                content="Workspace coding tools with policy-driven approvals"
              >
                <InformationCircleIcon className="h-2.5 w-2.5 flex-shrink-0" />
              </ToolTip>
            </div>
            {!isGoodAtAgentMode && notGreatAtAgent("Interactive")}
            <CheckIcon
              className={`ml-auto h-3 w-3 ${
                selection === "interactive" ? "" : "opacity-0"
              }`}
            />
          </ListboxOption>

          <ListboxOption value="full_access" className="gap-1">
            <div className="flex flex-row items-center gap-1.5">
              <ModeIcon mode="full_access" />
              <span>Full Access</span>
              <ToolTip
                style={{
                  zIndex: 200001,
                }}
                content="Unrestricted filesystem, shell, network and process execution with no per-command approval"
              >
                <ExclamationTriangleIcon className="text-warning h-2.5 w-2.5 flex-shrink-0" />
              </ToolTip>
            </div>
            {!isGoodAtAgentMode && notGreatAtAgent("Full Access")}
            <CheckIcon
              className={`ml-auto h-3 w-3 ${
                selection === "full_access" ? "" : "opacity-0"
              }`}
            />
          </ListboxOption>

          <div className="text-description-muted px-2 py-1">
            {`${metaKeyLabel} . for next mode`}
          </div>
        </ListboxOptions>
      </div>
    </Listbox>
  );
}
