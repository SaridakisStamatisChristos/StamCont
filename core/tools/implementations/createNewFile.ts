import { getExecutionBackend } from "../../agent/execution";

import { ToolImpl } from ".";
import { throwIfFileIsSecurityConcern } from "../../indexing/ignore";
import { getCleanUriPath, getUriPathBasename } from "../../util/uri";
import { getStringArg } from "../parseArgs";
import { ContinueError, ContinueErrorReason } from "../../util/errors";

export const createNewFileImpl: ToolImpl = async (args, extras) => {
  const filepath = getStringArg(args, "filepath");
  const contents = getStringArg(args, "contents", true);

  const backend = getExecutionBackend(extras);
  const resolvedPath = await backend.resolveWritablePath(filepath);
  if (backend.enforceSensitivePathChecks) {
    throwIfFileIsSecurityConcern(getCleanUriPath(resolvedPath.uri));
  }
  if (await backend.fileExists(resolvedPath)) {
    throw new ContinueError(
      ContinueErrorReason.FileAlreadyExists,
      `File ${filepath} already exists. Use the edit tool to edit this file`,
    );
  }

  await backend.writeFile(resolvedPath, contents);
  await extras.ide.openFile(resolvedPath.uri).catch(() => undefined);
  await extras.ide.saveFile(resolvedPath.uri).catch(() => undefined);
  if (extras.codeBaseIndexer && resolvedPath.isWithinWorkspace) {
    void extras.codeBaseIndexer.refreshCodebaseIndexFiles([resolvedPath.uri]);
  }
  return [
    {
      name: getUriPathBasename(resolvedPath.uri),
      description: getCleanUriPath(resolvedPath.uri),
      content: "File created successfully",
      uri: {
        type: "file",
        value: resolvedPath.uri,
      },
    },
  ];
};
