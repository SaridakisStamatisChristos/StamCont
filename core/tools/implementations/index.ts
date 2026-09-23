import { ContextItem, ToolExtras } from "../..";
import type { ExecutionBackend } from "../../agent/execution";

export type ToolExecutionExtras = ToolExtras & {
  executionBackend?: ExecutionBackend;
  executionSignal?: AbortSignal;
  strictProcessFailures?: boolean;
  managedBackgroundJobs?: boolean;
};

export type ToolImpl = (
  parameters: any,
  extras: ToolExecutionExtras,
) => Promise<ContextItem[]>;
