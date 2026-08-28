# Polyth — agent rules

Polyth is a local web app for project-scoped OpenCode coding-agent sessions: a Node HTTP/WS server serves a React 19 SPA and persists every conversation as append-only SQLite events. Parity target is polyth/Paseo; `docs/parity/polyth-parity.yaml` still has `planned`/`implementing` rows — never describe those as done.

## Package map

- `apps/web` — the only app: React 19 SPA, esbuild bundle, typed UI-slot registry (`src/slots.ts`).
- `packages/contracts` — normative surface: DTOs, `SessionEvent`, service interfaces, `UiSlot` (types) plus runtime exports (`cap`, `CAP`, `UI_SLOTS`, `isUiSlot`, `MODEL_VISIBLE_TYPES`).
- `packages/kernel` — scoped plugin contexts: provide/inject capabilities, events/waterfalls, LIFO effect disposal, slot contributions.
- `packages/session` — append-only `node:sqlite` WAL event store, projections, queue, `deriveMessages`.
- `packages/backend-opencode` — the ONLY OpenCode integration: spawns/attaches `opencode serve`, translates SSE to runtime events.
- `packages/server` — composition root: HTTP/WS gateway, `RouteHandler` chain, per-project runtime pool, broadcast, auth, static web.
- Feature packages (one dir each under `packages/`): permissions, goals, files, git, commands, terminal, multirun, fusion, walkthrough, schedule, knowledge, github, usage, browser, dictation, models, hotkeys, plugins.

## Styling (non-negotiable)

- Read `docs/dev/styles.md` before editing UI styles.
- Canonical web tokens live in `apps/web/src/tokens.css`; the main web app owns this contract and packages inherit it.
- Package widget CSS extends the token contract only with package-scoped additions. Do not hardcode a color, spacing, radius, type, motion, or control value when a canonical token exists.
- Scope package selectors under the package root. Never add cross-package selectors or redefine canonical tokens in a package.
- Shared UI primitives such as empty states, buttons, cards, and control geometry live in core `apps/web/src/styles.css`; do not duplicate them in package CSS.
- Embedded panel and card content responds to container queries. Viewport media queries are reserved for shell-level behavior.
- Never add styles to `packages/server/src/http.ts` or edit `App.tsx` for styling.

## Non-negotiable rules

- Erasable TS only (Node >= 22.14; scripts enable type stripping explicitly): no enums, no namespaces, no parameter properties.
- Local imports use explicit `.ts`. Cross-package imports use workspace names (`@polyth/contracts`); every package's `exports` is `"." : "./src/index.ts"`.
- Only `packages/backend-opencode` may talk to the OpenCode process/SDK. Grep gate enforced.
- Everything model-visible is appended to the session event log BEFORE UI display; pure UI state stays out of the log.
- Event types are `domain/past-tense` with JSON payloads; unknown types are safely ignored by the reducer, never crash.
- New feature routes are `RouteHandler`s registered at the composition root — never edit `packages/server/src/http.ts` for a feature.
- UI extensions register through the slot registry — never edit `App.tsx` to add a slot item.
- Secrets stay out of config and API responses (env-var names only; e.g. `mcp-secrets.json` values are never returned).

## Commands (repo root)

- Install: `npm install`
- Build: `npm run build` (esbuild -> `apps/web/dist`)
- Start: `npm start` -> `http://127.0.0.1:4400` (env: `PORT`, `POLYTH_DATA_DIR`; needs `opencode` on PATH)
- Dev: `npm run dev` = build once + start. No watcher/HMR.
- Test: `npm test` (all) or `node --test <file>`; plain `node:assert`.
- Typecheck: no root script — run `npx tsc --noEmit` inside each touched package and `apps/web` (each extends `tsconfig.base.json`).
- Lint / format / CI: none exist in this repo. Do not invent them.

## Parity tooling

Feature-parity work needs both reference CLIs on PATH (`$HOME/.opencode/bin` + npm global bin): `curl -fsSL https://opencode.ai/install | bash` (opencode, v1.18.x) and `npm i -g @polyth/web` (polyth).

## Where things live

- Developer docs: `docs/dev/` — `README.md` (feature workflow), `architecture.md` (orientation + deep reference), `parity.md`, `new-features.md`, `implementation-order.md`, `HANDOFF.md`. Parity matrix: `docs/parity/polyth-parity.yaml`.
- Tests: `packages/*/test/*.test.ts`, `apps/*/test/*.test.ts`.
- Runtime data: `./data` (override `POLYTH_DATA_DIR`) — `sessions.db`, `knowledge.db`, `projects.json`, `behavior.md`, `mcp.json`, `auth.json`, …

## Never do

- Call OpenCode from any package except `backend-opencode`.
- Show model-visible content in the UI before it is in the event log.
- Use enums/namespaces/parameter properties or omit `.ts` on local imports.
- Claim planned/implementing parity rows as shipped, or claim complete polyth/Paseo parity.
- Store or return secret values from any API.
