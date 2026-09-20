import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as util from "node:util";

import { ContinueError, ContinueErrorReason } from "core/util/errors.js";

import { parseEnvNumber } from "../util/truncateOutput.js";

import { Tool } from "./types.js";

const execFilePromise = util.promisify(childProcess.execFile);
const SEARCH_MAX_BUFFER = 10 * 1024 * 1024;

async function getGitignorePatterns(searchPath: string): Promise<string[]> {
  const gitIgnorePath = path.join(searchPath, ".gitignore");
  if (!fs.existsSync(gitIgnorePath)) {
    return [];
  }

  const content = fs.readFileSync(gitIgnorePath, "utf-8");
  const ignorePatterns: string[] = [];
  for (let line of content.trim().split("\n")) {
    line = line.trim();
    if (line.startsWith("#") || line === "" || line.startsWith("!")) {
      continue;
    }
    ignorePatterns.push(line);
  }
  return ignorePatterns;
}

// Procedure 1: search with ripgrep. execFile is intentional: model-supplied
// patterns and file globs are arguments, never shell syntax.
export async function checkIfRipgrepIsInstalled(): Promise<boolean> {
  try {
    await execFilePromise("rg", ["--version"], {
      maxBuffer: SEARCH_MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

async function searchWithRipgrep(
  pattern: string,
  searchPath: string,
  filePattern?: string,
) {
  const args = [
    "--line-number",
    "--with-filename",
    "--color",
    "never",
  ];

  if (filePattern) {
    args.push("-g", filePattern);
  }

  const ignorePatterns = await getGitignorePatterns(searchPath);
  for (const ignorePattern of ignorePatterns) {
    args.push("-g", `!${ignorePattern}`);
  }

  args.push("--", pattern, ".");
  return execFilePromise("rg", args, {
    cwd: searchPath,
    maxBuffer: SEARCH_MAX_BUFFER,
  });
}

// Procedure 2: fallback without a shell. This avoids turning a supposedly
// read-only Search tool into arbitrary command execution via interpolation.
async function searchWithGrepOrFindstr(
  pattern: string,
  searchPath: string,
  filePattern?: string,
) {
  const ignorePatterns = await getGitignorePatterns(searchPath);

  if (process.platform === "win32") {
    const fileSpec = filePattern || "*";
    return execFilePromise(
      "findstr",
      ["/S", "/N", "/P", "/R", pattern, fileSpec],
      {
        cwd: searchPath,
        maxBuffer: SEARCH_MAX_BUFFER,
      },
    );
  }

  const args = ["-R", "-n", "-H", "-I"];
  for (const ignorePattern of ignorePatterns) {
    args.push(`--exclude=${ignorePattern}`, `--exclude-dir=${ignorePattern}`);
  }
  if (filePattern) {
    args.push(`--include=${filePattern}`);
  }
  args.push("--", pattern, ".");

  return execFilePromise("grep", args, {
    cwd: searchPath,
    maxBuffer: SEARCH_MAX_BUFFER,
  });
}

// Output truncation defaults
const DEFAULT_SEARCH_MAX_RESULTS = 100;
const DEFAULT_SEARCH_MAX_RESULT_CHARS = 1000;

function getSearchMaxResults(): number {
  return parseEnvNumber(
    process.env.CONTINUE_CLI_SEARCH_CODE_MAX_RESULTS,
    DEFAULT_SEARCH_MAX_RESULTS,
  );
}

function getSearchMaxResultChars(): number {
  return parseEnvNumber(
    process.env.CONTINUE_CLI_SEARCH_CODE_MAX_RESULT_CHARS,
    DEFAULT_SEARCH_MAX_RESULT_CHARS,
  );
}

export const searchCodeTool: Tool = {
  name: "Search",
  displayName: "Search",
  description: "Search the codebase using ripgrep (rg) for a specific pattern",
  parameters: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: {
        type: "string",
        description: "The search pattern to look for",
      },
      path: {
        type: "string",
        description: "The path to search in (defaults to current directory)",
      },
      file_pattern: {
        type: "string",
        description: "Optional file pattern to filter results (e.g., '*.ts')",
      },
    },
  },
  readonly: true,
  isBuiltIn: true,
  preprocess: async (args) => {
    const truncatedPattern =
      args.pattern.length > 50
        ? args.pattern.substring(0, 50) + "..."
        : args.pattern;
    return {
      args,
      preview: [
        {
          type: "text",
          content: `Will search for: "${truncatedPattern}"`,
        },
      ],
    };
  },
  run: async (args: {
    pattern: string;
    path?: string;
    file_pattern?: string;
  }): Promise<string> => {
    const searchPath = args.path || process.cwd();
    if (!fs.existsSync(searchPath)) {
      throw new ContinueError(
        ContinueErrorReason.Unspecified,
        `Path does not exist: ${searchPath}`,
      );
    }
    if (!fs.statSync(searchPath).isDirectory()) {
      throw new ContinueError(
        ContinueErrorReason.Unspecified,
        `Search path is not a directory: ${searchPath}`,
      );
    }

    let stdout = "";
    let stderr = "";
    try {
      const results = (await checkIfRipgrepIsInstalled())
        ? await searchWithRipgrep(
            args.pattern,
            searchPath,
            args.file_pattern,
          )
        : await searchWithGrepOrFindstr(
            args.pattern,
            searchPath,
            args.file_pattern,
          );
      stdout = results.stdout;
      stderr = results.stderr;

      if (stderr) {
        return `Warning during search: ${stderr}\n\n${stdout}`;
      }

      if (!stdout.trim()) {
        return `No matches found for pattern "${args.pattern}"${
          args.file_pattern ? ` in files matching "${args.file_pattern}"` : ""
        }.`;
      }

      const maxResults = getSearchMaxResults();
      const maxResultChars = getSearchMaxResultChars();

      const splitLines = stdout.split("\n");
      const lines = splitLines.filter((line) => line.length <= maxResultChars);
      if (lines.length === 0) {
        return `No matches found for pattern "${args.pattern}"${
          args.file_pattern ? ` in files matching "${args.file_pattern}"` : ""
        }.`;
      }
      const truncated = lines.length > maxResults;
      const limitedLines = lines.slice(0, maxResults);
      const resultText = limitedLines.join("\n");

      const truncationMessage = truncated
        ? `\n\n[Results truncated: showing ${maxResults} of ${lines.length} matches]`
        : "";

      return `Search results for pattern "${args.pattern}"${
        args.file_pattern ? ` in files matching "${args.file_pattern}"` : ""
      }:\n\n${resultText}${truncationMessage}`;
    } catch (error: any) {
      if (error instanceof ContinueError) {
        throw error;
      }
      if (error.code === 1) {
        return `No matches found for pattern "${args.pattern}"${
          args.file_pattern ? ` in files matching "${args.file_pattern}"` : ""
        }.`;
      }
      throw new Error(
        `Error executing search: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },
};
