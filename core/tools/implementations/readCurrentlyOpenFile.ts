import { getUriDescription } from "../../util/uri";
import { getExecutionBackend } from "../../agent/execution";

import { ToolImpl } from ".";
import { throwIfFileIsSecurityConcern } from "../../indexing/ignore";
import { throwIfFileExceedsHalfOfContext } from "./readFileLimit";

export const readCurrentlyOpenFileImpl: ToolImpl = async (_, extras) => {
  const result = await extras.ide.getCurrentFile();

  if (result) {
    const backend = getExecutionBackend(extras);
    if (backend.kind === "sandbox") {
      const resolved = await backend.resolveExistingPath(result.path);
      if (!resolved) {
        throw new Error("Current file is not accessible inside the workspace sandbox");
      }
    }
    throwIfFileIsSecurityConcern(result.path);
    await throwIfFileExceedsHalfOfContext(
      result.path,
      result.contents,
      extras.config.selectedModelByRole.chat,
    );

    const { relativePathOrBasename, last2Parts, baseName } = getUriDescription(
      result.path,
      await extras.ide.getWorkspaceDirs(),
    );

    return [
      {
        name: `Current file: ${baseName}`,
        description: last2Parts,
        content: `\`\`\`${relativePathOrBasename}\n${result.contents}\n\`\`\``,
        uri: {
          type: "file",
          value: result.path,
        },
      },
    ];
  } else {
    return [
      {
        name: `No Current File`,
        description: "",
        content: "There are no files currently open.",
      },
    ];
  }
};
