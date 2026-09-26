# StamCont-Owned Release Infrastructure — PR22

## Scope

PR22 establishes release infrastructure that is owned by the standalone
`SaridakisStamatisChristos/StamCont` repository without claiming ownership of
Continue's npm package, VS Code Marketplace publisher, JetBrains Marketplace
listing, credentials, or signing identities.

PR22 is deliberately a **release infrastructure** change, not the first
standalone release. The first release remains a PR23 concern.

## Ownership decisions

| Surface | PR22 decision | Publication state |
|---|---|---|
| GitHub repository releases | StamCont-owned target | Infrastructure implemented, policy-disabled until PR23 |
| CLI GitHub bundle | StamCont-owned artifact name | Build/dry-run enabled |
| VS Code VSIX artifacts | StamCont-owned artifact names | Build/dry-run enabled |
| JetBrains ZIP artifact | StamCont-owned artifact name | Build/dry-run enabled |
| npm | No StamCont-owned package/scope is provisioned | Disabled |
| VS Code Marketplace | Existing compatibility identity remains `Continue.continue` | Disabled |
| JetBrains Marketplace | Existing compatibility plugin ID remains | Disabled |
| External code signing | No StamCont-owned signing identity/keys are provisioned | Disabled |
| GitHub provenance | GitHub/Sigstore artifact attestation | Enabled for non-PR release builds |

The machine-readable source of truth is
`release/stamcont-release-policy.json`.

## External registry policy

PR22 does not invent registry ownership.

The compatibility identities remain:

- CLI npm package: `@continuedev/cli`
- VS Code Marketplace identity: `Continue.continue`
- JetBrains plugin ID:
  `com.github.continuedev.continueintellijextension`

These values remain for compatibility only. The StamCont release workflow
contains no npm, VS Code Marketplace, Open VSX, or JetBrains Marketplace
publication command and consumes no credentials for those services.

A future external publication change must provision a real StamCont-owned
target first and update the release policy and validation contract in a
dedicated PR.

## Upstream release quarantine

Inherited Continue release workflows remain guarded by the upstream repository
identity. PR22 does not mechanically replace
`github.repository == 'continuedev/continue'`.

The release policy validator checks that the quarantine remains present in:

- `.github/workflows/auto-release.yml`
- `.github/workflows/stable-release.yml`
- `.github/workflows/vscode-prerelease.yml`
- `.github/workflows/jetbrains-release.yaml`

This makes accidental reactivation a CI failure.

## StamCont release workflow

New workflow:

`.github/workflows/stamcont-release.yml`

It supports three execution modes:

1. Pull-request dry run when release-infrastructure files change.
2. Manual build from `main` with an explicitly supplied SemVer.
3. Stable tag build for strict `vMAJOR.MINOR.PATCH` tags.

A stable tag must point to a commit reachable from `main`.

### PR22 publication lock

GitHub publication requires **both**:

1. `release.github.publishEnabled == true` in the checked-in policy; and
2. repository variable `STAMCONT_RELEASES_ENABLED == 'true'`.

PR22 intentionally leaves the checked-in policy set to `false`. Therefore
PR22 can build the complete release candidate but cannot publish a GitHub
release.

PR23 may enable this only after clean-environment release-readiness validation.

## Release artifacts

The release contract builds:

- `stamcont-cli-{version}.tar.gz`
- `stamcont-vscode-{version}-linux-x64.vsix`
- `stamcont-vscode-{version}-win32-x64.vsix`
- `stamcont-vscode-{version}-darwin-arm64.vsix`
- `stamcont-jetbrains-{version}.zip`
- `stamcont-sbom.cdx.json`
- `release-manifest.json`
- `SHA256SUMS`

Artifact filenames are StamCont-owned even when an archive intentionally
contains a compatibility identifier required by the installed extension or
package format.

## Supply-chain controls

PR22 adds the following controls:

- external actions used by the new release workflow are pinned to immutable
  commit SHAs;
- VS Code release build action dependencies are pinned to immutable SHAs;
- SHA-256 checksums are generated and verified before artifact upload;
- a CycloneDX JSON SBOM is generated with Syft through Anchore's SBOM action;
- non-PR release builds create GitHub artifact provenance attestations backed
  by Sigstore;
- release jobs use least-privilege permissions;
- no upstream registry credentials are referenced;
- no external publication occurs from the StamCont workflow.

## GitHub release transaction and rollback

Once PR23 explicitly enables GitHub publication, stable tag releases use this
transaction:

1. Reject an already-existing release for the tag.
2. Create a **draft** GitHub release for an existing verified tag.
3. Upload the complete release bundle.
4. Convert the draft to a published release only after uploads succeed.
5. If the upload/publish sequence fails after draft creation, delete the newly
   created draft.

External registries are not part of this transaction, so a GitHub release
cannot partially publish to npm or IDE marketplaces.

## Compatibility preservation

PR22 does not change:

- `stamcont` / `cn` CLI behavior;
- the npm compatibility package identity;
- `~/.continue` persisted state;
- `CONTINUE_*` fallback behavior;
- VS Code `continue.*` settings/state identifiers;
- VS Code `Continue.continue` Marketplace identity;
- JetBrains plugin/action/tool-window/settings persistence identifiers;
- implementation package namespaces;
- external Continue API behavior;
- AgentLoop, execution, sandbox, authority, security, session, or compaction
  semantics.

## CI contract

`StamCont Baseline` now contains a `Release contract` job that runs:

```text
node scripts/stamcont-release-policy.mjs
```

The validator locks ownership/quarantine invariants and fails if an unowned
external publication primitive is introduced into the StamCont release
workflow.

The release workflow itself runs a full dry-run build on pull requests that
modify release-infrastructure files, proving the actual CLI, VSIX, JetBrains,
SBOM, checksum, and metadata path rather than validating YAML alone.

`StamCont Execution Security` remains unchanged and mandatory.

## PR23 handoff

PR23 should:

1. Validate release artifacts from clean environments.
2. Install and exercise the CLI `stamcont` and `cn` entry points.
3. Install VSIX artifacts and validate identity/state compatibility.
4. Install the JetBrains ZIP and validate plugin/state compatibility.
5. Verify `SHA256SUMS`.
6. Verify GitHub provenance attestations on a non-PR dry run where supported.
7. Confirm provenance/attribution documentation.
8. Confirm the durable-resume demonstration.
9. Only after those checks, change
   `release.github.publishEnabled` from `false` to `true`.
10. Deliberately set the `STAMCONT_RELEASES_ENABLED` repository variable when
    the repository owner is ready to permit the first stable GitHub release.
11. Create the first new tag, expected to be `v0.1.0`.

External npm/Marketplace publication must remain disabled unless ownership is
separately provisioned and verified.
