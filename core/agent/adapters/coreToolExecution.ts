import type { Tool } from "../..";

import type { BuiltInExecutionProfileId } from "../capabilities";
import { AgentKernel } from "../kernel";
import type { AgentSession } from "../session";
import type { AgentTool } from "../tools";

import { getCoreToolCapabilityRequirement } from "./coreTool";

export interface CoreToolExecutionOptions<Output> {
  tool: Tool;
  execute: () => Output | Promise<Output>;
  profile?: BuiltInExecutionProfileId;
  sessionId?: string;
}

export class CoreToolKernelBridge {
  readonly kernel: AgentKernel;

  private readonly sessions = new Map<string, Promise<AgentSession>>();

  constructor(kernel: AgentKernel = new AgentKernel()) {
    this.kernel = kernel;
  }

  async execute<Output>(
    options: CoreToolExecutionOptions<Output>,
  ): Promise<Output> {
    const profile = options.profile ?? "interactive";
    const sessionId = options.sessionId?.trim() || "ide";
    const session = await this.getSession(sessionId, profile);
    const toolName = options.tool.function.name;

    const adapted: AgentTool<void, Output> = {
      name: toolName,
      description:
        options.tool.function.description ??
        options.tool.displayTitle ??
        toolName,
      requiredCapabilities:
        getCoreToolCapabilityRequirement(options.tool),
      execute: options.execute,
    };

    this.kernel.tools.replace(adapted);
    return this.kernel.executeTool<void, Output>(
      session,
      toolName,
      undefined,
    );
  }

  async closeSession(
    sessionId = "ide",
    profile: BuiltInExecutionProfileId = "interactive",
  ): Promise<boolean> {
    const key = this.sessionKey(sessionId, profile);
    const pending = this.sessions.get(key);
    if (!pending) {
      return false;
    }

    this.sessions.delete(key);
    return this.kernel.closeSession(await pending);
  }

  private getSession(
    sessionId: string,
    profile: BuiltInExecutionProfileId,
  ): Promise<AgentSession> {
    const key = this.sessionKey(sessionId, profile);
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }

    const created = this.kernel.createSession({
      id: `core:${sessionId}:${profile}`,
      profile,
      metadata: {
        surface: "core",
      },
    });
    this.sessions.set(key, created);
    return created;
  }

  private sessionKey(
    sessionId: string,
    profile: BuiltInExecutionProfileId,
  ): string {
    return `${sessionId}:${profile}`;
  }
}

export const coreToolKernelBridge = new CoreToolKernelBridge();
