import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ModelConfig } from "@continuedev/config-yaml";
import type {
  ContinueConfig,
  IDE,
  ILLM,
  LLMOptions,
  Tool,
} from "core/index.js";
import {
  ContinueAgentModelDriver,
  CoreAgentToolExecutor,
  type BuiltInExecutionProfileId,
  type CoreAgentToolApprovalHandler,
} from "core/agent/index.js";
import { llmFromProviderAndOptions } from "core/llm/llms/index.js";
import { getBaseToolDefinitions } from "core/tools/index.js";

const execFileAsync = promisify(execFile);

export interface CliCoreAgentRuntime {
  readonly llm: ILLM;
  readonly driver: ContinueAgentModelDriver;
  readonly toolExecutor: CoreAgentToolExecutor;
  readonly tools: readonly Tool[];
}

export function createCliCoreAgentRuntime(options: {
  readonly model: ModelConfig;
  readonly sessionId: string;
  readonly profile: BuiltInExecutionProfileId;
  readonly workspaceRoot?: string;
  readonly approve?: CoreAgentToolApprovalHandler;
}): CliCoreAgentRuntime {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const llm = createCliCoreLlm(options.model);
  const ide = createCliCoreIde(workspaceRoot);
  const tools = getBaseToolDefinitions();
  const config = createMinimalCliContinueConfig(llm, tools);

  const driver = new ContinueAgentModelDriver(llm);
  const toolExecutor = new CoreAgentToolExecutor({
    tools,
    extras: {
      ide,
      llm,
      fetch: globalThis.fetch as any,
      config,
    },
    sessionId: options.sessionId,
    profile: options.profile,
    approve: options.approve,
  });

  return {
    llm,
    driver,
    toolExecutor,
    tools,
  };
}

export function createCliCoreLlm(model: ModelConfig): ILLM {
  const llmOptions: LLMOptions = {
    ...(model as unknown as LLMOptions),
    model: model.model,
    title: model.name ?? model.model,
    completionOptions: {
      ...(model.completionOptions ?? {}),
      model: model.model,
    },
  };
  return llmFromProviderAndOptions(model.provider, llmOptions);
}

function createMinimalCliContinueConfig(
  llm: ILLM,
  tools: readonly Tool[],
): ContinueConfig {
  return {
    modelsByRole: {
      chat: [llm],
      edit: [],
      apply: [],
      summarize: [llm],
      autocomplete: [],
      embed: [],
      rerank: [],
      subagent: [],
    },
    selectedModelByRole: {
      chat: llm,
      edit: null,
      apply: null,
      summarize: llm,
      autocomplete: null,
      embed: null,
      rerank: null,
      subagent: null,
    },
    tools: [...tools],
    rules: [],
  } as unknown as ContinueConfig;
}

function createCliCoreIde(workspaceRoot: string): IDE {
  const toPath = (value: string) =>
    value.startsWith("file:")
      ? fileURLToPath(value)
      : path.resolve(workspaceRoot, value);

  const readText = (value: string) => fs.readFile(toPath(value), "utf8");

  return {
    getWorkspaceDirs: async () => [pathToFileURL(workspaceRoot).href],
    getIdeInfo: async () => ({
      ideType: "vscode",
      name: "stamcont-cli-agent",
      version: "cli",
      remoteName: "local",
      extensionVersion: "cli",
      isPrerelease: false,
    }),
    fileExists: async (value: string) => {
      try {
        await fs.access(toPath(value));
        return true;
      } catch {
        return false;
      }
    },
    readFile: readText,
    readRangeInFile: async (value: string, range: any) => {
      const lines = (await readText(value)).split(/\r?\n/);
      return lines
        .slice(range.start.line, range.end.line + 1)
        .join("\n");
    },
    writeFile: async (value: string, contents: string) => {
      const target = toPath(value);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, "utf8");
    },
    openFile: async () => undefined,
    saveFile: async () => undefined,
    getCurrentFile: async () => undefined,
    getOpenFiles: async () => [],
    getPinnedFiles: async () => [],
    getFileResults: async (pattern: string, maxResults?: number) => {
      const { glob } = await import("glob");
      const results = await glob(pattern, {
        cwd: workspaceRoot,
        dot: false,
        nodir: false,
      });
      return results.slice(0, maxResults ?? 100);
    },
    getDiff: async (includeUnstaged: boolean) => {
      const diffs: string[] = [];
      const run = async (args: string[]) => {
        try {
          const { stdout } = await execFileAsync("git", args, {
            cwd: workspaceRoot,
            maxBuffer: 8 * 1024 * 1024,
          });
          if (stdout.trim()) {
            diffs.push(stdout);
          }
        } catch {
          // A non-git workspace simply has no diff to display.
        }
      };
      if (includeUnstaged) {
        await run(["diff", "--no-ext-diff"]);
      }
      await run(["diff", "--cached", "--no-ext-diff"]);
      return diffs;
    },
    runCommand: async (command: string) => {
      await execFileAsync(
        process.platform === "win32"
          ? process.env.COMSPEC || "cmd.exe"
          : process.env.SHELL || "/bin/sh",
        process.platform === "win32"
          ? ["/d", "/s", "/c", command]
          : ["-lc", command],
        {
          cwd: workspaceRoot,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
    },
  } as unknown as IDE;
}
