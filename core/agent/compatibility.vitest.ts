import { describe, expect, it } from "vitest";

import { AgentDiagnosticsBuffer } from "./diagnostics";
import { AgentLifecycleError } from "./lifecycle";
import { AgentPersistenceError } from "./persistence";
import {
  emitAgentCompatibilityFailureDiagnostic,
  getAgentCompatibilityFailureCode,
} from "./compatibility";

describe("agent compatibility diagnostics", () => {
  it("classifies supported compatibility failures only", () => {
    expect(
      getAgentCompatibilityFailureCode(
        new AgentPersistenceError(
          "unsupported_schema",
          "contains secret payload that must not be emitted",
        ),
      ),
    ).toBe("unsupported_persistence_schema");
    expect(
      getAgentCompatibilityFailureCode(
        new AgentLifecycleError(
          "unsupported_lifecycle_schema",
          "unsupported",
        ),
      ),
    ).toBe("unsupported_lifecycle_schema");
    expect(
      getAgentCompatibilityFailureCode(new Error("other")),
    ).toBeUndefined();
  });

  it("emits only stable compatibility identity", async () => {
    const diagnostics = new AgentDiagnosticsBuffer();
    await emitAgentCompatibilityFailureDiagnostic(
      diagnostics.sink,
      {
        sessionId: "compat-session",
        executionProfile: "interactive",
      },
      new AgentPersistenceError(
        "unsupported_schema",
        "prompt=secret-content",
      ),
    );

    expect(diagnostics.list("compat-session")).toEqual([
      expect.objectContaining({
        type: "failure",
        sessionId: "compat-session",
        details: {
          category: "compatibility",
          code: "unsupported_persistence_schema",
        },
      }),
    ]);
    expect(
      JSON.stringify(diagnostics.list("compat-session")),
    ).not.toContain("secret-content");
  });
});
