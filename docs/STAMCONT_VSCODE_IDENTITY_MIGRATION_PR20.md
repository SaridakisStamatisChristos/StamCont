# StamCont VS Code Identity Migration — PR20

## Scope

PR20 migrates the VS Code surface toward StamCont without breaking installed
Continue-era identifiers that VS Code, user settings, keyboard shortcuts,
workspace state, view placement, URI routing, or automation may persist.

This PR does not publish an extension and does not enable inherited release
workflows.

## Decision matrix

| Surface | PR20 decision | Reason |
|---|---|---|
| Human-facing display name/descriptions | StamCont | Already migrated safely in PR18 |
| Command IDs | Add `stamcont.*` primary aliases; retain `continue.*` | Existing keybindings/automation may reference exact IDs |
| Built-in keybindings/menu command references | Use `stamcont.*` | New built-in interactions use the StamCont namespace |
| Legacy command-palette entries | Retained but hidden | Compatibility remains without duplicate visible commands |
| Configuration keys | Keep `continue.*` | VS Code persists settings by exact key; duplicate namespaces create precedence/synchronization ambiguity |
| View/container IDs | Keep Continue-era IDs | VS Code can persist layout and view placement by exact ID |
| Activation view ID | Keep `onView:continueGUIView` | Required for existing contributed view identity |
| URI activation | Keep `onUri` under current extension identity | URI routing depends on installed extension identity |
| Marketplace `publisher + name` | Keep `Continue.continue` for now | Changing either can create a different extension and break upgrade continuity |
| Package dependencies | Keep `@continuedev/*` | External/package-graph migration is not PR20 |
| VSIX naming/release workflow | Defer to PR22 | Artifact ownership and publishing targets are not yet defined |

## Command compatibility

Runtime command registration now dual-registers every command in the
`continue.*` namespace under both:

- the existing `continue.*` identifier; and
- a corresponding `stamcont.*` alias.

The callback is identical for both IDs. No command behavior is forked.

The manifest contributes StamCont aliases for all currently contributed
Continue commands. Built-in keybindings and menu command references use the
StamCont alias. Continue-era contributed commands remain present but are hidden
from the default command palette so that existing external references continue
to resolve without creating duplicate visible commands.

Explicit `onCommand:stamcont.*` activation events are included because the
extension still supports VS Code versions where contributed-command automatic
activation cannot be assumed.

## Configuration compatibility

PR20 deliberately does not add `stamcont.*` configuration keys.

The current runtime reads the `continue` configuration section throughout the
VS Code extension. Existing user, remote, workspace, and resource-scoped
settings may all contain Continue-era values. Introducing a second namespace
without a complete precedence and synchronization model could make settings
appear to disappear or produce conflicting values.

The `continue.*` configuration namespace is therefore an intentional
compatibility surface for the first standalone StamCont release unless a later
dedicated migration provides deterministic dual-read/dual-write semantics and
rollback behavior.

## View, state, and URI compatibility

PR20 preserves:

- activity-bar container ID `continue`;
- panel container ID `continueConsole`;
- webview ID `continue.continueGUIView`;
- console webview ID `continue.continueConsoleView`;
- `onView:continueGUIView` activation;
- `onUri` activation;
- existing extension-context/global-state keys.

This protects persisted VS Code layout/state and avoids invalidating installed
deep-link behavior.

## Marketplace identity

PR20 does not claim or invent a StamCont VS Code Marketplace publisher.

The manifest therefore retains:

- publisher: `Continue`;
- name: `continue`;
- effective installed extension ID: `Continue.continue`.

This is a compatibility hold, not a branding decision. PR22 must define an
owned publisher/release target before a distinct marketplace identity can be
adopted. If StamCont becomes a separate marketplace extension, the migration
must define the install/upgrade handoff explicitly rather than pretending that
the old marketplace identity can be renamed in place.

## Packaging and release behavior

PR20 does not alter or activate publication workflows. The inherited VSIX
technical filename remains tied to the compatibility package name and is
deferred to PR22 together with publisher ownership, release credentials,
artifact naming, checksums, signing, SBOM/provenance, and dry-run behavior.

## Validation contract

`src/identity.vitest.ts` locks the following PR20 invariants:

- marketplace `publisher + name` remains unchanged;
- every contributed `continue.*` command has a `stamcont.*` alias;
- built-in keybindings and active menu command references use StamCont aliases;
- legacy commands remain available but hidden from the default command palette;
- configuration keys remain `continue.*`;
- view/container IDs remain stable;
- URI/view activation compatibility remains stable;
- StamCont command aliases have explicit activation events.

PR20 must also pass the repository's `StamCont Baseline` and
`StamCont Execution Security` gates before merge.
