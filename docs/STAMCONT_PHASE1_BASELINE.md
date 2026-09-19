# StamCont Phase 1 — Baseline and Containment

## Purpose

Phase 1 establishes a reproducible StamCont engineering baseline before the shared agent kernel is introduced.

The product's automation capabilities are intentionally preserved. This phase does **not** remove or weaken:

- shell / Bash execution
- filesystem tools
- background jobs
- hooks
- MCP
- subagents
- autonomous tool loops
- network-capable tools
- headless execution

StamCont is explicitly targeting an opt-in **Full Access** execution profile in which those capabilities can operate without per-command approval.

## What is being contained

The fork inherited release and publishing workflows designed for the upstream Continue project. Those workflows reference upstream tags, marketplaces, secrets, artifact naming, package identities, and release conventions.

Until StamCont has its own release identity, inherited publishing workflows must not automatically mutate or publish from this repository.

They are preserved for reference and migration, but automatic inherited release paths are quarantined during Phase 1.

## Baseline CI

`.github/workflows/stamcont-baseline.yml` is the canonical Phase 1 gate.

It intentionally avoids external model-provider API calls and upstream Continue credentials.

The baseline covers:

1. local package builds
2. Core typechecking, linting, Jest and Vitest
3. CLI typechecking, linting, build, unit tests and smoke tests
4. GUI typechecking, linting and tests
5. VS Code typechecking, linting and Vitest
6. binary typechecking and tests
7. Rust sync crate compilation

Heavy external-service E2E suites and marketplace publishing are not part of this first gate.

## Phase 1 exit criteria

Phase 1 is complete when:

- the StamCont baseline workflow is green on the fork
- inherited publishing cannot accidentally publish upstream-branded artifacts
- failures in the imported codebase are documented and either repaired or explicitly quarantined
- the initial build/test timings are recorded
- the repository is ready for Phase 2: the shared Agent Kernel boundary
