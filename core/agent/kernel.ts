import { v4 as uuidv4 } from "uuid";

import {
  BuiltInExecutionProfileId,
  ExecutionProfile,
  getExecutionProfile,
  intersectExecutionProfiles,
} from "./capabilities";
import { AgentEventBus, AgentEventSink } from "./events";
import { AgentSession } from "./session";
import {
  AgentTool,
  AgentToolDispatcher,
  AgentToolRegistry,
} from "./tools";

export interface AgentKernelOptions {
  tools?: readonly AgentTool<any, any>[];
  events?: AgentEventBus;
  clock?: () => number;
  idFactory?: () => string;
}

export interface CreateAgentSessionOptions {
  id?: string;
  profile?: BuiltInExecutionProfileId | Readonly<ExecutionProfile>;
  parent?: AgentSession;
  metadata?: Readonly<Record<string, unknown>>;
}

export class AgentSubagentDeniedError extends Error {
  constructor(readonly parentSessionId: string) {
    super(
      `Agent session "${parentSessionId}" is not authorized to create subagents`,
    );
    this.name = "AgentSubagentDeniedError";
  }
}

export class AgentKernel {
  readonly tools: AgentToolRegistry;
  readonly events: AgentEventBus;

  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly dispatcher: AgentToolDispatcher;

  constructor(options: AgentKernelOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? uuidv4;
    this.events = options.events ?? new AgentEventBus();
    this.tools = new AgentToolRegistry(options.tools);
    this.dispatcher = new AgentToolDispatcher({
      registry: this.tools,
      events: this.events,
      clock: this.clock,
    });
  }

  subscribe(sink: AgentEventSink): () => void {
    return this.events.subscribe(sink);
  }

  async createSession(
    options: CreateAgentSessionOptions = {},
  ): Promise<AgentSession> {
    const requestedProfile = this.resolveProfile(options.profile);
    const profile = options.parent
      ? this.resolveNestedProfile(options.parent, requestedProfile)
      : requestedProfile;
    const session = new AgentSession({
      id: options.id ?? this.idFactory(),
      profile,
      parentSessionId: options.parent?.id,
      parentSignal: options.parent?.signal,
      metadata: options.metadata,
      createdAt: this.clock(),
    });

    await this.events.emit({
      type: "session.created",
      sessionId: session.id,
      parentSessionId: session.parentSessionId,
      timestamp: this.clock(),
      details: { profileId: profile.id },
    });

    return session;
  }

  async forkSession(
    parent: AgentSession,
    options: Omit<CreateAgentSessionOptions, "parent"> = {},
  ): Promise<AgentSession> {
    parent.assertActive();
    return this.createSession({
      ...options,
      parent,
      profile: options.profile ?? parent.profile,
    });
  }

  async executeTool<Input, Output>(
    session: AgentSession,
    toolName: string,
    input: Input,
  ): Promise<Output> {
    return this.dispatcher.execute<Input, Output>(session, toolName, input);
  }

  async cancelSession(
    session: AgentSession,
    reason = "cancelled",
  ): Promise<boolean> {
    const changed = session.cancel(reason);
    if (!changed) {
      return false;
    }

    await this.events.emit({
      type: "session.cancelled",
      sessionId: session.id,
      parentSessionId: session.parentSessionId,
      timestamp: this.clock(),
      details: { reason },
    });
    return true;
  }

  async closeSession(session: AgentSession): Promise<boolean> {
    const changed = session.close();
    if (!changed) {
      return false;
    }

    await this.events.emit({
      type: "session.closed",
      sessionId: session.id,
      parentSessionId: session.parentSessionId,
      timestamp: this.clock(),
    });
    return true;
  }

  private resolveProfile(
    profile:
      | BuiltInExecutionProfileId
      | Readonly<ExecutionProfile>
      | undefined,
  ): Readonly<ExecutionProfile> {
    if (!profile) {
      return getExecutionProfile("interactive");
    }
    return typeof profile === "string" ? getExecutionProfile(profile) : profile;
  }

  private resolveNestedProfile(
    parent: AgentSession,
    requestedProfile: Readonly<ExecutionProfile>,
  ): Readonly<ExecutionProfile> {
    parent.assertActive();
    if (!parent.capabilities.subagents) {
      throw new AgentSubagentDeniedError(parent.id);
    }
    return intersectExecutionProfiles(
      parent.profile,
      requestedProfile,
    );
  }
}
