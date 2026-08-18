# Polyth

polyth feature parity on a DeepSeek-Harness/Cordis-style "everything is a plugin" microkernel. See `docs/PLAN.md` (merged build contract) and `docs/parity/polyth-parity.yaml` (209-row parity matrix).

## Run

```bash
npm install
npm run build        # bundles apps/web
npm start            # http://127.0.0.1:4400 (spawns `opencode serve` per project)
```

Env: `PORT` (4400), `POLYTH_DATA_DIR` (./data), opencode binary on PATH.

## Test

```bash
npm test             # node --test across packages
POLYTH_REAL_OPENCODE=1 node --test packages/backend-opencode/test/adapter.test.ts  # live spawn smoke
```

## Layout

- `packages/contracts` — normative types (SessionEvent, AgentRuntime, SessionService, PluginContext). Type-only.
- `packages/kernel` — plugin loader, scoped contexts, reversible effects, typed events/waterfall, profile resolver.
- `packages/session` — append-only event store (node:sqlite WAL) + `deriveMessages`.
- `packages/backend-opencode` — the only package that talks to the opencode process.
- `packages/permissions` — monotonic fail-closed rule engine.
- `packages/server` — REST + WS gateway, session orchestration (runtime events → durable log → broadcast).
- `apps/web` — React 19 workspace UI (slot-registry extensible).
