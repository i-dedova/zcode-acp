import { describe, expect, it } from "vitest";

import {
  coerceConfigValueId,
  negotiateProtocolVersion,
  shapeForVersion,
} from "../src/utils.js";

describe("negotiateProtocolVersion", () => {
  it("echoes the offered version when supported", () => {
    expect(negotiateProtocolVersion(1)).toBe(1);
    expect(negotiateProtocolVersion(2)).toBe(2);
  });

  it("answers our highest for a NEWER offer than we speak", () => {
    expect(negotiateProtocolVersion(3)).toBe(2);
  });

  it("never upgrades a missing or malformed offer to v2 (review round 1)", () => {
    // A client whose version we cannot parse gets the v1 wire shape every
    // ACP client tolerates — not mode-less configId traffic it never
    // negotiated.
    expect(negotiateProtocolVersion(undefined)).toBe(1);
    expect(negotiateProtocolVersion(null)).toBe(1);
    expect(negotiateProtocolVersion(Number.NaN)).toBe(1);
    expect(negotiateProtocolVersion(0)).toBe(1);
    expect(negotiateProtocolVersion(1.5)).toBe(1);
  });
});

describe("shapeForVersion", () => {
  it("keeps v1 responses byte-identical (modes retained)", () => {
    const resp = { sessionId: "s", modes: { currentModeId: "build" }, configOptions: [] };
    expect(shapeForVersion(1, resp)).toBe(resp);
  });

  it("strips the top-level modes field for v2 connections", () => {
    const resp = {
      sessionId: "s",
      modes: { currentModeId: "build" },
      configOptions: [{ id: "mode", category: "mode" }],
    };
    const shaped = shapeForVersion(2, resp);
    expect(shaped.modes).toBeUndefined();
    expect(shaped.sessionId).toBe("s");
    expect(shaped.configOptions).toHaveLength(1);
    // the input object is not mutated
    expect(resp.modes).toBeDefined();
  });
});

describe("coerceConfigValueId", () => {
  it("unwraps the v2 discriminated id envelope", () => {
    expect(coerceConfigValueId({ type: "id", value: "high" })).toBe("high");
  });

  it("leaves v1 spellings untouched", () => {
    expect(coerceConfigValueId("high")).toBe("high");
    expect(coerceConfigValueId(true)).toBe(true);
    expect(coerceConfigValueId({ type: "boolean", value: true })).toEqual({
      type: "boolean",
      value: true,
    });
  });

  it("maps a malformed id envelope to the empty string", () => {
    expect(coerceConfigValueId({ type: "id" })).toBe("");
    expect(coerceConfigValueId({ type: "id", value: { nested: true } })).toBe("");
  });
});
