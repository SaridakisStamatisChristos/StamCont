import { describe, expect, it, vi } from "vitest";

import { AgentKernel } from "core/agent/kernel.js";

import {
  adaptCliTool,
  getCliToolCapabilityRequirement,
} from "./cliToolAdapter.js";
import type { Tool } from "../tools/types.js";

function tool(
  name: string,
  options: Partial<Tool> = {},
): Tool {
  return {
    name,
    displayName: name,
    description: name,
    parameters: { type: "object", properties: {} },
    readonly: true,
    isBuiltIn: true,
    run: async () => "ok",
    ...options,
  };
}

describe("CLI tool adapter", () => {
  it("classifies existing built-ins by capability", () => {
    expect(getCliToolCapabilityRequirement(tool("Read"))).toEqual({
      filesystemRead: "workspace",
    });
    expect(
      getCliToolCapabilityRequirement(
        tool("Write", { readonly: false }),
      ),
    ).toEqual({ filesystemWrite: "workspace" });
    expect(
      getCliToolCapabilityRequirement(
        tool("Bash", { readonly: false }),
      ),
    ).toEqual({
      shell: "workspace",
      processControl: true,
    });
    expect(getCliToolCapabilityRequirement(tool("Fetch"))).toEqual({
      network: "restricted",
    });
    expect(
      getCliToolCapabilityRequirement(
        tool("Subagent", { readonly: false }),
      ),
    ).toEqual({ subagents: true });
  });

  it("classifies MCP tools through the shared MCP capability", () => {
    expect(
      getCliToolCapabilityRequirement(
        tool("remote_tool", {
          isBuiltIn: false,
          readonly: undefined,
        }),
      ),
    ).toEqual({ mcp: true });
  });

  it("delegates legacy execution without changing arguments or context", async () => {
    const run = vi.fn(async () => "legacy-result");
    const legacy = tool("Read", { run });
    const kernel = new AgentKernel({
      tools: [adaptCliTool(legacy)],
      idFactory: () => "session-1",
    });
    const session = await kernel.createSession({
      profile: "interactive",
    });
    const context = {
      toolCallId: "call-1",
      parallelToolCallCount: 2,
    };

    const result = await kernel.executeTool(
      session,
      "Read",
      {
        tool: legacy,
        args: { filepath: "README.md" },
        context,
      },
    );

    expect(result).toBe("legacy-result");
    expect(run).toHaveBeenCalledWith(
      { filepath: "README.md" },
      context,
    );
  });

  it("allows unrestricted tools in full_access but blocks writes in plan", async () => {
    const legacy = tool("Write", {
      readonly: false,
      run: async () => "written",
    });
    const kernel = new AgentKernel({
      tools: [adaptCliTool(legacy)],
      idFactory: (() => {
        let next = 0;
        return () => `session-${++next}`;
      })(),
    });
    const plan = await kernel.createSession({ profile: "plan" });
    const full = await kernel.createSession({ profile: "full_access" });

    await expect(
      kernel.executeTool(plan, "Write", {
        tool: legacy,
        args: { filepath: "x", content: "y" },
      }),
    ).rejects.toThrow("filesystem.write:workspace");

    await expect(
      kernel.executeTool(full, "Write", {
        tool: legacy,
        args: { filepath: "x", content: "y" },
      }),
    ).resolves.toBe("written");
  });
});
