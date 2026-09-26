#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const json = (path) => JSON.parse(read(path));
const fail = (message) => {
  console.error(`release-readiness: ${message}`);
  process.exit(1);
};
const assert = (value, message) => {
  if (!value) fail(message);
};

const policy = json("release/stamcont-release-policy.json");

assert(policy.schemaVersion === 1, "release policy schema must remain version 1");
assert(policy.product === "StamCont", "release product must be StamCont");
assert(
  policy.repository === "SaridakisStamatisChristos/StamCont",
  "release repository must be the standalone StamCont repository",
);
assert(
  ["pr23-validation", "pr23-release-ready"].includes(policy.phase),
  "PR23 policy phase must be validation or release-ready",
);
if (policy.phase === "pr23-validation") {
  assert(
    policy.release.github.publishEnabled === false,
    "validation phase must keep GitHub publication disabled",
  );
}
if (policy.phase === "pr23-release-ready") {
  assert(
    policy.release.github.publishEnabled === true,
    "release-ready phase must enable the checked-in GitHub publication gate",
  );
}

for (const [name, target] of Object.entries(policy.externalDistribution ?? {})) {
  assert(target.publishEnabled === false, `${name} publication must remain disabled`);
  assert(target.ownedTarget === null, `${name} must not claim an unprovisioned target`);
}

const readme = read("README.md");
assert(
  readme.includes("## Standalone release installation"),
  "README must document standalone release installation",
);
assert(
  readme.includes("UPSTREAM.md"),
  "README must retain explicit upstream provenance linkage",
);

const upstream = read("UPSTREAM.md");
assert(
  upstream.includes("5522c6f44ca0ac3528b37244818fbfa39b5af470"),
  "UPSTREAM.md must preserve the imported baseline commit",
);
assert(
  upstream.includes("Apache License 2.0"),
  "UPSTREAM.md must preserve Apache-2.0 attribution",
);

const cliInstall = read("docs/snippets/cli-install.mdx");
for (const forbidden of [
  "raw.githubusercontent.com/continuedev/continue",
  "npm i -g @continuedev/cli",
]) {
  assert(
    !cliInstall.includes(forbidden),
    `standalone CLI install docs must not direct users to upstream distribution: ${forbidden}`,
  );
}
assert(
  cliInstall.includes("stamcont-cli-"),
  "CLI install docs must refer to the StamCont release bundle",
);

const ideInstall = read("docs/ide-extensions/install.mdx");
for (const forbidden of [
  "marketplace.visualstudio.com/items?itemName=Continue.continue",
  'search for "Continue" in the marketplace',
]) {
  assert(
    !ideInstall.includes(forbidden),
    `standalone IDE install docs must not direct users to upstream Marketplace distribution: ${forbidden}`,
  );
}
assert(ideInstall.includes(".vsix"), "VS Code docs must describe VSIX installation");
assert(
  ideInstall.includes("Install Plugin from Disk"),
  "JetBrains docs must describe ZIP installation from disk",
);

const durable = read("core/agent/releaseReadiness.vitest.ts");
for (const flow of ["Flow A:", "Flow B:", "Flow C:", "Flow D:"]) {
  assert(durable.includes(flow), `durable release-readiness demonstration is missing ${flow}`);
}

const workflow = read(".github/workflows/stamcont-release.yml");
for (const required of [
  '"release-validation/**"',
  "Clean CLI install /",
  "Clean VSIX install",
  "Clean JetBrains install",
  "Durable resume demonstration",
  "Standalone readiness gate",
  "actions/attest@",
]) {
  assert(workflow.includes(required), `release workflow is missing readiness primitive: ${required}`);
}

console.log(`release-readiness: OK (${policy.phase})`);
