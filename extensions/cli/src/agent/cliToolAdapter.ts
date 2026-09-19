import type {
  AgentTool,
  CapabilityRequirement,
} from "core/agent/index.js";

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
): AgentTool<CliToolInvocation, string> {
  return {
    name: tool.name,
    description: tool.description,
    requiredCapabilities: (invocation) =>
      getCliToolCapabilityRequirement(invocation.tool),
    execute: async (invocation) => {
      return invocation.tool.run(
        invocation.args,
        invocation.context,
      );
    },
  };
}
