import { describe, expect, it } from "vitest";

import { getCoreToolCapabilityRequirement } from "./coreTool";

function tool(
  name: string,
  readonly: boolean,
  uri?: string,
) {
  return {
    function: { name },
    readonly,
    uri,
  };
}

describe("Core tool capability adapter", () => {
  it("classifies workspace reads and writes", () => {
    expect(
      getCoreToolCapabilityRequirement(tool("read_file", true)),
    ).toEqual({ filesystemRead: "workspace" });
    expect(
      getCoreToolCapabilityRequirement(tool("create_new_file", false)),
    ).toEqual({ filesystemWrite: "workspace" });
  });

  it("classifies terminal and network tools", () => {
    expect(
      getCoreToolCapabilityRequirement(tool("run_terminal_command", false)),
    ).toEqual({
      shell: "workspace",
      processControl: true,
    });
    expect(
      getCoreToolCapabilityRequirement(tool("fetch_url_content", true)),
    ).toEqual({ network: "restricted" });
  });

  it("requires background-job capability for detached terminal work", () => {
    expect(
      getCoreToolCapabilityRequirement(
        tool("run_terminal_command", false),
        { command: "test", waitForCompletion: false },
      ),
    ).toEqual({
      shell: "workspace",
      processControl: true,
      backgroundJobs: true,
    });
  });

  it("classifies URI-backed MCP and HTTP tools", () => {
    expect(
      getCoreToolCapabilityRequirement(
        tool("dynamic", false, "mcp://server/tool"),
      ),
    ).toEqual({ mcp: true });
    expect(
      getCoreToolCapabilityRequirement(
        tool("dynamic", true, "https://example.com/tool"),
      ),
    ).toEqual({ network: "restricted" });
  });

  it("fails conservatively for unknown tools", () => {
    expect(
      getCoreToolCapabilityRequirement(tool("unknown_read", true)),
    ).toEqual({ filesystemRead: "workspace" });
    expect(
      getCoreToolCapabilityRequirement(tool("unknown_write", false)),
    ).toEqual({ filesystemWrite: "workspace" });
  });
});
