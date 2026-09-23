import type { Tool } from "../..";

import { CapabilityRequirement } from "../capabilities";

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
  "read_file",
  "read_file_range",
  "read_currently_open_file",
  "grep_search",
  "file_glob_search",
  "ls",
  "codebase",
  "view_diff",
  "view_repo_map",
  "view_subdirectory",
  "read_skill",
  "request_rule",
]);

const writeTools = new Set([
  "create_new_file",
  "edit_existing_file",
  "single_find_and_replace",
  "multi_edit",
  "create_rule_block",
]);

const networkTools = new Set(["search_web", "fetch_url_content"]);

export function getCoreToolCapabilityRequirement(
  tool: Pick<Tool, "function" | "readonly" | "uri">,
  input?: unknown,
): CapabilityRequirement {
  if (tool.uri) {
    try {
      const protocol = new URL(tool.uri).protocol;
      if (protocol === "mcp:") {
        return { mcp: true };
      }
      if (protocol === "http:" || protocol === "https:") {
        return NETWORK;
      }
    } catch {
      return tool.readonly ? WORKSPACE_READ : WORKSPACE_WRITE;
    }
  }

  const name = tool.function.name;
  if (name === "run_terminal_command") {
    const requestsBackgroundJob =
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      (input as Record<string, unknown>).waitForCompletion === false;
    return requestsBackgroundJob
      ? { ...SHELL, backgroundJobs: true }
      : SHELL;
  }
  if (networkTools.has(name)) {
    return NETWORK;
  }
  if (writeTools.has(name)) {
    return WORKSPACE_WRITE;
  }
  if (readTools.has(name)) {
    return WORKSPACE_READ;
  }

  return tool.readonly ? WORKSPACE_READ : WORKSPACE_WRITE;
}
