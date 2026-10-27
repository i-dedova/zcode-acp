import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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

const tempHomes: string[] = [];
function useFakeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "i31-catalog-"));
  tempHomes.push(home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("ZCODE_HOME", home);
  return home;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe("persisted model catalog cache", () => {
  it("round-trips write/read within a fake home", async () => {
    useFakeHome();
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
    useFakeHome();
    const providers = providersFromAvailability([
      { providerId: "p", modelId: "m", levels: ["low"] },
    ]);
    writeModelCatalogCache(providers);
    // corrupt via the same write path is not possible — assert the guard by
    // reading a file we overwrite with junk through the fs directly.
    const { writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    const file = path.join(tempHomes[0]!, "v2", "acp-model-catalog.json");
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

  it("background refresh resumes the pin, falls back to create, closes the superseded sid", async () => {
    useFakeHome();
    const server = new ZcodeAcpServer();
    const requested: Array<{ method: string; params: Record<string, unknown> }> = [];
    let nextId = 1;
    let id = 0;
    server.ensureBackend = (async () => ({
      request(reqId: number, method: string, params?: Record<string, unknown>) {
        void reqId;
        id += 1;
        requested.push({ method, params: params ?? {} });
        if (method === "provider/refreshRegistry") {
          return Promise.resolve({ result: {} });
        }
        if (method === "session/resume") {
          // The pinned sid from a previous generation is dead — the backend
          // rejects; the job must fall back to create.
          return Promise.resolve({ error: { code: -32602, message: "no such session" } });
        }
        if (method === "session/create") {
          return Promise.resolve({
            result: {
              session: { sessionId: "sess_new_catalog" },
              settings: {
                model: {
                  available: [
                    {
                      ref: { providerId: "p", modelId: "m" },
                      reasoning: { levels: [{ value: "low" }, { value: "high" }] },
                    },
                  ],
                },
              },
            },
          });
        }
        if (method === "session/close") {
          return Promise.resolve({ result: {} });
        }
        return Promise.resolve({ result: {} });
      },
      get nextId() {
        id += 0;
        return nextId++;
      },
    })) as unknown as ZcodeAcpServer["ensureBackend"];
    writeModelCatalogCache(
      providersFromAvailability([
        { providerId: "old", modelId: "m", levels: ["low"] },
      ]),
      "sess_old_catalog",
    );
    await refreshModelCatalogInBackground(server, { force: true });
    const methods = requested.map((r) => r.method);
    expect(methods).toContain("provider/refreshRegistry");
    expect(methods).toContain("session/resume");
    expect(methods).toContain("session/create");
    expect(methods).toContain("session/close");
    const close = requested.find((r) => r.method === "session/close");
    expect(close?.params["sessionId"]).toBe("sess_old_catalog");
    const read = readModelCatalogCache();
    expect(read?.catalogSessionId).toBe("sess_new_catalog");
    expect(read?.providers["p"]?.["m"]?.levels).toEqual(["low", "high"]);
  });

  it("background refresh is a no-op loop under the in-flight flag", async () => {
    useFakeHome();
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
