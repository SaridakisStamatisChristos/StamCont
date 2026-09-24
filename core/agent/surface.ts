import type { AgentModelInputItem } from "./model";
import type { BuiltInExecutionProfileId } from "./capabilities";
import type { AgentLoopStatus } from "./loop";
import type {
  AgentRunError,
  AgentStopReason,
  JsonValue,
} from "./protocol";

export type AgentSurfaceRunStatus =
  | "running"
  | "resumable"
  | "resume_blocked"
  | AgentLoopStatus;

export type AgentSurfaceToolPolicy =
  | "disabled"
  | "allowedWithPermission"
  | "allowedWithoutPermission";

export interface AgentSurfaceRunRequest {
  readonly sessionId: string;
  readonly profile: BuiltInExecutionProfileId;
  readonly toolNames: readonly string[];
  readonly toolPolicies?: Readonly<
    Record<string, AgentSurfaceToolPolicy>
  >;
  /**
   * Compatibility-only context used to bootstrap a previously non-durable
   * surface into an empty durable session. Once durable history exists it is
   * ignored; the durable log remains authoritative.
   */
  readonly initialInput?: readonly AgentModelInputItem[];
  readonly systemPrompt?: string;
  readonly userPrompt?: string;
  readonly maxIterations?: number;
}

export interface AgentSurfaceApproval {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly profile: BuiltInExecutionProfileId;
  readonly itemId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly input: JsonValue;
}

export type AgentSurfaceEvent =
  | {
      readonly type: "run_state";
      readonly status: AgentSurfaceRunStatus;
      readonly stopReason?: AgentStopReason;
      readonly error?: AgentRunError;
    }
  | {
      readonly type: "assistant_delta";
      readonly responseId: string;
      readonly itemId: string;
      readonly delta: string;
    }
  | {
      readonly type: "assistant_completed";
      readonly responseId: string;
      readonly itemId: string;
      readonly content: string;
    }
  | {
      readonly type: "tool_requested";
      readonly responseId: string;
      readonly itemId: string;
      readonly callId: string;
      readonly name: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "approval_required";
      readonly approval: AgentSurfaceApproval;
    }
  | {
      readonly type: "tool_running";
      readonly itemId: string;
      readonly callId: string;
      readonly name: string;
    }
  | {
      readonly type: "tool_result";
      readonly itemId: string;
      readonly callId: string;
      readonly name: string;
      readonly status: "success" | "failure";
      readonly output?: JsonValue;
      readonly error?: AgentRunError;
    }
  | {
      readonly type: "response_completed";
      readonly responseId: string;
      readonly stopReason: AgentStopReason;
    };

export interface AgentSurfaceRunResult {
  readonly sessionId: string;
  readonly resumed: boolean;
  readonly status: AgentLoopStatus;
  readonly stopReason?: AgentStopReason;
  readonly error?: AgentRunError;
}

export type AgentSurfaceTimelineItem =
  | {
      readonly type: "user_message";
      readonly content: string;
    }
  | {
      readonly type: "assistant_message";
      readonly itemId: string;
      readonly content: string;
    }
  | {
      readonly type: "tool_call";
      readonly itemId: string;
      readonly callId: string;
      readonly name: string;
      readonly input: JsonValue;
    }
  | {
      readonly type: "tool_result";
      readonly itemId: string;
      readonly callId: string;
      readonly name: string;
      readonly status: "success" | "failure";
      readonly output?: JsonValue;
      readonly error?: AgentRunError;
    };

export interface AgentSurfaceSessionSnapshot {
  readonly sessionId: string;
  readonly status: AgentSurfaceRunStatus;
  readonly lifecycleState?: string;
  readonly stopReason?: AgentStopReason;
  readonly error?: AgentRunError;
  readonly blockReason?: string;
  readonly timeline: readonly AgentSurfaceTimelineItem[];
}

export interface AgentSurfaceSessionMetadata {
  readonly sessionId: string;
  readonly modifiedAt: number;
}
