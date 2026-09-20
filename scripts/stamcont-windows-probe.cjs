// Temporary native launcher probe: no package install or provider calls.
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

async function main() {
  const source = readFileSync("core/agent/windowsSandbox.ts", "utf8");
  const match = source.match(/const WINDOWS_SANDBOX_LAUNCHER = String.raw`([\s\S]*?)`;/);
  if (!match) throw new Error("Launcher not found");
  let script = match[1].replace("$configJson =", "[Console]::Error.WriteLine('probe: script-enter')\n$configJson =");
  script = script.replace("$config = $configJson | ConvertFrom-Json", "[Console]::Error.WriteLine('probe: before-json')\n$config = $configJson | ConvertFrom-Json\n[Console]::Error.WriteLine('probe: after-json')");
  script = script.replace(/^(\s*)Write-StamContDiagnostic -Stage "([^"]+)"/gm, "$1[Console]::Error.WriteLine('probe: $2')\n$&");
  const safe = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]);
  const runtime = new Set(["USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "HOMEDRIVE", "HOMEPATH", "SYSTEMDRIVE"]);
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
    if (mode === "broker-builtins") {
      const powerShellHome = path.join(env.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0");
      env.PSModulePath = path.join(powerShellHome, "Modules");
      env.PATH = [path.join(env.SYSTEMROOT, "System32"), env.SYSTEMROOT, powerShellHome].join(path.delimiter);
    }
    const command = "echo stamcont-probe-command";
    const config = {
      ProfileName: `StamContSandbox_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      Roots: [workspace], Cwd: workspace, ReadOnly: false,
      Environment: childEnv,
      CommandInterpreter: path.join(env.SYSTEMROOT, "System32", "cmd.exe"),
      CommandUtf8Base64: Buffer.from(command).toString("base64"),
      CommandUtf8Length: Buffer.byteLength(command),
      CommandSha256: createHash("sha256").update(command).digest("hex"),
      Diagnostics: true,
      DiagnosticsPath: path.join(workspace, "trace.log"),
    };
    const launcher = path.join(workspace, "probe.ps1");
    writeFileSync(launcher, script);
    const start = Date.now();
    const child = spawn(path.join(env.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher, "-ConfigBase64", Buffer.from(JSON.stringify(config)).toString("base64")],
      { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const report = data => process.stdout.write(`[${mode} +${Date.now() - start}ms] ${data}`);
    child.stdout.on("data", report);
    child.stderr.on("data", report);
    const timer = setTimeout(() => {
      report("probe timeout; stopping owned process tree\n");
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }, 45000);
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", code => { report(`exit=${code}\n`); resolve(); });
    });
    clearTimeout(timer);
    try { report(readFileSync(config.DiagnosticsPath, "utf8")); } catch {}
    try { rmSync(workspace, { recursive: true, force: true }); }
    catch (error) { report(`probe cleanup: ${error.code}\n`); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
