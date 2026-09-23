import type {
  ContextItem,
  McpUiState,
  Tool,
  ToolCall,
  ToolExtras,
} from "../..";

import {
  getExecutionProfile,
  type BuiltInExecutionProfileId,
} from "../capabilities";
import type {
  AgentModelToolDefinition,
  AgentToolExecutionContext,
  AgentToolExecutionOutcome,
  AgentToolExecutor,
} from "../model";
import type {
  AgentToolCallItem,
  JsonObject,
  JsonValue,
} from "../protocol";
import {
  AgentCapabilityDeniedError,
  AgentToolAuthorizationDeniedError,
  AgentToolNotFoundError,
  type AgentToolAuthorizationDecision,
  type AgentToolAuthorizer,
} from "../tools";
import {
  callTool,
  type CoreToolCallResult,
} from "../../tools/callTool";
import { CLIENT_TOOLS_IMPLS } from "../../tools/builtIn";

import {
  CoreToolKernelBridge,
  coreToolKernelBridge,
} from "./coreToolExecution";

const DEFAULT_CORE_TOOL_POLICY = "allowedWithPermission" as const;
const clientOnlyToolNames = new Set<string>(CLIENT_TOOLS_IMPLS);

type CoreToolPolicy =
  | "disabled"
  | "allowedWithPermission"
  | "allowedWithoutPermission";

export interface CoreAgentToolApprovalRequest {
  readonly sessionId: string;
  readonly profile: BuiltInExecutionProfileId;
  readonly itemId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly input: JsonObject;
  readonly policy: Exclude<CoreToolPolicy, "disabled">;
}

export type CoreAgentToolApprovalHandler = (
  request: CoreAgentToolApprovalRequest,
) => boolean | Promise<boolean>;

export interface CoreAgentClientToolExecutionRequest {
  readonly sessionId: string;
  readonly profile: BuiltInExecutionProfileId;
  readonly itemId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly input: JsonObject;
}

export interface CoreAgentClientToolExecutionResult {
  readonly contextItems: readonly ContextItem[];
  readonly mcpUiState?: McpUiState;
  readonly errorMessage?: string;
}

export type CoreAgentClientToolExecutionHandler = (
  request: CoreAgentClientToolExecutionRequest,
) => Promise<CoreAgentClientToolExecutionResult>;

export interface CoreAgentToolRuntimeOptions {
  readonly tools: readonly Tool[];
  readonly extras: Omit<ToolExtras, "tool" | "toolCallId">;
  readonly sessionId: string;
  readonly profile?: BuiltInExecutionProfileId;
  readonly approve?: CoreAgentToolApprovalHandler;
  readonly executeClientTool?: CoreAgentClientToolExecutionHandler;
  readonly bridge?: CoreToolKernelBridge;
}

export interface CoreAgentToolRuntimeDescription {
  readonly definitions: readonly AgentModelToolDefinition[];
  readonly unsupportedToolNames: readonly string[];
}

export class CoreAgentToolExecutor implements AgentToolExecutor {
  readonly profile: BuiltInExecutionProfileId;
  readonly sessionId: string;
  readonly description: CoreAgentToolRuntimeDescription;

  private readonly tools = new Map<string, Tool>();
  private readonly bridge: CoreToolKernelBridge;

  constructor(private readonly options: CoreAgentToolRuntimeOptions) {
    this.profile = options.profile ?? "interactive";
    this.sessionId = requireSessionId(options.sessionId);
    this.bridge = options.bridge ?? coreToolKernelBridge;

    const unsupportedToolNames: string[] = [];
    for (const tool of options.tools) {
      const name = tool.function.name.trim();
      if (!name) {
        throw new Error("Core agent tool names must be non-empty");
      }
      if (this.tools.has(name)) {
        throw new Error(`Duplicate Core agent tool name: ${name}`);
      }
      if (clientOnlyToolNames.has(name) && !options.executeClientTool) {
        unsupportedToolNames.push(name);
        continue;
      }
      this.tools.set(name, tool);
    }

    this.description = Object.freeze({
      definitions: Object.freeze(
        [...this.tools.values()].map(coreToolToAgentDefinition),
      ),
      unsupportedToolNames: Object.freeze(unsupportedToolNames),
    });
  }

  async execute(
    toolCall: AgentToolCallItem,
    context: AgentToolExecutionContext,
  ): Promise<AgentToolExecutionOutcome> {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return failure(
        "kernel_rejection",
        `Agent tool "${toolCall.name}" is not available in the Core runtime`,
        {
          itemId: toolCall.id,
          callId: toolCall.callId,
          toolName: toolCall.name,
        },
      );
    }

    const input = asInputObject(toolCall.input);
    if (!input) {
      return failure(
        "tool_failure",
        `Agent tool "${toolCall.name}" requires a JSON object input`,
        {
          itemId: toolCall.id,
          callId: toolCall.callId,
          toolName: toolCall.name,
        },
      );
    }

    if (clientOnlyToolNames.has(toolCall.name)) {
      return this.executeClientTool(tool, toolCall, input, context);
    }

    const continueToolCall: ToolCall = {
      id: toolCall.callId,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(input),
      },
    };

    const result = await callTool(
      tool,
      continueToolCall,
      {
        ...this.options.extras,
        tool,
        toolCallId: toolCall.callId,
      },
      {
        profile: this.profile,
        sessionId: this.sessionId,
        signal: context.signal,
        authorize: this.createKernelAuthorizer(tool, toolCall, input),
        bridge: this.bridge,
        processId: createCoreAgentProcessId(
          this.sessionId,
          toolCall.id,
          toolCall.callId,
        ),
        strictProcessFailures: true,
        managedBackgroundJobs: true,
      },
    );

    if (
      context.signal.aborted ||
      result.errorCode === "tool_cancelled"
    ) {
      throw new Error(
        `Agent tool "${toolCall.name}" was cancelled`,
      );
    }

    if (result.errorCode === "executor_failure") {
      throw new Error(
        result.errorMessage ??
          `Core tool executor failed for "${toolCall.name}"`,
      );
    }

    if (result.errorMessage) {
      return coreFailure(result, toolCall);
    }

    return {
      status: "success",
      output: toJsonValue({
        contextItems: result.contextItems,
        ...(result.mcpUiState
          ? { mcpUiState: result.mcpUiState }
          : {}),
      }),
    };
  }

  async cancel(reason = "agent run cancelled"): Promise<boolean> {
    return this.bridge.cancelSession(
      this.sessionId,
      this.profile,
      reason,
    );
  }

  async close(): Promise<boolean> {
    return this.bridge.closeSession(this.sessionId, this.profile);
  }

  private async executeClientTool(
    tool: Tool,
    toolCall: AgentToolCallItem,
    input: JsonObject,
    context: AgentToolExecutionContext,
  ): Promise<AgentToolExecutionOutcome> {
    const executeClientTool = this.options.executeClientTool;
    if (!executeClientTool) {
      return failure(
        "kernel_rejection",
        `Agent tool "${toolCall.name}" requires a client execution adapter`,
        {
          itemId: toolCall.id,
          callId: toolCall.callId,
          toolName: toolCall.name,
        },
      );
    }

    try {
      const result = await this.bridge.execute({
        tool,
        input,
        profile: this.profile,
        sessionId: this.sessionId,
        signal: context.signal,
        authorize: this.createKernelAuthorizer(tool, toolCall, input),
        execute: async () =>
          executeClientTool({
            sessionId: this.sessionId,
            profile: this.profile,
            itemId: toolCall.id,
            callId: toolCall.callId,
            toolName: toolCall.name,
            input,
          }),
      });

      if (result.errorMessage) {
        return failure(
          "tool_failure",
          result.errorMessage,
          {
            itemId: toolCall.id,
            callId: toolCall.callId,
            toolName: toolCall.name,
          },
        );
      }

      return {
        status: "success",
        output: toJsonValue({
          contextItems: result.contextItems,
          ...(result.mcpUiState
            ? { mcpUiState: result.mcpUiState }
            : {}),
        }),
      };
    } catch (error) {
      if (context.signal.aborted) {
        throw new Error(
          `Agent tool "${toolCall.name}" was cancelled`,
        );
      }
      if (error instanceof AgentToolAuthorizationDeniedError) {
        return failure(
          error.code === "approval_required"
            ? "approval_required"
            : "tool_denied",
          error.message,
          {
            itemId: toolCall.id,
            callId: toolCall.callId,
            toolName: toolCall.name,
          },
        );
      }
      if (
        error instanceof AgentCapabilityDeniedError ||
        error instanceof AgentToolNotFoundError
      ) {
        return failure(
          "kernel_rejection",
          error.message,
          {
            itemId: toolCall.id,
            callId: toolCall.callId,
            toolName: toolCall.name,
          },
        );
      }
      return failure(
        "tool_failure",
        error instanceof Error ? error.message : String(error),
        {
          itemId: toolCall.id,
          callId: toolCall.callId,
          toolName: toolCall.name,
        },
      );
    }
  }

  private createKernelAuthorizer(
    tool: Tool,
    toolCall: AgentToolCallItem,
    input: JsonObject,
  ): AgentToolAuthorizer<unknown> {
    return async (): Promise<AgentToolAuthorizationDecision> => {
      const policy = resolveToolPolicy(tool, input);
      if (policy === "disabled") {
        return {
          allowed: false,
          code: "tool_denied",
          reason: "Tool is disabled by execution policy",
        };
      }

      const approvalMode =
        getExecutionProfile(this.profile).capabilities.approvalMode;
      const requiresApproval =
        approvalMode === "always" ||
        (approvalMode === "policy" &&
          policy === "allowedWithPermission");

      if (!requiresApproval) {
        return { allowed: true };
      }
      if (!this.options.approve) {
        return {
          allowed: false,
          code: "approval_required",
          reason:
            "Tool execution requires approval but no approval handler is attached",
        };
      }

      const approved = await this.options.approve({
        sessionId: this.sessionId,
        profile: this.profile,
        itemId: toolCall.id,
        callId: toolCall.callId,
        toolName: toolCall.name,
        input,
        policy,
      });
      return approved
        ? { allowed: true }
        : {
            allowed: false,
            code: "tool_denied",
            reason: "User denied tool execution",
          };
    };
  }
}

export function createCoreAgentProcessId(
  sessionId: string,
  itemId: string,
  callId: string,
): string {
  return [
    "agent",
    encodeURIComponent(requireSessionId(sessionId)),
    encodeURIComponent(itemId),
    encodeURIComponent(callId),
  ].join(":");
}

export function describeCoreAgentTools(
  tools: readonly Tool[],
): CoreAgentToolRuntimeDescription {
  const definitions: AgentModelToolDefinition[] = [];
  const unsupportedToolNames: string[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    const name = tool.function.name.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    if (clientOnlyToolNames.has(name)) {
      unsupportedToolNames.push(name);
      continue;
    }
    definitions.push(coreToolToAgentDefinition(tool));
  }

  return {
    definitions,
    unsupportedToolNames,
  };
}

function coreToolToAgentDefinition(
  tool: Tool,
): AgentModelToolDefinition {
  const parameters = tool.function.parameters;
  return {
    name: tool.function.name,
    ...(tool.function.description
      ? { description: tool.function.description }
      : {}),
    ...(parameters
      ? { inputSchema: toJsonObject(parameters, "tool input schema") }
      : {}),
  };
}

function resolveToolPolicy(
  tool: Tool,
  input: JsonObject,
): CoreToolPolicy {
  const basePolicy =
    (tool.defaultToolPolicy as CoreToolPolicy | undefined) ??
    DEFAULT_CORE_TOOL_POLICY;
  if (!tool.evaluateToolCallPolicy) {
    return basePolicy;
  }

  const dynamic = tool.evaluateToolCallPolicy(
    basePolicy,
    input as Record<string, unknown>,
    undefined,
  ) as CoreToolPolicy;

  if (basePolicy === "disabled") {
    return "disabled";
  }
  if (
    basePolicy === "allowedWithPermission" &&
    dynamic === "allowedWithoutPermission"
  ) {
    return "allowedWithPermission";
  }
  return dynamic;
}

function coreFailure(
  result: CoreToolCallResult,
  toolCall: AgentToolCallItem,
): AgentToolExecutionOutcome {
  const code = result.errorCode ?? "tool_failure";
  return failure(
    code,
    result.errorMessage ?? `Agent tool "${toolCall.name}" failed`,
    {
      itemId: toolCall.id,
      callId: toolCall.callId,
      toolName: toolCall.name,
      ...(result.errorReason
        ? { continueErrorReason: result.errorReason }
        : {}),
    },
  );
}

function failure(
  code: string,
  message: string,
  details: JsonObject,
): AgentToolExecutionOutcome {
  return {
    status: "failure",
    error: {
      code,
      message,
      details,
    },
  };
}

function requireSessionId(sessionId: string): string {
  const value = sessionId.trim();
  if (!value) {
    throw new Error("Core agent tool runtime requires a non-empty session id");
  }
  return value;
}

function asInputObject(value: JsonValue): JsonObject | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  return value as JsonObject;
}

function toJsonObject(
  value: unknown,
  label: string,
): JsonObject {
  const converted = toJsonValue(value);
  if (
    typeof converted !== "object" ||
    converted === null ||
    Array.isArray(converted)
  ) {
    throw new Error(`${label} must serialize to a JSON object`);
  }
  return converted as JsonObject;
}

function toJsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Core tool output is not JSON serializable");
  }
  return JSON.parse(encoded) as JsonValue;
}
