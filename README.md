# Polyth

polyth feature parity on a DeepSeek-Harness/Cordis-style "everything is a plugin" microkernel.

## Docs

- `CHANGELOG.md` — full project history from the initial commit, grouped by milestone, plus what is still open.
- `docs/dev/README.md` — how to build a new feature from zero (kernel, contracts, events, tests).
- `docs/dev/architecture.md` — current packages, protocol, event vocabulary, UI slot model.
- `docs/dev/parity.md` — feature-parity map vs polyth + Paseo, by product domain.
- `docs/dev/new-features.md` — implement-now catalog for the remaining web parity gaps.
- `docs/dev/implementation-order.md` + `docs/dev/HANDOFF.md` — sequenced work packages and the current handoff.
- `docs/dev/pr-index.json` — machine-readable disposition of every scanned upstream PR.
- `docs/parity/polyth-parity.yaml` — 209-row parity matrix (status per feature).

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
