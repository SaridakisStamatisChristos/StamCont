import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { resumeAgentSession } from "../../../redux/thunks/resumeAgentSession";
import { Button } from "../../ui";

export function AgentRuntimeBanner() {
  const dispatch = useAppDispatch();
  const status = useAppSelector(
    (state) => state.session.agentRuntimeStatus,
  );

  if (status === "resumable") {
    return (
      <div className="border-border bg-vsc-input-background mx-2 mb-1 flex items-center justify-between gap-2 rounded border px-2 py-1">
        <span className="text-description text-xs">
          Durable agent session recovered and ready to resume.
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void dispatch(resumeAgentSession())}
        >
          Resume
        </Button>
      </div>
    );
  }

  if (status === "resume_blocked") {
    return (
      <div className="border-border bg-vsc-input-background text-description mx-2 mb-1 rounded border px-2 py-1 text-xs">
        Durable agent recovery is blocked because a previous tool execution
        cannot be replayed safely. Start a new session after reviewing the
        last tool state.
      </div>
    );
  }

  return null;
}
