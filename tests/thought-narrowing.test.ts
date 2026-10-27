/**
 * I31 fork patch: thought-level narrowing.
 *
 * The backend advertises the builtin catalog's GENERIC vocabulary
 * (low/medium/high/xhigh/max) for builtin:<family>-<plan> models, while the
 * model's real level set is declared per model in config.json
 * (provider.<id>.models.<modelId>.reasoning.variants). buildConfigOptions must
 * narrow the advertised list to that declaration — intersected with what the
 * backend offers — and clamp the current to the declared defaultVariant.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";
import { buildConfigOptions } from "../src/config/options.js";
import { ZcodeAcpServer } from "../src/server.js";

// vi.mock factories are hoisted above imports — keep the mutable fake config
// in vi.hoisted state so the factory can read it at call time.
const h = vi.hoisted(() => {
  const PROVIDER = "builtin:zai-coding-plan";
  const MODEL = "GLM-5.3-Flash";
  let current: unknown = { provider: {} };
  return {
    PROVIDER,
    MODEL,
    setCurrent: (c: unknown) => {
      current = c;
    },
    read: () => current,
  };
});

function makeConfig(models: Record<string, { reasoning?: Record<string, unknown> }>) {
  return {
    provider: {
      [h.PROVIDER]: {
        name: "Z.ai - Coding Plan",
        kind: "anthropic",
        enabled: true,
        options: { baseURL: "https://example.test/api", apiKey: "plan-token" },
        models,
      },
    },
  };
}

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(h.read());
      return actual.readFileSync(p);
    },
  };
});

/** Fake backend answering session/read with the GENERIC builtin advertisement. */
class FakeBackend {
  isDead = false;
  constructor(
    public modelId: string = h.MODEL,
    public levels: Array<Record<string, string>> = [
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
      { value: "xhigh", label: "xhigh" },
      { value: "max", label: "max" },
    ],
    public currentLevel: string = "medium",
  ) {}
  async request(
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: number; result?: unknown; error?: unknown }> {
    if (method === "session/read") {
      return {
        id,
        result: {
          projection: { status: "idle" },
          settings: {
            mode: { current: "build" },
            model: { current: { providerId: h.PROVIDER, modelId: this.modelId } },
            thoughtLevel: { current: this.currentLevel, available: this.levels },
          },
        },
      };
    }
    return { id, result: {} };
  }
}

function makeServer(modelId: string, levels: Array<Record<string, string>>, current: string) {
  const server = new ZcodeAcpServer();
  server.registerSession("sess_acp", "sess_zcode");
  server.backend = new FakeBackend(modelId, levels, current) as unknown as ZcodeAcpServer["backend"];
  return server;
}

async function setConfig(models: Record<string, { reasoning?: Record<string, unknown> }>) {
  h.setCurrent(makeConfig(models));
}

async function thoughtOption(server: ZcodeAcpServer) {
  const options: Array<acp.SessionConfigOption> = await buildConfigOptions(server, "sess_acp");
  return options.find((o) => o.id === "thought");
}

describe("thought-level narrowing (i31 fork patch)", () => {
  it("narrows the backend's generic list to the config-declared variants", async () => {
    await setConfig({
      [h.MODEL]: { reasoning: { enabled: true, variants: ["low", "high", "max"], defaultVariant: "max" } },
    });
    const thought = await thoughtOption(makeServer(h.MODEL, undefined as never, "medium"));
    expect(thought?.options.map((o) => o.value)).toEqual(["low", "high", "max"]);
  });

  it("clamps an out-of-set current to the declared defaultVariant, not canonical order", async () => {
    // Backend current "medium" is a phantom: outside the declared set. The
    // clamp must prefer the declared default "max" (what the session actually
    // runs at per the desktop), not THOUGHT_ORDER's first entry ("low").
    await setConfig({
      [h.MODEL]: { reasoning: { enabled: true, variants: ["low", "high", "max"], defaultVariant: "max" } },
    });
    const thought = await thoughtOption(makeServer(h.MODEL, undefined as never, "medium"));
    expect(thought?.currentValue).toBe("max");
  });

  it("keeps the backend list when the config declares nothing for the model", async () => {
    await setConfig({ "OTHER-MODEL": { reasoning: { variants: ["low", "high"] } } });
    const thought = await thoughtOption(makeServer(h.MODEL, undefined as never, "high"));
    expect(thought?.options.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(thought?.currentValue).toBe("high");
  });

  it("keeps the backend list when reasoning is disabled for the model", async () => {
    await setConfig({
      [h.MODEL]: { reasoning: { enabled: false, variants: ["low", "high", "max"] } },
    });
    const thought = await thoughtOption(makeServer(h.MODEL, undefined as never, "high"));
    expect(thought?.options.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("keeps the backend list when the intersection is empty (stale config)", async () => {
    await setConfig({ [h.MODEL]: { reasoning: { enabled: true, variants: ["nothink", "turbo"] } } });
    const thought = await thoughtOption(makeServer(h.MODEL, undefined as never, "high"));
    expect(thought?.options.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("narrows a lazy/composer session whose session/read carries no model.current", async () => {
    // New-thread composers hit the live path via a lazy session whose
    // session/read has no model.current — the narrowing must fall back to the
    // enabled provider's leading model (the one the pending branch advertises)
    // instead of leaving the generic list standing.
    const server = new ZcodeAcpServer();
    server.registerSession("sess_acp", "sess_zcode");
    class LazyBackend {
      isDead = false;
      async request(
        id: number,
        method: string,
      ): Promise<{ id: number; result?: unknown; error?: unknown }> {
        if (method === "session/read") {
          return {
            id,
            result: {
              projection: { status: "idle" },
              settings: {
                mode: { current: "build" },
                thoughtLevel: {
                  current: "medium",
                  available: [
                    { value: "low", label: "low" },
                    { value: "medium", label: "medium" },
                    { value: "high", label: "high" },
                    { value: "xhigh", label: "xhigh" },
                    { value: "max", label: "max" },
                  ],
                },
              },
            },
          };
        }
        return { id, result: {} };
      }
    }
    server.backend = new LazyBackend() as unknown as ZcodeAcpServer["backend"];
    await setConfig({
      [h.MODEL]: { reasoning: { enabled: true, variants: ["low", "high", "max"], defaultVariant: "max" } },
    });
    const thought = await thoughtOption(server);
    expect(thought?.options.map((o) => o.value)).toEqual(["low", "high", "max"]);
    expect(thought?.currentValue).toBe("max");
  });
});
