import { getExecutionBackend } from "../../agent/execution";
import { getUriPathBasename } from "../../util/uri";

import { ToolImpl } from ".";
import { throwIfFileIsSecurityConcern } from "../../indexing/ignore";
import { getStringArg } from "../parseArgs";
import { throwIfFileExceedsHalfOfContext } from "./readFileLimit";
import { ContinueError, ContinueErrorReason } from "../../util/errors";

export const readFileImpl: ToolImpl = async (args, extras) => {
  const filepath = getStringArg(args, "filepath");

  const backend = getExecutionBackend(extras);
  const resolvedPath = await backend.resolveExistingPath(filepath);
  if (!resolvedPath) {
    throw new ContinueError(
      ContinueErrorReason.FileNotFound,
      `File "${filepath}" does not exist or is not accessible. You might want to check the path and try again.`,
    );
  }

  if (backend.enforceSensitivePathChecks) {
    throwIfFileIsSecurityConcern(resolvedPath.displayPath);
  }

  const content = await backend.readFile(resolvedPath);

  await throwIfFileExceedsHalfOfContext(
    resolvedPath.displayPath,
    content,
    extras.config.selectedModelByRole.chat,
  );

  return [
    {
      name: getUriPathBasename(resolvedPath.uri),
      description: resolvedPath.displayPath,
      content,
      uri: {
        type: "file",
        value: resolvedPath.uri,
      },
    },
  ];
};
