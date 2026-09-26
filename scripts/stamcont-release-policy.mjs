#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const fail = (message) => {
  console.error(`release-policy: ${message}`);
  process.exit(1);
};
const assert = (condition, message) => {
  if (!condition) fail(message);
};

const policy = json("release/stamcont-release-policy.json");

assert(policy.schemaVersion === 1, "schemaVersion must be 1");
assert(policy.product === "StamCont", "product must be StamCont");
assert(
  policy.repository === "SaridakisStamatisChristos/StamCont",
  "repository must be the standalone StamCont repository",
);
assert(policy.release?.sourceBranch === "main", "release source branch must be main");
assert(
  policy.release?.tagPattern === "^v\\d+\\.\\d+\\.\\d+$",
  "release tag pattern must be strict stable SemVer",
);
assert(
  policy.release?.github?.enableRepositoryVariable === "STAMCONT_RELEASES_ENABLED",
  "GitHub publication must require the explicit repository variable gate",
);

for (const [name, target] of Object.entries(policy.externalDistribution ?? {})) {
  assert(target.publishEnabled === false, `${name} publication must remain disabled`);
  assert(target.ownedTarget === null, `${name} must not claim an unprovisioned owned target`);
}

const cliPackage = json("extensions/cli/package.json");
assert(
  cliPackage.name === policy.externalDistribution.npm.compatibilityIdentity,
  "CLI compatibility npm identity changed without an owned target",
);
assert(
  cliPackage.bin?.stamcont === "dist/stamcont.js" && cliPackage.bin?.cn === "dist/cn.js",
  "CLI stamcont/cn compatibility binaries must remain present",
);

const vscodePackage = json("extensions/vscode/package.json");
const vscodeIdentity = `${vscodePackage.publisher}.${vscodePackage.name}`;
assert(
  vscodeIdentity === policy.externalDistribution.vscodeMarketplace.compatibilityIdentity,
  "VS Code compatibility Marketplace identity changed without an owned target",
);

const jetbrainsManifest = read(
  "extensions/intellij/src/main/resources/META-INF/plugin.xml",
);
const expectedJetBrainsId =
  policy.externalDistribution.jetbrainsMarketplace.compatibilityIdentity;
assert(
  jetbrainsManifest.includes(`<id>${expectedJetBrainsId}</id>`),
  "JetBrains compatibility plugin ID changed without an owned target",
);

const releaseWorkflow = read(".github/workflows/stamcont-release.yml");
for (const forbidden of [
  "npm publish",
  "vsce publish",
  "ovsx publish",
  "publishPlugin",
  "JETBRAINS_PUBLISH_TOKEN",
  "NPM_TOKEN",
  "VSCE_PAT",
  "OVSX_PAT",
]) {
  assert(
    !releaseWorkflow.includes(forbidden),
    `StamCont release workflow must not contain external publication primitive: ${forbidden}`,
  );
}
assert(
  releaseWorkflow.includes("STAMCONT_RELEASES_ENABLED"),
  "GitHub release publication must use the explicit repository-variable gate",
);
assert(
  releaseWorkflow.includes("actions/attest@"),
  "release workflow must generate GitHub provenance attestations",
);
assert(
  releaseWorkflow.includes("anchore/sbom-action@"),
  "release workflow must generate an SBOM",
);

for (const path of [
  ".github/workflows/auto-release.yml",
  ".github/workflows/stable-release.yml",
  ".github/workflows/vscode-prerelease.yml",
  ".github/workflows/jetbrains-release.yaml",
]) {
  const workflow = read(path);
  assert(
    workflow.includes("github.repository == 'continuedev/continue'"),
    `${path} lost its upstream repository quarantine guard`,
  );
}

const expectedArtifacts = new Set([
  "stamcont-cli-{version}.tar.gz",
  "stamcont-vscode-{version}-linux-x64.vsix",
  "stamcont-vscode-{version}-win32-x64.vsix",
  "stamcont-vscode-{version}-darwin-arm64.vsix",
  "stamcont-jetbrains-{version}.zip",
  "stamcont-sbom.cdx.json",
  "release-manifest.json",
  "SHA256SUMS",
]);
assert(
  policy.artifacts.length === expectedArtifacts.size &&
    policy.artifacts.every((name) => expectedArtifacts.has(name)),
  "release artifact contract drifted",
);

console.log("release-policy: OK");
