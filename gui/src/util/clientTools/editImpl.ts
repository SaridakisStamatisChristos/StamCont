import { v4 as uuid } from "uuid";

import { applyForEditTool } from "../../redux/thunks/handleApplyStateUpdate";

import { ClientToolImpl } from "./callClientTool";
import { resolveClientToolExistingPath } from "./resolveClientToolPath";

export const editToolImpl: ClientToolImpl = async (
  args,
  toolCallId,
  extras,
) => {
  if (!args.filepath || !args.changes) {
    throw new Error(
      "`filepath` and `changes` arguments are required to edit an existing file.",
    );
  }
  let filepath = args.filepath;
  if (filepath.startsWith("./")) {
    filepath = filepath.slice(2);
  }

  const firstUriMatch = await resolveClientToolExistingPath(
    filepath,
    extras,
  );

  const streamId = uuid();
  void extras.dispatch(
    applyForEditTool({
      streamId,
      text: args.changes,
      toolCallId,
      filepath: firstUriMatch,
    }),
  );

  return {
    respondImmediately: false,
    output: undefined, // no immediate output - output for edit tools should be added based on apply state coming in
  };
};
