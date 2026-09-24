import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { ModelConfig } from "@continuedev/config-yaml";
import {
  ContinueAgentModelDriver,
  type ContinueAgentLlm,
} from "core/agent/adapters/continueModel.js";
import {
  CoreAgentToolExecutor,
  type CoreAgentToolApprovalHandler,
} from "core/agent/adapters/coreToolRuntime.js";
import type { BuiltInExecutionProfileId } from "core/agent/capabilities.js";
import type {
  ContinueConfig,
  FetchFunction,
  IDE,
  ILLM,
  LLMOptions,
  Tool,
} from "core/index.js";
import { llmFromProviderAndOptions } from "core/llm/llms/index.js";
import { getBaseToolDefinitions } from "core/tools/index.js";

const execFileAsync = promisify(execFile);

type CliCoreLlm = ILLM & ContinueAgentLlm;

export interface CliCoreAgentRuntime {
  readonly llm: CliCoreLlm;
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
  const fetch: FetchFunction = (url, init) => globalThis.fetch(url, init);

  const driver = new ContinueAgentModelDriver(llm);
  const toolExecutor = new CoreAgentToolExecutor({
    tools,
    extras: {
      ide,
      llm,
      fetch,
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

export function createCliCoreLlm(model: ModelConfig): CliCoreLlm {
  const capabilities = new Set(model.capabilities ?? []);
  const llmOptions: LLMOptions = {
    ...model,
    model: model.model,
    title: model.name ?? model.model,
    contextLength: model.contextLength,
    apiKey: model.apiKey,
    apiBase: model.apiBase,
    requestOptions: model.requestOptions,
    cacheBehavior: model.cacheBehavior,
    useLegacyCompletionsEndpoint: model.useLegacyCompletionsEndpoint,
    useResponsesApi: model.useResponsesApi,
    baseAgentSystemMessage: model.chatOptions?.baseAgentSystemMessage,
    basePlanSystemMessage: model.chatOptions?.basePlanSystemMessage,
    baseChatSystemMessage: model.chatOptions?.baseSystemMessage,
    capabilities:
      model.capabilities === undefined
        ? {}
        : {
            tools: capabilities.has("tool_use"),
            uploadImage: capabilities.has("image_input"),
            nextEdit: capabilities.has("next_edit"),
          },
    completionOptions: {
      ...(model.defaultCompletionOptions ?? {}),
      model: model.model,
    },
  };
  const llm = llmFromProviderAndOptions(model.provider, llmOptions);
  if (!llm.capabilities) {
    throw new Error(
      "Canonical agent model construction requires a capabilities object",
    );
  }
  return llm as CliCoreLlm;
}

function createMinimalCliContinueConfig(
  llm: ILLM,
  tools: readonly Tool[],
): ContinueConfig {
  const config: ContinueConfig = {
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
  };
  return config;
}

function createCliCoreIde(workspaceRoot: string): IDE {
  const toPath = (value: string) =>
    value.startsWith("file:")
      ? fileURLToPath(value)
      : path.resolve(workspaceRoot, value);

  const readText = (value: string) => fs.readFile(toPath(value), "utf8");
  const unsupported = (method: string): never => {
    throw new Error(
      `CLI agent IDE adapter does not support "${method}"`,
    );
  };

  const ide: IDE = {
    getIdeInfo: async () => ({
      ideType: "vscode",
      name: "stamcont-cli-agent",
      version: "cli",
      remoteName: "local",
      extensionVersion: "cli",
      isPrerelease: false,
    }),
    getIdeSettings: async () => unsupported("getIdeSettings"),
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
    getClipboardContent: async () => unsupported("getClipboardContent"),
    isTelemetryEnabled: async () => false,
    isWorkspaceRemote: async () => false,
    getUniqueId: async () => "stamcont-cli-agent",
    getTerminalContents: async () => unsupported("getTerminalContents"),
    getDebugLocals: async () => unsupported("getDebugLocals"),
    getTopLevelCallStackSources: async () =>
      unsupported("getTopLevelCallStackSources"),
    getAvailableThreads: async () => unsupported("getAvailableThreads"),
    getWorkspaceDirs: async () => [pathToFileURL(workspaceRoot).href],
    fileExists: async (value: string) => {
      try {
        await fs.access(toPath(value));
        return true;
      } catch {
        return false;
      }
    },
    writeFile: async (value: string, contents: string) => {
      const target = toPath(value);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, "utf8");
    },
    removeFile: async (value: string) => {
      await fs.rm(toPath(value), { force: true });
    },
    showVirtualFile: async () => unsupported("showVirtualFile"),
    openFile: async () => undefined,
    openUrl: async () => unsupported("openUrl"),
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
    saveFile: async () => undefined,
    readFile: readText,
    readRangeInFile: async (value: string, range) => {
      const lines = (await readText(value)).split(/\r?\n/);
      return lines
        .slice(range.start.line, range.end.line + 1)
        .join("\n");
    },
    showLines: async () => unsupported("showLines"),
    getOpenFiles: async () => [],
    getCurrentFile: async () => undefined,
    getPinnedFiles: async () => [],
    getSearchResults: async () => unsupported("getSearchResults"),
    getFileResults: async (pattern: string, maxResults?: number) => {
      const { glob } = await import("glob");
      const results = await glob(pattern, {
        cwd: workspaceRoot,
        dot: false,
        nodir: false,
      });
      return results.slice(0, maxResults ?? 100);
    },
    subprocess: async () => unsupported("subprocess"),
    getProblems: async () => unsupported("getProblems"),
    getBranch: async () => unsupported("getBranch"),
    getTags: async () => unsupported("getTags"),
    getRepoName: async () => unsupported("getRepoName"),
    showToast: async () => unsupported("showToast"),
    getGitRootPath: async () => unsupported("getGitRootPath"),
    listDir: async () => unsupported("listDir"),
    getFileStats: async () => unsupported("getFileStats"),
    readSecrets: async () => unsupported("readSecrets"),
    writeSecrets: async () => unsupported("writeSecrets"),
    gotoDefinition: async () => unsupported("gotoDefinition"),
    gotoTypeDefinition: async () => unsupported("gotoTypeDefinition"),
    getSignatureHelp: async () => unsupported("getSignatureHelp"),
    getReferences: async () => unsupported("getReferences"),
    getDocumentSymbols: async () => unsupported("getDocumentSymbols"),
    onDidChangeActiveTextEditor: () => undefined,
  };

  return ide;
}
