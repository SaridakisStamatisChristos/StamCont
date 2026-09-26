#!/usr/bin/env node

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
};

let testsPassed = 0;
let testsFailed = 0;

function runTest(name, testFn) {
  process.stdout.write(`Testing ${name}... `);
  try {
    testFn();
    console.log(`${colors.green}✓${colors.reset}`);
    testsPassed++;
  } catch (error) {
    console.log(`${colors.red}✗${colors.reset}`);
    console.error(`  Error: ${error.message}`);
    testsFailed++;
  }
}

function execCommand(command, options = {}) {
  return execSync(command, {
    cwd: __dirname,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
}

function getCLICommand(binary, args = "") {
  const script = `dist/${binary}.js`;
  return process.platform === "win32"
    ? `node ${script} ${args}`
    : `./${script} ${args}`;
}

console.log("🧪 Running smoke tests for bundled StamCont CLI...\n");

runTest("Primary and compatibility wrappers exist", () => {
  for (const file of ["dist/index.js", "dist/stamcont.js", "dist/cn.js"]) {
    if (!existsSync(resolve(__dirname, file))) {
      throw new Error(`${file} not found`);
    }
  }
});

runTest("Both wrappers have shebangs", () => {
  for (const file of ["dist/stamcont.js", "dist/cn.js"]) {
    const content = readFileSync(resolve(__dirname, file), "utf8");
    if (!content.startsWith("#!/usr/bin/env node")) {
      throw new Error(`${file} is missing its shebang`);
    }
  }
});

runTest("Package exposes stamcont primary and cn alias", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(__dirname, "package.json"), "utf8"),
  );
  if (packageJson.bin?.stamcont !== "dist/stamcont.js") {
    throw new Error("stamcont bin mapping is missing or incorrect");
  }
  if (packageJson.bin?.cn !== "dist/cn.js") {
    throw new Error("cn compatibility alias is missing or incorrect");
  }
});

runTest("Primary version command works", () => {
  const output = execCommand(getCLICommand("stamcont", "--version"));
  const packageJson = JSON.parse(
    readFileSync(resolve(__dirname, "package.json"), "utf8"),
  );
  if (!output.includes(packageJson.version)) {
    throw new Error(
      `Version mismatch. Expected ${packageJson.version}, got: ${output}`,
    );
  }
});

runTest("Legacy cn version command remains compatible", () => {
  const output = execCommand(getCLICommand("cn", "--version"));
  const packageJson = JSON.parse(
    readFileSync(resolve(__dirname, "package.json"), "utf8"),
  );
  if (!output.includes(packageJson.version)) {
    throw new Error("cn compatibility alias did not return the package version");
  }
});

runTest("Primary help identifies StamCont", () => {
  const output = execCommand(getCLICommand("stamcont", "--help"));
  if (
    !output.includes("StamCont CLI") ||
    !output.includes("Usage: stamcont") ||
    !output.includes("--version")
  ) {
    throw new Error("stamcont help output is missing expected identity");
  }
});

runTest("Legacy help preserves cn invocation name", () => {
  const output = execCommand(getCLICommand("cn", "--help"));
  if (!output.includes("StamCont CLI") || !output.includes("Usage: cn")) {
    throw new Error("cn help output does not preserve compatibility");
  }
});

runTest("Bundle size is reasonable", () => {
  const stats = readFileSync(resolve(__dirname, "dist/index.js"));
  const sizeInMB = stats.length / (1024 * 1024);
  console.log(`(${sizeInMB.toFixed(1)}M)`);

  const MAX_BUNDLE_SIZE_MB = 28;
  if (sizeInMB > MAX_BUNDLE_SIZE_MB) {
    throw new Error(
      `Bundle too large: ${sizeInMB.toFixed(1)}M (max ${MAX_BUNDLE_SIZE_MB}M)`,
    );
  }
});

runTest("Local packages are bundled", () => {
  const bundleContent = readFileSync(
    resolve(__dirname, "dist/index.js"),
    "utf8",
  );

  if (
    !bundleContent.includes("AssistantUnrolled") &&
    !bundleContent.includes("config-yaml")
  ) {
    throw new Error("@continuedev/config-yaml not properly bundled");
  }

  if (
    !bundleContent.includes("anthropic") &&
    !bundleContent.includes("gemini") &&
    !bundleContent.includes("openai") &&
    !bundleContent.includes("azure") &&
    !bundleContent.includes("bedrock")
  ) {
    throw new Error("@continuedev/openai-adapters not properly bundled");
  }
});

runTest("Primary CLI can be invoked", () => {
  const nullDevice = process.platform === "win32" ? "nul" : "/dev/null";
  execCommand(`${getCLICommand("stamcont", "--help")} > ${nullDevice} 2>&1`);
});

runTest("Build metadata exists", () => {
  if (!existsSync(resolve(__dirname, "dist/meta.json"))) {
    throw new Error("dist/meta.json not found");
  }
  const meta = JSON.parse(
    readFileSync(resolve(__dirname, "dist/meta.json"), "utf8"),
  );
  if (!meta.inputs || !meta.outputs) {
    throw new Error("Invalid metadata structure");
  }
});

runTest("No missing runtime dependencies", () => {
  const output = execCommand(
    `${getCLICommand("stamcont", "--version")} 2>&1`,
    { env: { ...process.env, NODE_ENV: "production" } },
  );

  if (
    output.includes("Cannot find module") ||
    output.includes("MODULE_NOT_FOUND")
  ) {
    throw new Error("Missing module detected in output");
  }
});

console.log("\n" + "=".repeat(50));
if (testsFailed === 0) {
  console.log(
    `${colors.green}✅ All ${testsPassed} tests passed!${colors.reset}`,
  );
  process.exit(0);
}

console.log(
  `${colors.red}❌ ${testsFailed} test(s) failed, ${testsPassed} passed${colors.reset}`,
);
process.exit(1);
