import { ContinueError, ContinueErrorReason } from "core/util/errors";

import type { ClientToolExtras } from "./callClientTool";

export async function resolveClientToolExistingPath(
  filepath: string,
  extras: ClientToolExtras,
): Promise<string> {
  if (!filepath || typeof filepath !== "string") {
    throw new ContinueError(
      ContinueErrorReason.FindAndReplaceMissingFilepath,
      "filepath (string) is required",
    );
  }

  const executionProfile =
    extras.getState().session?.executionProfile ?? "interactive";
  const result = await extras.ideMessenger.request("tools/resolvePath", {
    filepath,
    executionProfile,
  });

  if (result.status === "error") {
    throw new ContinueError(
      ContinueErrorReason.FileNotFound,
      result.error,
    );
  }

  const uri = result.content.uri;
  if (!uri) {
    throw new ContinueError(
      ContinueErrorReason.FileNotFound,
      `File ${filepath} does not exist or is not accessible`,
    );
  }

  return uri;
}
