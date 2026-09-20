import { type ExecutionProfileId, ToolCallState } from "core";
import {
  BuiltInToolNames,
  CLIENT_TOOLS_IMPLS,
} from "core/tools/builtIn";
import { ContinueErrorReason } from "core/util/errors";

import { IIdeMessenger } from "../../context/IdeMessenger";
import {
  errorToolCall,
  setProcessedToolCallArgs,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { AppThunkDispatch } from "../store";

export async function preprocessToolCalls(
  dispatch: AppThunkDispatch,
  ideMessenger: IIdeMessenger,
  generatedToolCalls: ToolCallState[],
  executionProfile: ExecutionProfileId = "interactive",
): Promise<void> {
  // Tool call pre-processing
  await Promise.all(
    generatedToolCalls.map(async (tcState) => {
      const toolName = tcState.toolCall.function.name;
      const isClientTool = CLIENT_TOOLS_IMPLS.some(
        (clientToolName) => clientToolName === toolName,
      );
      const interactivePreprocessWouldReadFile =
        toolName === BuiltInToolNames.SingleFindAndReplace ||
        toolName === BuiltInToolNames.MultiEdit;

      if (
        (executionProfile === "full_access" && isClientTool) ||
        (executionProfile === "interactive" &&
          interactivePreprocessWouldReadFile)
      ) {
        // Full Access client edits resolve host paths only at execution time.
        // In Interactive, skip only preprocessors that read file contents via
        // the legacy IDE path resolver; execution then performs canonical
        // sandbox validation. edit_existing_file has no preprocess hook, so
        // preserving its legacy async round-trip is safe and keeps UI ordering.
        return;
      }

      let errorReason: ContinueErrorReason | undefined = undefined;
      let errorMessage: string | undefined = undefined;
      let preprocessedArgs: Record<string, unknown> | undefined = undefined;
      const result = await ideMessenger.request("tools/preprocessArgs", {
        toolName: tcState.toolCall.function.name,
        args: tcState.parsedArgs,
      });
      if (result.status === "success") {
        preprocessedArgs = result.content.preprocessedArgs;
        errorMessage = result.content.errorMessage;
        errorReason = result.content.errorReason;
      } else {
        errorMessage = result.error;
        errorReason = ContinueErrorReason.Unknown;
      }
      if (errorReason) {
        dispatch(
          errorToolCall({
            toolCallId: tcState.toolCallId,
          }),
        );
        dispatch(
          updateToolCallOutput({
            toolCallId: tcState.toolCallId,
            contextItems: [
              {
                icon: "problems",
                name: "Invalid Tool Call",
                description: "",
                content: `${tcState.toolCall.function.name} failed because the arguments were invalid, with the following message: ${errorMessage}\n\nPlease try something else or request further instructions.`,
                hidden: false,
              },
            ],
          }),
        );
      } else if (preprocessedArgs) {
        dispatch(
          setProcessedToolCallArgs({
            toolCallId: tcState.toolCallId,
            newArgs: preprocessedArgs,
          }),
        );
      }
    }),
  );
}
