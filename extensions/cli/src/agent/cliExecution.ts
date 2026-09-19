import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { IDE } from "core/index.js";
import {
  createExecutionBackend,
  type ExecutionBackend,
} from "core/agent/execution.js";
import type { BuiltInExecutionProfileId } from "core/agent/capabilities.js";

import type { PermissionMode } from "../permissions/types.js";

export function permissionModeToExecutionProfile(
  mode: PermissionMode,
): BuiltInExecutionProfileId {
  switch (mode) {
    case "plan":
      return "plan";
    case "auto":
      return "full_access";
    case "normal":
    default:
      return "interactive";
  }
}

function createCliIde(workspaceRoot: string): IDE {
  return {
    getWorkspaceDirs: async () => [pathToFileURL(workspaceRoot).href],
    getIdeInfo: async () => ({
      ideType: "vscode",
      name: "stamcont-cli",
      version: "cli",
      remoteName: "local",
      extensionVersion: "cli",
      isPrerelease: false,
    }),
    fileExists: async (uri: string) => {
      try {
        await fs.access(new URL(uri));
        return true;
      } catch {
        return false;
      }
    },
  } as unknown as IDE;
}

export function createCliExecutionBackend(
  mode: PermissionMode,
  workspaceRoot = process.cwd(),
): ExecutionBackend {
  return createExecutionBackend(
    permissionModeToExecutionProfile(mode),
    createCliIde(path.resolve(workspaceRoot)),
  );
}

async function resolveExisting(
  backend: ExecutionBackend,
  input: string,
): Promise<string> {
  const resolved = await backend.resolveExistingPath(input);
  if (!resolved) {
    throw new Error(`Path does not exist or is not accessible: ${input}`);
  }
  return resolved.displayPath;
}

export async function prepareCliToolArgs(
  toolName: string,
  args: Record<string, any>,
  mode: PermissionMode,
  workspaceRoot = process.cwd(),
): Promise<{
  args: Record<string, any>;
  backend: ExecutionBackend;
}> {
  const backend = createCliExecutionBackend(mode, workspaceRoot);
  const prepared = { ...args };

  switch (toolName) {
    case "Read":
    case "Write": {
      if (typeof prepared.filepath === "string") {
        prepared.filepath =
          toolName === "Write"
            ? (await backend.resolveWritablePath(prepared.filepath)).displayPath
            : await resolveExisting(backend, prepared.filepath);
      }
      break;
    }
    case "Edit":
    case "MultiEdit": {
      if (typeof prepared.file_path === "string") {
        prepared.file_path = await resolveExisting(
          backend,
          prepared.file_path,
        );
      }
      break;
    }
    case "List": {
      if (typeof prepared.dirpath === "string") {
        prepared.dirpath = await resolveExisting(backend, prepared.dirpath);
      }
      break;
    }
    case "Search": {
      prepared.path = await resolveExisting(
        backend,
        typeof prepared.path === "string" ? prepared.path : ".",
      );
      break;
    }
    default:
      break;
  }

  return { args: prepared, backend };
}
