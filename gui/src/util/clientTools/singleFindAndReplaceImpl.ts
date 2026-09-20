import { validateSingleEdit } from "core/edit/searchAndReplace/findAndReplaceUtils";
import { executeFindAndReplace } from "core/edit/searchAndReplace/performReplace";
import { ContinueError, ContinueErrorReason } from "core/util/errors";
import { v4 as uuid } from "uuid";

import { applyForEditTool } from "../../redux/thunks/handleApplyStateUpdate";

import { ClientToolImpl } from "./callClientTool";
import { resolveClientToolExistingPath } from "./resolveClientToolPath";

export const singleFindAndReplaceImpl: ClientToolImpl = async (
  args,
  toolCallId,
  extras,
) => {
  if (!args.filepath || typeof args.filepath !== "string") {
    throw new ContinueError(
      ContinueErrorReason.FindAndReplaceMissingFilepath,
      "filepath (string) is required",
    );
  }

  // Note that this is fully duplicate of what occurs in args preprocessing
  // This is to handle cases where file changes while tool call is pending
  const { oldString, newString, replaceAll } = validateSingleEdit(
    args.old_string,
    args.new_string,
    args.replace_all,
  );
  const fileUri = await resolveClientToolExistingPath(
    args.filepath,
    extras,
  );

  const editingFileContents = await extras.ideMessenger.ide.readFile(fileUri);
  const newFileContents = executeFindAndReplace(
    editingFileContents,
    oldString,
    newString,
    replaceAll ?? false,
    0,
  );

  // Apply the changes to the file
  const streamId = uuid();
  void extras.dispatch(
    applyForEditTool({
      streamId,
      toolCallId,
      text: newFileContents,
      filepath: fileUri,
      isSearchAndReplace: true,
    }),
  );

  // Return success - applyToFile will handle the completion state
  return {
    respondImmediately: false, // Let apply state handle completion
    output: undefined,
  };
};
