<h1 align="center">StamCont</h1>

<p align="center">
  <strong>Durable, provider-neutral coding-agent runtime with resumable sessions, capability-scoped execution, cross-platform sandboxing, context compaction, and shared CLI/IDE semantics.</strong>
</p>

<div align="center">

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![StamCont Baseline](https://github.com/SaridakisStamatisChristos/StamCont/actions/workflows/stamcont-baseline.yml/badge.svg)](https://github.com/SaridakisStamatisChristos/StamCont/actions/workflows/stamcont-baseline.yml)
[![Execution Security](https://github.com/SaridakisStamatisChristos/StamCont/actions/workflows/stamcont-execution-security.yml/badge.svg)](https://github.com/SaridakisStamatisChristos/StamCont/actions/workflows/stamcont-execution-security.yml)

</div>

## What is StamCont?

**StamCont** is an engineering-focused coding-agent platform built around a single canonical agent runtime shared across CLI and IDE/GUI surfaces.

The project focuses on the hard parts of long-running agent execution: durable state, deterministic replay, safe resume after interruption, provider-neutral model events, capability-controlled tool execution, context-budget management, nested agent authority, and OS-enforced execution boundaries.

The canonical runtime is:

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
host / sandbox execution backend
```

## Core capabilities

- **One provider-neutral AgentLoop** — provider adapters translate into canonical events; providers do not directly execute tools.
- **Durable sessions** — append-only JSONL history is authoritative, with derived indexes, snapshots, and compaction artifacts.
- **Deterministic replay and resume** — completed work is not rerun, safe pre-execution boundaries can resume, and ambiguous external side effects are not silently repeated.
- **Authoritative tool execution** — only completed canonical tool-call items can become executable work.
- **Explicit execution profiles** — `Plan`, `Interactive`, and `Full Access` map to distinct capability and approval policies.
- **Cross-platform sandboxing** — Linux uses `bubblewrap`, macOS uses `sandbox-exec`, and Windows uses AppContainer + Job Objects for constrained execution.
- **Context budgeting and compaction** — long sessions can be compacted at safe semantic boundaries without deleting authoritative history.
- **Nested sessions / subagents** — child sessions inherit at most the authority of their parent and cannot escalate capabilities.
- **Cancellation propagation** — cancellation flows through owned model, tool, and process work.
- **Privacy-bounded diagnostics** — diagnostics reuse canonical identities without dumping prompts, raw tool payloads, credentials, or opaque reasoning state.
- **CLI / IDE parity** — both surfaces execute through the same Core runtime semantics rather than separate agent implementations.

## Execution profiles

| Profile | Filesystem | Shell | Network | Approval posture |
| --- | --- | --- | --- | --- |
| **Plan** | Workspace read-only | Sandboxed workspace shell | Restricted | Always |
| **Interactive** | Workspace read/write | Sandboxed workspace shell | Restricted | Policy-driven |
| **Full Access** | OS-user scope | Host shell | Full | No per-command kernel approval |

`Plan` and `Interactive` fail closed when an enforceable platform sandbox is unavailable. `Full Access` is explicit and intentionally uses the authority of the OS user running StamCont.

## Durable runtime model

Each durable session stores an authoritative append-only log:

```text
<agent-session-root>/<sessionId>/
├── session.jsonl              # authoritative history
├── session.idx                # derived index
├── session.snapshot.json      # derived snapshot
└── session.compaction.json    # derived compacted context
```

The log remains historical truth. Indexes, snapshots, compaction artifacts, diagnostics, and UI projections are rebuildable or derived state.

Resume semantics are designed around side-effect safety: StamCont distinguishes work that definitely did not execute from work that may already have produced an external effect. Ambiguous tool attempts block automatic replay instead of risking duplicate actions.

## Repository map

```text
core/agent/                     Canonical agent protocol, reducer, loop,
                                kernel, persistence, lifecycle, compaction,
                                budgeting, sessions, sandboxing and diagnostics

extensions/cli/src/agent/       CLI integration with the canonical runtime

gui/                            IDE/GUI agent surface integration

extensions/vscode/              VS Code host integration

docs/STAMCONT_AGENT_KERNEL.md    Kernel, capabilities and execution boundary

docs/STAMCONT_AGENT_RUNTIME.md   Durable runtime and release architecture

docs/STAMCONT_PHASE1_BASELINE.md Baseline and inherited-workflow containment

.github/workflows/
  stamcont-baseline.yml         Main repository validation gate
  stamcont-execution-security.yml
                                Cross-platform execution-security gate
```

## Current state

The current release line includes the canonical-runtime integration gates plus the standalone distribution infrastructure and clean-install validation introduced through PR23. The implemented architecture covers:

- plain-response durability and terminal replay;
- canonical tool-call execution through `AgentKernel`;
- durable cancellation;
- crash/restart boundaries;
- long-context compaction and replanning;
- CLI / IDE semantic parity;
- nested-session authority;
- adversarial and property-oriented runtime tests;
- cross-platform execution-security validation.

For the implementation-level contract and known limits, read [StamCont Agent Runtime](docs/STAMCONT_AGENT_RUNTIME.md).

## Standalone release installation

StamCont's first standalone distribution is designed around GitHub release
artifacts rather than inherited Continue registry or Marketplace identities.

For a published release such as `v0.1.0`, download the artifact that matches
your surface from the repository's **Releases** page:

- `stamcont-cli-0.1.0.tar.gz` — standalone CLI bundle;
- `stamcont-vscode-0.1.0-<platform>-<arch>.vsix` — VS Code package;
- `stamcont-jetbrains-0.1.0.zip` — JetBrains plugin package;
- `SHA256SUMS` and `release-manifest.json` — integrity metadata;
- `stamcont-sbom.cdx.json` — CycloneDX SBOM.

Verify the downloaded artifact against `SHA256SUMS` before installation.
GitHub provenance attestations are generated by the StamCont release workflow
for non-PR release builds.

The historical npm and IDE Marketplace identities remain compatibility
surfaces only. Do **not** treat `@continuedev/cli`, `Continue.continue`, or
the inherited JetBrains Marketplace identity as StamCont-owned distribution
channels.

Detailed installation instructions are maintained in the CLI and IDE docs.

## Development and validation

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

Focused CLI/Core parity:

```bash
cd extensions/cli
npm test -- src/agent/releaseParity.test.ts
```

The repository-level release gates are **StamCont Baseline** and **StamCont Execution Security**.

## Architecture documentation

- [Agent Kernel](docs/STAMCONT_AGENT_KERNEL.md) — execution profiles, capabilities, host/sandbox backends, subagents, cancellation, and security boundaries.
- [Agent Runtime](docs/STAMCONT_AGENT_RUNTIME.md) — canonical event model, persistence, replay, resume, compaction, diagnostics, provider contract, release flows, and known limits.
- [Phase 1 Baseline](docs/STAMCONT_PHASE1_BASELINE.md) — reproducible baseline and containment of inherited upstream publishing paths.

## Origin and attribution

StamCont began from an imported [Continue](https://github.com/continuedev/continue) source baseline and intentionally retains substantial inherited code and compatibility layers under Apache-2.0. The standalone repository represents that upstream baseline as a provenance root rather than carrying the full upstream commit graph.

**StamCont is not the upstream Continue project.** Its current development centers on the StamCont-specific durable agent runtime, execution kernel, persistence/resume model, context-management architecture, cross-platform execution security, and release-readiness integration described above.

Inherited Continue components and notices remain attributable to their original authors. See [UPSTREAM.md](UPSTREAM.md) for the exact imported baseline and history policy.

## License

Licensed under the [Apache License 2.0](LICENSE).

Portions of this repository are derived from Continue and remain subject to the applicable upstream copyright and attribution notices.
