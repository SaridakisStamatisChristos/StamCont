import type { Tool } from "../..";

import type { BuiltInExecutionProfileId } from "../capabilities";
import { AgentKernel } from "../kernel";
import type { AgentSession } from "../session";
import type {
  AgentTool,
  AgentToolAuthorizer,
  AgentToolContext,
} from "../tools";

import { getCoreToolCapabilityRequirement } from "./coreTool";

export interface CoreToolExecutionOptions<Output> {
  tool: Tool;
  input?: unknown;
  authorize?: AgentToolAuthorizer<unknown>;
  execute: (context: AgentToolContext) => Output | Promise<Output>;
  profile?: BuiltInExecutionProfileId;
  sessionId?: string;
  signal?: AbortSignal;
}

export class CoreToolKernelBridge {
  readonly kernel: AgentKernel;

  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly activeProfiles = new Map<
    string,
    BuiltInExecutionProfileId
  >();

  constructor(kernel: AgentKernel = new AgentKernel()) {
    this.kernel = kernel;
  }

  async execute<Output>(
    options: CoreToolExecutionOptions<Output>,
  ): Promise<Output> {
    const profile = options.profile ?? "interactive";
    const sessionId = options.sessionId?.trim() || "ide";
    if (options.signal?.aborted) {
      throw new Error(
        `Tool execution cancelled before start: ${abortReason(options.signal)}`,
      );
    }

    const session = await this.getSession(sessionId, profile);
    const toolName = options.tool.function.name;

    const adapted: AgentTool<unknown, Output> = {
      name: toolName,
      description:
        options.tool.function.description ??
        options.tool.displayTitle ??
        toolName,
      requiredCapabilities: (input) =>
        getCoreToolCapabilityRequirement(options.tool, input),
      authorize: options.authorize,
      execute: (_input, context) => options.execute(context),
    };

    this.kernel.tools.replace(adapted);

    const cancel = () => {
      void this.cancelSession(
        sessionId,
        profile,
        abortReason(options.signal!),
      );
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await this.kernel.executeTool<unknown, Output>(
        session,
        toolName,
        options.input,
      );
    } finally {
      options.signal?.removeEventListener("abort", cancel);
    }
  }

  async cancelSession(
    sessionId = "ide",
    profile?: BuiltInExecutionProfileId,
    reason = "cancelled",
  ): Promise<boolean> {
    const resolvedProfile = profile ?? this.activeProfiles.get(sessionId);
    if (!resolvedProfile) {
      return false;
    }

    const key = this.sessionKey(sessionId, resolvedProfile);
    const pending = this.sessions.get(key);
    if (!pending) {
      if (this.activeProfiles.get(sessionId) === resolvedProfile) {
        this.activeProfiles.delete(sessionId);
      }
      return false;
    }

    this.sessions.delete(key);
    if (this.activeProfiles.get(sessionId) === resolvedProfile) {
      this.activeProfiles.delete(sessionId);
    }
    return this.kernel.cancelSession(await pending, reason);
  }

  async closeAllSessions(): Promise<number> {
    const sessionIds = [...this.activeProfiles.keys()];
    const closed = await Promise.all(
      sessionIds.map((sessionId) => this.closeSession(sessionId)),
    );
    return closed.filter(Boolean).length;
  }

  async closeSession(
    sessionId = "ide",
    profile?: BuiltInExecutionProfileId,
  ): Promise<boolean> {
    const resolvedProfile = profile ?? this.activeProfiles.get(sessionId);
    if (!resolvedProfile) {
      return false;
    }

    const key = this.sessionKey(sessionId, resolvedProfile);
    const pending = this.sessions.get(key);
    if (!pending) {
      if (this.activeProfiles.get(sessionId) === resolvedProfile) {
        this.activeProfiles.delete(sessionId);
      }
      return false;
    }

    this.sessions.delete(key);
    if (this.activeProfiles.get(sessionId) === resolvedProfile) {
      this.activeProfiles.delete(sessionId);
    }
    return this.kernel.closeSession(await pending);
  }

  private async getSession(
    sessionId: string,
    profile: BuiltInExecutionProfileId,
  ): Promise<AgentSession> {
    const activeProfile = this.activeProfiles.get(sessionId);
    if (activeProfile && activeProfile !== profile) {
      await this.closeSession(sessionId, activeProfile);
    }

    const key = this.sessionKey(sessionId, profile);
    const existing = this.sessions.get(key);
    if (existing) {
      this.activeProfiles.set(sessionId, profile);
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
    this.activeProfiles.set(sessionId, profile);
    return created;
  }

  private sessionKey(
    sessionId: string,
    profile: BuiltInExecutionProfileId,
  ): string {
    return `${sessionId}:${profile}`;
  }
}

function abortReason(signal: AbortSignal): string {
  if (typeof signal.reason === "string" && signal.reason.trim()) {
    return signal.reason;
  }
  if (signal.reason instanceof Error && signal.reason.message) {
    return signal.reason.message;
  }
  return "cancelled";
}

export const coreToolKernelBridge = new CoreToolKernelBridge();
