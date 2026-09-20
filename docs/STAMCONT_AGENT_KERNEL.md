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
- strict child-process environment allowlisting that strips API credentials, cloud tokens, SSH-agent handles, language/runtime injection variables, and host temp-directory pointers;
- sandbox-owned `HOME` / `USERPROFILE` and temporary directories rather than exposing host user state;
- owned process-group tracking and descendant process-tree termination on cancellation;
- restricted native HTTP(S) fetches that reject localhost, private, link-local, multicast, and other reserved targets, reject mixed public/private DNS answers, pin the actual connection lookup to the validated address, preserve the original hostname for HTTP Host/TLS SNI/certificate validation, and revalidate redirects.

Sandboxed shell execution is OS-enforced where a supported containment primitive is available:

- Linux uses `bubblewrap` with isolated namespaces, a private tmpfs, `--unshare-net`, and workspace binds; Plan mounts those workspace binds read-only;
- macOS uses `sandbox-exec` with workspace rules, a per-process private temp directory, denied network access, and read-only workspace rules for Plan;
- Windows uses an ephemeral AppContainer profile, workspace-scoped ACL grants, no network capability, a private HOME/TEMP area, and a Job Object configured to kill the owned process tree when the launcher closes; Plan adds an AppContainer-SID deny-write ACL so read-only behavior is enforced at the OS boundary;
- platforms without an enforceable sandbox primitive fail closed for Interactive/Plan shell execution rather than silently falling back to an unrestricted host shell.

Plan and Interactive share the same confinement implementation but not the same write authority. Interactive receives writable workspace mounts. Plan is read-only both at the kernel capability layer and at the OS sandbox/filesystem-backend layer, so a Plan shell cannot bypass tool-level write denial by redirecting output to a workspace file.

## Capability and enforcement boundary

The capability model distinguishes workspace-scoped and unrestricted filesystem/shell access at the dispatcher boundary.

- **Full Access** selects `HostExecutionBackend` and uses the authority of the current OS user without a StamCont workspace allowlist.
- **Interactive** selects `SandboxExecutionBackend` with workspace read/write, sandboxed shell execution, restricted HTTP(S), environment filtering, and owned process cancellation.
- **Plan** also selects `SandboxExecutionBackend`, but its kernel capabilities continue to deny filesystem writes.

The sandbox is intentionally fail-closed when process isolation cannot be enforced. Restricted HTTP now binds policy resolution to connection establishment using a pinned lookup agent, so an attacker cannot pass policy validation with one DNS answer and cause the HTTP stack to connect using a later private answer.

Filesystem writes revalidate the nearest existing ancestor immediately before creation and use a no-follow final-component open where the platform exposes `O_NOFOLLOW`. This materially narrows symlink races, but it does not claim to eliminate every parent-directory replacement TOCTOU race on every filesystem. The OS process sandbox remains the authoritative boundary for shell-originated writes.

Residual-risk boundary: built-in host-process filesystem operations cannot make a universal race-free path guarantee using Node path APIs alone on every supported filesystem. Canonicalization, nearest-existing-ancestor checks, final-component no-follow where available, and the profile capability layer substantially narrow that surface; shell-originated operations are additionally constrained by the OS sandbox. Full Access intentionally does not receive those workspace restrictions.

Windows shell containment is implemented through AppContainer plus Job Objects rather than a policy-only wrapper. The launcher creates a unique profile per sandbox process, grants only the workspace/private runtime paths required for execution, starts the command under AppContainer security capabilities, assigns the process to an owned kill-on-close Job Object, and removes the temporary profile/ACL entries during teardown. AppContainer is created without network capabilities, so shell-originated outbound networking remains denied while approved built-in HTTP continues through the restricted fetch path.

The focused execution-security workflow is authoritative for OS-boundary claims. It runs the adversarial execution suite on Ubuntu, macOS, and Windows and sets `STAMCONT_REQUIRE_OS_SANDBOX_TESTS=1`, so missing containment primitives fail the security job instead of converting integration coverage into skips.

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

The execution-hardening implementation is complete when both the focused cross-platform execution-security workflow and the normal StamCont baseline are green on the PR and again on merged `main`.

The final hardening gate covers:

- Windows AppContainer filesystem, Plan read-only, descendant-process, environment, temp-isolation, cancellation, and network-denial properties;
- Linux/macOS sandbox filesystem, read-only, nested-shell, environment, temp-isolation, cancellation, and network-denial properties;
- restricted HTTP DNS-to-connect pinning, redirect revalidation, cross-origin credential stripping, and caller `Host`/proxy-auth suppression;
- Full Access regression coverage proving that host-wide current-user filesystem/shell semantics remain unrestricted.

After that gate is merged and green, the next architecture phase is the provider-neutral `AgentLoop`. The separate Orchestrator repository remains out of scope until the AgentLoop is stable.

The separate Orchestrator repository remains a later higher-level planning/DAG/durability layer and is not a dependency of the kernel.
