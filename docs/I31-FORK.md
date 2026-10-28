# The i31 fork — provider-authoritative reasoning levels, dual ACP protocol, T3 Code

This repository is a maintained fork. Two remotes are normal here:

| remote | repo | role |
|---|---|---|
| `origin` | <https://github.com/i-dedova/zcode-acp> | the fork — all i31 work lands here |
| `upstream` | <https://github.com/william0wang/zcode-acp> | the project this fork improves |

Work branch: `i31/reasoning-levels`. Version scheme: `0.76.3-i31.<n>` (the
`-i31.<n>` suffix bumps with every installed build; version strings are not
freshness signals — verify by digest, below).

Fork policy: copied-and-improved code. Keep the delta patch-shaped: no
wholesale reformatting of upstream files (it poisons future upstream merges),
no new runtime dependencies, upstream behavior byte-identical for v1 clients.

## What the fork changes

Architecture context: [ARCHITECTURE.md](ARCHITECTURE.md) and
[PROTOCOL.md](PROTOCOL.md) describe the upstream bridge; everything below is
the i31 delta on top.

### ACP v1/v2 dual protocol

- `initialize` negotiates per connection: the client's offered version is
  echoed when supported (v2 draft clients get 2), malformed offers never
  upgrade, v1 sessions stay byte-identical (modes advertised, zero
  `configId` anywhere).
- v2 connections get `configId` on every config option and no top-level
  `modes`; every response and notification path (session/new, set, resume,
  load, dispatch fan-out, quota dock) shapes per receiving connection.
- `session/set_config_option` accepts the v1 bare string, the v1 boolean
  envelope, and the v2 `{type: "id", value}` envelope. The ACP SDK 1.3.0 v2
  spec spells this value FLAT (`{sessionId, configId, type, value}` — see
  `@agentclientprotocol/sdk` `dist/v2/schema/zod.gen.js`); the bridge parser
  accepts both spellings.

### Persisted model catalog — the never-hardcode invariant

Reasoning levels are never hardcoded. The single vocabulary source of truth
is the persisted catalog `~/.zcode/v2/acp-model-catalog.json`
(`{version, updatedAt, catalogSessionId?, providers: {<providerId>:
{<modelId>: {levels: string[], defaultLevel?}}}}`).

- Writers: every backend create/resume snapshot harvests into it, and the
  first `session/new` per bridge process triggers a background refresh
  (TTL 10 min, never blocking): `provider/refreshRegistry` pre-step, then a
  full snapshot via a pinned catalog session (resume; fallback create;
  superseded session closed). T3's app-launch and provider-status probes
  therefore keep the catalog warm without any composer traffic.
- Readers: pending sessions (composer not yet materialized) and live
  sessions both resolve the thought vocabulary catalog-first; `config.json`
  per-model `reasoning.variants` are the fallback; a single-level catalog
  entry is treated as the backend echoing its default, not a vocabulary.
- When nothing declares a vocabulary, the thought option is OMITTED — the
  bridge never invents levels. This is the designed omission invariant.

### Composer defaults resolution (pending sessions)

The advertised model resolves in order: `ZCODE_ACP_MODEL` env pin → the
cross-session last-used model (`~/.zcode/v2/acp-last-model-choice.json`,
written on every picker choice) → the leading selectable entry. The
advertised thought default is the vocabulary's declared default, or the
`ZCODE_ACP_THOUGHT` pin when the pin is a member of the vocabulary.

Known ceiling (T3): its `session/new` carries no model and its composer
renders its own remembered selection, so a never-opened composer can display
a different model than the one a first prompt would use; the first pick or
prompt reconciles (T3 applies rebuilt options — its mode·thought chips track
switches).

### Account-plan provider fixes

- Builtin plan labels prefer the bundled provider table's names ("Z.AI
  Individual Coding Plan", "Start Plan") over duplicate desktop-written
  names; builtin plans never union personal `provider_config.json` rules.
- A desktop-provisioned key counts as entitlement (`current: entitled` is
  load-bearing — pushing `current: false` excludes key-provisioned plans
  from the backend's switchable registry, breaking switches with
  "Provider Registry 中不存在 Model").
- Start Plan is switchable when its stored key is present.

### Windows launch fixes

- The sqlite-capable Node search includes the bridge's own
  `process.execPath` (a `which node` result can be an MSYS POSIX path
  Windows cannot exec — the old failure was `spawn EFTYPE`).
- Bundled CLI discovery probes BOTH the per-user NSIS install
  (`%LOCALAPPDATA%\Programs\ZCode`) and the per-machine install
  (`%ProgramFiles%\ZCode`).

## Client setup — T3 Code nightly

1. Provider type "ACP", command `zcode-acp-server` (or
   `node <global>/node_modules/zcode-acp-server/dist/cli.js`), args empty.
   T3 offers ACP protocol v2; the bridge negotiates it automatically.
2. Optional per-instance defaults go in the provider's **Environment**
   channel (butler pattern — the same mechanism browseros-butler uses):

   ```
   ZCODE_ACP_MODEL=builtin:zai-start-plan\GLM-5.3-Flash
   ZCODE_ACP_THOUGHT=max
   ```

   `ZCODE_ACP_MODEL` uses the exact composer spelling
   `providerId\modelId`. Pins are soft: an unknown pin warns and falls
   through to the normal default; a fresh session applies the pin;
   resumed sessions keep their stored selection.
3. Thought level pins are honored only inside the model's advertised
   vocabulary — never invented.
4. T3's composer remembers its own last pick per instance. After changing a
   pin, re-seat by picking the pinned model once (or clear the renderer's
   composer-drafts storage). The picker is the per-session chooser; pins are
   instance defaults.
5. To hard-restrict what a T3 instance can run, use its per-instance hidden
   model preferences so the composer can only assert pinned models. Hiding a
   model does NOT stop its cached capability data from feeding the
   instance-wide picker (see troubleshooting).

Other clients: Zed/JetBrains keep working as upstream (v1). BrowserOS stays
v1-only; the bridge never upgrades a v1 client.

## Install and digest pinning

```bash
npm run build
npm pack
npm install -g zcode-acp-server-0.76.3-i31.<n>.tgz
```

Verify the install by digest (sha512 of the packed tgz and of
`dist/index.js`), recorded per install in the estate records — an install is
identified by digest, not by version string:

```bash
node -e "const c=require('crypto'),fs=require('fs');const h=c.createHash('sha512');h.update(fs.readFileSync(process.argv[1]));console.log(h.digest('base64'))" "$(npm root -g)/zcode-acp-server/dist/index.js"
```

The installed global build is what editors spawn; a source-tree change does
nothing until rebuilt, repacked, and reinstalled, and a running editor keeps
its OLD bridge process until fully restarted.

## Troubleshooting (i31-specific)

**Composer frozen on one reasoning level (T3).**
T3 stamps ONE capability list — from its provider-probe session — onto every
model in its picker, caches it 15 min in memory and on disk across restarts
(`C:\Users\innad\.t3\caches\acpRegistry_<instance>.json`), and its renderer
sticky selections can mask fresh values. Ladder:
1. Fully restart T3 (bridge processes and probe caches die with it).
2. Check the persisted catalog has the model with >= 2 levels
   (`~/.zcode/v2/acp-model-catalog.json`); if not, trigger a refresh (open a
   new session) and re-check.
3. Check the T3 cache file: which model's vocabulary did the probe capture?
   A single-level model (e.g. `zai-plan-apikey` entries) poisons the shared
   list — restart re-probes on the current default.
4. Re-pick the model once (sticky re-seat), then verify.

**`spawn EFTYPE` / "no sqlite-capable node found" at startup.**
The bridge could not find a Node able to run the zcode CLI. Fixed in i31.5
(`process.execPath` candidate); if still hit, set `ZCODE_NODE` to a real
`node.exe` (>= 22.5) and `ZCODE_BIN` to the CLI (`zcode.cjs`).

**"Provider Registry 中不存在 Model" on a model switch.**
The backend registry rejected the plan/model — usually an entitlement or
`current` push problem. Confirm the account-provider push ran (bridge log
`account-provider:`), the plan is enabled/entitled in the desktop, and the
build includes the `current: entitled` fix.

**Catalog stale / wrong levels.**
Delete `~/.zcode/v2/acp-model-catalog.json` and open a new session — the
background refresh rebuilds it (TTL is 10 min; deletion forces the next
refresh).

**Advertised model differs from what the first prompt uses (T3).**
The never-opened-composer ceiling above. Pick the model explicitly before
sending.

## Wire verification

`scripts/probe-acp.mjs <offeredProtocolVersion> [label]` drives the
INSTALLED bridge over stdio: initialize (echo check), session/new
(vocabulary check), set_config_option in both spellings, a start-plan
switch, `providers/list`. Read `ZCODE_BIN`/`ZCODE_NODE` from the
environment; set `ZCODE_BIN` to the real CLI for a live-backend run.

## Records

Decision history, review rounds, and evidence captures live in the estate:
`~/.agents/spec-records/I31-zcode-in-t3code/T1-acp-adapter-integration/`
(implementation-decisions log + `proof/`).
