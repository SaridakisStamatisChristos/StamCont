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

export interface AgentTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  requiredCapabilities?: CapabilityRequirement;
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

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(tools: readonly AgentTool[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: AgentTool): void {
    const name = tool.name.trim();
    if (!name) {
      throw new Error("Agent tool name must be non-empty");
    }
    if (this.tools.has(name)) {
      throw new Error(`Agent tool "${name}" is already registered`);
    }

    this.tools.set(name, { ...tool, name });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): readonly AgentTool[] {
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

    const missing = getMissingCapabilities(
      session.capabilities,
      tool.requiredCapabilities,
    );
    if (missing.length > 0) {
      await this.emit(session, "tool.denied", tool.name, {
        missingCapabilities: missing,
      });
      throw new AgentCapabilityDeniedError(tool.name, missing);
    }

    await this.emit(session, "tool.started", tool.name);

    try {
      const output = await tool.execute(input, {
        sessionId: session.id,
        parentSessionId: session.parentSessionId,
        signal: session.signal,
        capabilities: session.capabilities,
      });

      session.assertActive();
      await this.emit(session, "tool.completed", tool.name);
      return output;
    } catch (error) {
      await this.emit(session, "tool.failed", tool.name, {
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
