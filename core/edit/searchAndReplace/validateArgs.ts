import { IDE } from "../..";
import { SandboxExecutionBackend } from "../../agent/sandbox";
import { ContinueError, ContinueErrorReason } from "../../util/errors";
import { resolveRelativePathInDir } from "../../util/ideUtils";
import { resolveInputPath } from "../../util/pathResolver";

export async function validateSearchAndReplaceFilepath(
  filepath: unknown,
  ide: IDE,
  allowOutsideWorkspace = false,
  strictWorkspace = false,
) {
  if (!filepath || typeof filepath !== "string") {
    throw new ContinueError(
      ContinueErrorReason.FindAndReplaceMissingFilepath,
      "filepath (string) is required",
    );
  }
  const resolvedFilepath = allowOutsideWorkspace
    ? await resolveInputPath(ide, filepath)
    : strictWorkspace
      ? await new SandboxExecutionBackend(ide).resolveExistingPath(filepath)
      : await resolveRelativePathInDir(filepath, ide);
  const resolvedUri =
    typeof resolvedFilepath === "string"
      ? resolvedFilepath
      : resolvedFilepath?.uri;
  const exists =
    typeof resolvedFilepath === "string"
      ? true
      : resolvedUri
        ? await ide.fileExists(resolvedUri)
        : false;
  if (!resolvedUri || !exists) {
    throw new ContinueError(
      ContinueErrorReason.FileNotFound,
      `File ${filepath} does not exist`,
    );
  }
  return resolvedUri;
}
