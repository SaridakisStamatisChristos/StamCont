import {
  emitAgentDiagnostic,
  type AgentDiagnosticContext,
  type AgentDiagnosticsSink,
} from "./diagnostics";
import { AgentLifecycleError } from "./lifecycle";
import { AgentPersistenceError } from "./persistence";

export type AgentCompatibilityFailureCode =
  | "unsupported_persistence_schema"
  | "unsupported_lifecycle_schema";

export function getAgentCompatibilityFailureCode(
  error: unknown,
): AgentCompatibilityFailureCode | undefined {
  if (
    error instanceof AgentPersistenceError &&
    error.code === "unsupported_schema"
  ) {
    return "unsupported_persistence_schema";
  }
  if (
    error instanceof AgentLifecycleError &&
    error.code === "unsupported_lifecycle_schema"
  ) {
    return "unsupported_lifecycle_schema";
  }
  return undefined;
}

export async function emitAgentCompatibilityFailureDiagnostic(
  sink: AgentDiagnosticsSink | undefined,
  context: AgentDiagnosticContext,
  error: unknown,
): Promise<void> {
  const code = getAgentCompatibilityFailureCode(error);
  if (!code) return;
  await emitAgentDiagnostic(sink, {
    type: "failure",
    timestamp: Date.now(),
    ...context,
    details: {
      category: "compatibility",
      code,
    },
  });
}
