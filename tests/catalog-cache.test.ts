import { describe, expect, it, vi } from "vitest";

import { ZcodeAcpServer } from "../src/server.js";
import {
  availabilityFromResult,
  catalogEntryFor,
  catalogNeedsRefresh,
  providersFromAvailability,
  readModelCatalogCache,
  refreshModelCatalogInBackground,
  writeModelCatalogCache,
} from "../src/config/model-catalog-cache.js";

const REAL_FILE = (
  readModelCatalogCache as unknown as { length: number }
) && undefined;
void REAL_FILE;

function useFakeHome(home: string) {
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("ZCODE_HOME", home);
}

describe("persisted model catalog cache", () => {
  it("round-trips write/read within a fake home", async () => {
    useFakeHome("C:/Users/innad/tmp/i31-cache-test-home");
    const providers = providersFromAvailability([
      {
        providerId: "builtin:zai-coding-plan",
        modelId: "GLM-5.3-Flash",
        defaultLevel: "max",
        levels: ["low", "high", "max"],
      },
      { providerId: "builtin:zai-start-plan", modelId: "GLM-5.3-Flash", levels: ["low"] },
    ]);
    writeModelCatalogCache(providers, "sess_catalog");
    const read = readModelCatalogCache();
    expect(read?.providers["builtin:zai-coding-plan"]?.["GLM-5.3-Flash"]?.levels).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(read?.catalogSessionId).toBe("sess_catalog");
    expect(catalogNeedsRefresh(600000)).toBe(false);
    expect(catalogNeedsRefresh(0)).toBe(true);
  });

  it("returns undefined for a corrupt file", async () => {
    useFakeHome("C:/Users/innad/tmp/i31-cache-test-home2");
    const providers = providersFromAvailability([
      { providerId: "p", modelId: "m", levels: ["low"] },
    ]);
    writeModelCatalogCache(providers);
    // corrupt via the same write path is not possible — assert the guard by
    // reading a file we overwrite with junk through the fs directly.
    const { writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    const file = path.join("C:/Users/innad/tmp/i31-cache-test-home2", "v2", "acp-model-catalog.json");
    writeFileSync(file, "{ not json");
    expect(readModelCatalogCache()).toBeUndefined();
  });

  it("maps availability with provider awareness and skips empty levels", () => {
    const providers = providersFromAvailability([
      { providerId: "a", modelId: "m1", levels: ["low", "high"], defaultLevel: "low" },
      { providerId: "b", modelId: "m1", levels: ["enabled"] },
      { providerId: "a", modelId: "empty", levels: [] },
    ]);
    const identity = (x: string) => x;
    expect(catalogEntryFor({ version: 1, updatedAt: 0, providers }, "a", "m1", identity)?.levels).toEqual([
      "low",
      "high",
    ]);
    expect(catalogEntryFor({ version: 1, updatedAt: 0, providers }, "b", "m1", identity)?.levels).toEqual([
      "enabled",
    ]);
    expect(catalogEntryFor({ version: 1, updatedAt: 0, providers }, "c", "m1", identity)).toBeUndefined();
    expect(catalogEntryFor({ version: 1, updatedAt: 0, providers }, "a", "empty", identity)).toBeUndefined();
  });

  it("parses a backend snapshot result into the availability list", () => {
    const avail = availabilityFromResult({
      settings: {
        model: {
          available: [
            { ref: { providerId: "p", modelId: "m" }, reasoning: { levels: [{ value: "low" }, { value: "max" }] } },
          ],
        },
      },
    });
    expect(avail).toEqual([{ providerId: "p", modelId: "m", defaultLevel: "low", levels: ["low", "max"] }]);
  });

  it("background refresh is a no-op loop under the in-flight flag", async () => {
    useFakeHome("C:/Users/innad/tmp/i31-cache-test-home3");
    const server = new ZcodeAcpServer();
    // No backend is spawned by the flag guard when a refresh is already in
    // flight; and with a fresh cache file absent, ensureBackend would be
    // required — stub it out to keep this unit pure.
    let calls = 0;
    (server as unknown as { catalogRefreshInFlight: boolean }).catalogRefreshInFlight = true;
    (server as unknown as { ensureBackend: () => Promise<unknown> }).ensureBackend = async () => {
      calls += 1;
      throw new Error("should not be called");
    };
    await refreshModelCatalogInBackground(server);
    expect(calls).toBe(0);
    expect(
      (server as unknown as { catalogRefreshInFlight: boolean }).catalogRefreshInFlight,
    ).toBe(true);
  });
});
