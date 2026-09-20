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

### Host Executor

Full Access now selects a concrete `HostExecutionBackend` for Core execution instead of relying only on capability labels. The backend uses the authority of the OS user running StamCont and does not add an artificial workspace allowlist.

The current host-backed surface includes:

- reading full files and line ranges by absolute, `file://`, `~`, or workspace-relative path;
- creating files and directories outside the opened workspace;
- listing arbitrary OS-user-accessible directories;
- editing existing outside-workspace files through the existing VS Code apply/diff flow;
- executing shell commands with an explicit arbitrary `cwd`;
- foreground and detached/background process creation;
- binding spawned processes to the owning kernel session's cancellation signal.

Relative paths continue to resolve from the first local workspace when one exists, preserving the normal coding workflow. Absolute paths provide the whole-machine path needed for cross-project Full Access work.

### Sandbox Executor

Plan and Interactive now select `SandboxExecutionBackend` instead of the legacy IDE-only execution path.

The sandbox enforces workspace-scoped execution across both IDE and CLI surfaces:

- canonical `realpath` validation for existing files and directories;
- multi-root workspace support;
- rejection of absolute paths outside configured workspace roots;
- symlink/junction escape rejection after canonicalization;
- writable-path validation against the nearest existing ancestor before directories/files are created;
- host-side Core path authorization for GUI edit tools, returning the canonical URI that the webview is allowed to use;
- CLI argument preprocessing and execution-time revalidation through the same profile-selected backend;
- filtered child-process environments with `HOME` / `USERPROFILE` relocated into the workspace;
- owned process-group tracking and descendant process-tree termination on cancellation;
- restricted native HTTP(S) fetches that reject localhost, private, link-local, multicast, and other reserved targets and revalidate redirects.

Sandboxed shell execution is OS-enforced where a supported containment primitive is available:

- Linux uses `bubblewrap` with isolated namespaces and `--unshare-net`;
- macOS uses `sandbox-exec` with workspace file rules and denied network access;
- unsupported platforms fail closed for Interactive/Plan shell execution rather than silently falling back to an unrestricted host shell.

Plan and Interactive therefore share the same filesystem/process sandbox boundary, while the kernel capability profile still distinguishes what the model is permitted to do. In particular, Plan retains read-only filesystem capability even though it uses the same sandbox backend.

## Capability and enforcement boundary

The capability model distinguishes workspace-scoped and unrestricted filesystem/shell access at the dispatcher boundary.

- **Full Access** selects `HostExecutionBackend` and uses the authority of the current OS user without a StamCont workspace allowlist.
- **Interactive** selects `SandboxExecutionBackend` with workspace read/write, sandboxed shell execution, restricted HTTP(S), environment filtering, and owned process cancellation.
- **Plan** also selects `SandboxExecutionBackend`, but its kernel capabilities continue to deny filesystem writes.

The sandbox is intentionally fail-closed when process isolation cannot be enforced. Remaining hardening work includes native Windows shell containment, broader cross-platform enforcement coverage, and stronger HTTP DNS-pinning/connection binding against DNS-rebinding races.

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

- harden the execution backends across supported platforms, especially native Windows process containment and remaining platform-specific edge cases;
- strengthen restricted HTTP transport against DNS-rebinding/connection-race classes beyond target prevalidation and redirect revalidation;
- continue promoting the streamed model loop toward a provider-neutral `AgentLoop` contract now that Host and Sandbox execution backends are established.

The separate Orchestrator repository remains a later higher-level planning/DAG/durability layer and is not a dependency of the kernel.
