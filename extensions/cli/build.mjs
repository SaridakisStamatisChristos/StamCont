#!/usr/bin/env node

import * as esbuild from "esbuild";
import { chmodSync, copyFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

// Parse command line arguments
const args = process.argv.slice(2);
const noMinify = args.includes("--no-minify");

const __dirname = dirname(fileURLToPath(import.meta.url));

// List of packages to mark as external (ONLY native modules that cannot be bundled)
// Note: Everything else will be bundled to create a self-contained CLI
// Users should not need to install any additional dependencies
const external = [
  "fsevents", // macOS native file watcher (optional dependency)
  "./xhr-sync-worker.js", // JSDOM worker file that needs to be copied separately
];

console.log("Building CLI with esbuild...");

// Plugin to handle optional react-devtools-core
const optionalDevtoolsPlugin = {
  name: "optional-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => {
      // Return path to our stub instead of marking as external
      return { path: resolve(__dirname, "stubs/react-devtools-core.js") };
    });
  },
};

// Core BaseLLM records optional local developer token metrics in sqlite.
// The standalone CLI agent runtime needs BaseLLM/provider behavior, but must
// not bundle or require the native sqlite3 addon just to start the CLI.
// Production model execution is unaffected; only local dev-token telemetry is
// disabled inside this self-contained bundle.
const coreDevDataSqliteStubPlugin = {
  name: "core-devdata-sqlite-stub",
  setup(build) {
    build.onResolve({ filter: /devdataSqlite(?:\.js)?$/ }, (args) => {
      const importer = args.importer.replaceAll("\\", "/");
      if (!importer.includes("/core/")) {
        return undefined;
      }
      return {
        path: resolve(__dirname, "stubs/core-devdata-sqlite.js"),
      };
    });

    // PR9 pulls Core provider classes into the standalone CLI bundle.
    // Some Core modules import sqlite eagerly even though CLI agent execution
    // does not use indexing or the local dev-data DB. Replace those native
    // packages at the bundle boundary so startup stays self-contained.
    build.onResolve({ filter: /^sqlite$/ }, () => ({
      path: resolve(__dirname, "stubs/sqlite.js"),
    }));
    build.onResolve({ filter: /^sqlite3$/ }, () => ({
      path: resolve(__dirname, "stubs/sqlite3.js"),
    }));
  },
};

try {
  const result = await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "esm",
    outfile: "dist/index.js",
    external,
    sourcemap: true,
    minify: !noMinify, // Use --no-minify flag to control minification
    metafile: true,
    plugins: [optionalDevtoolsPlugin, coreDevDataSqliteStubPlugin],

    // Handle .js extensions in imports
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".json"],

    // Handle TypeScript paths and local packages
    alias: {
      "@continuedev/config-yaml": resolve(
        __dirname,
        "../../packages/config-yaml/dist/index.js",
      ),
      "@continuedev/openai-adapters": resolve(
        __dirname,
        "../../packages/openai-adapters/dist/index.js",
      ),
      "@continuedev/config-types": resolve(
        __dirname,
        "../../packages/config-types/dist/index.js",
      ),
      core: resolve(__dirname, "../../core"),
      "@continuedev/fetch": resolve(
        __dirname,
        "../../packages/fetch/dist/index.js",
      ),
      "@continuedev/llm-info": resolve(
        __dirname,
        "../../packages/llm-info/dist/index.js",
      ),
      "@continuedev/terminal-security": resolve(
        __dirname,
        "../../packages/terminal-security/dist/index.js",
      ),
    },

    // Add banner to create require for CommonJS packages
    banner: {
      js: `import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __pathDirname } from 'path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __pathDirname(__filename);`,
    },
  });

  // Write metafile for analysis
  writeFileSync("dist/meta.json", JSON.stringify(result.metafile, null, 2));

  // Create wrapper script with shebang that explicitly runs the CLI
  // Note: We must call runCli(); a plain dynamic import will not execute the CLI.
  writeFileSync(
    "dist/cn.js",
    "#!/usr/bin/env node\nimport { runCli } from './index.js';\nawait runCli();\n",
  );
  // Copy worker files needed by JSDOM
  const workerSource = resolve(
    __dirname,
    "node_modules/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js",
  );
  const workerDest = resolve(__dirname, "dist/xhr-sync-worker.js");
  try {
    copyFileSync(workerSource, workerDest);
    console.log("✓ Copied xhr-sync-worker.js");
  } catch (error) {
    console.warn("Warning: Could not copy xhr-sync-worker.js:", error.message);
  }

  // Make the wrapper script executable
  chmodSync("dist/cn.js", 0o755);

  // Calculate bundle size
  const bundleSize = result.metafile.outputs["dist/index.js"].bytes;
  console.log(
    `✓ Build complete! Bundle size: ${(bundleSize / 1024 / 1024).toFixed(2)} MB`,
  );
} catch (error) {
  console.error("Build failed:", error);
  process.exit(1);
}
