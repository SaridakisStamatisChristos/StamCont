# Contributing to StamCont

Thank you for contributing to **StamCont**.

StamCont originated from Continue, but the active project direction is the StamCont-specific durable coding-agent runtime: provider-neutral execution, deterministic persistence/replay, safe resume, capability-scoped tools, context budgeting and compaction, nested sessions, and cross-platform execution security.

## Before you start

For substantial behavior changes, open an issue first so the design can be discussed before implementation.

Please keep pull requests focused. A good PR:

- addresses one coherent problem;
- includes or updates tests;
- preserves the canonical AgentLoop / AgentKernel authority boundaries;
- updates architecture documentation when behavior changes;
- avoids silently weakening sandbox, persistence, replay, or capability invariants;
- does not re-enable inherited upstream publishing paths.

## Development environment

StamCont currently pins Node.js **20.20.1**.

```bash
nvm use
```

The repository contains multiple packages/surfaces. Install the dependencies required by the component you are changing.

## Architecture first

Before changing the agent runtime, read:

- [StamCont Agent Kernel](docs/STAMCONT_AGENT_KERNEL.md)
- [StamCont Agent Runtime](docs/STAMCONT_AGENT_RUNTIME.md)
- [Phase 1 Baseline](docs/STAMCONT_PHASE1_BASELINE.md)

The canonical runtime path is:

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

Provider adapters translate events. They do not become an alternate tool-execution authority.

## Working with the repository

1. Fork **StamCont** on GitHub.
2. Clone your fork:

   ```bash
   git clone https://github.com/YOUR_USERNAME/StamCont.git
   cd StamCont
   ```

3. Create a focused branch from `main`:

   ```bash
   git checkout -b my-change
   ```

4. Implement the change with tests.
5. Run the relevant validation commands.
6. Open a pull request against `SaridakisStamatisChristos/StamCont:main`.

## Validation

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

Focused CLI/Core runtime parity:

```bash
cd extensions/cli
npm test -- src/agent/releaseParity.test.ts
```

### Repository gates

The primary StamCont release gates are:

- **StamCont Baseline**
- **StamCont Execution Security**

Changes touching execution boundaries, networking, filesystem access, process ownership, sandboxing, cancellation, or capabilities should receive especially careful adversarial coverage.

## Runtime invariants to preserve

Contributions to the canonical runtime should preserve these principles:

1. completed canonical output items are authoritative;
2. provider adapters do not execute tools;
3. tool execution passes through AgentKernel authorization;
4. durable `session.jsonl` history is authoritative;
5. derived indexes/snapshots/compaction never replace history;
6. ambiguous external side effects are not silently replayed;
7. child sessions cannot exceed parent authority;
8. Plan remains read-only;
9. constrained execution fails closed when required sandbox enforcement is unavailable;
10. diagnostics do not expose sensitive prompts, credentials, raw tool payloads, or opaque reasoning state.

## Documentation contributions

Documentation for StamCont-specific architecture belongs in this repository.

Some deeper documentation and UI/configuration material is inherited from Continue and remains useful while compatibility surfaces are retained. When editing such material, distinguish clearly between:

- **StamCont behavior**, which should be documented as StamCont; and
- **legacy/inherited Continue-compatible interfaces**, which may retain their technical names until intentionally migrated.

Do not redirect StamCont contributors to Continue's issue tracker or discussions for StamCont-specific work.

## Legacy identifiers and compatibility

You will still encounter identifiers such as:

- `~/.continue`;
- `@continuedev/*`;
- `continue.*` command/configuration IDs;
- inherited extension/package metadata.

These are currently compatibility or migration surfaces. Do not mechanically rename them in unrelated PRs: changing them can be a breaking product migration rather than a documentation cleanup.

## Pull-request review

Review focuses on:

- correctness and determinism;
- security and capability boundaries;
- persistence/recovery semantics;
- test quality;
- cross-platform behavior;
- compatibility impact;
- documentation accuracy.

## Contribution licensing

StamCont does not currently require a separate CLA. See [CLA.md](CLA.md) for the contribution-licensing policy.

## Upstream attribution

StamCont retains code and history derived from [Continue](https://github.com/continuedev/continue) under Apache-2.0. Preserve required license and attribution notices when modifying inherited code.
