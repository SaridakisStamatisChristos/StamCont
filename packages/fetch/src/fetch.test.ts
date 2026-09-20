import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  patchedFetch: vi.fn(),
}));

vi.mock("./node-fetch-patch.js", () => ({
  default: mocks.patchedFetch,
}));

vi.mock("./getAgentOptions.js", () => ({
  getAgentOptions: vi.fn(async () => ({})),
}));

import { Response } from "node-fetch";

import { fetchwithRequestOptions } from "./fetch.js";

describe("fetchwithRequestOptions transport selection", () => {
  beforeEach(() => {
    mocks.patchedFetch.mockReset();
    mocks.patchedFetch.mockResolvedValue(
      new Response("ok", {
        status: 200,
      }),
    );
  });

  it("preserves an explicit caller-provided agent", async () => {
    const explicitAgent = { securityBoundary: "pinned-dns-agent" };

    await fetchwithRequestOptions(
      "https://example.com/resource",
      {
        agent: explicitAgent,
      } as any,
    );

    expect(mocks.patchedFetch).toHaveBeenCalledTimes(1);
    expect(mocks.patchedFetch.mock.calls[0][1]).toMatchObject({
      agent: explicitAgent,
    });
  });
});
