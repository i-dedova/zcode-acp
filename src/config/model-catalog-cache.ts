/**
 * Persisted model catalog — the bridge's single read source for per-model
 * reasoning vocabularies (i31 Scope 5, operator design: "the bridge always
 * reads from the persisted json the model catalog, not from anything else").
 *
 * Writers:
 *  - harvest: every create/resume snapshot (cacheModelAvailability call
 *    sites) persists the FULL registry listing here — the same data the
 *    in-memory server.modelAvailability map holds, but durable.
 *  - background refresh: the first session/new per bridge process, when the
 *    file is older than CATALOG_TTL_MS, resumes a pinned catalog session
 *    (fallback create) and persists its snapshot — this covers T3's provider
 *    status probes and composer creations, which never materialize.
 *
 * Readers: buildConfigOptions (pending + live). Nothing else reads model
 * vocabularies.
 *
 * All file I/O is best-effort (log-and-swallow, the lazy-sessions.ts
 * pattern): a store problem degrades to the config-only fallback, never
 * fails a request.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import type { ZcodeAcpServer } from "../server.js";
import { log, warn, zcodeHomeDir } from "../utils.js";

const CATALOG_FILENAME = "acp-model-catalog.json";

/** Refresh cadence for the background job; harvest writes bypass it. */
export const CATALOG_TTL_MS = 10 * 60 * 1000;

export interface CatalogModelEntry {
  levels: string[];
  defaultLevel?: string;
}

export interface ModelCatalogCache {
  version: 1;
  updatedAt: number;
  /** Backend session id the last snapshot came from — resumed by the
   *  background refresh so leftover sessions stay bounded at ~1. */
  catalogSessionId?: string;
  providers: Record<string, Record<string, CatalogModelEntry>>;
}

/** Resolved at call time so tests can stub HOME/ZCODE_HOME without re-importing. */
function catalogPath(): string {
  return path.join(zcodeHomeDir(), "v2", CATALOG_FILENAME);
}

export function readModelCatalogCache(): ModelCatalogCache | undefined {
  try {
    const p = catalogPath();
    if (!existsSync(p)) {
      return undefined;
    }
    const v = JSON.parse(readFileSync(p, "utf8")) as ModelCatalogCache;
    if (
      typeof v === "object" &&
      v !== null &&
      v.version === 1 &&
      typeof v.updatedAt === "number" &&
      typeof v.providers === "object" &&
      v.providers !== null
    ) {
      return v;
    }
  } catch {
    // absent/corrupt — caller falls back to config declarations
  }
  return undefined;
}

/** Atomic write (tmp + rename), the lazy-sessions.ts pattern. */
export function writeModelCatalogCache(
  providers: ModelCatalogCache["providers"],
  catalogSessionId?: string,
): void {
  try {
    const p = catalogPath();
    mkdirSync(path.dirname(p), { recursive: true });
    const next: ModelCatalogCache = {
      version: 1,
      updatedAt: Date.now(),
      providers,
    };
    if (catalogSessionId) {
      next.catalogSessionId = catalogSessionId;
    }
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, p);
    log(`catalog-cache: persisted ${Object.keys(providers).length} provider(s)`);
  } catch (e) {
    warn(`catalog-cache: write failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

export function catalogNeedsRefresh(ttlMs: number = CATALOG_TTL_MS): boolean {
  const cache = readModelCatalogCache();
  if (!cache) {
    return true;
  }
  return Date.now() - cache.updatedAt > ttlMs;
}

/**
 * Look up one model's vocabulary, provider-aware: the same modelId exists
 * under several plans (GLM-5.3-Flash under coding-plan, start-plan, apikey),
 * so the provider ids are compared through configProviderIdFor
 * normalization. ModelId-only matches never apply (review-round-1 rule: no
 * cross-provider vocabulary bleed). Returns undefined when the cache does
 * not know the model under THIS provider.
 */
export function catalogEntryFor(
  cache: ModelCatalogCache,
  providerId: string,
  modelId: string,
  normalize: (pid: string) => string,
): CatalogModelEntry | undefined {
  for (const [pid, models] of Object.entries(cache.providers)) {
    const m = models?.[modelId];
    if (!m || !Array.isArray(m.levels) || m.levels.length === 0) {
      continue;
    }
    if (normalize(pid) === normalize(providerId)) {
      return m;
    }
  }
  return undefined;
}

/**
 * Map a create/resume snapshot result to the availability list the bridge
 * keeps in memory (same shape cacheModelAvailability stores). Shared with
 * the background refresh so both writers parse identically.
 */
/** The slice of a backend create/resume result the catalog reads. */
export interface SnapshotResult {
  settings?: {
    model?: {
      available?: Array<{
        ref?: { providerId?: string; modelId?: string };
        reasoning?: {
          defaultLevel?: string;
          levels?: Array<{ value?: string }>;
        };
      }>;
    };
  };
}

export function availabilityFromResult(result: SnapshotResult | null | undefined): Array<{
  providerId?: string;
  modelId?: string;
  defaultLevel?: string;
  levels?: string[];
}> {
  const out: Array<{
    providerId?: string;
    modelId?: string;
    defaultLevel?: string;
    levels?: string[];
  }> = [];
  for (const a of result?.settings?.model?.available ?? []) {
    const levels: string[] = [];
    for (const l of a.reasoning?.levels ?? []) {
      if (typeof l.value === "string") {
        levels.push(l.value);
      }
    }
    out.push({
      providerId: a.ref?.providerId,
      modelId: a.ref?.modelId,
      defaultLevel: a.reasoning?.defaultLevel ?? levels[0],
      levels,
    });
  }
  return out;
}

/** Convert the availability list into the persisted per-provider record. */
export function providersFromAvailability(
  avail: Array<{
    providerId?: string;
    modelId?: string;
    defaultLevel?: string;
    levels?: string[];
  }>,
): ModelCatalogCache["providers"] {
  const out: ModelCatalogCache["providers"] = {};
  for (const a of avail) {
    if (!a.providerId || !a.modelId || !Array.isArray(a.levels) || a.levels.length === 0) {
      continue;
    }
    const models = out[a.providerId] ?? {};
    const entry: CatalogModelEntry = { levels: a.levels };
    if (a.defaultLevel !== undefined) {
      entry.defaultLevel = a.defaultLevel;
    }
    models[a.modelId] = entry;
    out[a.providerId] = models;
  }
  return out;
}

/**
 * Background catalog refresh: fire-and-forget, never blocks the caller.
 * Covers T3's provider-status probes and composer creations, whose
 * session/new never materializes a backend session. Refreshes the backend
 * registry first (best-effort — a newly activated plan lands without a
 * desktop restart), then takes a full snapshot via a PINNED catalog session
 * (resumed; fallback create) so leftover sessions stay bounded at ~1.
 * ponytail: ceiling: per-process in-flight flag + TTL — constant probing
 * spawns at most once per TTL window per process; upgrade when: cross-
 * process coordination or a sessionless registry read appears in the
 * app-server method table.
 */
export async function refreshModelCatalogInBackground(
  server: ZcodeAcpServer,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (server.catalogRefreshInFlight) {
    return;
  }
  if (!opts.force && !catalogNeedsRefresh()) {
    return;
  }
  server.catalogRefreshInFlight = true;
  void (async () => {
    try {
      const backend = await server.ensureBackend();
      try {
        await backend.request(server.nextId(), "provider/refreshRegistry", {}, 10000);
      } catch (e) {
        log(
          `catalog-cache: provider/refreshRegistry unavailable (${e instanceof Error ? e.message : String(e)}) — snapshotting current registry`,
        );
      }
      const prev = readModelCatalogCache();
      let result: SnapshotResult | undefined;
      let usedSid: string | undefined;
      if (prev?.catalogSessionId) {
        const resp = await backend.request(
          server.nextId(),
          "session/resume",
          { sessionId: prev.catalogSessionId },
          30000,
        );
        if (!resp.error) {
          result = resp.result as SnapshotResult;
          usedSid = prev.catalogSessionId;
        }
      }
      if (!result) {
        // Same param shape the bridge's own create path sends (workspaceFor):
        // the backend wants a workspace object, not a bare cwd.
        const workspace = { workspacePath: process.cwd(), workspaceKey: process.cwd() };
        const resp = await backend.request(
          server.nextId(),
          "session/create",
          { workspace, mcpServers: [] },
          30000,
        );
        if (resp.error) {
          log(`catalog-cache: refresh create failed: ${resp.error.message}`);
          return;
        }
        const raw = resp.result as (SnapshotResult & { session?: { sessionId?: string } }) | null;
        result = raw ?? undefined;
        usedSid = raw?.session?.sessionId;
        if (prev?.catalogSessionId && usedSid && prev.catalogSessionId !== usedSid) {
          // Superseded pinned session — best-effort teardown (the runtime
          // dies; the stored row persists server-side, bounded by the pin).
          void backend
            .request(server.nextId(), "session/close", { sessionId: prev.catalogSessionId }, 10000)
            .catch(() => undefined);
        }
      }
      const avail = availabilityFromResult(result);
      if (avail.length === 0) {
        log("catalog-cache: refresh snapshot carried no model availability");
        return;
      }
      writeModelCatalogCache(providersFromAvailability(avail), usedSid);
    } catch (e) {
      warn(`catalog-cache: refresh failed (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      server.catalogRefreshInFlight = false;
    }
  })();
}
