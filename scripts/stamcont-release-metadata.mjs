#!/usr/bin/env node
import {
  createHash,
} from "node:crypto";
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1];
};

const directory = resolve(getArg("--dir", "release"));
const version = getArg("--version");
const sourceSha = getArg("--source-sha", process.env.GITHUB_SHA ?? "unknown");
const repository =
  getArg("--repository", process.env.GITHUB_REPOSITORY) ??
  "SaridakisStamatisChristos/StamCont";

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid or missing release version: ${version ?? "<missing>"}`);
}

const excluded = new Set(["SHA256SUMS", "release-manifest.json"]);
const files = [];

const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (!stat.isFile()) continue;

    const rel = relative(directory, path).replaceAll("\\", "/");
    if (excluded.has(rel)) continue;

    const bytes = readFileSync(path);
    files.push({
      path: rel,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
};

walk(directory);

if (files.length === 0) {
  throw new Error("No release artifacts found");
}

files.sort((a, b) => a.path.localeCompare(b.path));

const manifest = {
  schemaVersion: 1,
  product: "StamCont",
  version,
  source: {
    repository,
    sha: sourceSha,
    ref: process.env.GITHUB_REF ?? null,
  },
  build: {
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  },
  artifacts: files,
};

const manifestPath = join(directory, "release-manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const manifestBytes = readFileSync(manifestPath);
const checksumEntries = [
  ...files,
  {
    path: "release-manifest.json",
    size: manifestBytes.length,
    sha256: createHash("sha256").update(manifestBytes).digest("hex"),
  },
].sort((a, b) => a.path.localeCompare(b.path));

writeFileSync(
  join(directory, "SHA256SUMS"),
  `${checksumEntries.map((f) => `${f.sha256}  ${f.path}`).join("\n")}\n`,
);

console.log(
  `release-metadata: wrote metadata for ${files.length} primary artifacts plus the release manifest`,
);
