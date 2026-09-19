# StamCont Agent Kernel

## Purpose

The StamCont Agent Kernel is the shared execution substrate for CLI, VS Code, JetBrains, future desktop/computer-control surfaces, and later integration with the separate Orchestrator project.

It is intentionally independent of any specific model provider or UI.

## Phase 2 foundation

The first kernel layer establishes five invariants:

1. **Session-scoped state** — every root agent and subagent owns an isolated `AgentSession`.
2. **Capability-based execution** — every tool call crosses one dispatcher and is checked against the session's capabilities.
3. **First-class Full Access** — unrestricted local execution is an explicit profile, not a hidden permission bypass.
4. **Structured events** — lifecycle events are emitted independently of UI/telemetry consumers.
5. **Cancellation propagation** — parent cancellation propagates to child sessions, while child cancellation cannot cancel the parent.

## Built-in execution profiles

### Plan

- workspace read
- no filesystem writes
- workspace shell
- restricted network
- MCP and subagents available
- explicit approval posture

### Interactive

- workspace read/write
- workspace shell
- restricted network
- process/background-job support
- MCP and subagents
- policy-driven approvals

### Full Access

- unrestricted filesystem read/write
- unrestricted shell
- full network
- process control
- background jobs
- MCP
- subagents
- computer control
- no per-command approval

Full Access is deliberately explicit and opt-in at the product surface.

## Current API

```ts
import {
  AgentKernel,
  AgentTool,
} from "./agent";

const tool: AgentTool<{ command: string }, string> = {
  name: "shell.execute",
  description: "Execute a shell command",
  requiredCapabilities: { shell: "workspace" },
  execute: async ({ command }, context) => {
    // Adapter implementation supplied by CLI / IDE surface.
    return command;
  },
};

const kernel = new AgentKernel({ tools: [tool] });
const session = await kernel.createSession({ profile: "full_access" });
const result = await kernel.executeTool(
  session,
  "shell.execute",
  { command: "git status" },
);
```

## Deliberate non-goals of the first kernel commit

This foundation does not yet replace Continue's existing CLI agent loop, Core tool implementation, permission UI, model adapters, or MCP manager.

Those systems remain operational while adapters are introduced incrementally.

The next migration step is to wrap the existing CLI/Core tools behind `AgentTool`, then move permission/profile resolution into the kernel without changing externally visible behavior. After that, the existing streamed LLM loop can be promoted into a provider-neutral `AgentLoop` using the same session and dispatcher contracts.

The separate Orchestrator repository will be integrated later as a higher-level planning/DAG/durability layer. It is not a dependency of the kernel.
