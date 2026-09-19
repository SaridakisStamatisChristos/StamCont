import type { BuiltInExecutionProfileId } from "core/agent/capabilities.js";
import { AgentKernel } from "core/agent/kernel.js";
import type { AgentSession } from "core/agent/session.js";

import type { PermissionMode } from "../permissions/types.js";
import type { Tool, ToolRunContext } from "../tools/types.js";

import { adaptCliTool } from "./cliToolAdapter.js";

export interface CliKernelToolExecution {
  tool: Tool;
  toolName?: string;
  args: Record<string, any>;
  context?: ToolRunContext;
  mode: PermissionMode;
  sessionId?: string;
}

export function permissionModeToExecutionProfile(
  mode: PermissionMode,
): BuiltInExecutionProfileId {
  switch (mode) {
    case "plan":
      return "plan";
    case "auto":
      return "full_access";
    case "normal":
    default:
      return "interactive";
  }
}

export class CliAgentKernelBridge {
  readonly kernel: AgentKernel;

  private readonly sessions = new Map<string, Promise<AgentSession>>();

  constructor(kernel: AgentKernel = new AgentKernel()) {
    this.kernel = kernel;
  }

  async execute(options: CliKernelToolExecution): Promise<string> {
    const profile = permissionModeToExecutionProfile(options.mode);
    const session = await this.getSession(
      options.sessionId,
      profile,
    );

    const toolName = options.toolName?.trim() || options.tool.name;
    this.kernel.tools.replace(adaptCliTool(options.tool, toolName));

    return this.kernel.executeTool(session, toolName, {
      tool: options.tool,
      args: options.args,
      context: options.context,
    });
  }

  async closeSession(
    sessionId: string,
    mode: PermissionMode,
  ): Promise<boolean> {
    const profile = permissionModeToExecutionProfile(mode);
    const key = this.sessionKey(sessionId, profile);
    const pending = this.sessions.get(key);
    if (!pending) {
      return false;
    }

    this.sessions.delete(key);
    const session = await pending;
    return this.kernel.closeSession(session);
  }

  clear(): void {
    this.sessions.clear();
  }

  private getSession(
    sessionId: string | undefined,
    profile: BuiltInExecutionProfileId,
  ): Promise<AgentSession> {
    const key = this.sessionKey(sessionId, profile);
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }

    const created = this.kernel.createSession({
      id: this.kernelSessionId(sessionId, profile),
      profile,
      metadata: {
        surface: "cli",
        legacyPermissionMode:
          profile === "full_access"
            ? "auto"
            : profile === "plan"
              ? "plan"
              : "normal",
      },
    });
    this.sessions.set(key, created);
    return created;
  }

  private sessionKey(
    sessionId: string | undefined,
    profile: BuiltInExecutionProfileId,
  ): string {
    return `${sessionId?.trim() || "ephemeral"}:${profile}`;
  }

  private kernelSessionId(
    sessionId: string | undefined,
    profile: BuiltInExecutionProfileId,
  ): string {
    return `cli:${sessionId?.trim() || "ephemeral"}:${profile}`;
  }
}

export const cliAgentKernelBridge = new CliAgentKernelBridge();
