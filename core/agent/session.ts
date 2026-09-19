import {
  cloneCapabilities,
  ExecutionProfile,
  freezeCapabilities,
} from "./capabilities";

export type AgentSessionState = "active" | "cancelled" | "closed";

export interface AgentSessionOptions {
  id: string;
  profile: Readonly<ExecutionProfile>;
  parentSessionId?: string;
  parentSignal?: AbortSignal;
  metadata?: Readonly<Record<string, unknown>>;
  createdAt: number;
}

export class AgentSession {
  readonly id: string;
  readonly parentSessionId?: string;
  readonly profile: Readonly<ExecutionProfile>;
  readonly capabilities;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;

  private readonly controller = new AbortController();
  private parentAbortListener?: () => void;
  private sessionState: AgentSessionState = "active";
  private cancellationReason?: string;

  constructor(options: AgentSessionOptions) {
    this.id = options.id;
    this.parentSessionId = options.parentSessionId;
    this.profile = options.profile;
    this.capabilities = freezeCapabilities(
      cloneCapabilities(options.profile.capabilities),
    );
    this.metadata = Object.freeze({ ...(options.metadata ?? {}) });
    this.createdAt = options.createdAt;

    if (options.parentSignal) {
      this.attachParentSignal(options.parentSignal);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get state(): AgentSessionState {
    return this.sessionState;
  }

  get cancelReason(): string | undefined {
    return this.cancellationReason;
  }

  assertActive(): void {
    if (this.sessionState !== "active") {
      throw new Error(
        `Agent session ${this.id} is ${this.sessionState}${
          this.cancellationReason ? `: ${this.cancellationReason}` : ""
        }`,
      );
    }
  }

  cancel(reason = "cancelled"): boolean {
    if (this.sessionState !== "active") {
      return false;
    }

    this.sessionState = "cancelled";
    this.cancellationReason = reason;
    this.detachParentSignal();
    this.controller.abort(reason);
    return true;
  }

  close(): boolean {
    if (this.sessionState === "closed") {
      return false;
    }

    this.sessionState = "closed";
    this.detachParentSignal();
    if (!this.controller.signal.aborted) {
      this.controller.abort("session closed");
    }
    return true;
  }

  private attachParentSignal(parentSignal: AbortSignal): void {
    if (parentSignal.aborted) {
      this.cancel("parent session cancelled");
      return;
    }

    const listener = () => {
      this.cancel("parent session cancelled");
    };
    parentSignal.addEventListener("abort", listener, { once: true });
    this.parentAbortListener = () => {
      parentSignal.removeEventListener("abort", listener);
    };
  }

  private detachParentSignal(): void {
    this.parentAbortListener?.();
    this.parentAbortListener = undefined;
  }
}
