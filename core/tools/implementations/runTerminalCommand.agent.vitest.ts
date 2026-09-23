import { EventEmitter } from "node:events";
import type {
  ChildProcess,
  SpawnOptions,
} from "node:child_process";
import { PassThrough } from "node:stream";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ExecutionBackend } from "../../agent/execution";
import {
  clearAllBackgroundProcesses,
  getAllBackgroundedProcessIds,
} from "../../util/processTerminalStates";
import {
  ContinueError,
  ContinueErrorReason,
} from "../../util/errors";
import { runTerminalCommandImpl } from "./runTerminalCommand";

afterEach(() => {
  clearAllBackgroundProcesses();
});

describe("runTerminalCommand agent semantics", () => {
  it("surfaces non-zero exits as process failures in strict agent mode", async () => {
    const child = fakeChild();
    let markSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const backend = fakeBackend(child.process, [], markSpawned);
    const pending = runTerminalCommandImpl(
      { command: "fail" },
      {
        executionBackend: backend,
        strictProcessFailures: true,
        toolCallId: "process-failure",
      } as any,
    );

    await spawned;
    child.close(7);

    await expect(pending).rejects.toMatchObject({
      name: "ContinueError",
      reason: ContinueErrorReason.CommandExecutionFailed,
    } satisfies Partial<ContinueError>);
  });

  it("retains legacy context-item failure behavior outside strict mode", async () => {
    const child = fakeChild();
    let markSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const backend = fakeBackend(child.process, [], markSpawned);
    const pending = runTerminalCommandImpl(
      { command: "fail" },
      {
        executionBackend: backend,
        toolCallId: "legacy-process-failure",
      } as any,
    );

    await spawned;
    child.close(3);

    await expect(pending).resolves.toMatchObject([
      {
        status: "Command failed with: Command failed with exit code 3",
      },
    ]);
  });

  it("keeps agent background jobs attached to their owning session", async () => {
    const child = fakeChild();
    const spawnOptions: SpawnOptions[] = [];
    const backend = fakeBackend(child.process, spawnOptions);

    await expect(
      runTerminalCommandImpl(
        {
          command: "background",
          waitForCompletion: false,
        },
        {
          executionBackend: backend,
          managedBackgroundJobs: true,
          toolCallId: "background-call",
          executionProcessId: "agent:session:item:background-call",
        } as any,
      ),
    ).resolves.toMatchObject([
      {
        status: "Command is running in the background...",
      },
    ]);

    expect(spawnOptions[0]?.detached).toBe(false);
    expect(child.unref).not.toHaveBeenCalled();
    expect(getAllBackgroundedProcessIds()).toContain(
      "agent:session:item:background-call",
    );
    expect(getAllBackgroundedProcessIds()).not.toContain("background-call");

    child.close(0);
    expect(getAllBackgroundedProcessIds()).not.toContain(
      "agent:session:item:background-call",
    );
  });
});

function fakeBackend(
  child: ChildProcess,
  capturedOptions: SpawnOptions[] = [],
  onSpawn?: () => void,
): ExecutionBackend {
  return {
    kind: "host",
    enforceSensitivePathChecks: false,
    wrapFetch: (fetch) => fetch,
    resolveExistingPath: async () => null,
    resolveWritablePath: async () => {
      throw new Error("unused");
    },
    readFile: async () => "",
    readFileRange: async () => "",
    fileExists: async () => false,
    writeFile: async () => undefined,
    listDirectory: async () => [],
    resolveWorkingDirectory: async () => process.cwd(),
    isLocalShell: async () => true,
    spawnShell: (_command, options) => {
      capturedOptions.push(options);
      onSpawn?.();
      return child;
    },
    runShell: async () => undefined,
  };
}

function fakeChild(): {
  process: ChildProcess;
  close: (code: number) => void;
  unref: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const unref = vi.fn(() => emitter as ChildProcess);

  Object.assign(emitter, {
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    killed: false,
    pid: 12345,
    unref,
    kill: vi.fn(() => true),
  });

  return {
    process: emitter as ChildProcess,
    unref,
    close(code: number) {
      (emitter as { exitCode: number | null }).exitCode = code;
      emitter.emit("close", code, null);
    },
  };
}
