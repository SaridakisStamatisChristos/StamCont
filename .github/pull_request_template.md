## Description

Describe the problem and the change. Keep the scope focused.

## Architecture / compatibility impact

- Does this change affect AgentLoop, AgentKernel, persistence/replay, context compaction, sandboxing, networking, cancellation, subagents, or execution profiles?
- Does it change an inherited Continue-compatible identifier or interface?
- If yes, explain the compatibility and migration impact.

## Checklist

- [ ] I've read the [StamCont contributing guide](../CONTRIBUTING.md).
- [ ] I added or updated relevant tests.
- [ ] I updated relevant documentation.
- [ ] I did not silently weaken a capability, sandbox, persistence, replay, or side-effect-safety invariant.
- [ ] I did not re-enable an inherited upstream publishing path.
- [ ] I ran the relevant local validation commands.

## Validation

List the commands/tests you ran and their results.

```text
# example
cd core
npm run vitest -- agent/releaseReadiness.vitest.ts
```

For release-sensitive changes, the repository gates are **StamCont Baseline** and **StamCont Execution Security**.

## Screenshots / recordings

For user-interface changes, include a screenshot or short recording when it materially helps review.
