import {
  getApiKeyValidationError,
  isValidAnthropicApiKey,
} from "./apiKeyValidation.js";

// Construct provider-shaped values at runtime so format-validation coverage is
// preserved without embedding credential-like literals that secret scanners
// may mistake for live keys.
const syntheticAnthropicKey = (suffix: string) =>
  ["sk", "ant", suffix].join("-");

describe("isValidAnthropicApiKey", () => {
  it("should return true for valid API keys", () => {
    expect(isValidAnthropicApiKey(syntheticAnthropicKey("1234567890"))).toBe(
      true,
    );
    expect(
      isValidAnthropicApiKey(syntheticAnthropicKey("abcdefghijklmnop")),
    ).toBe(true);
    expect(
      isValidAnthropicApiKey(syntheticAnthropicKey("test-key-with-dashes")),
    ).toBe(true);
    expect(
      isValidAnthropicApiKey(
        syntheticAnthropicKey("api03_unit_test_fixture_1234567890abcdef"),
      ),
    ).toBe(true);
  });

  it("should return false for invalid API keys", () => {
    expect(isValidAnthropicApiKey("")).toBe(false);
    expect(isValidAnthropicApiKey(syntheticAnthropicKey(""))).toBe(false);
    expect(isValidAnthropicApiKey("TEST-")).toBe(false);
    expect(isValidAnthropicApiKey("TEST-openai-1234567890")).toBe(false);
    expect(isValidAnthropicApiKey("invalid-key")).toBe(false);
    expect(isValidAnthropicApiKey("1234567890")).toBe(false);
  });

  it("should return false for null or undefined", () => {
    expect(isValidAnthropicApiKey(null)).toBe(false);
    expect(isValidAnthropicApiKey(undefined)).toBe(false);
  });

  it("should return false for non-string values", () => {
    expect(isValidAnthropicApiKey(123 as any)).toBe(false);
    expect(isValidAnthropicApiKey({} as any)).toBe(false);
    expect(isValidAnthropicApiKey([] as any)).toBe(false);
  });
});

describe("getApiKeyValidationError", () => {
  it("should return appropriate error messages", () => {
    expect(getApiKeyValidationError("")).toBe("API key is required");
    expect(getApiKeyValidationError(null)).toBe("API key is required");
    expect(getApiKeyValidationError(undefined)).toBe("API key is required");
    expect(getApiKeyValidationError("TEST-")).toBe(
      'API key must start with "sk-ant-"',
    );
    expect(getApiKeyValidationError("TEST-openai-1234")).toBe(
      'API key must start with "sk-ant-"',
    );
    expect(getApiKeyValidationError(syntheticAnthropicKey(""))).toBe(
      "API key is too short",
    );
    expect(getApiKeyValidationError("invalid")).toBe(
      'API key must start with "sk-ant-"',
    );
  });
});
