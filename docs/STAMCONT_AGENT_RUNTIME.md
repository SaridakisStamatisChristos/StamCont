# StamCont Agent Runtime — Release Architecture and Operations

This document describes the implemented StamCont agent runtime at the Roadmap PR16 release-readiness gate. It documents current behavior; it is not a proposal for a second runtime.

The canonical execution path is:

```text
CLI or IDE/GUI surface
        ↓
provider-neutral AgentModelDriver
        ↓
canonical AgentRunEvent protocol + reducer
        ↓
AgentLoop
        ↓
AgentKernel-authorized tool runtime
        ↓
host/sandbox execution backend
```

The durable session log is historical truth. Indexes, snapshots, compaction artifacts, context plans, diagnostics, and UI projections are derived state.

## 1. Canonical runtime authority

StamCont has one provider-neutral agent loop: `core/agent/loop.ts`.

The loop consumes `AgentModelDriver` streams and reduces only canonical `AgentRunEvent` values. Provider adapters do not execute tools. Tool execution occurs only after an authoritative completed canonical tool-call item has been reduced and the response terminates with normalized `tool_use`.

Core branching uses only these normalized stop reasons:

```text
tool_use
end_turn
max_tokens
cancelled
error
unknown
```

Provider-specific finish strings are normalized at the adapter boundary.

Completed output items are authoritative. Streaming message, reasoning, and tool-call deltas are presentation/early-parsing data and cannot become executable authority. Opaque/signed/encrypted provider continuation state is retained only on the completed authoritative item.

## 2. Surfaces

### CLI

The CLI durable runtime is implemented in `extensions/cli/src/agent/runtime.ts` and calls the same Core `runAgentLoop`.

The CLI durable-session root is:

```text
<continueHome>/agent-sessions/
```

A new CLI session receives a generated or explicitly supplied session ID. Resume uses an explicit durable session ID or selects the newest durable session when the caller requests bare resume.

### IDE / GUI / VS Code

Core creates `AgentSurfaceRuntime` at:

```text
<Continue global path>/agent-sessions/
```

The surface runtime projects canonical events into presentation-safe surface events while keeping canonical durable history authoritative. Once a durable session exists, stale UI history cannot overwrite it.

The GUI/VS Code and CLI surfaces therefore differ in presentation and approval UX, but both execute through the same Core AgentLoop semantics.

## 3. Execution profiles and approval behavior

Built-in profiles are defined in `core/agent/capabilities.ts`.

### Plan

- workspace filesystem read;
- no filesystem write capability;
- workspace shell;
- restricted network;
- MCP and subagents available;
- approval mode `always`;
- no background/process-control authority.

Plan remains read-only at both capability and OS-sandbox layers. A shell command cannot bypass Plan write denial by redirecting output.

### Interactive

- workspace read/write;
- workspace shell;
- restricted network;
- process/background-job support;
- MCP and subagents;
- policy-driven approvals.

Interactive is the normal constrained coding profile.

### Full Access

- unrestricted filesystem read/write;
- unrestricted shell;
- full network;
- process control/background jobs;
- MCP, subagents, and computer-control capability;
- approval mode `never`.

Full Access is explicit and intentionally uses the authority of the OS user running StamCont. It is not a hidden bypass.

## 4. AgentKernel and tool contract

`AgentKernel` is the execution authorization authority.

A tool registered with the kernel declares:

- a stable name;
- an optional capability requirement;
- an optional policy authorizer;
- an execution function.

The dispatcher performs, in order:

```text
session active check
→ tool lookup
→ capability check
→ optional policy authorization
→ tool started
→ execution
→ completion/failure event
```

CLI/Core compatibility adapters must route execution into this boundary rather than creating an alternate executor with independent authority.

For canonical model execution:

1. the provider produces a completed canonical tool-call item;
2. the response terminates with `tool_use`;
3. AgentLoop discovers executable completed calls;
4. the configured tool executor routes them through the kernel/tool runtime;
5. the result is persisted as a canonical `tool_result`;
6. the next model request receives the persisted result.

A tool-level failure remains a tool result and is not misreported as a provider-stream failure.

## 5. Durable session layout

Each durable session is stored under:

```text
<agent-session-root>/<sessionId>/
```

### `session.jsonl` — authoritative

This append-only JSONL file is the authoritative durable history.

Persistence schema version:

```text
AGENT_PERSISTENCE_SCHEMA_VERSION = 1
```

Every record contains:

```text
schemaVersion
sessionId
sequence
kind
payload
```

Supported record kinds are:

```text
model_input
model_event
tool_result
lifecycle
metadata
```

Sequence numbers are positive, contiguous, and validated on replay. Wrong-session records, rollback/duplicate durable sequence corruption, malformed JSON, and unsupported schema versions fail explicitly.

Durable JSONL append is fsync'd before an append is considered committed.

### `session.idx` — derived

The index contains byte offsets/lengths for authoritative records.

It is derived state, not historical truth. It is rebuilt from `session.jsonl` when missing, stale, or corrupt.

PR15 moved index maintenance off the per-event append hot path. In-memory index state advances with each committed record and the derived index is checkpointed on clean close/rebuild. A crash may therefore leave a stale index, but recovery reconstructs it from the authoritative log.

### `session.snapshot.json` — derived

Snapshots are atomically replaced derived state with:

```text
schemaVersion
sessionId
logSequence
createdAt
state
```

A snapshot is fresh only when its `logSequence` matches the current committed log sequence. Stale/corrupt snapshots never replace authoritative replay.

### `session.compaction.json` — derived

Compaction artifacts are versioned/fingerprinted derived context representations.

They include:

- compaction schema version;
- session identity;
- source sequence range;
- source fingerprint;
- summary fingerprint;
- safe semantic boundary;
- protected source sequences;
- algorithm ID/version;
- summary text.

The original durable records remain in `session.jsonl`; compaction never erases historical truth.

## 6. Durable lifecycle and resume behavior

Durable lifecycle records have their own explicit lifecycle schema version.

The state machine includes:

```text
created
running
waiting_for_model
waiting_for_tool
resumable
interrupted
completed
cancelled
failed
closed
```

Resume is determined from replayed durable facts, not UI state.

Important restart behavior:

- a completed `end_turn` is terminal and is not rerun;
- a persisted cancellation stays cancelled after restart;
- a crash before a tool-attempt `started` marker can safely resume the pending tool;
- a tool attempt that may already have produced an external side effect but has no durable result is ambiguous and blocks automatic replay;
- ambiguous external side effects are never silently repeated;
- explicit reconciliation is required where the lifecycle API exposes it;
- unsupported persistence/lifecycle versions fail loudly rather than being silently reinterpreted.

A new user turn after a completed `end_turn` explicitly reopens the lifecycle through `resumable` before the new durable input is appended.

## 7. Provider adapter contract

Provider adapters translate between existing provider/model infrastructure and the canonical model contract.

They must preserve:

- stable response identity;
- monotonic canonical event sequence;
- unique event IDs;
- stable output-item identity;
- authoritative `output_item.completed`;
- normalized terminal stop reason;
- provider request/item metadata required for continuation;
- opaque reasoning continuation state where supplied by the provider.

They must not:

- execute tools;
- invent opaque provider state;
- leak provider SDK types into AgentLoop/reducer/kernel branching;
- emit arbitrary provider finish reasons as Core control values.

## 8. Compaction and context budgeting

Context planning is derived from authoritative durable history.

The budget includes:

- input estimate;
- tool-definition estimate;
- provider continuation overhead when available;
- reserved output tokens;
- safety margin.

Planner outcomes are:

```text
fits_raw
fits_with_existing_compaction
needs_compaction
overflow_non_compactable
```

When compaction is required and a summarizer is available, the runtime compacts only at a semantically safe completed-turn/resolved-tool-round boundary, persists the derived artifact, and replans.

Protected information remains verbatim where required, including system messages, the latest relevant user input, paired tool-call/result data required for correctness, and provider-native/opaque continuation state.

If no safe compactable representation can fit, the model request is not issued and the runtime returns an explicit context error.

## 9. Nested sessions / subagents

Subagents are real child kernel sessions, not a parallel runtime.

Child effective authority is the intersection of parent authority and the requested child profile:

```text
child capability ≤ parent capability
```

Parent cancellation propagates to active child sessions. Child cancellation does not cancel the parent.

Parent/child identity is persisted strongly enough for durable relationship recovery. Child context is constructed explicitly; parent history is not blindly cloned.

Child tools continue to execute through AgentKernel. MCP/subagent paths cannot be used to escalate capabilities.

## 10. Cancellation and process ownership

Cancellation propagates through the active model/tool runtime and into owned execution backends.

The sandbox/host execution layer tracks processes owned by the session and terminates the owned process tree when cancellation requires it. Unrelated host processes are outside that ownership set and must remain untouched.

Cross-platform execution-security CI is the authority for OS containment claims:

- Linux: bubblewrap;
- macOS: sandbox-exec;
- Windows: AppContainer + Job Object.

Interactive/Plan shell execution fails closed if the required enforceable sandbox primitive is unavailable.

## 11. Network boundary

Interactive/Plan use restricted networking. Restricted fetch rejects localhost, private/link-local/multicast/reserved destinations, validates DNS answers, pins the validated address at connection time, preserves hostname for Host/TLS verification, and revalidates redirects.

Full Access intentionally has full network capability.

## 12. Diagnostics and privacy

Diagnostics are non-authoritative observers. They cannot mutate canonical execution state.

Operational diagnostics reuse existing session/response/event/tool/provider-request identities rather than creating a second identity model.

Debug output is intentionally content-bounded. Diagnostics must not expose:

- credentials/tokens;
- user prompts or assistant content;
- raw tool payloads/results;
- opaque/encrypted reasoning.

Compatibility failures such as unsupported durable schema are reported using privacy-safe categories/codes rather than dumping the offending payload.

## 13. Compatibility and migration

Legacy Continue history can be migrated through explicit compatibility code when the current surface is empty and the migration is supported.

Once durable history exists:

```text
durable replay is authoritative
```

Stale UI/surface history is ignored.

Unsupported durable schemas are not silently upgraded or reinterpreted. Migration must be explicit and version-aware.

Compatibility adapters remain thin adapters and cannot become an alternate runtime, tool authority, persistence truth, or provider control plane.

## 14. Performance / scale expectations

PR15 added deterministic scale fixtures and removed a quadratic derived-index rewrite from the durable append hot path.

The PR15 CI measurement on Node v20.20.1 / Linux x64 observed:

- 2,500 streamed deltas: about 59 ms;
- 180 durable appends: about 91 ms total / 0.51 ms average;
- 272-record replay: about 4.6 ms;
- compaction: about 7.9 ms;
- 512 KiB tool-result round trip: about 4.3 ms.

These are observational CI measurements, not hard real-time guarantees. Correctness tests do not use brittle wall-clock thresholds.

The runtime is designed for long coding sessions by keeping the append-only log authoritative, rebuilding derived indexes, compacting context rather than history, and avoiding duplicate full-log reads where a verified current record snapshot is already available.

## 15. Development and validation commands

### Core

```bash
cd core
npm run tsc:check
npm run lint
npm test -- --runInBand
npm run vitest
```

Focused release-readiness integration:

```bash
cd core
npm run vitest -- agent/releaseReadiness.vitest.ts
```

### CLI

```bash
cd extensions/cli
npm run lint
npm run build
npm test
npm run test:smoke
```

Focused CLI/Core-surface parity:

```bash
cd extensions/cli
npm test -- src/agent/releaseParity.test.ts
```

### Repository gates

Required release gates are:

```text
StamCont Baseline
StamCont Execution Security
```

Baseline covers Core/packages, CLI agent runtime, GUI/VS Code, and packaged binary. Execution Security runs the security surface on Linux, macOS, and Windows plus the Windows launcher startup probe.

## 16. Release-readiness flow matrix

Roadmap PR16 validates these full flows:

### A — plain response

```text
new session
→ provider
→ canonical events
→ authoritative completed answer
→ persistence
→ reopen
→ terminal completed state without provider rerun
```

### B — tool use

```text
provider completed tool call
→ normalized tool_use
→ AgentKernel capability/policy authorization
→ tool execution
→ durable tool result
→ model continuation
→ final end_turn
```

### C — cancellation

```text
active run
→ external/user cancellation
→ durable cancelled lifecycle
→ reopen
→ remains cancelled
```

OS-owned process cancellation is additionally covered by StamCont Execution Security.

### D — crash/restart

Both sides are required:

- pre-execution crash boundary resumes safely;
- post-start ambiguous external side effect blocks automatic replay.

### E — long context

```text
large durable history
→ safe compaction boundary
→ compacted context plan
→ fitting provider request
→ semantic continuation
```

### F — CLI / IDE surface parity

The same canonical task through the CLI durable adapter and Core IDE surface adapter must produce equivalent AgentLoop terminal semantics and canonical durable user/assistant history.

## 17. Known limits and explicit non-goals

- Diagnostics are not a tracing authority and intentionally omit content.
- Compaction summaries are derived and may lose non-protected detail; the original log remains available for historical truth.
- Built-in host-process filesystem operations cannot claim a universal race-free path guarantee from Node path APIs on every filesystem. The sandbox and capability layers narrow this risk; see `STAMCONT_AGENT_KERNEL.md`.
- Full Access intentionally trusts the current OS user's authority.
- Provider quality/availability is external to the canonical runtime.
- The current roadmap does not turn subagents into an independent DAG/orchestration system.
- Repository fork detachment is not part of PR16. It is a separate post-roadmap repository operation after PR16 is merged, green, documented, and archived.

## 18. Release definition

For this roadmap, StamCont is release-ready only when all of the following remain true together:

1. real provider requests are translated into canonical events;
2. executable tools come only from authoritative completed calls;
3. AgentKernel remains the execution authority;
4. durable sessions survive restart;
5. replay is deterministic;
6. opaque provider continuation data round-trips correctly;
7. context compaction preserves authoritative history;
8. context budgeting prevents unsafe overflow;
9. ambiguous side effects are never silently repeated;
10. cancellation propagates through owned model/tool/process work;
11. CLI and IDE/GUI use canonical Core semantics;
12. child sessions cannot escalate authority;
13. diagnostics are useful without leaking sensitive payloads;
14. supported compatibility migration is explicit;
15. adversarial/property tests remain green;
16. scale regressions remain bounded by deterministic fixtures;
17. Baseline is green;
18. Execution Security is green on Windows/Linux/macOS;
19. this documentation matches the implementation.

Repository independence / GitHub fork detachment remains a separate post-roadmap operation.
