import {
  emitAgentDiagnostic,
  type AgentDiagnosticContext,
  type AgentDiagnosticsSink,
} from "./diagnostics";
import { AgentLifecycleError } from "./lifecycle";
import { AgentLegacyHistoryMigrationError } from "./migration";
import { AgentPersistenceError } from "./persistence";

export type AgentCompatibilityFailureCode =
  | "unsupported_persistence_schema"
  | "unsupported_lifecycle_schema"
  | "legacy_history_incompatible";

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
  if (error instanceof AgentLegacyHistoryMigrationError) {
    return "legacy_history_incompatible";
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
