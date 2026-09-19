import generateRepoMap from "../../util/generateRepoMap";
import { getExecutionBackend } from "../../agent/execution";

import { ToolImpl } from ".";
import { ContinueError, ContinueErrorReason } from "../../util/errors";
import { getStringArg } from "../parseArgs";

export const viewSubdirectoryImpl: ToolImpl = async (args: any, extras) => {
  const directory_path = getStringArg(args, "directory_path");

  const backend = getExecutionBackend(extras);
  const resolvedPath = await backend.resolveExistingPath(directory_path);

  if (!resolvedPath) {
    throw new ContinueError(
      ContinueErrorReason.DirectoryNotFound,
      `Directory path "${directory_path}" does not exist or is not accessible.`,
    );
  }

  if (!(await backend.fileExists(resolvedPath))) {
    throw new ContinueError(
      ContinueErrorReason.DirectoryNotFound,
      `Directory path "${directory_path}" does not exist or is not accessible.`,
    );
  }

  const repoMap = await generateRepoMap(extras.llm, extras.ide, {
    dirUris: [resolvedPath.uri],
    outputRelativeUriPaths: true,
    includeSignatures: false,
  });

  return [
    {
      name: "Repo map",
      description: `Map of ${resolvedPath.displayPath}`,
      content: repoMap,
    },
  ];
};
