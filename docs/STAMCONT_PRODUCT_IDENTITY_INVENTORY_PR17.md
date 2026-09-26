# StamCont PR17 — Product Identity, Compatibility, and Secret-Fixture Inventory

**Status:** PR17 audit artifact  
**Repository snapshot:** `SaridakisStamatisChristos/StamCont` @ `97d8dc35f61a4cef79c9c11a6591e28c9a768de9`  
**Scope:** inventory and migration design only  
**Runtime behavior changes:** none

## 1. Purpose

PR17 establishes the migration map required before any product-identity rename is implemented.

The repository is already independently named and documented as StamCont, but distributable packages, IDE manifests, persisted paths, environment variables, telemetry identifiers, package scopes, and inherited release workflows still contain Continue-era identity.

This document classifies those surfaces so PR18 onward can migrate them without breaking existing installs, persisted state, command bindings, configuration, package resolution, or release safety.

PR17 intentionally does **not** rename runtime identifiers, move storage, change package names, alter executables, modify tests, publish artifacts, or change release behavior.

## 2. Classification model

| Class | Meaning | Default migration posture |
|---|---|---|
| C0 | Cosmetic / presentation identity | Safe to change when no protocol or lookup depends on the value |
| C1 | Public distribution identity | Change only with package/marketplace ownership and release plan |
| C2 | Runtime identifier | Preserve unless aliases and migration tests exist |
| C3 | Persisted-state / compatibility identifier | Highest compatibility sensitivity; dual-read or explicit migration required |
| C4 | External dependency identity | Do not rename locally unless dependency itself is replaced/published |
| C5 | Release infrastructure identity | Keep quarantined until StamCont-owned release credentials and targets exist |
| C6 | Synthetic secret / test fixture | May be rewritten without changing coverage if validation semantics are preserved |
| C7 | Historical/provenance identity | Retain when required for attribution, upstream references, or compatibility history |

Risk levels below use **low / medium / high / critical** to describe migration risk, not security severity.

## 3. Executive inventory

### 3.1 Repository and presentation identity

Already StamCont-facing:

- GitHub repository: `SaridakisStamatisChristos/StamCont`
- standalone repository history and provenance model
- `README.md`
- `UPSTREAM.md`
- `CLA.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `CONTRIBUTING.md`
- issue and pull-request templates
- CODEOWNERS
- StamCont baseline/security workflows and architecture documentation

Classification: **C0/C7, already migrated**.

### 3.2 Root workspace identity

`package.json`:

- current `name`: `continue`

This is a workspace/package identity, not merely a README label.

Classification: **C1**  
Risk: **medium**  
PR target: PR18 or PR19 depending on whether tooling relies on the workspace name.

### 3.3 CLI distribution identity

`extensions/cli/package.json` currently contains:

- package: `@continuedev/cli`
- description: `Continue CLI`
- author: `Continue Dev, Inc.`
- repository: `https://github.com/continuedev/continue.git`
- bugs: `https://github.com/continuedev/continue/issues`
- homepage: `https://continue.dev`
- executable: `cn`

It also depends on Continue-scoped packages including:

- `@continuedev/config-yaml`
- `@continuedev/openai-adapters`
- `@continuedev/sdk`
- `@continuedev/terminal-security`

Classification:

- textual metadata: **C0**
- npm package name: **C1**
- executable `cn`: **C2/C3** because scripts, users, docs, automation, and persisted invocation expectations can depend on it
- `@continuedev/*` dependencies: **C4** until coordinated package migration

Risk: **high** for package/bin renames; **low** for repository/homepage/description metadata.

### 3.4 Core/internal npm package identity

Observed package identities include:

- `@continuedev/core`
- `@continuedev/config-types`
- `@continuedev/config-yaml`
- `@continuedev/fetch`
- `@continuedev/llm-info`
- `@continuedev/openai-adapters`
- `@continuedev/terminal-security`
- `@continuedev/sdk-generator`
- `@continuedev/sdk`
- `@continuedev/hub-api`

Additional product-facing package names include:

- `continue-binary` in platform-specific binary package descriptors
- `continue-docs` in `docs-site/package.json`

The codebase imports Continue-scoped packages throughout core, GUI, CLI, VS Code, and package workspaces.

Classification:

- package names: **C1/C4**
- import specifiers: **C4** while those package names remain canonical
- lockfile occurrences: derived release/build metadata; migrate only as a consequence of manifest changes

Risk: **high** if renamed piecemeal. A coordinated package graph migration is required.

### 3.5 Binary identity

`binary/package.json` contains inherited author metadata and the platform package descriptors use `continue-binary`.

JetBrains release workflow artifact names also use `continue-binary-<platform>-<arch>`.

Classification: **C1/C5**  
Risk: **medium/high**, because artifact consumers and packaging scripts can depend on exact filenames.

### 3.6 VS Code product identity

`extensions/vscode/package.json` currently contains:

- `name: "continue"`
- `displayName: "Continue - open-source AI code agent"`
- `publisher: "Continue"`
- `author: "Continue Dev, Inc"`
- upstream repository, bug tracker, support email, and homepage
- Continue-scoped package dependencies

Classification:

- display text, repository/homepage/description: **C0**
- extension `name` and `publisher`: **C1/C3** because together they form marketplace/install identity
- package dependencies: **C4**

Risk: **critical** for publisher/name if an upgrade path from an installed extension must be preserved.

#### VS Code command namespace

The manifest currently declares **38 command contribution entries**, all using `continue.*` identifiers. One identifier is contributed more than once, so the entry count is not the same as a unique-ID count.

Examples:

- `continue.applyCodeFromChat`
- `continue.focusEdit`
- `continue.newSession`
- `continue.viewHistory`
- `continue.openConfigPage`
- `continue.toggleTabAutocompleteEnabled`
- `continue.nextEditWindow.acceptNextEditSuggestion`

Classification: **C2/C3**  
Risk: **high**

These identifiers can be referenced by keybindings, user settings, command URIs, tests, webviews, documentation, and external automation. They must not be bulk-renamed.

#### VS Code configuration namespace

The manifest currently exposes **12** `continue.*` configuration properties:

- `continue.telemetryEnabled`
- `continue.showInlineTip`
- `continue.disableQuickFix`
- `continue.enableQuickActions`
- `continue.enableTabAutocomplete`
- `continue.enableNextEdit`
- `continue.pauseTabAutocompleteOnBattery`
- `continue.pauseCodebaseIndexOnStart`
- `continue.enableConsole`
- `continue.remoteConfigServerUrl`
- `continue.userToken`
- `continue.remoteConfigSyncPeriod`

Classification: **C3**  
Risk: **critical**

User settings persist under these keys. A future StamCont namespace must read legacy values or intentionally keep these keys.

#### VS Code view/container IDs

Observed contribution IDs include:

- `continue`
- `continueConsole`
- `continue.continueGUIView`
- `continue.continueConsoleView`

Classification: **C2/C3**  
Risk: **high**, because VS Code can persist layout/view state by contribution ID.

### 3.7 JetBrains plugin identity

`extensions/intellij/gradle.properties`:

- `pluginGroup=com.github.continuedev.continueintellijextension`

`extensions/intellij/src/main/resources/META-INF/plugin.xml`:

- plugin ID: `com.github.continuedev.continueintellijextension`
- plugin name: `Continue`
- vendor: `continue-dev` / `https://www.continue.dev/`
- release notes link: upstream Continue releases
- code classes under `com.github.continuedev.continueintellijextension.*`
- tool window / notification / service identifiers carrying Continue identity
- **15** explicit action entries, primarily `continue.*`

Classification:

- display name/vendor/links: **C0**
- plugin ID: **C1/C3**
- Kotlin/Java package namespace: **C2**
- action IDs: **C2/C3**

Risk: **critical** for plugin ID and package namespace. Changing the marketplace plugin ID can create a distinct product rather than an upgrade. Renaming implementation packages also creates a broad code migration with no product benefit by itself.

### 3.8 Persisted filesystem identity

`core/util/paths.ts` and CLI environment handling currently use:

- default global directory: `~/.continue`
- override: `CONTINUE_GLOBAL_DIR`
- `.continueignore`
- `.continuerc.json`
- `~/.continue/sessions`
- `~/.continue/index`
- `~/.continue/sharedConfig.json`
- `~/.continue/config.json`
- `~/.continue/config.yaml`
- `~/.continue/config.ts`
- `~/.continue/.env`
- `~/.continue/logs`
- `~/.continue/.migrations`
- `~/.continue/.configs`
- other data/cache/diff/staging paths under the same root

CLI session code also writes/reads sessions under the Continue global directory.

Classification: **C3 / intentionally retained legacy surface**  
Risk: **critical**

A blind switch to `~/.stamcont` would make existing configuration, authentication, sessions, indexes, and migration markers appear to disappear. Any future path change requires explicit dual-read/migration semantics and rollback coverage.

### 3.9 Environment variable identity

Observed Continue-prefixed variables include at least:

- `CONTINUE_GLOBAL_DIR`
- `CONTINUE_API_BASE`
- `CONTINUE_METRICS_ENABLED`
- `CONTINUE_CLI_ENABLE_TELEMETRY`
- test-specific `CONTINUE_CLI_TEST`
- test-specific `CONTINUE_CLI_TEST_SESSION_ID`
- release/runtime variables referenced by inherited workflows and tests

Classification: **C2/C3**  
Risk: **high**

Future `STAMCONT_*` variables should be aliases first, with deterministic precedence and tests. Existing `CONTINUE_*` names should not simply stop working.

### 3.10 Remote-service / API identity

CLI defaults include:

- `https://api.continue.dev/`

Storage sync and authentication code use that base for remote endpoints.

Classification: **C4/C3**  
Risk: **critical**

This is not a cosmetic URL. Replacing it requires a StamCont-operated backend or an explicit local-only/compatibility strategy. PR18 must not redirect traffic to an invented endpoint.

### 3.11 Telemetry identity

CLI telemetry currently uses Continue-era identifiers including:

- service/meter: `continue-cli`
- metric family prefix: `continue_cli_*`
- attribute: `is_continue_remote_agent`
- enable/disable environment variables under `CONTINUE_*`

Classification: **C2/C5**  
Risk: **medium/high**

Changing names can break dashboards, filters, alerts, and external collectors. Migrate only with an observability compatibility plan; do not emit duplicate metric families accidentally.

### 3.12 Repository automation and release identity

Inherited release workflows contain deliberate guards such as:

- `if: github.repository == 'continuedev/continue'`

Observed in workflows including:

- `.github/workflows/auto-release.yml`
- `.github/workflows/stable-release.yml`
- `.github/workflows/vscode-prerelease.yml`
- `.github/workflows/jetbrains-release.yaml`

These guards currently prevent Continue-targeted publication from executing as if StamCont were the upstream repository.

Other inherited release surfaces include:

- npm semantic-release configuration
- JetBrains publication/signing inputs
- VS Code packaging/release logic
- `packages/shared-release.config.js` tag format: `@continuedev/<package>@<version>`
- CLI semantic-release configuration
- Runloop blueprint publication logic
- Continue-named artifact files

Classification: **C5 / intentionally quarantined legacy surface**  
Risk: **critical**

Do not merely replace `continuedev/continue` with the StamCont repository. PR22 must reconstruct release targets, credentials, package ownership, publisher ownership, tags, and permissions intentionally.

### 3.13 Release credential references

Workflows reference secret/environment names such as:

- `SEMANTIC_RELEASE_TOKEN`
- `NPM_TOKEN`
- `JETBRAINS_PUBLISH_TOKEN`
- `PUBLISH_TOKEN`
- `PRIVATE_KEY`
- `PRIVATE_KEY_PASSWORD`
- `CERTIFICATE_CHAIN`
- GitHub tokens supplied by Actions

These are **secret references**, not embedded credential values.

Classification: **C5**, not C6  
Action: preserve/quarantine until StamCont-owned release infrastructure exists. Do not copy upstream credentials or assume repository secrets exist.

### 3.14 Historical/provenance identity

Continue references in `UPSTREAM.md`, Apache-2.0 attribution, historical migration notes, and compatibility documentation are intentional.

Classification: **C7**  
Risk: **high legal/provenance risk if erased**

These references should not be mass-replaced.

## 4. Synthetic secret / test-fixture inventory

No audited current-tree item below is evidence of a real credential. The known GitHub alert is associated with a synthetic API-key-shaped test fixture inherited in the baseline.

### 4.1 Scanner-sensitive Anthropic-shaped fixtures

`extensions/cli/src/util/apiKeyValidation.test.ts` contains synthetic values including:

- `sk-ant-1234567890`
- `sk-ant-abcdefghijklmnop`
- `sk-ant-test-key-with-dashes`
- another longer `sk-ant-...` shape used to validate accepted prefixes

Purpose: validate the Anthropic key prefix/length logic.

Classification: **C6**  
Risk: **low runtime / high scanner-noise risk**  
PR18 action: construct fake values from fragments (for example `["sk", "ant", "unit-test-fixture"].join("-")`) while preserving all positive/negative validation cases.

### 4.2 CLI E2E/auth fixtures

Observed synthetic values include:

- `test-api-key-from-env`
- `TEST-test-invalid-key-format`
- `local-api-key`
- `api-secret-value`
- `my-local-api-key`
- other generic test-only secret values

Files include:

- `extensions/cli/src/e2e/headless-anthropic-api-key.test.ts`
- `extensions/cli/src/CLIPlatformClient.test.ts`
- `extensions/cli/src/integration/model-persistence-unauthenticated.test.ts`

Classification: **C6**  
Risk: **low**  
PR18 action: keep semantics; only rewrite values that resemble provider credentials or trigger scanners.

### 4.3 OAuth/token fixtures

`core/context/mcp/MCPOauth.vitest.ts` uses values such as:

- `test-access-token`
- `other-access-token`
- `token1`
- `token2`

Classification: **C6**  
Risk: **low**  
PR18 action: optional clarity cleanup; these are already visibly synthetic and need not be changed unless scanner evidence justifies it.

### 4.4 OpenAI-compatible request fixtures

Tests under `core/llm/llms/` and `core/llm/llms/test-utils/` use generic values such as:

- `test-api-key`
- `Authorization: Bearer test-api-key`

Files include:

- `OpenAI.vitest.ts`
- `OpenAI-compatible-core.vitest.ts`
- `OpenAI-compatible.vitest.ts`
- `test-utils/openai-test-utils.ts`

Classification: **C6**  
Risk: **low**  
PR18 action: generally retain unless secret scanning flags them; they are not realistic provider-key shapes.

### 4.5 Auth-header override fixtures

`packages/openai-adapters/src/test/customFetch-auth-override.vitest.ts` uses generic values such as:

- `Bearer custom-token`
- `custom-key`

Classification: **C6**  
Risk: **low**  
PR18 action: retain unless a scanner specifically identifies them.

### 4.6 Local secret resolution fixtures

`core/config/yaml/LocalPlatformClient.vitest.ts` generates or writes synthetic values for local `.env`, workspace `.env`, and process environment resolution.

Classification: **C6**  
Risk: **low**  
PR18 action: preserve coverage. No reason to weaken the secret-resolution tests.

### 4.7 Secret-fixture policy for PR18 onward

1. Never disable GitHub secret scanning globally.
2. Never rewrite history solely to remove synthetic fixtures.
3. Do not rotate/revoke credentials without evidence that a real credential exists.
4. Prefer constructed fake provider-shaped values over pasted realistic-looking keys.
5. Keep positive and negative format-validation coverage.
6. Add a short comment when a provider-like fake string is intentionally constructed for scanner hygiene.
7. Keep release secret references as references; do not replace them with literals.

## 5. Migration matrix

| Surface | Current | Proposed StamCont direction | Compatibility | Alias/migration strategy | Target PR | Risk |
|---|---|---|---|---|---|---|
| Product display name | Continue | StamCont | no for pure labels | direct cosmetic update | PR18 | low |
| Root workspace name | `continue` | `stamcont` candidate | possible tooling dependency | validate first | PR18/19 | medium |
| CLI npm package | `@continuedev/cli` | `@stamcont/cli` candidate, availability unverified | yes for existing consumers | new package/transition strategy; do not overwrite upstream | PR19/22 | high |
| CLI executable | `cn` | `stamcont` primary candidate | yes | retain `cn` alias for migration window | PR19 | high |
| Internal npm scope | `@continuedev/*` | `@stamcont/*` candidate where StamCont-owned publication is needed | coordinated graph required | migrate atomically or keep external upstream dependencies | PR19/22 | high |
| Binary package/artifact | `continue-binary` | StamCont-named artifacts | likely | preserve old lookup where consumers exist | PR19/22 | medium/high |
| VS Code display metadata | Continue/upstream URLs | StamCont/repository-local URLs | no for labels | direct change | PR18 | low |
| VS Code marketplace identity | publisher `Continue`, name `continue` | StamCont-controlled publisher/name, exact values TBD | upgrade-sensitive | decide marketplace continuity before change | PR20 | critical |
| VS Code command IDs | `continue.*` | StamCont aliases optional | yes | keep legacy IDs; add aliases only if valuable | PR20 | high |
| VS Code settings | `continue.*` | StamCont namespace optional | yes | legacy read + new key precedence/migration | PR20 | critical |
| VS Code view IDs | Continue-era IDs | StamCont IDs optional | yes | preserve or migrate stored layout deliberately | PR20 | high |
| Global data dir | `~/.continue` | `~/.stamcont` eventual candidate | yes | dual-read / explicit migration / rollback | PR19/20 | critical |
| Env vars | `CONTINUE_*` | `STAMCONT_*` primary aliases | yes | deterministic precedence; legacy fallback | PR19 | high |
| Continue API base | `api.continue.dev` | no replacement until StamCont backend strategy exists | yes/external | retain compatibility endpoint or disable dependent feature explicitly; never invent endpoint | later design | critical |
| CLI telemetry | `continue-cli`, `continue_cli_*` | `stamcont-cli`, `stamcont_cli_*` | collector-sensitive | coordinated observability migration | PR19/22 | medium/high |
| JetBrains display metadata | Continue | StamCont | no for labels | direct update | PR21 | low |
| JetBrains plugin ID | `com.github.continuedev.continueintellijextension` | StamCont-controlled ID TBD | marketplace/upgrade-sensitive | choose continuity strategy before mutation | PR21 | critical |
| JetBrains action IDs | `continue.*` | StamCont aliases optional | yes | retain legacy IDs initially | PR21 | high |
| JetBrains code package | `com.github.continuedev...` | optional future refactor | not needed for product identity | retain unless strong engineering reason | not required | high/no benefit |
| Release repository guards | `continuedev/continue` | StamCont release gates | n/a | rebuild release workflows with owned targets/credentials | PR22 | critical |
| Semantic-release tags | `@continuedev/...@version` | StamCont-owned tag scheme | no inherited tags | new tags only | PR22 | high |
| Synthetic key fixture | provider-shaped fake `sk-ant-...` | constructed fake | test semantics required | construct at runtime in test | PR18 | low |
| Provenance links | Continue upstream | retain where historical | required | no rename | all | high if removed |

## 6. Proposed naming scheme

These are **design candidates**, not claims of registry, marketplace, publisher, or domain availability.

Preferred human-facing identity:

- product: **StamCont**
- repository: `SaridakisStamatisChristos/StamCont`
- executable candidate: `stamcont`
- npm scope candidate: `@stamcont/*`
- CLI package candidate: `@stamcont/cli`
- metrics candidate: `stamcont-cli` / `stamcont_cli_*`
- global directory eventual candidate: `~/.stamcont`
- environment prefix candidate: `STAMCONT_`
- command/settings prefix candidate: `stamcont.`

Compatibility policy:

- Human-facing labels should move to StamCont first.
- Existing `continue.*` command/settings identifiers should remain functional during migration.
- `cn` should remain an executable alias if `stamcont` is introduced.
- `CONTINUE_*` environment variables should remain accepted while `STAMCONT_*` is introduced.
- `~/.continue` must remain readable until an explicit state migration has completed.
- `@continuedev/*` must be treated as external/public identities until StamCont-owned packages and release policy are ready.
- Marketplace identifiers must not change until ownership and upgrade-path behavior are understood.

## 7. Risk assessment

### Critical

- changing VS Code publisher/name without an upgrade strategy
- changing VS Code configuration keys without legacy reads
- moving `~/.continue` without data migration
- changing JetBrains plugin ID without marketplace continuity analysis
- enabling inherited release workflows by mechanically replacing repository guards
- redirecting `api.continue.dev` to a nonexistent/unowned endpoint

### High

- removing `cn` abruptly
- piecemeal `@continuedev/*` package renames
- changing command/action IDs
- changing environment variable names without aliases
- erasing upstream attribution/provenance
- changing artifact names without packaging-consumer review

### Medium

- telemetry namespace changes
- root workspace name
- binary package descriptor names
- internal code namespace refactors

### Low

- product-facing descriptions
- repository/bug/homepage links to StamCont-owned locations
- display labels
- synthetic scanner-sensitive test fixture construction, provided assertions remain equivalent

## 8. PR18–PR23 implementation plan

### PR18 — Non-breaking presentation and fixture hygiene

Allowed scope:

- update low-risk package/extension presentation metadata to StamCont
- point repository and bug links at StamCont
- use a safe repository-local homepage until a StamCont-owned domain exists
- update product-facing labels/descriptions that are not identifiers
- harden scanner-sensitive synthetic key fixtures
- add comments documenting intentionally constructed fake keys

Must preserve:

- package names
- executable names
- `continue.*` command/config/action IDs
- `~/.continue`
- `CONTINUE_*`
- external API behavior
- marketplace plugin/extension IDs
- release behavior

Validation:

- unit tests covering changed fixtures
- manifest parsing
- baseline CI
- execution-security CI
- secret scanning remains enabled

### PR19 — CLI identity migration

Design and test:

- StamCont-facing CLI package strategy
- `stamcont` executable plus `cn` compatibility alias
- `STAMCONT_*` environment aliases with documented precedence
- global-directory migration strategy; do not strand `~/.continue`
- telemetry naming strategy
- package dependency strategy
- CLI docs and smoke tests

Do not publish until PR22 release infrastructure is ready.

### PR20 — VS Code identity migration

Design and test:

- marketplace publisher/name ownership
- StamCont-facing display identity
- preserve or alias legacy `continue.*` commands
- migrate settings with legacy reads
- preserve/migrate view IDs and stored state
- verify URI/webview/message compatibility
- extension upgrade test from legacy state

### PR21 — JetBrains identity migration

Design and test independently from VS Code:

- marketplace identity/upgrade strategy
- StamCont-facing display/vendor metadata
- action-ID compatibility
- persisted settings/state compatibility
- avoid unnecessary Kotlin package refactor
- plugin packaging and upgrade tests

### PR22 — StamCont-owned release infrastructure

Rebuild rather than mechanically rebrand inherited release workflows.

Required decisions:

- npm scope/package ownership
- VS Code publisher ownership
- JetBrains marketplace ownership
- GitHub tag scheme
- release credentials and least-privilege permissions
- artifact names
- signing/checksum policy
- provenance/SBOM expectations
- dry-run path that cannot publish accidentally

Remove or permanently quarantine Continue-targeted release behavior only after StamCont replacements are proven.

### PR23 — First standalone release readiness

Validate from clean environments:

- install
- build
- CLI invocation
- compatibility alias
- persisted-state migration
- VS Code package/install/upgrade
- JetBrains package/install/upgrade if included
- release artifacts
- checksums
- security gates
- secret scan status
- docs
- provenance
- reproducible durable-resume demo

Only then prepare the first StamCont release, likely `v0.1.0`, without reusing inherited Continue tags.

## 9. PR17 acceptance criteria

- [x] Package metadata inventoried
- [x] CLI package and executable identity inventoried
- [x] VS Code product, command, configuration, view, and marketplace identities classified
- [x] JetBrains plugin, action, group, and implementation identities classified
- [x] Persisted filesystem paths classified
- [x] Environment-variable identity classified
- [x] Remote API identity classified
- [x] Telemetry identity classified
- [x] `@continuedev/*` dependency/import identity classified
- [x] Release and marketplace workflow identity classified
- [x] Release secret references separated from secret literals
- [x] Scanner-sensitive test fixtures inventoried
- [x] Proposed StamCont naming scheme documented as unverified candidates
- [x] Migration matrix produced
- [x] PR18–PR23 plan produced
- [x] No runtime behavior changed
- [x] No package/command/config/path identifier renamed
- [x] No release or publication triggered
- [x] No history rewrite performed

## 10. Decision

PR17 confirms that StamCont can migrate its presentation identity immediately in low-risk areas, but the remaining Continue-era identifiers are not one homogeneous rename set.

The safe order is:

1. presentation + fixture hygiene,
2. CLI compatibility migration,
3. VS Code migration,
4. JetBrains migration,
5. StamCont-owned release infrastructure,
6. standalone release readiness.

Until those stages are complete, compatibility-sensitive Continue identifiers are intentional technical debt, not accidental branding residue.
