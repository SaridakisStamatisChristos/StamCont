# StamCont First Standalone Release Readiness — PR23

## Decision

PR23 validates the first standalone StamCont GitHub release path from built
artifacts through clean installation and supply-chain verification.

The validated target is the StamCont GitHub repository release channel only.
npm, VS Code Marketplace, Open VSX, and JetBrains Marketplace publication
remain disabled because no StamCont-owned external registry identities have
been provisioned.

## Validation evidence

A non-pull-request `release-validation/pr23` workflow run exercised the same
release builders and metadata path used by a future stable tag while remaining
incapable of publishing a GitHub release.

The successful validation covered:

| Readiness requirement | Result |
| --- | --- |
| Release ownership / quarantine contract | Pass |
| CLI artifact build | Pass |
| VS Code Linux x64 VSIX build | Pass |
| VS Code Windows x64 VSIX build | Pass |
| VS Code macOS arm64 VSIX build | Pass |
| JetBrains distributable ZIP build | Pass |
| CycloneDX SBOM generation | Pass |
| SHA-256 checksum generation and verification | Pass |
| GitHub/Sigstore provenance attestation | Pass |
| Durable resume demonstration | Pass |
| Clean CLI install — Linux | Pass |
| Clean CLI install — macOS | Pass |
| Clean CLI install — Windows | Pass |
| Clean VSIX install and compatibility inspection | Pass |
| Clean JetBrains ZIP install and compatibility inspection | Pass |
| Aggregate standalone readiness gate | Pass |

The validation run deliberately skipped `Publish GitHub release` because it
was not a stable tag.

## CLI clean-install validation

The release workflow installs the generated
`stamcont-cli-<version>.tar.gz` into a fresh npm prefix on Linux, macOS, and
Windows and verifies both executable surfaces:

```text
stamcont --help
cn --help
```

PR23 also fixes the release bundle itself so that its staged package manifest
represents a prebuilt local distribution rather than a source checkout:

- the staged version is the release version;
- the compatibility package identity remains `@continuedev/cli`;
- the release manifest is marked `private` to prevent accidental npm
  publication;
- source-development `prepare` and semantic-release lifecycle hooks are
  removed from the staged bundle;
- the prebuilt `stamcont` and `cn` entry points remain present.

No npm publication is introduced.

## VS Code clean-install validation

The Linux x64 VSIX is installed into a fresh extension directory using a clean
VS Code test harness. The installed extension is then inspected to verify:

- compatibility Marketplace identity remains `Continue.continue`;
- visible product identity begins with `StamCont`;
- both `continue.newSession` and `stamcont.newSession` are present;
- persisted `continue.*` configuration keys remain available;
- no new persisted `stamcont.*` configuration namespace is introduced;
- compatibility view-container identities remain present.

This validates the PR20 compatibility strategy against the packaged artifact,
not only the repository manifest.

## JetBrains clean-install validation

The generated StamCont JetBrains ZIP is checksum-verified, archive-tested, and
extracted into a fresh plugin directory. The packaged plugin manifest is
inspected to confirm:

- plugin ID remains
  `com.github.continuedev.continueintellijextension`;
- visible plugin name is `StamCont`;
- legacy tool-window and notification IDs remain `Continue`;
- Continue-era action IDs required for compatibility remain present;
- visible settings identity is StamCont.

This validates the PR21 compatibility boundary on the actual distributable
plugin.

## Durable runtime demonstration

PR23 runs the focused canonical runtime release-readiness suite:

```text
core/agent/releaseReadiness.vitest.ts
```

The demonstration includes terminal replay without re-running the provider,
AgentKernel-authorized tool execution, durable cancellation, and safe versus
ambiguous crash/restart behavior.

## Integrity, SBOM, and provenance

The release bundle includes and validates:

- `SHA256SUMS`;
- `release-manifest.json`;
- `stamcont-sbom.cdx.json` in CycloneDX JSON format.

Because PR23 uses a non-PR validation push, the metadata job also executes
GitHub artifact attestation successfully. This proves the Sigstore-backed
provenance path before the first stable tag.

## Provenance and attribution

Release-facing documentation continues to link to `UPSTREAM.md`, which
records:

- upstream repository `continuedev/continue`;
- imported baseline commit
  `5522c6f44ca0ac3528b37244818fbfa39b5af470`;
- Apache License 2.0;
- the standalone-history policy and explicit non-claim of authorship.

Standalone installation documentation no longer directs StamCont users to
Continue's npm package or IDE Marketplace listings.

## Release controls after PR23

After successful validation, PR23 changes the checked-in policy phase to
`pr23-release-ready` and enables the **first** GitHub publication gate.

A real GitHub release still requires all of the following:

1. a strict stable `vMAJOR.MINOR.PATCH` tag reachable from `main`;
2. checked-in `release.github.publishEnabled == true`;
3. repository variable `STAMCONT_RELEASES_ENABLED == 'true'`;
4. successful artifact, metadata, provenance, clean-install, and standalone
   readiness jobs.

The repository-variable gate is deliberately not changed by PR23 code. It is
the repository owner's final operational arm switch before a stable tag is
created.

## External distribution remains disabled

PR23 does not enable or claim ownership of:

- npm;
- Visual Studio Marketplace;
- Open VSX;
- JetBrains Marketplace;
- inherited Continue signing or publication credentials.

The first standalone release target remains GitHub Releases only.

## Expected first release

Once PR23 is merged and the repository owner deliberately arms
`STAMCONT_RELEASES_ENABLED`, the expected first stable tag is:

```text
v0.1.0
```

Creating that tag and publishing the release are operational actions after the
release-readiness PR, not part of this validation branch.
