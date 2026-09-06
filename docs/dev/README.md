# Developing a Polyth feature from zero

This is the working contract for adding features to Polyth. It describes the seams a
feature must use, the invariants it must keep, and the checklist that makes a change
mergeable. Read `architecture.md` for the system as it exists, `ui.md` for the web
UI extension architecture (host vs package boundary, slots, surfaces, settings,
capabilities), `components.md` for the component contract, `widgets.md` for widgets,
`styles.md` for canonical styling, `parity.md` for what is missing,
`new-features.md` for the historical implement-now catalog (F-numbers; all shipped),
`tracks.md` for the spec-driven track lifecycle, `desktop.md` for Electron packaging
and release operations, and `implementation-order.md` for sequencing.

## The one-paragraph mental model

Polyth is a web product on a plugin microkernel. A tiny composition root
(`packages/server/src/index.ts`) wires capability providers (session store, projects,
permissions, runtime pool) into a kernel context, then hands feature packages two
seams: a **server package seam** (`@polyth/plugins` `ServerPackageHost`: RouteHandler
routes, append+broadcast events, services, runtimes) and a **web package seam**
(`@polyth/web-sdk` `WebPackageHost`: slots, widgets, surfaces, capabilities, settings,
project context, reducers, navigation). Every conversation is an append-only `SessionEvent` log in
SQLite; the web app is a projection of that log delivered over one WebSocket. Only
`packages/backend-opencode` may talk to the OpenCode process. Feature web UI lives in
the feature package and registers through the web-sdk — see `ui.md` before any UI
work.

## Ground rules (violating any of these fails review)

1. **Erasable TypeScript only.** Node 22 strips types at runtime: no `enum`, no
   `namespace`, no parameter properties, no `const enum`. Local imports always carry the
   explicit `.ts` extension (`import { x } from "./y.ts"`). Cross-package imports use
   workspace names (`import type { SessionEvent } from "@polyth/contracts"`), resolved by
   npm workspaces via each package's `"exports": { ".": "./src/index.ts" }`.
2. **Only `packages/backend-opencode` talks to OpenCode.** No other package may import
   the OpenCode SDK, spawn `opencode`, or hit its HTTP API. Verify with a repo-wide
   grep before committing (`grep -rn "opencode" packages/*/src packages/*/widgets`
   should only hit `backend-opencode` and config/string data).
   If your feature needs a model call, use the seams the server already exposes:
   `oneShot(runtime, …)` for utility completions or `sessions.send(...)` for
   conversational turns.
3. **Append before display.** Anything the model can see — user text, tool output,
   attached knowledge, browser page text, generated reviews, transcripts — must be
   appended to the session event log *before* it is shown in the UI or sent to the
   runtime. Pure UI state (layout, quota polling, file reads for browsing) must NOT
   pollute the log. If in doubt: would replaying the log reproduce what the model knew?
4. **Contracts first.** New DTOs, event payloads, and service interfaces go in
   `packages/contracts/src/index.ts` (type-only, JSON-serializable). The web app and
   server share these shapes; `apps/web/src/api.ts` only wraps fetch calls around them.
   Additions must be backward compatible: optional fields, new event types (old clients
   ignore unknown types), never repurposed fields.
5. **Fail closed, degrade honestly.** Permission checks deny by default. Missing
   engines (Chromium, STT) report an honest capability state instead of pretending.
   Errors carry a `code` (`not-found`, `invalid-input`, `conflict`, `unsupported`) that
   `http.ts` maps to a status.

## Where each kind of code lives

| Concern | Location |
|---|---|
| Types / DTOs / event payloads | `packages/contracts/src/index.ts` |
| Kernel (contexts, plugin loader) | `packages/kernel` — rarely changes |
| Durable session log + projections | `packages/session` (node:sqlite, WAL) |
| Feature services (pure logic + own persistence) | `packages/<feature>/src/index.ts` |
| Feature REST routes | `packages/<feature>/src/serverEntry.ts` (route handler + `routes:` on the returned `ServerPackage`); legacy routes sit in `packages/server/src/routes/` — new feature routes belong to the package |
| Wiring / composition | `packages/server/src/index.ts` (`boot()`) |
| WS fan-out | `packages/server/src/ws.ts` (extend only for new stream kinds) |
| Feature web UI (views, widgets, settings pages, surfaces, slot contributions) | `packages/<feature>/widgets/` |
| Package web entry (registrations) | `packages/<feature>/widgets/index.tsx` — `defineWebPackage` from `@polyth/web-sdk` |
| Host shell / shared primitives / registries | `apps/web/src/components/`, `apps/web/src/components/ui/`, `apps/web/src/*.ts` (host work only — see `ui.md`) |
| Web client state | `apps/web/src/store.ts` (+ `reduce.ts` render model) |
| Client API wrappers | `apps/web/src/api.ts`; package UI may use `createApiTransport` from `@polyth/web-sdk` |
| UI slot registrations | `host.slots.register(...)` through `@polyth/web-sdk` (never `apps/web/src/slots.ts` directly) |
| Electron host / native IPC / packaging | `apps/desktop` |
| Tests | `packages/<feature>/test/*.test.ts`, `apps/web/test/*.test.ts` |

## Step-by-step: adding a feature

### 1. Define the contract

Add DTOs and (if the model can see the data) event payload interfaces to
`@polyth/contracts`. Keep everything JSON-serializable. Name events
`domain/past-tense-verb` (`knowledge/attached`, `queue/enqueued`,
`browser/action-completed`). If the event should not feed model-history derivation, the
appender passes `{ ignorable: true }` — the type stays in the log but
`deriveMessages()` skips it.

### 2. Build the service package

Create `packages/<name>` with `package.json` (`"name": "@polyth/<name>"`,
`"exports": { ".": "./src/index.ts" }`, and the `polyth` markers:
`"serverEntry": "./src/serverEntry.ts"` when the feature has a server
surface, `"webEntry": "./widgets/index.tsx"` when it has web UI, plus the
`descriptor` block with name/description/core/enabled/hasSettings), a
`tsconfig.json` extending `../../tsconfig.base.json`, `src/index.ts`, and
`test/`. The service is a factory function taking its dependencies as an
options object — never importing the server:

```ts
export interface FooService { list(): Promise<FooDto[]>; /* … */ }
export function createFooService(opts: {
  file: string;                                  // package-owned persistence
  append?: (sessionId: string, type: string, data: JsonObject) => Promise<SessionEvent>;
}): FooService { /* … */ }
```

Persistence rules:
- Long-lived server records → `node:sqlite` (own DB file under the data dir, like
  `packages/knowledge`) or a package-owned JSON file with atomic writes (like
  `packages/schedule`). Schema changes are forward-only and covered by a reopen test.
- Session-scoped truth → the event log via the injected `append` (never write your own
  session tables).
- Browser-only preferences → namespaced localStorage keys in the web app
  (`polyth.<area>.<key>`), via `apps/web/src/settings.ts` / `uiPrefs.ts` /
  `prefs.ts`; widget placement/config is browser-local per project under
  `polyth.widgetLayout.<projectId>`. Server-owned settings (shared across devices) go
  through a settings route + package store instead — decide by asking "should another
  device see this?".

### 3. Expose REST routes

Declare `"polyth": { "serverEntry": "./src/serverEntry.ts" }` in the package
manifest and export a `registerPackage(host)` factory from it (see
`packages/example-feature/src/serverEntry.ts` — the minimal template). The
returned `ServerPackage` carries `routes:` (a `RouteHandler`), and the
package is discovered and wired automatically; routes are added while the
package is enabled and removed when disabled. The handler pattern-matches
path+method and returns `true` when handled:

```ts
// packages/<name>/src/serverEntry.ts
import type { RouteHandler } from "@polyth/contracts";
import type { ServerPackage, ServerPackageHost } from "@polyth/plugins";

export function fooRoutes(host: ServerPackageHost): RouteHandler {
  return async ({ path, method, json, body }) => {
    if (path === "/api/foo" && method === "GET") { json(200, await foo.list()); return true; }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  return { routes: fooRoutes(host) };
}
```

Cross-cutting routes that do not belong to one package may still be
registered in the `routes` array in `boot()`. Validate ownership on every
mutating endpoint (project/session ids must exist and match), reject path
traversal, and never derive URLs from the `Host` header. Throw
`Object.assign(new Error(msg), { code })` for typed failures.

### 4. Emit durable events + broadcast

If the feature produces model-visible or session-relevant state, append
through the package host's persist-then-broadcast seam:

```ts
// inside a package service (via host.events, captured in registerPackage):
append: async (sessionId, type, data) =>
  host.events.append(sessionId, type, data, { ignorable: true, producerPlugin: "foo" }),
```

`host.events.append` persists the event to the session log (allocating the
per-session `seq` transactionally), then broadcasts it over `/ws`. Clients
that were offline recover the same events via gap-fill
(`GET /api/sessions/:id/events?afterSeq=` or the WS `subscribe` message) —
you get reconnect safety for free by staying on this path. Cross-cutting
services wired directly in `boot()` use the same shape
(`store.append` + `broadcast.event`, as knowledge/schedule/review do).

### 5. Build the UI

Feature UI lives in `packages/<feature>/widgets/` and registers through
`@polyth/web-sdk` in `widgets/index.tsx` — see `docs/dev/ui.md` for the full
decision table and `docs/dev/widgets.md` for widgets. The mechanisms:

- Full main-area module (Fusion, Walkthrough, Goals-style) → register a
  **package-window surface** with `host.surfaces.register(...)` (the
  `AppView` switch is gone; `Main.tsx` is shell composition only).
- Right-rail panel → **rail surface** with `host.surfaces.register(...)`, or
  a `workspace.right.tabs` slot contribution (Knowledge's Tracks panel).
- Injection point inside existing UI → `host.slots.register({ slot, id,
  render, order, meta })` with a typed `UiSlot` (`composer.leading`,
  `session.message.actions`, `settings.pages`, `commandPalette.commands`,
  `workStatus.sections`, …). Adding a new slot is host/contract work
  (`UI_SLOTS` in contracts + a `SlotHost` mount) — never import feature
  components directly into `App.tsx`.
- User-placeable dashboard content → **widget** via
  `host.widgets.registerPlugin(...)` (`widgets.md`).
  Mark `recommended: true` when the widget should appear in the Widget
  Library recommended tab; recommendations merge across packages.
- Settings → `host.settings.registerPage(...)` (group `Workspace |
  Engineering | Customize | System`) plus `host.settings.registerItems(...)`
  so item-level settings search keeps working.
- Discoverable "open this feature" entry → `host.capabilities.register(...)`
  (feeds header, rails, command search, Settings from one model).
- Events → state: the client receives `{ type: "event" | "projection" }`
  messages; the shell's `apps/web/src/reduce.ts` derives the render model.
  Package event handling belongs in the built-in reducer only for
  shell-level state; package UI can register a client reducer with
  `host.reducers.register(eventType, reducer)` (pure, DOM-free).
- Commands & shortcuts → `commandPalette.commands` slot contribution
  (bridged by the shell) with `CommandDescriptor.defaultShortcut` for
  default bindings; users rebind in Settings → Shortcuts.

### 6. Test

- Unit-test the service package: `node --test packages/<name>/test/<name>.test.ts`,
  plain `node:assert`. No test frameworks, no mocking libraries — inject fakes through
  the factory options.
- DOM-free UI logic (reducers, stores, matchers) is tested the same way under
  `apps/web/test/`.
- Route logic that needs the session store gets an in-memory store
  (`createStore(":memory:")`).
- The full suite must stay green: `npm test`.
- Typecheck per package: `npx tsc --noEmit` in the package dir (each `tsconfig.json`
  extends the base config). There is no repo-root typecheck.
- Live OpenCode smoke (optional, needs the CLI):
  `POLYTH_REAL_OPENCODE=1 node --test packages/backend-opencode/test/adapter.test.ts`.

### 7. Update the parity matrix

If the feature closes or advances a row in `docs/parity/polyth-parity.yaml`, update the
row's `status`, `tests`, and `notes`. Do not add rows for internal refactors.

## Runbook

```bash
npm install
npm run build        # package web entries (packages/*/dist/web) + apps/web shell
npm start            # http://127.0.0.1:4400, spawns `opencode serve` per project
npm test             # node --test across all packages
```

`http://127.0.0.1:4400` is the canonical active instance for this repo. Only one
server may own a data directory at a time — a second instance (e.g. started from
a worktree) fails the `data-directory-locked` check and must not shadow the
active port (an instance bound to `:4401` has no projects and cannot create
sessions; kill it and use `:4400`).

Env: `PORT` (4400), `POLYTH_DATA_DIR` (./data), `POLYTH_SMALL_MODEL`
("provider/model" for auditors, commit messages, recaps), `POLYTH_FAKE_QUOTAS=1`,
`POLYTH_FAKE_BROWSER=1`, `POLYTH_CHROMIUM_PATH`, `POLYTH_TUNNEL_URL`,
`POLYTH_TRUSTED_PLUGIN_DIR`. OpenCode CLI (v1.18.x) must be on `PATH`
(`$HOME/.opencode/bin`); polyth (`npm i -g @polyth/web`) is used for
side-by-side parity comparison, not at runtime.
