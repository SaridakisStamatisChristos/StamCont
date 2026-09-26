# StamCont JetBrains Identity Migration — PR21

## Scope

PR21 migrates the JetBrains surface toward StamCont while preserving exact identifiers that JetBrains, existing installations, user settings, actions, tool-window layout, or Marketplace continuity may depend on.

This PR does not publish the plugin, does not enable inherited release/signing workflows, and does not rename implementation packages.

## Decision matrix

| Surface | PR21 decision | Reason |
|---|---|---|
| Plugin display name | Change to `StamCont` | Presentation-only metadata |
| Vendor label / URL | Change to StamCont + repository URL | Presentation-only metadata; no Marketplace ownership claim |
| Release-notes link | Point to StamCont repository releases | Repository-local presentation |
| Plugin ID | Keep `com.github.continuedev.continueintellijextension` | Marketplace/install continuity is exact-ID sensitive |
| Gradle group | Keep `com.github.continuedev.continueintellijextension` | Build/package compatibility; no product benefit from isolated rename |
| Gradle root project / artifact base name | Keep `continue-intellij-extension` | Artifact/distribution naming belongs to PR22 |
| Kotlin package namespace | Keep `com.github.continuedev.continueintellijextension.*` | Broad refactor has compatibility risk and no runtime benefit |
| Action IDs | Keep existing `continue.*` and other exact IDs | Keymaps, automation, tests, and integrations may reference them |
| Action labels / Go-To-Action text | Change visible prefixes to StamCont | Presentation-only |
| Tool-window ID | Keep `Continue` | JetBrains persists tool-window layout/state by ID |
| Tool-window title | Present `StamCont` at runtime | Safe display layer without changing lookup ID |
| Notification group ID | Keep `Continue` | Runtime lookup/notification compatibility |
| Service IDs | Keep existing Continue-era IDs | Runtime lookup compatibility |
| Inline completion provider ID | Keep `Continue` | Extension-point identity compatibility |
| Settings configurable ID | Keep existing FQCN ID | Exact configuration identity |
| Settings display name | Change to `StamCont` | Presentation-only |
| Persistent state component name | Keep existing Continue-era FQCN | Existing settings must remain readable |
| Persistent storage file | Keep `ContinueExtensionSettings.xml` | Existing settings must remain readable |
| Marketplace publication/signing | Defer to PR22 | StamCont ownership/credentials are not yet defined |

## Release quarantine

The inherited JetBrains workflow remains intentionally guarded for the upstream repository and is not re-enabled for StamCont in PR21. In particular, PR21 does not mechanically replace `github.repository == 'continuedev/continue'`, does not claim the upstream Marketplace listing, and does not introduce publication credentials.

PR22 must define StamCont-owned Marketplace/distribution targets, signing, artifact names, credentials, dry-run behavior, and rollback policy before publication can be enabled.

## Validation

PR21 adds `JetBrainsIdentityMigrationTest` to lock the compatibility boundary:

- StamCont display metadata is present;
- the inherited plugin ID remains unchanged;
- Continue-era action, tool-window, notification, service, provider, and settings-state identifiers remain valid;
- no `stamcont.*` action namespace is introduced without an explicit alias design;
- persisted `ContinueExtensionSettings.xml` state remains readable;
- implementation/build identity remains unchanged where migration is deferred;
- the existing tool-window lookup ID remains stable while the visible title becomes StamCont.

The StamCont baseline workflow now includes a JetBrains job that runs:

```text
./gradlew test buildPlugin --stacktrace --no-daemon
```

This provides Kotlin compilation, unit/compatibility testing, manifest/plugin patching, and a non-publishing packaging dry run. The aggregate `StamCont Baseline` gate now requires the JetBrains job in addition to the existing core, CLI, GUI/VS Code, and native jobs.

`StamCont Execution Security` remains required and unchanged.

## Non-goals

PR21 intentionally does not:

- change the Marketplace plugin ID;
- create a StamCont Marketplace identity;
- rename Kotlin packages;
- rename persisted settings/state;
- rename action IDs;
- rename the tool-window ID;
- rename Gradle artifact identity;
- redirect Continue external services;
- modify AgentLoop, tool execution, security, session, sandbox, or persistence semantics;
- publish or sign artifacts.

Those boundaries keep PR21 an identity/presentation migration rather than a release or runtime rewrite.
