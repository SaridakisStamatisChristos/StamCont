import { CompletionOptions } from "../..";
import { AutocompleteLanguageInfo } from "../constants/AutocompleteLanguageInfo";

// TODO: Do we want to stop completions when reaching a `/src/` string?
const SRC_DIRECTORY = "/src/";
// Starcoder2 tends to output artifacts starting with the letter "t"
const STARCODER2_T_ARTIFACTS = ["t.", "\nt", "<file_sep>"];
const PYTHON_ENCODING = "#- coding: utf-8";
const CODE_BLOCK_END = "```";

const commonStops = [SRC_DIRECTORY, PYTHON_ENCODING, CODE_BLOCK_END];

export function getStopTokens(
  completionOptions: Partial<CompletionOptions> | undefined,
  lang: AutocompleteLanguageInfo,
  model: string,
): string[] {
  const stopTokens = [
    ...(completionOptions?.stop || []),
    ...commonStops,
    ...(model.toLowerCase().includes("starcoder2")
      ? STARCODER2_T_ARTIFACTS
      : []),
    // ...lang.topLevelKeywords.map((word) => `\n${word}`),
  ];

  return stopTokens;
}
