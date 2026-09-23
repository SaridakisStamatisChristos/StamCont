import {
  CapabilityRequirement,
  getMissingCapabilities,
} from "./capabilities";
import { AgentEventBus } from "./events";
import { AgentSession } from "./session";

export interface AgentToolContext {
  sessionId: string;
  parentSessionId?: string;
  signal: AbortSignal;
  capabilities: AgentSession["capabilities"];
}

export interface AgentToolAuthorizationDecision {
  readonly allowed: boolean;
  readonly code?: string;
  readonly reason?: string;
}

export type AgentToolAuthorizer<Input> = (
  input: Input,
  context: AgentToolContext,
) =>
  | boolean
  | AgentToolAuthorizationDecision
  | Promise<boolean | AgentToolAuthorizationDecision>;

export type AgentCapabilityRequirement<Input> =
  | CapabilityRequirement
  | ((input: Input) => CapabilityRequirement);

export interface AgentTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  requiredCapabilities?: AgentCapabilityRequirement<Input>;
  authorize?: AgentToolAuthorizer<Input>;
  execute(
    input: Input,
    context: AgentToolContext,
  ): Output | Promise<Output>;
}

export class AgentToolNotFoundError extends Error {
  constructor(readonly toolName: string) {
    super(`Agent tool "${toolName}" is not registered`);
    this.name = "AgentToolNotFoundError";
  }
}

export class AgentCapabilityDeniedError extends Error {
  constructor(
    readonly toolName: string,
    readonly missingCapabilities: readonly string[],
  ) {
    super(
      `Agent tool "${toolName}" requires unavailable capabilities: ${missingCapabilities.join(
        ", ",
      )}`,
    );
    this.name = "AgentCapabilityDeniedError";
  }
}

export class AgentToolAuthorizationDeniedError extends Error {
  constructor(
    readonly toolName: string,
    readonly code = "tool_denied",
    readonly reason = "Tool execution was denied by policy",
  ) {
    super(`Agent tool "${toolName}" denied: ${reason}`);
    this.name = "AgentToolAuthorizationDeniedError";
  }
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentTool<any, any>>();

  constructor(tools: readonly AgentTool<any, any>[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: AgentTool<any, any>): void {
    const name = tool.name.trim();
    if (!name) {
      throw new Error("Agent tool name must be non-empty");
    }
    if (this.tools.has(name)) {
      throw new Error(`Agent tool "${name}" is already registered`);
    }

    this.tools.set(name, { ...tool, name });
  }

  replace(tool: AgentTool<any, any>): void {
    const name = tool.name.trim();
    if (!name) {
      throw new Error("Agent tool name must be non-empty");
    }
    this.tools.set(name, { ...tool, name });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): AgentTool<any, any> | undefined {
    return this.tools.get(name);
  }

  list(): readonly AgentTool<any, any>[] {
    return [...this.tools.values()];
  }
}

export interface AgentToolDispatcherOptions {
  registry: AgentToolRegistry;
  events: AgentEventBus;
  clock: () => number;
}

export class AgentToolDispatcher {
  constructor(private readonly options: AgentToolDispatcherOptions) {}

  async execute<Input, Output>(
    session: AgentSession,
    toolName: string,
    input: Input,
  ): Promise<Output> {
    session.assertActive();

    const tool = this.options.registry.get(toolName) as
      | AgentTool<Input, Output>
      | undefined;
    if (!tool) {
      throw new AgentToolNotFoundError(toolName);
    }

    await this.emit(session, "tool.requested", tool.name);

    const requirement =
      typeof tool.requiredCapabilities === "function"
        ? tool.requiredCapabilities(input)
        : tool.requiredCapabilities;
    const missing = getMissingCapabilities(
      session.capabilities,
      requirement,
    );
    if (missing.length > 0) {
      await this.emit(session, "tool.denied", tool.name, {
        denialKind: "capability",
        missingCapabilities: missing,
      });
      throw new AgentCapabilityDeniedError(tool.name, missing);
    }

    const context: AgentToolContext = {
      sessionId: session.id,
      parentSessionId: session.parentSessionId,
      signal: session.signal,
      capabilities: session.capabilities,
    };

    if (tool.authorize) {
      let rawDecision: boolean | AgentToolAuthorizationDecision;
      try {
        rawDecision = await tool.authorize(input, context);
      } catch (error) {
        await this.emit(session, "tool.failed", tool.name, {
          stage: "authorization",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const decision =
        typeof rawDecision === "boolean"
          ? { allowed: rawDecision }
          : rawDecision;
      if (!decision.allowed) {
        const code = decision.code ?? "tool_denied";
        const reason =
          decision.reason ?? "Tool execution was denied by policy";
        await this.emit(session, "tool.denied", tool.name, {
          denialKind: "policy",
          code,
          reason,
        });
        throw new AgentToolAuthorizationDeniedError(
          tool.name,
          code,
          reason,
        );
      }
    }

    await this.emit(session, "tool.started", tool.name);

    try {
      const output = await tool.execute(input, context);

      session.assertActive();
      await this.emit(session, "tool.completed", tool.name);
      return output;
    } catch (error) {
      await this.emit(session, "tool.failed", tool.name, {
        stage: "execution",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async emit(
    session: AgentSession,
    type:
      | "tool.requested"
      | "tool.denied"
      | "tool.started"
      | "tool.completed"
      | "tool.failed",
    toolName: string,
    details?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.options.events.emit({
      type,
      sessionId: session.id,
      parentSessionId: session.parentSessionId,
      toolName,
      timestamp: this.options.clock(),
      details,
    });
  }
}
