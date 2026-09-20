// Temporary native launcher probe: no package install or provider calls.
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

async function main() {
  const source = readFileSync("core/agent/windowsSandbox.ts", "utf8");
  const match = source.match(/const WINDOWS_SANDBOX_LAUNCHER = String.raw`([\s\S]*?)`;/);
  if (!match) throw new Error("Launcher not found");
  let script = match[1].replace(
    "$configValues = @{}",
    "[Console]::Error.WriteLine('probe: script-enter')\n[Console]::Error.WriteLine('probe: before-config')\n$configValues = @{}",
  );
  script = script.replace(
    "$config = $configValues",
    "$config = $configValues\n[Console]::Error.WriteLine('probe: after-config')",
  );
  script = script.replace(/^(\s*)Write-StamContDiagnostic -Stage "([^"]+)"/gm, "$1[Console]::Error.WriteLine('probe: $2')\n$&");
  const safe = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]);
  const runtime = new Set(["USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "HOMEDRIVE", "HOMEPATH", "SYSTEMDRIVE"]);
  let failed = false;
  for (const mode of ["broker-runtime", "broker-builtins"]) {
    const workspace = mkdtempSync(path.join(process.cwd(), "stamcont-probe-"));
    const home = path.join(workspace, "home");
    const temp = path.join(workspace, "tmp");
    mkdirSync(home);
    mkdirSync(temp);
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (safe.has(key.toUpperCase())) env[key.toUpperCase()] = value;
    }
    Object.assign(env, { HOME: home, USERPROFILE: home, TMP: temp, TEMP: temp, TMPDIR: temp });
    const childEnv = { ...env };
    if (mode.startsWith("broker-")) {
      for (const [key, value] of Object.entries(process.env)) {
        if (runtime.has(key.toUpperCase())) env[key.toUpperCase()] = value;
      }
    }
    const command = [
      "echo stamcont-probe-command",
      "echo TEMP=%TEMP%",
      'if not exist "%TEMP%" exit /b 41',
      'echo probe-temp>"%TEMP%\\probe-marker"',
      'type "%TEMP%\\probe-marker"',
    ].join(" & ");
    const environmentPayload = Object.entries(childEnv)
      .filter(([key, value]) =>
        typeof value === "string" &&
        key.length > 0 &&
        !key.includes("=") &&
        !key.includes("\0") &&
        !value.includes("\0"))
      .map(([key, value]) => `${key}=${value}`)
      .join("\0");
    const diagnosticsPath = path.join(workspace, "trace.log");
    const configRecords = {
      ProfileName: `StamContSandbox_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      RootsUtf8: workspace,
      Cwd: workspace,
      ReadOnly: "0",
      CommandInterpreter: path.join(env.SYSTEMROOT, "System32", "cmd.exe"),
      EnvironmentUtf8Base64: Buffer.from(environmentPayload, "utf8").toString("base64"),
      HostLocalAppData: process.env.LOCALAPPDATA || process.env.LocalAppData || "",
      HostAppData: process.env.APPDATA || process.env.AppData || "",
      HostTemp: process.env.TEMP || process.env.TMP || "",
      CommandUtf8Base64: Buffer.from(command).toString("base64"),
      CommandUtf8Length: String(Buffer.byteLength(command)),
      CommandSha256: createHash("sha256").update(command).digest("hex"),
      Diagnostics: "1",
      DiagnosticsPath: diagnosticsPath,
    };
    const configPayload = Object.entries(configRecords)
      .map(([key, value]) => `${key}=${Buffer.from(value, "utf8").toString("base64")}`)
      .join("\n");
    const configPath = path.join(workspace, "probe.config");
    const launcher = path.join(workspace, "probe.ps1");
    writeFileSync(configPath, configPayload);
    writeFileSync(launcher, script);
    const windowsPowerShell = path.join(
      env.SYSTEMROOT,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const modernPowerShell = path.join(
      process.env.ProgramFiles || process.env.PROGRAMFILES || "C:\\Program Files",
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    const broker = require("node:fs").existsSync(modernPowerShell)
      ? modernPowerShell
      : windowsPowerShell;
    if (mode === "broker-builtins") {
      const brokerHome = path.dirname(broker);
      env.PSModulePath = path.join(brokerHome, "Modules");
      env.PATH = [
        path.join(env.SYSTEMROOT, "System32"),
        env.SYSTEMROOT,
        brokerHome,
      ].join(path.delimiter);
    }
    const start = Date.now();
    const child = spawn(broker,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher, "-ConfigPath", configPath],
      { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const report = data => process.stdout.write(`[${mode} +${Date.now() - start}ms] ${data}`);
    child.stdout.on("data", report);
    child.stderr.on("data", report);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      failed = true;
      report("probe timeout; stopping owned process tree\n");
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }, 45000);
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", code => {
        report(`exit=${code}\n`);
        if (!timedOut && code !== 0) failed = true;
        resolve();
      });
    });
    clearTimeout(timer);
    try { report(readFileSync(diagnosticsPath, "utf8")); } catch {}
    try { rmSync(workspace, { recursive: true, force: true }); }
    catch (error) { report(`probe cleanup: ${error.code}\n`); }
  }
  if (failed) {
    process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
