import { spawn, type ChildProcess } from "node:child_process";

type StamContChildProcess = ChildProcess & {
  __stamcontIsolatedProcessGroup?: boolean;
};

export function markIsolatedProcessGroup(process: ChildProcess): ChildProcess {
  (process as StamContChildProcess).__stamcontIsolatedProcessGroup = true;
  return process;
}

const PROCESS_TREE_TERMINATION_TIMEOUT_MS = 5_000;

function isIsolatedProcessGroup(child: ChildProcess): boolean {
  return (child as StamContChildProcess).__stamcontIsolatedProcessGroup === true;
}

function isChildProcessActive(child: ChildProcess): boolean {
  return (
    !child.killed &&
    (child.exitCode ?? null) === null &&
    (child.signalCode ?? null) === null
  );
}

function windowsTaskkillArgs(
  child: ChildProcess,
  signal: NodeJS.Signals,
): string[] {
  const args = ["/PID", String(child.pid), "/T"];
  // Windows has no POSIX-style SIGTERM semantics for a hidden broker
  // process. StamCont-owned isolated trees must terminate deterministically
  // so the broker closes its kill-on-close Job Object and descendants cannot
  // escape cancellation. Preserve the softer behavior for ordinary host
  // children.
  if (signal === "SIGKILL" || isIsolatedProcessGroup(child)) {
    args.push("/F");
  }
  return args;
}

function waitForChildProcessClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (!isChildProcessActive(child)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onClose = () => finish();
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(
      () =>
        finish(
          new Error(`Process tree did not terminate within ${timeoutMs}ms`),
        ),
      timeoutMs,
    );

    child.once("close", onClose);
    child.once("error", onError);

    // Avoid missing an exit that raced with listener registration.
    if (!isChildProcessActive(child)) {
      finish();
    }
  });
}

export function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!isChildProcessActive(child)) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", windowsTaskkillArgs(child, signal), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }

  if (isIsolatedProcessGroup(child) && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing the direct child if its group already exited.
    }
  }

  child.kill(signal);
}

export async function terminateProcessTreeAndWait(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  timeoutMs: number = PROCESS_TREE_TERMINATION_TIMEOUT_MS,
): Promise<void> {
  if (!isChildProcessActive(child)) {
    return;
  }

  const childClose = waitForChildProcessClose(child, timeoutMs);

  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", windowsTaskkillArgs(child, signal), {
      stdio: "ignore",
      windowsHide: true,
    });
    const taskkillComplete = new Promise<void>((resolve, reject) => {
      killer.once("error", reject);
      killer.once("close", (code) => {
        if (code === 0 || !isChildProcessActive(child)) {
          resolve();
          return;
        }
        reject(new Error(`taskkill exited with code ${code ?? "unknown"}`));
      });
    });

    await Promise.all([taskkillComplete, childClose]);
    return;
  }

  terminateProcessTree(child, signal);
  await childClose;
}

// Track which processes have been backgrounded
const processTerminalBackgroundStates = new Map<string, boolean>();

// Track which foreground processes are currently running
interface RunningProcessInfo {
  process: ChildProcess;
  onPartialOutput?: (params: {
    toolCallId: string;
    contextItems: any[];
  }) => void;
  currentOutput: string;
}

const processTerminalForegroundStates = new Map<string, RunningProcessInfo>();

// Background process functions (existing)
export function markProcessAsBackgrounded(toolCallId: string): void {
  processTerminalBackgroundStates.set(toolCallId, true);
}

export function isProcessBackgrounded(toolCallId: string): boolean {
  return processTerminalBackgroundStates.has(toolCallId);
}

export function removeBackgroundedProcess(toolCallId: string): void {
  processTerminalBackgroundStates.delete(toolCallId);
}

// Foreground process functions (new)
export function markProcessAsRunning(
  toolCallId: string,
  process: ChildProcess,
  onPartialOutput?: (params: {
    toolCallId: string;
    contextItems: any[];
  }) => void,
  currentOutput: string = "",
): void {
  processTerminalForegroundStates.set(toolCallId, {
    process,
    onPartialOutput,
    currentOutput,
  });
}

export function isProcessRunning(toolCallId: string): boolean {
  return processTerminalForegroundStates.has(toolCallId);
}

export function getRunningProcess(
  toolCallId: string,
): ChildProcess | undefined {
  const info = processTerminalForegroundStates.get(toolCallId);
  return info?.process;
}

export function updateProcessOutput(toolCallId: string, output: string): void {
  const info = processTerminalForegroundStates.get(toolCallId);
  if (info) {
    info.currentOutput = output;
  }
}

export function removeRunningProcess(toolCallId: string): void {
  processTerminalForegroundStates.delete(toolCallId);
}

export async function killTerminalProcess(toolCallId: string): Promise<void> {
  const processInfo = processTerminalForegroundStates.get(toolCallId);
  if (processInfo && !processInfo.process.killed) {
    const { process } = processInfo;

    if (isIsolatedProcessGroup(process)) {
      try {
        await terminateProcessTreeAndWait(process, "SIGTERM");
      } catch {
        if (!isChildProcessActive(process)) {
          processTerminalForegroundStates.delete(toolCallId);
          return;
        }
        await terminateProcessTreeAndWait(process, "SIGKILL");
      }
      processTerminalForegroundStates.delete(toolCallId);
      return;
    }

    terminateProcessTree(process, "SIGTERM");

    // Force kill after 5 seconds if still running.
    setTimeout(() => {
      if (isChildProcessActive(process)) {
        terminateProcessTree(process, "SIGKILL");
      }
    }, 5000);

    processTerminalForegroundStates.delete(toolCallId);
  }
}

// Function to cancel multiple terminal commands at once
export async function killMultipleTerminalProcesses(
  toolCallIds: string[],
): Promise<void> {
  const cancelPromises = toolCallIds.map((toolCallId) =>
    killTerminalProcess(toolCallId),
  );
  await Promise.all(cancelPromises);
}

// Function to cancel ALL currently running terminal commands
export async function killAllRunningTerminalProcesses(): Promise<string[]> {
  const runningIds = getAllRunningProcessIds();
  if (runningIds.length > 0) {
    await killMultipleTerminalProcesses(runningIds);
  }
  return runningIds; // Return the IDs that were cancelled
}

// Utility functions
export function getAllRunningProcessIds(): string[] {
  return Array.from(processTerminalForegroundStates.keys());
}

export function getAllBackgroundedProcessIds(): string[] {
  return Array.from(processTerminalBackgroundStates.keys());
}

// Utility function for testing - clears all background process states
export function clearAllBackgroundProcesses(): void {
  processTerminalBackgroundStates.clear();
}
