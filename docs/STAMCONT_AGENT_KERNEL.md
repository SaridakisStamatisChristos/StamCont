# StamCont Agent Kernel

## Purpose

The StamCont Agent Kernel is the shared execution substrate for CLI, VS Code, JetBrains, future desktop/computer-control surfaces, and later integration with the separate Orchestrator project.

It is intentionally independent of any specific model provider or UI.

## Phase 2 invariants

The kernel establishes these invariants:

1. **Session-scoped state** — every root agent and subagent owns an isolated `AgentSession`.
2. **Capability-based execution** — adapted tool calls cross the shared dispatcher and are checked against session capabilities.
3. **First-class Full Access** — unrestricted execution is an explicit profile, not a hidden permission bypass.
4. **Structured events** — lifecycle events are emitted independently of UI/telemetry consumers.
5. **Cancellation propagation** — parent cancellation propagates to child sessions, while child cancellation cannot cancel the parent.
6. **Legacy compatibility** — existing Continue tool implementations, permission UX, telemetry, MCP plumbing, and model adapters remain reusable behind the kernel.

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
- no per-command kernel approval

Full Access is explicit. CLI legacy `auto` mode currently maps to `full_access`.

## Live integration state

### CLI

Approved CLI tool calls now execute through `CliAgentKernelBridge` and the shared kernel dispatcher.

Legacy permission handling remains the first gate. The mapping is:

```text
normal -> interactive
plan   -> plan
auto   -> full_access
```

Existing preprocessing, permission prompts, telemetry, Git-AI integration, tool implementations, and chat-history UI behavior remain intact.

### Subagents

Subagents now run as real child kernel sessions.

They no longer temporarily mutate global tool permissions, replace the global system-message function, or disable the global ChatHistoryService. Child execution receives invocation-scoped permissions, system message, history behavior, kernel session ID, and cancellation.

Parent cancellation propagates to children. Cancelling a child does not cancel its parent.

### Core / IDE

Core-side built-in, MCP, and HTTP tool execution now passes through `CoreToolKernelBridge` from the existing `core/tools/callTool.ts` seam.

The IDE now exposes Chat, Plan, Interactive, and explicit Full Access choices in the existing mode selector. Plan maps to the kernel `plan` profile, Interactive maps to `interactive`, and Full Access maps to `full_access`.

The selected execution profile and chat session ID are propagated with Core-side tool calls. Core kernel sessions are isolated by chat session, and switching the profile for a chat closes the previous Core kernel session before the replacement is created.

Chat changes and new-session transitions explicitly close the outgoing Core kernel session. VS Code registers Core disposal with the extension lifecycle so any remaining IDE kernel sessions are closed when the host deactivates.

Interactive retains the existing GUI policy/approval layer. Full Access skips per-command approval for tools that are already active, while explicitly disabled/excluded tools remain blocked.

## Capability boundary

The capability model distinguishes workspace-scoped and unrestricted filesystem/shell access. At this phase, the kernel enforces the declared capability requirement at the dispatcher boundary.

The labels **workspace** and **unrestricted** are not yet an OS sandbox. Path-aware filesystem confinement and process-level shell/network sandboxing are separate enforcement work and must not be assumed from the profile names alone.

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
  execute: async ({ command }) => command,
};

const kernel = new AgentKernel({ tools: [tool] });
const session = await kernel.createSession({ profile: "full_access" });
const result = await kernel.executeTool(
  session,
  "shell.execute",
  { command: "git status" },
);
```

## Remaining Phase 2 work

The major remaining product-facing work is:

- decide and implement path/process/network enforcement semantics for workspace-restricted profiles;
- continue promoting the streamed model loop toward a provider-neutral `AgentLoop` contract.

The separate Orchestrator repository remains a later higher-level planning/DAG/durability layer and is not a dependency of the kernel.
