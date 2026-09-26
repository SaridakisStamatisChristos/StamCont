import * as path from "path";

import { describe, expect, it } from "vitest";

import { readIdentityEnv, resolveCliEnvironment } from "./env.js";

describe("CLI identity environment compatibility", () => {
  it("prefers non-empty STAMCONT_* values over legacy values", () => {
    expect(
      readIdentityEnv(
        {
          STAMCONT_API_BASE: "https://stamcont.example/",
          CONTINUE_API_BASE: "https://legacy.example/",
        },
        "STAMCONT_API_BASE",
        "CONTINUE_API_BASE",
      ),
    ).toBe("https://stamcont.example/");
  });

  it("falls back to legacy variables", () => {
    expect(
      readIdentityEnv(
        { CONTINUE_API_BASE: "https://legacy.example/" },
        "STAMCONT_API_BASE",
        "CONTINUE_API_BASE",
      ),
    ).toBe("https://legacy.example/");
  });

  it("treats an empty StamCont alias as unset", () => {
    expect(
      readIdentityEnv(
        {
          STAMCONT_API_BASE: "",
          CONTINUE_API_BASE: "https://legacy.example/",
        },
        "STAMCONT_API_BASE",
        "CONTINUE_API_BASE",
      ),
    ).toBe("https://legacy.example/");
  });

  it("keeps the historical defaults when neither alias is set", () => {
    const resolved = resolveCliEnvironment({}, "/home/test-user");
    expect(resolved.apiBase).toBe("https://api.continue.dev/");
    expect(resolved.stamcontHome).toBe(
      path.join("/home/test-user", ".continue"),
    );
    expect(resolved.continueHome).toBe(resolved.stamcontHome);
  });

  it("uses STAMCONT_GLOBAL_DIR before CONTINUE_GLOBAL_DIR", () => {
    const resolved = resolveCliEnvironment(
      {
        STAMCONT_GLOBAL_DIR: "/tmp/stamcont-state",
        CONTINUE_GLOBAL_DIR: "/tmp/continue-state",
      },
      "/home/test-user",
    );
    expect(resolved.stamcontHome).toBe("/tmp/stamcont-state");
    expect(resolved.continueHome).toBe("/tmp/stamcont-state");
  });
});
