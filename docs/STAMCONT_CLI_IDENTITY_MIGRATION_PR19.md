# StamCont PR19 — CLI Identity Migration

Status: implementation plan executed in PR19  
Scope: CLI identity and compatibility only  
Publication: intentionally deferred until PR22

## 1. Goals

PR19 establishes StamCont as the CLI-facing product identity without breaking
existing command lines, state, environment configuration, telemetry collectors,
or inherited package dependencies.

The migration is deliberately additive.

## 2. Executable identity

Primary executable:

- `stamcont`

Compatibility executable:

- `cn`

Both wrappers invoke the same bundled runtime. Help and validation output use
the executable name that invoked the runtime, so existing `cn` automation
continues to receive coherent command examples while new usage can standardize
on `stamcont`.

No command semantics are changed.

## 3. Environment alias precedence

For public compatibility surfaces, the rule is:

1. non-empty `STAMCONT_*`
2. corresponding `CONTINUE_*`
3. historical default

Implemented aliases:

| StamCont | Continue fallback |
| --- | --- |
| `STAMCONT_GLOBAL_DIR` | `CONTINUE_GLOBAL_DIR` |
| `STAMCONT_API_BASE` | `CONTINUE_API_BASE` |
| `STAMCONT_METRICS_ENABLED` | `CONTINUE_METRICS_ENABLED` |
| `STAMCONT_CLI_ENABLE_TELEMETRY` | `CONTINUE_CLI_ENABLE_TELEMETRY` |
| `STAMCONT_REMOTE` | `CONTINUE_REMOTE` |
| `STAMCONT_CLI_TEST` | `CONTINUE_CLI_TEST` |
| `STAMCONT_CLI_TEST_SESSION_ID` | `CONTINUE_CLI_TEST_SESSION_ID` |

Legacy names are not deprecated or removed by PR19.

## 4. Global-state migration policy

PR19 does **not** change the default global directory.

Default remains:

`~/.continue`

Reason: that directory contains compatibility-critical state including auth,
configuration, sessions, indexes, migration markers, logs, caches, and local
metadata. Switching the default to `~/.stamcont` without a data migration would
make existing state appear lost.

`STAMCONT_GLOBAL_DIR` is supported immediately as an explicit override and is
also understood by Core path resolution.

A future default-directory cutover must provide:

- state discovery
- conflict rules
- atomic or resumable copy/move behavior
- dual-read during transition
- rollback tests
- Windows/macOS/Linux path coverage

## 5. Telemetry naming strategy

PR19 migrates telemetry **controls**, not emitted telemetry identifiers.

New controls:

- `STAMCONT_METRICS_ENABLED`
- `STAMCONT_CLI_ENABLE_TELEMETRY`

Retained emitted identifiers:

- service/meter: `continue-cli`
- metrics: `continue_cli_*`
- remote-agent attribute: `is_continue_remote_agent`

This avoids accidental double emission and protects existing dashboards,
collectors, alerts, and filters. A later telemetry namespace cutover must be
explicit and observable rather than a silent rename.

## 6. Package and dependency strategy

PR19 intentionally retains:

- npm package identity `@continuedev/cli`
- internal `@continuedev/*` dependency identities
- existing local alias wiring
- default remote API `https://api.continue.dev/`

These are compatibility/distribution/external-service surfaces. They are not
safe cosmetic replacements.

The executable can become StamCont-facing before the package registry identity
changes.

## 7. Release quarantine

PR19 does not publish anything.

The inherited release system remains quarantined. StamCont-owned npm scope,
credentials, tags, artifact naming, signing, checksums, provenance, and dry-run
safety belong to PR22.

The CLI README therefore documents source builds rather than presenting the
inherited `@continuedev/cli` registry package as a StamCont distribution.

## 8. Validation added

PR19 adds coverage for:

- `stamcont` primary wrapper
- `cn` compatibility wrapper
- wrapper-specific help identity
- bin-map integrity
- environment alias precedence
- Core recognition of `STAMCONT_GLOBAL_DIR`
- legacy global-dir fallback
- telemetry-control aliases
- telemetry emitted-name compatibility
- `STAMCONT_REMOTE` / `CONTINUE_REMOTE` precedence

## 9. Explicit non-goals

PR19 does not:

- move users to `~/.stamcont`
- rename `@continuedev/*` packages
- publish an npm package
- change the remote API default
- rename OpenTelemetry metric families
- change VS Code identity
- change JetBrains identity
- enable inherited release workflows
- alter AgentLoop/tool/runtime semantics
