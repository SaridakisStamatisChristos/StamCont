import { CompletionOptions } from "@continuedev/config-yaml";
import type { ToolStatus } from "core/index.js";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources.mjs";

import type {
  PermissionMode,
  ToolPermissions,
} from "../permissions/types.js";
import { ToolCallPreview } from "../tools/types.js";

export interface StreamExecutionContext {
  permissionMode?: PermissionMode;
  permissions?: ToolPermissions;
  systemMessage?: string;
  useChatHistoryService?: boolean;
  sessionId?: string;
  isHeadless?: boolean;
}

export interface StreamCallbacks {
  onContent?: (content: string) => void;
  onContentComplete?: (content: string) => void;
  onToolStart?: (toolName: string, toolArgs?: any) => void;
  onToolResult?: (result: string, toolName: string, status: ToolStatus) => void;
  onToolError?: (error: string, toolName?: string) => void;
  onToolPermissionRequest?: (
    toolName: string,
    toolArgs: any,
    requestId: string,
    preview?: ToolCallPreview[],
  ) => void;
  onSystemMessage?: (message: string) => void;
}

export function getDefaultCompletionOptions(
  opts?: CompletionOptions,
): Partial<ChatCompletionCreateParamsStreaming> {
  if (!opts) return {};
  return {
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    frequency_penalty: opts.frequencyPenalty,
    presence_penalty: opts.presencePenalty,
    top_p: opts.topP,
  };
}
