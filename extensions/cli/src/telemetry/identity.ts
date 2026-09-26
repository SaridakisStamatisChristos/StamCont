import {
  readIdentityEnv,
  type EnvironmentSource,
} from "../env.js";

// These emitted identifiers intentionally remain legacy-compatible in PR19.
// Changing them would split/break existing OpenTelemetry dashboards and alerts.
export const TELEMETRY_SERVICE_NAME = "continue-cli";
export const TELEMETRY_METRIC_PREFIX = "continue_cli";
export const TELEMETRY_REMOTE_ATTRIBUTE = "is_continue_remote_agent";

export function resolveTelemetryPreference(
  source: EnvironmentSource = process.env,
): boolean {
  const metricsEnabled = readIdentityEnv(
    source,
    "STAMCONT_METRICS_ENABLED",
    "CONTINUE_METRICS_ENABLED",
  );

  if (metricsEnabled === "0") {
    return false;
  }
  if (metricsEnabled === "1") {
    return true;
  }

  return (
    readIdentityEnv(
      source,
      "STAMCONT_CLI_ENABLE_TELEMETRY",
      "CONTINUE_CLI_ENABLE_TELEMETRY",
    ) !== "0"
  );
}
