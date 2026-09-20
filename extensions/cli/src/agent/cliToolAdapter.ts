import type { CapabilityRequirement } from "core/agent/capabilities.js";
import type { AgentTool } from "core/agent/tools.js";

import type { Tool, ToolRunContext } from "../tools/types.js";

export interface CliToolInvocation {
  tool: Tool;
  args: Record<string, any>;
  context?: ToolRunContext;
}

const WORKSPACE_READ: CapabilityRequirement = {
  filesystemRead: "workspace",
};
const WORKSPACE_WRITE: CapabilityRequirement = {
  filesystemWrite: "workspace",
};
const NETWORK: CapabilityRequirement = {
  network: "restricted",
};
const SHELL: CapabilityRequirement = {
  shell: "workspace",
  processControl: true,
};

const readTools = new Set([
  "List",
  "Read",
  "Search",
  "Diff",
  "Skills",
  "Status",
  "CheckBackgroundJob",
]);

const writeTools = new Set(["Edit", "MultiEdit", "Write"]);

export function getCliToolCapabilityRequirement(
  tool: Pick<Tool, "name" | "readonly" | "isBuiltIn">,
): CapabilityRequirement {
  if (!tool.isBuiltIn) {
    return { mcp: true };
  }

  if (tool.name === "Bash") {
    return SHELL;
  }
  if (tool.name === "Fetch" || tool.name === "UploadArtifact") {
    return NETWORK;
  }
  if (tool.name === "Subagent") {
    return { subagents: true };
  }
  if (writeTools.has(tool.name)) {
    return WORKSPACE_WRITE;
  }
  if (readTools.has(tool.name)) {
    return WORKSPACE_READ;
  }

  if (tool.readonly === true) {
    return WORKSPACE_READ;
  }
  if (tool.readonly === false) {
    return WORKSPACE_WRITE;
  }

  return {};
}

export function adaptCliTool(
  tool: Tool,
  nameOverride?: string,
): AgentTool<CliToolInvocation, string> {
  const name = nameOverride?.trim() || tool.name;
  return {
    name,
    description: tool.description ?? name,
    requiredCapabilities: () =>
      getCliToolCapabilityRequirement({
        ...tool,
        name,
      }),
    execute: async (invocation, agentContext) => {
      return invocation.tool.run(invocation.args, {
        ...invocation.context,
        toolCallId: invocation.context?.toolCallId ?? agentContext.sessionId,
        parallelToolCallCount:
          invocation.context?.parallelToolCallCount ?? 1,
        executionSignal: agentContext.signal,
      });
    },
  };
}
