import { ToolImpl } from ".";
import { getExecutionBackend } from "../../agent/execution";
import { ContinueError, ContinueErrorReason } from "../../util/errors";

export function resolveLsToolDirPath(dirPath: string | undefined) {
  if (!dirPath || dirPath === ".") {
    return ".";
  }
  return dirPath.replace(/\\/g, "/");
}

const MAX_LS_TOOL_LINES = 200;

export const lsToolImpl: ToolImpl = async (args, extras) => {
  const dirPath = resolveLsToolDirPath(args?.dirPath);
  const backend = getExecutionBackend(extras);
  const resolvedPath = await backend.resolveExistingPath(dirPath);
  if (!resolvedPath) {
    throw new ContinueError(
      ContinueErrorReason.DirectoryNotFound,
      `Directory ${args.dirPath} not found or is not accessible. You can use absolute paths, relative paths, or paths starting with ~`,
    );
  }

  const entries = await backend.listDirectory(
    resolvedPath,
    args?.recursive ?? false,
    MAX_LS_TOOL_LINES + 1,
  );

  const lines = entries.slice(0, MAX_LS_TOOL_LINES);

  let content =
    lines.length > 0
      ? lines.join("\n")
      : `No files/folders found in ${resolvedPath.displayPath}`;

  const contextItems = [
    {
      name: "File/folder list",
      description: `Files/folders in ${resolvedPath.displayPath}`,
      content,
    },
  ];

  if (entries.length > MAX_LS_TOOL_LINES) {
    let warningContent = `${entries.length - MAX_LS_TOOL_LINES} ls entries were truncated`;
    if (args?.recursive) {
      warningContent += ". Try using a non-recursive search";
    }
    contextItems.push({
      name: "Truncation warning",
      description: "",
      content: warningContent,
    });
  }

  return contextItems;
};
