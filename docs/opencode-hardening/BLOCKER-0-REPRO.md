# BLOCKER 0 — V2 adapter stubs the model catalog to `[]` (P0 reproduction)

Status: reproduced against a real OpenCode 1.18.18 server, 2026-08-28.

## One-line summary

On a healthy, credentialed OpenCode 1.18.18 backend that serves 68 models across 2
connected providers, Polyth auto-negotiates protocol V2 and returns `[]` from
`/api/models`, `/api/providers`, and `/api/agents`, so the composer shows
"No models available — check that the backend is running and configured" and send is
disabled. The backend is fine; the emptiness is manufactured by
`packages/backend-opencode/src/protocolV2.ts`, whose `models()`, `agents()`, and
`sessions()` are hardcoded to return `[]`.

## Versions

- opencode 1.18.18 (`/home/ubuntu/.local/bin/opencode`)
- Node v22.22.2, Linux x86_64
- Polyth branch `feat/opencode-real-world-validation-17e1`
- Credentials present in env: `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`
  (auto-detected by opencode → provider `google` connected), plus OpenCode Zen free
  models (provider `opencode`).

## Root cause chain (code)

1. `opencode serve` 1.18.18 exposes BOTH surfaces in one `/doc` (OpenAPI 3.1.0, 162
   paths): legacy (`/provider`, `/config/providers`, `/session`, `/global/health`)
   and V2 (`/api/model`, `/api/provider`, `/api/agent`, `/api/session`,
   `/api/session/{sessionID}/prompt`, `/api/event`).
2. `hasV2ProtocolDocument` (`protocolV2.ts`) returns true because `/doc` contains
   `/api/session` and `/api/session/{sessionID}/prompt`.
3. `createProtocolAdapter` (`protocol.ts`) with the product default
   `protocol: "auto"` therefore selects **v2** (`packages/backend-opencode/src/index.ts`
   defaults `options.protocol ?? "auto"`; there is no env/config escape hatch wired
   into `npm start`).
4. The V2 adapter is a deliberate stub: `models()`, `agents()`, `sessions()` return
   `[]`; every mutation is rejected with `capability-unsupported`
   ("disabled until its beta contract is pinned").
5. `/api/models` in `packages/server/src/http.ts` → `runtimeCatalog.models()` →
   `runtime.models()` → V2 stub → `[]`.
6. `apps/web/src/components/Composer.tsx` renders
   `composer.noModelsAvailableCheckThatTheBackend` ("No models available — check that
   the backend is running and configured.") whenever the catalog is empty, and Enter
   is a guarded no-op.

## Reproduction commands

```sh
# 1. Real OpenCode server (any cwd; keys already in env)
opencode serve --hostname 127.0.0.1 --port 14711

# 2. Backend truth: V2 catalog is populated
curl -s 'http://127.0.0.1:14711/api/model?directory=/workspace'    # 68 models
curl -s 'http://127.0.0.1:14711/api/provider?directory=/workspace' # google + opencode

# 3. Polyth with default (auto) protocol
PORT=14400 POLYTH_DATA_DIR=/tmp/polyth-blocker0-data npm start
curl -s -X POST http://127.0.0.1:14400/api/projects \
  -H 'content-type: application/json' -d '{"path":"/workspace"}'

# 4. Polyth product APIs — all empty despite the healthy backend
curl -s 'http://127.0.0.1:14400/api/models'        # []
curl -s 'http://127.0.0.1:14400/api/models?all=1'  # []
curl -s 'http://127.0.0.1:14400/api/providers'     # []
curl -s 'http://127.0.0.1:14400/api/agents'        # []
```

Polyth's own spawned backend (`opencode serve --port 34599`, visible in `ps`) was
queried directly at the same moment: `GET /api/model` → 68 models. The Polyth server
log confirms V2 was negotiated ("v2 event streaming is not contract-tested").

## Expected vs observed

| Surface | Expected | Observed |
| --- | --- | --- |
| OpenCode `GET /api/model` | populated | 68 models (google 39, opencode 29) |
| OpenCode `GET /api/provider` | populated | 2 providers (google, opencode) |
| OpenCode `GET /api/agent` | populated | 7 agents (build, plan, general, explore, compaction, title, summary) |
| Polyth `GET /api/models` (+`?all=1`) | 68 models | `[]` |
| Polyth `GET /api/providers` | 2 providers | `[]` |
| Polyth `GET /api/agents` | 7 agents | `[]` |
| Web composer | model picker usable | "No models available — check that the backend is running and configured.", send disabled |

Adapter isolation (same live endpoint, `artifacts/.../adapter-compare.txt`):
auto-negotiation → `v2`; V2 adapter `models()` → 0; legacy adapter `models()` → 7382
(legacy `/provider` returns the whole models.dev catalog of 204 providers; `connected`
lists exactly `["google","opencode"]`).

This also rules out the "catalog genuinely empty upstream" explanation: upstream has
models AND, even if it did not, the legacy adapter would still return the available
catalog while V2 returns a compile-time `[]` without issuing any HTTP request
(`void options.transport` — the transport is never used).

Verdict: this is BLOCKER 0. Model discovery is a read-only listing that the real
1.18.18 server serves correctly (`GET /api/model`, `GET /api/provider`, and
`POST /api/session` all work — see `v2-session-create.json`). Stubbing it to `[]` is
not an acceptable "unsupported capability"; it makes a healthy backend look broken
and disables the composer entirely.

## Real OpenCode 1.18.18 V2 discovery contract (for the implementation agent)

All V2 reads take `?directory=<abs path>` and wrap payloads in a
`{ location: {directory, project}, data }` envelope. Raw captures live in
`artifacts/opencode-real-world/blocker-0-repro/`.

| Purpose | Method + path | operationId | Notes |
| --- | --- | --- | --- |
| Health | `GET /api/health` | `v2.health.get` | `{"healthy":true}` — no protocol marker field |
| Models | `GET /api/model` | `v2.model.list` | `data[]`: `id`, `providerID`, `name`, `api`, `capabilities`, `request`, `variants`, `time`, `cost`, `status` (incl. `"deprecated"`), `enabled`, `limit` |
| Providers | `GET /api/provider` | `v2.provider.list` | `data[]`: `id`, `name`, `api{type,package,url?}`, `request` — only ACTIVE (connected) providers |
| One provider | `GET /api/provider/{providerID}` | `v2.provider.get` | |
| Agents | `GET /api/agent` | `v2.agent.list` | `data[]`: `id` (not `name`), `mode`, `hidden`, `permissions`, `description` |
| Session list | `GET /api/session` | `v2.session.list` | cursor-paged (`cursor.next`/`cursor.previous`) |
| Session create | `POST /api/session` | `v2.session.create` | body `{}` ok; returns `data.id` (`ses_…`), `projectID`, `time`, `location` |
| Prompt | `POST /api/session/{sessionID}/prompt` | `v2.session.prompt` | "Durably admit one session input…" |
| Events | `GET /api/event` | `v2.event.subscribe` | native event stream |
| Legacy models | `GET /config/providers` | `config.providers` | connected only: google 38 + opencode 6 models, plus `default` map |
| Legacy full catalog | `GET /provider` | `provider.list` | 5.7 MB: `all` (204 providers / 7382 models), `connected: ["google","opencode"]`, `default` |

Key difference the fix must respect: legacy `/provider` returns the entire models.dev
catalog with a separate `connected` list, while V2 `/api/model` / `/api/provider`
return only usable (configured) entries, already flattened, in the `{location, data}`
envelope.

## Evidence

- Raw captures: `artifacts/opencode-real-world/blocker-0-repro/`
  (`opencode-doc.json`, `v2-models.json`, `v2-providers.json`, `v2-agents.json`,
  `v2-session-create.json`, `v2-session-list.json`, `legacy-config-providers.json`,
  `legacy-provider-summary.json`, `polyth-api-*.json`,
  `polyth-spawned-backend-v2-models.json`, `adapter-compare.txt`, `versions.txt`,
  `process-info.txt`, `v2-api-contract-summary.json`). All scanned against every
  API key in the environment — no secret values present. Note: `v2-providers.json`
  contains a `request.body.apiKey` field for the OpenCode Zen free tier; it is a
  public placeholder, not a credential, and is stripped from the fixture below.
- Server logs: `logs/opencode-real-world/blocker-0-repro/`
  (`opencode-serve.log`, `polyth-server.log`).
- Sanitized fixture for the implementer (3 models + 2 providers, `request.body`
  stripped): `packages/backend-opencode/test/fixtures/opencode-v2-model-catalog.json`.
