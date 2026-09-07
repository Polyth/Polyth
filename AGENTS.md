# Polyth — agent rules

Polyth is a local web product for project-scoped OpenCode coding-agent sessions: a Node HTTP/WS server serves a React 19 SPA and persists every conversation as append-only SQLite events. Parity target is polyth/Paseo; `docs/parity/polyth-parity.yaml` still has `planned`/`implementing` rows — never describe those as done.

## Source-of-truth hierarchy

When documents conflict, resolve in this order:

1. The current runtime implementation and public type contracts (`packages/contracts`, `packages/web-sdk`, `packages/plugins`).
2. This file (`/AGENTS.md`) — architectural invariants.
3. `docs/dev/ui.md`, `docs/dev/components.md`, `docs/dev/widgets.md`, `docs/dev/styles.md` — specialized guides.
4. `docs/dev/README.md` (feature workflow) and `docs/dev/architecture.md` (deep reference).
5. Historical plans (`docs/dev/new-features.md`, `implementation-order.md`, `runtime-*-plan.md`, `HANDOFF.md`, `docs/PHASE-3-HANDOFF.md`) and `docs/parity/*` — never let a plan silently override an implementation doc.

## Memory

- Use the project memory (MemPalace) for important facts, decisions, constraints, and session outcomes: search it before recalling information about this repository or past work, and file durable updates after learning or changing something important.
- Do not rely on chat context alone for important knowledge. Record concise, actionable notes after meaningful sessions, including what changed, what was verified, and any follow-up needed.
- For browser verification, use the running project at `http://192.168.1.200:4400/` when it is available.

## Package map

- `apps/web` — the React 19 SPA **host shell**: shell components, registries, shared UI primitives, canonical tokens. Feature UI does NOT live here (see below).
- `apps/desktop` — Electron shell: boots the server on a loopback port, bundles OpenCode, packaging/release.
- `apps/mobile` — Capacitor shell: native client for an existing Polyth server; renders the same web build.
- `packages/contracts` — normative surface: DTOs, `SessionEvent`, `UiSlot`/`UI_SLOTS` (types + runtime exports: `cap`, `CAP`, `isUiSlot`, `MODEL_VISIBLE_TYPES`).
- `packages/kernel` — scoped plugin contexts: provide/inject capabilities, events/waterfalls, LIFO effect disposal, slot contributions.
- `packages/tenancy` — the Space (tenant) boundary: identity, Spaces, memberships, request→`SpaceContext` resolution, per-Space storage roots with canonical path validation, audit. Infrastructure, never discovered as a feature.
- `packages/session` — append-only `node:sqlite` WAL event store, projections, queue, `deriveMessages`.
- `packages/backend-opencode` — the ONLY OpenCode integration: spawns/attaches `opencode serve`, translates SSE to runtime events.
- `packages/server` — composition root: HTTP/WS gateway, `RouteHandler` chain, per-project runtime pool, broadcast, auth, static web.
- `packages/web-sdk` — **the supported feature/package UI integration seam**: `defineWebPackage`, `WebPackageHost` (slots, widgets, surfaces, workbench, resources, resource views, capabilities, settings, project context, reducers, store, navigation, ui, errors), `createApiTransport`.
- `packages/plugins` — server-side package seam: `ServerPackageHost` (routes, events, services, runtimes, oneShot/smallModel), package discovery via `polyth.serverEntry`.
- Feature packages (one dir each under `packages/`): permissions, goals, files, editor, git, commands, terminal, multirun, fusion, walkthrough, schedule, knowledge, github, usage, browser, dictation, models, hotkeys, plugins, ssh, secure-safe, home-assistant, task-trackers, workflow, example-feature.

Every browser feature package declares `"polyth": { "webEntry": "./widgets/index.tsx" }` and owns a `widgets/` dir (web entry + feature UI + `styles.css`). Every server feature package declares `"polyth": { "serverEntry": "./src/serverEntry.ts" }`. The build bundles each `widgets/index.tsx` into `packages/<id>/dist/web/` and publishes `/packages-manifest.json`; the shell loads catalog metadata, then activates only enabled packages (`defineWebPackage((host) => installer)`).

## Where each kind of code belongs

| Concern | Location |
|---|---|
| DTOs / event payloads / service interfaces | `packages/contracts/src/index.ts` |
| Feature service logic + package persistence | `packages/<feature>/src/index.ts` |
| Feature REST routes | `packages/<feature>/src/serverEntry.ts` (route handler + `routes:` on the returned `ServerPackage`); legacy routes may sit in `packages/server/src/routes/` — new feature routes belong to the package |
| Composition-root wiring (cross-cutting) | `packages/server/src/index.ts` (`boot()`) |
| Tenancy / Space enforcement | `packages/tenancy/src/`, `packages/server/src/{spaces,spaceScope}.ts` — never re-derived inside a feature |
| Feature web UI (views, widgets, settings pages, surfaces, slot contributions) | `packages/<feature>/widgets/` |
| Package web entry (registrations) | `packages/<feature>/widgets/index.tsx` — `defineWebPackage` |
| Shared shell components / primitives / registries | `apps/web/src/components/`, `apps/web/src/components/ui/`, `apps/web/src/*.ts` |
| Canonical design tokens | `apps/web/src/tokens.css` (contract), theme values in `apps/web/src/theme.ts` |
| Feature CSS | `packages/<feature>/widgets/styles.css` |
| Tests | `packages/<feature>/test/*.test.ts`, `apps/web/test/*.test.ts` |

## Styling (non-negotiable)

- Read `docs/dev/styles.md` before editing UI styles.
- Canonical tokens live in `apps/web/src/tokens.css`; the host owns this contract and packages inherit it. Never hardcode a color, spacing, radius, type, motion, or control value when a canonical token exists.
- Feature CSS is scoped under a stable package root in `packages/<feature>/widgets/styles.css`. Never add cross-package selectors, never redefine canonical tokens, never style another package's or the shell's components.
- Shared primitives (buttons, inputs, empty states, dialogs, menus, cards) live in `apps/web/src/styles.css` / `apps/web/src/components/ui/`; do not duplicate them in package CSS.
- Embedded panel/card content responds to container queries. Viewport media queries are reserved for shell-level behavior.
- Never add styles to `packages/server/src/http.ts` or edit `App.tsx` for styling.

## Non-negotiable rules

- Erasable TS only (Node >= 22.14; scripts enable type stripping explicitly): no enums, no namespaces, no parameter properties.
- Local imports use explicit `.ts`. Cross-package imports use workspace names (`@polyth/contracts`, `@polyth/web-sdk`, `@polyth/plugins`); every package's `exports` is `"." : "./src/index.ts"`.
- Only `packages/backend-opencode` may talk to the OpenCode process/SDK. Check with a repo-wide grep before committing (`grep -rn "opencode" packages/*/src packages/*/widgets` should only hit `backend-opencode` and config/string data).
- Everything model-visible is appended to the session event log BEFORE UI display; pure UI state stays out of the log.
- Event types are `domain/past-tense` with JSON payloads; unknown types are safely ignored by the reducer, never crash.
- Feature web UI registers through `@polyth/web-sdk` (`defineWebPackage`) — never edit `App.tsx`, `Main.tsx`, or host registries (`apps/web/src/slots.ts`, `widgets/catalog.ts`, `surfaces.ts`, `workspace/surfaceRegistry.ts`, `capabilities.ts`, `settings/registry.ts`) to expose a feature. Host edits are for host/core work only.
- Feature packages may import from `apps/web/src` ONLY the documented generic shell modules (store, reduce, i18n, `components/ui`, `widgets/catalog.ts`, …). The authoritative allowlist is the `GENERIC_SHELL_IMPORTS` set in `apps/web/test/packageContainment.test.ts` — anything else belongs in the package.
- New feature routes are `RouteHandler`s registered through the package's `serverEntry` (or the composition-root `routes` array) — never edit `packages/server/src/http.ts` for a feature.
- Secrets stay out of config and API responses (env-var names only; e.g. `mcp-secrets.json` values are never returned).

## Before editing X, read Y

| You are about to… | Read first |
|---|---|
| Touch any CSS / style / layout | `docs/dev/styles.md` |
| Add or change feature web UI | `docs/dev/ui.md` |
| Create/modify a component | `docs/dev/components.md` |
| Add a widget / change widget behavior | `docs/dev/widgets.md` |
| Add a feature or change its server surface | `docs/dev/README.md` |
| Change host shell, registries, or primitives | `docs/dev/ui.md` (host vs package boundary) + `docs/dev/architecture.md` |
| Change public contracts (`@polyth/contracts`, `@polyth/web-sdk`, `@polyth/plugins`) | find every consumer first (`grep -rln "@polyth/<name>" apps packages`) |
| Touch session events / `deriveMessages` | `docs/dev/architecture.md` (event vocabulary) |
| Store per-user data, read a resource by id, or add a route | `docs/architecture/spaces-and-tenancy.md` (the Space boundary) |

## Commands (repo root)

- Install: `npm install`
- Build: `npm run build` (web packages → `packages/*/dist/web`, shell → `apps/web/dist`)
- Start: `npm start` → `http://127.0.0.1:4400` (env: `PORT`, `POLYTH_DATA_DIR`; needs an installed `opencode` — found on PATH, in a documented install location such as `~/.opencode/bin`, or via a login-shell PATH probe. `POLYTH_OPENCODE_BIN` pins an exact binary; `POLYTH_OPENCODE_SHELL_PROBE=0` disables the shell probe. When none is found the reason and every location tried are logged and served from `/api/runtime/diagnostics`.)
- Dev: `npm run dev` = build once + start. No HMR.
- Watch: `npm run watch` (`scripts/supervisor.ts`) = build, start, then rebuild/restart on change and keep the server alive across crashes. `packages/*/src` changes restart only; `packages/*/widgets` and `apps/web/src` changes rebuild (reload the browser). Flags: `--watch=fs|git|both`, `--restart=auto|always`, `--pull`, `npm run watch -- --help`.
- Test: `npm test` (all) or `node --test <file>`; plain `node:assert`.
- Typecheck: no root script — run `npx tsc --noEmit` inside each touched package and `apps/web` (each extends `tsconfig.base.json`).
- Lint / format / CI: none exist in this repo. Do not invent them.

## Spaces (tenancy) — non-negotiable

A **Space** is Polyth's tenant: it owns projects, sessions, files, worktrees,
knowledge, secrets, integrations, and executions. It is a server-side security
boundary, never a client-side filter. (User-facing name is "Space" — "workspace"
already means UI layout here.) Full design: `docs/architecture/spaces-and-tenancy.md`.

- Every `/api` request resolves a `SpaceContext` in the gateway BEFORE any handler runs. Read it as `rc.space`.
- Route factories receive `SpaceServicesFor` (`(ctx) => SpaceServices`), not services. Call `spaces(rc.space)` inside the handler — never capture a service at construction time.
- There is no unscoped session/project service in the HTTP gateway. If you find yourself wanting one, you are about to write an IDOR.
- Never accept a `spaceId`/`tenantId` from a request body or query. The only inputs are the `X-Polyth-Space` header and the `polyth_space` cookie, and both are re-checked against membership.
- Cross-tenant access answers `not-found`, never `forbidden` — a distinguishable denial makes any id an existence oracle.
- Package state that a Space owns goes in `host.spaceStorage(ctx)`, not `host.storageDir` (which is the shared, deployment-wide root). Build paths with `spaceStorage(ctx).path(relative)` — it refuses traversal and symlink escape.
- Any cache, map, or key that can hold tenant data includes the `spaceId`.
- Branch on `host.deployment` (or the `allows*` helpers in `@polyth/contracts`), never on ad-hoc `if (cloud)` checks.
- New tenant-owned tables/files need a migration that adopts existing rows into the default Space, plus an isolation test using a KNOWN-VALID id from another Space.

## Never do

- Call OpenCode from any package except `backend-opencode`.
- Show model-visible content in the UI before it is in the event log.
- Use enums/namespaces/parameter properties or omit `.ts` on local imports.
- Edit `App.tsx`/`Main.tsx`/host registries to add a feature, or import a feature component into the host to "make it visible".
- Add a widget/settings page/surface by hand-wiring into `apps/web` when the `web-sdk` seam exists.
- Create a second implementation of a primitive that already exists in the host.
- Persist pure presentation preferences in the event log, or move model-visible state into transient React/browser state.
- Claim planned/implementing parity rows as shipped, or claim complete polyth/Paseo parity.
- Store or return secret values from any API.
- Load a resource by id and check its Space afterwards, authorize by `userId` instead of Space, or trust a client-supplied tenant id.
