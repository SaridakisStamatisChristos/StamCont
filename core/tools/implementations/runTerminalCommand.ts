import iconv from "iconv-lite";
import { ContinueError, ContinueErrorReason } from "../../util/errors";
import { getExecutionBackend } from "../../agent/execution";
import { ToolImpl } from ".";
import {
  isProcessBackgrounded,
  markProcessAsRunning,
  removeBackgroundedProcess,
  removeRunningProcess,
  updateProcessOutput,
} from "../../util/processTerminalStates";
import {
  getBooleanArg,
  getOptionalStringArg,
  getStringArg,
} from "../parseArgs";

// Default timeout for terminal commands (2 minutes)
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

// Automatically decode the buffer according to the platform to avoid garbled Chinese
function getDecodedOutput(data: Buffer): string {
  if (process.platform === "win32") {
    try {
      let out = iconv.decode(data, "utf-8");
      if (/�/.test(out)) {
        out = iconv.decode(data, "gbk");
      }
      return out;
    } catch {
      return iconv.decode(data, "gbk");
    }
  } else {
    return data.toString();
  }
}

// Add color-supporting environment variables
const getColorEnv = () => ({
  ...process.env,
  FORCE_COLOR: "1",
  COLORTERM: "truecolor",
  TERM: "xterm-256color",
  CLICOLOR: "1",
  CLICOLOR_FORCE: "1",
});

function bindAbortSignal(
  childProc: {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
  },
  signal?: AbortSignal,
): () => void {
  if (!signal) {
    return () => undefined;
  }

  const abort = () => {
    if (childProc.exitCode === null && childProc.signalCode === null) {
      childProc.kill("SIGTERM");
    }
  };
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

export const runTerminalCommandImpl: ToolImpl = async (args, extras) => {
  const command = getStringArg(args, "command");
  // Default to waiting for completion if not specified
  const waitForCompletion =
    getBooleanArg(args, "waitForCompletion", false) ?? true;
  const requestedCwd = getOptionalStringArg(args, "cwd");
  const backend = getExecutionBackend(extras);
  const toolCallId = extras.toolCallId || "";

  if (await backend.isLocalShell()) {
    const cwd = await backend.resolveWorkingDirectory(requestedCwd);
    // For streaming output
    if (extras.onPartialOutput) {
      try {
        return new Promise((resolve, reject) => {
          let terminalOutput = "";
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          let sigkillTimeoutId: ReturnType<typeof setTimeout> | undefined;

          if (!waitForCompletion) {
            const status = "Command is running in the background...";
            if (extras.onPartialOutput) {
              extras.onPartialOutput({
                toolCallId,
                contextItems: [
                  {
                    name: "Terminal",
                    description: "Terminal command output",
                    content: "",
                    status: status,
                  },
                ],
              });
            }
          }

          const childProc = backend.spawnShell(command, {
            cwd,
            env: getColorEnv(),
          });
          const cleanupAbort = bindAbortSignal(
            childProc,
            extras.executionSignal,
          );

          // Track this process for foreground cancellation
          if (toolCallId && waitForCompletion) {
            markProcessAsRunning(
              toolCallId,
              childProc,
              extras.onPartialOutput,
              terminalOutput,
            );
          }

          // Check if the child process is still running.
          // `childProc.killed` only indicates that kill() was called,
          // not that the process has actually exited.
          const isRunning = () =>
            childProc.exitCode === null && childProc.signalCode === null;

          // Set up timeout for waitForCompletion mode
          if (waitForCompletion) {
            timeoutId = setTimeout(() => {
              if (isRunning()) {
                terminalOutput +=
                  "\n[Timeout: process killed after 2 minutes]\n";

                // Update UI with timeout message
                if (extras.onPartialOutput) {
                  extras.onPartialOutput({
                    toolCallId,
                    contextItems: [
                      {
                        name: "Terminal",
                        description: "Terminal command output",
                        content: terminalOutput,
                        status: "Command timed out",
                      },
                    ],
                  });
                }

                // Try graceful termination first
                childProc.kill("SIGTERM");

                // Force kill after 5 seconds if still running
                sigkillTimeoutId = setTimeout(() => {
                  if (isRunning()) {
                    childProc.kill("SIGKILL");
                  }
                }, 5_000);
              }
            }, DEFAULT_TOOL_TIMEOUT_MS);
          }

          childProc.stdout?.on("data", (data) => {
            // Skip if this process has been backgrounded
            if (isProcessBackgrounded(toolCallId)) return;

            const newOutput = getDecodedOutput(data);
            terminalOutput += newOutput;

            // Update the tracked output for potential cancellation notifications
            if (toolCallId && waitForCompletion) {
              updateProcessOutput(toolCallId, terminalOutput);
            }

            // Send partial output to UI
            if (extras.onPartialOutput) {
              const status = waitForCompletion
                ? ""
                : "Command is running in the background...";
              extras.onPartialOutput({
                toolCallId,
                contextItems: [
                  {
                    name: "Terminal",
                    description: "Terminal command output",
                    content: terminalOutput,
                    status: status,
                  },
                ],
              });
            }
          });

          childProc.stderr?.on("data", (data) => {
            // Skip if this process has been backgrounded
            if (isProcessBackgrounded(toolCallId)) return;

            const newOutput = getDecodedOutput(data);
            terminalOutput += newOutput;

            // Update the tracked output for potential cancellation notifications
            if (toolCallId && waitForCompletion) {
              updateProcessOutput(toolCallId, terminalOutput);
            }

            // Send partial output to UI, status is not required
            if (extras.onPartialOutput) {
              extras.onPartialOutput({
                toolCallId,
                contextItems: [
                  {
                    name: "Terminal",
                    description: "Terminal command output",
                    content: terminalOutput,
                  },
                ],
              });
            }
          });

          // If we don't need to wait for completion, resolve immediately
          if (!waitForCompletion) {
            const status = "Command is running in the background...";
            resolve([
              {
                name: "Terminal",
                description: "Terminal command output",
                content: terminalOutput,
                status: status,
              },
            ]);
          }

          childProc.on("close", (code) => {
            cleanupAbort();
            // Clear timeout on normal completion
            if (timeoutId) {
              clearTimeout(timeoutId);
            }

            // Clear inner SIGKILL timeout if process exits before grace period
            if (sigkillTimeoutId) {
              clearTimeout(sigkillTimeoutId);
            }

            // Clean up process tracking
            if (toolCallId) {
              if (isProcessBackgrounded(toolCallId)) {
                removeBackgroundedProcess(toolCallId);
                return;
              }
              // Remove from foreground tracking if it was tracked
              removeRunningProcess(toolCallId);
            }

            if (waitForCompletion) {
              // Normal completion, resolve now
              if (!code || code === 0) {
                const status = "Command completed";
                resolve([
                  {
                    name: "Terminal",
                    description: "Terminal command output",
                    content: terminalOutput,
                    status: status,
                  },
                ]);
              } else {
                const status = `Command failed with exit code ${code}`;
                resolve([
                  {
                    name: "Terminal",
                    description: "Terminal command output",
                    content: terminalOutput,
                    status: status,
                  },
                ]);
              }
            } else {
              // Already resolved, just update the UI with final output
              if (extras.onPartialOutput) {
                const status =
                  code === 0 || !code
                    ? "\nBackground command completed"
                    : `\nBackground command failed with exit code ${code}`;
                extras.onPartialOutput({
                  toolCallId,
                  contextItems: [
                    {
                      name: "Terminal",
                      description: "Terminal command output",
                      content: terminalOutput,
                      status: status,
                    },
                  ],
                });
              }
            }
          });

          childProc.on("error", (error) => {
            cleanupAbort();
            // Clear timeout on error
            if (timeoutId) {
              clearTimeout(timeoutId);
            }

            // Clear SIGKILL timeout to prevent delayed kill after rejection
            if (sigkillTimeoutId) {
              clearTimeout(sigkillTimeoutId);
            }

            // Clean up process tracking
            if (toolCallId) {
              if (isProcessBackgrounded(toolCallId)) {
                removeBackgroundedProcess(toolCallId);
                return;
              }
              // Remove from foreground tracking if it was tracked
              removeRunningProcess(toolCallId);
            }

            reject(error);
          });
        });
      } catch (error: any) {
        throw error;
      }
    } else {
      // Fallback to non-streaming for older clients
      const cwd = await backend.resolveWorkingDirectory(requestedCwd);

      if (waitForCompletion) {
        // Standard execution, waiting for completion
        try {
          const output = await new Promise<{ stdout: string; stderr: string }>(
            (resolve, reject) => {
              let timeoutId: ReturnType<typeof setTimeout> | undefined;
              let sigkillTimeoutId: ReturnType<typeof setTimeout> | undefined;

              const childProc = backend.spawnShell(command, {
                cwd,
                env: getColorEnv(),
              });
              const cleanupAbort = bindAbortSignal(
                childProc,
                extras.executionSignal,
              );

              // Track this process for foreground cancellation
              if (toolCallId) {
                markProcessAsRunning(toolCallId, childProc, undefined, "");
              }

              let stdout = "";
              let stderr = "";

              // Check if the child process is still running.
              // `childProc.killed` only indicates that kill() was called,
              // not that the process has actually exited.
              const isRunning = () =>
                childProc.exitCode === null && childProc.signalCode === null;

              // Set up timeout
              timeoutId = setTimeout(() => {
                if (isRunning()) {
                  stderr += "\n[Timeout: process killed after 2 minutes]\n";

                  // Try graceful termination first
                  childProc.kill("SIGTERM");

                  // Force kill after 5 seconds if still running
                  sigkillTimeoutId = setTimeout(() => {
                    if (isRunning()) {
                      childProc.kill("SIGKILL");
                    }
                  }, 5_000);
                }
              }, DEFAULT_TOOL_TIMEOUT_MS);

              childProc.stdout?.on("data", (data) => {
                stdout += getDecodedOutput(data);
              });

              childProc.stderr?.on("data", (data) => {
                stderr += getDecodedOutput(data);
              });

              childProc.on("close", (code) => {
            cleanupAbort();
                // Clear outer timeout
                if (timeoutId) {
                  clearTimeout(timeoutId);
                }

                // Clear inner SIGKILL timeout if process exits before grace period
                if (sigkillTimeoutId) {
                  clearTimeout(sigkillTimeoutId);
                }

                // Clean up process tracking
                if (toolCallId) {
                  removeRunningProcess(toolCallId);
                }

                if (code === 0) {
                  resolve({ stdout, stderr });
                } else {
                  const error = new ContinueError(
                    ContinueErrorReason.CommandExecutionFailed,
                    `Command failed with exit code ${code}`,
                  );
                  (error as any).stderr = stderr;
                  reject(error);
                }
              });

              childProc.on("error", (error) => {
            cleanupAbort();
                // Clear timeout on error
                if (timeoutId) {
                  clearTimeout(timeoutId);
                }

                // Clear SIGKILL timeout to prevent delayed kill after rejection
                if (sigkillTimeoutId) {
                  clearTimeout(sigkillTimeoutId);
                }

                // Clean up process tracking
                if (toolCallId) {
                  removeRunningProcess(toolCallId);
                }
                reject(error);
              });
            },
          );

          const status = "Command completed";
          return [
            {
              name: "Terminal",
              description: "Terminal command output",
              content: output.stdout ?? "",
              status: status,
            },
          ];
        } catch (error: any) {
          const status = `Command failed with: ${error.message || error.toString()}`;
          return [
            {
              name: "Terminal",
              description: "Terminal command output",
              content: error.stderr ?? error.toString(),
              status: status,
            },
          ];
        }
      } else {
        // For non-streaming but also not waiting for completion, use spawn
        // but don't attach any listeners other than error
        try {
          const childProc = backend.spawnShell(command, {
            cwd,
            env: getColorEnv(),
            // Detach the process so it's not tied to the parent
            detached: true,
            // Redirect to /dev/null equivalent (works cross-platform)
            stdio: "ignore",
          });
          const cleanupAbort = bindAbortSignal(
            childProc,
            extras.executionSignal,
          );

          // Even for detached processes, add event handlers to clean up the background process map
          childProc.on("close", () => {
            cleanupAbort();
            if (isProcessBackgrounded(toolCallId)) {
              removeBackgroundedProcess(toolCallId);
            }
          });

          childProc.on("error", () => {
            cleanupAbort();
            if (isProcessBackgrounded(toolCallId)) {
              removeBackgroundedProcess(toolCallId);
            }
          });

          // Unref the child to allow the Node.js process to exit
          childProc.unref();
          const status = "Command is running in the background...";
          return [
            {
              name: "Terminal",
              description: "Terminal command output",
              content: status,
              status: status,
            },
          ];
        } catch (error: any) {
          const status = `Command failed with: ${error.message || error.toString()}`;
          return [
            {
              name: "Terminal",
              description: "Terminal command output",
              content: status,
              status: status,
            },
          ];
        }
      }
    }
  }

  // Workspace-backed remote execution remains delegated to the IDE until the
  // Interactive sandbox provides its own remote process boundary.
  if (requestedCwd) {
    throw new Error(
      "Explicit cwd is not supported by the legacy remote IDE executor",
    );
  }
  await backend.runShell(command);
  return [
    {
      name: "Terminal",
      description: "Terminal command output",
      content:
        "Command executed in remote terminal. Output capture is not yet available for remote environments.",
      status: "Command executed",
    },
  ];
};
