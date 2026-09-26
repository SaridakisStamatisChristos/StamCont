import { describe, expect, it } from "vitest";

import {
  TELEMETRY_METRIC_PREFIX,
  TELEMETRY_REMOTE_ATTRIBUTE,
  TELEMETRY_SERVICE_NAME,
  resolveTelemetryPreference,
} from "./identity.js";

describe("telemetry identity migration", () => {
  it("keeps emitted telemetry identifiers compatible", () => {
    expect(TELEMETRY_SERVICE_NAME).toBe("continue-cli");
    expect(TELEMETRY_METRIC_PREFIX).toBe("continue_cli");
    expect(TELEMETRY_REMOTE_ATTRIBUTE).toBe("is_continue_remote_agent");
  });

  it("accepts StamCont metrics controls", () => {
    expect(resolveTelemetryPreference({ STAMCONT_METRICS_ENABLED: "0" })).toBe(
      false,
    );
    expect(resolveTelemetryPreference({ STAMCONT_METRICS_ENABLED: "1" })).toBe(
      true,
    );
  });

  it("keeps Continue-era metrics controls working", () => {
    expect(resolveTelemetryPreference({ CONTINUE_METRICS_ENABLED: "0" })).toBe(
      false,
    );
    expect(resolveTelemetryPreference({ CONTINUE_METRICS_ENABLED: "1" })).toBe(
      true,
    );
  });

  it("gives StamCont metrics controls precedence", () => {
    expect(
      resolveTelemetryPreference({
        STAMCONT_METRICS_ENABLED: "1",
        CONTINUE_METRICS_ENABLED: "0",
      }),
    ).toBe(true);
  });

  it("supports the CLI telemetry alias with StamCont precedence", () => {
    expect(
      resolveTelemetryPreference({
        STAMCONT_CLI_ENABLE_TELEMETRY: "0",
        CONTINUE_CLI_ENABLE_TELEMETRY: "1",
      }),
    ).toBe(false);
  });

  it("preserves the legacy default of enabled before exporter gating", () => {
    expect(resolveTelemetryPreference({})).toBe(true);
  });
});
