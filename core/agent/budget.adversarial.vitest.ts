import { describe, expect, it } from "vitest";

import {
  AgentContextBudgetError,
  createFallbackAgentContextEstimator,
  planAgentContextBudget,
  type AgentContextEstimator,
} from "./budget";
import {
  AGENT_PERSISTENCE_SCHEMA_VERSION,
  type AgentPersistedRecord,
} from "./persistence";

const sessionId = "pr14-budget";

function record(
  sequence: number,
  kind: AgentPersistedRecord["kind"],
  payload: unknown,
): AgentPersistedRecord {
  return {
    schemaVersion: AGENT_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    sequence,
    kind,
    payload,
  };
}

describe("PR14 adversarial context budgeting", () => {
  it("fails closed on a pathological user request under a tiny context window", () => {
    const records = [
      record(1, "model_input", {
        type: "message",
        role: "user",
        content: "x".repeat(100_000),
      }),
    ];

    const plan = planAgentContextBudget(records, sessionId, {
      budget: {
        contextLimitTokens: 128,
        reservedOutputTokens: 16,
      },
    });

    expect(plan.decision).toBe("overflow_non_compactable");
    expect(plan.input).toBeUndefined();
    expect(plan.provenance.rawTotalRequiredTokens).toBeGreaterThan(
      plan.provenance.contextLimitTokens,
    );
  });

  it("accounts for a huge tool result rather than silently truncating it", () => {
    const records = [
      record(1, "model_input", {
        type: "message",
        role: "user",
        content: "inspect",
      }),
      record(2, "tool_result", {
        type: "tool_result",
        status: "success",
        toolCallItemId: "tool-1",
        callId: "call-1",
        name: "read_file",
        output: "z".repeat(75_000),
      }),
    ];

    const plan = planAgentContextBudget(records, sessionId, {
      budget: {
        contextLimitTokens: 256,
        reservedOutputTokens: 32,
      },
      phase: "post_tool",
    });

    expect(plan.decision).toBe("overflow_non_compactable");
    expect(plan.provenance.phase).toBe("post_tool");
  });

  it("accounts for huge tool schemas before allowing a model request", () => {
    const records = [
      record(1, "model_input", {
        type: "message",
        role: "user",
        content: "hello",
      }),
    ];

    const plan = planAgentContextBudget(records, sessionId, {
      budget: {
        contextLimitTokens: 512,
        reservedOutputTokens: 64,
      },
      tools: [
        {
          name: "huge_schema",
          description: "d".repeat(50_000),
          inputSchema: {
            type: "object",
            description: "s".repeat(50_000),
          },
        },
      ],
    });

    expect(plan.decision).toBe("overflow_non_compactable");
    expect(plan.provenance.toolDefinitionTokens).toBeGreaterThan(512);
  });

  it("uses the conservative fallback when no provider estimator is available", () => {
    const records = [
      record(1, "model_input", {
        type: "message",
        role: "user",
        content: "short",
      }),
    ];

    const plan = planAgentContextBudget(records, sessionId, {
      budget: {
        contextLimitTokens: 4096,
        reservedOutputTokens: 128,
      },
    });

    expect(plan.provenance.estimator).toMatchObject({
      id: "stamcont.agent.context-budget.utf8-bytes",
      accuracy: "estimated",
    });
    expect(plan.decision).toBe("fits_raw");
  });

  it("handles the minimum valid context window without negative or wrapped accounting", () => {
    const records = [
      record(1, "model_input", {
        type: "message",
        role: "user",
        content: "x",
      }),
    ];

    const plan = planAgentContextBudget(records, sessionId, {
      budget: {
        contextLimitTokens: 1,
        reservedOutputTokens: 0,
        safetyMarginTokens: 0,
      },
    });

    expect(plan.decision).toBe("overflow_non_compactable");
    expect(plan.provenance.contextLimitTokens).toBe(1);
    expect(plan.provenance.rawTotalRequiredTokens).toBeGreaterThan(1);
  });

  it("rejects a broken estimator instead of trusting non-finite counts", () => {
    const records = [
      record(1, "model_input", {
        type: "message",
        role: "user",
        content: "hello",
      }),
    ];
    const broken: AgentContextEstimator = {
      id: "broken",
      version: 1,
      accuracy: "exact",
      estimateInputTokens() {
        return Number.POSITIVE_INFINITY;
      },
      estimateToolDefinitionTokens() {
        return 0;
      },
    };

    expect(() =>
      planAgentContextBudget(records, sessionId, {
        budget: {
          contextLimitTokens: 1000,
          reservedOutputTokens: 100,
        },
        estimator: broken,
      }),
    ).toThrow(AgentContextBudgetError);

    expect(
      createFallbackAgentContextEstimator().accuracy,
    ).toBe("estimated");
  });
});
