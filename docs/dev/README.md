# Developing a Polyth feature from zero

This is the working contract for adding features to Polyth. It describes the seams a
feature must use, the invariants it must keep, and the checklist that makes a change
mergeable. Read `architecture.md` for the system as it exists, `parity.md` for what is
missing, `new-features.md` for the implement-now catalog, `tracks.md` for the
spec-driven track lifecycle, `desktop.md` for Electron packaging and release
operations, and `implementation-order.md` for sequencing.

## The one-paragraph mental model

Polyth is a web product on a plugin microkernel. A tiny composition root
(`packages/server/src/index.ts`) wires capability providers (session store, projects,
permissions, runtime pool) into a kernel context, then hands feature packages three
seams: a **RouteHandler** for REST, an **append+broadcast** function for durable events,
and (client-side) a **typed UI slot**. Every conversation is an append-only
`SessionEvent` log in SQLite; the web app is a projection of that log delivered over one
WebSocket. Only `packages/backend-opencode` may talk to the OpenCode process.

## Ground rules (violating any of these fails review)

1. **Erasable TypeScript only.** Node 22 strips types at runtime: no `enum`, no
   `namespace`, no parameter properties, no `const enum`. Local imports always carry the
   explicit `.ts` extension (`import { x } from "./y.ts"`). Cross-package imports use
   workspace names (`import type { SessionEvent } from "@polyth/contracts"`), resolved by
   npm workspaces via each package's `"exports": { ".": "./src/index.ts" }`.
2. **Only `packages/backend-opencode` talks to OpenCode.** No other package may import
   the OpenCode SDK, spawn `opencode`, or hit its HTTP API. A grep gate enforces this.
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
| REST endpoints | `packages/server/src/routes/<feature>.ts` as a `RouteHandler` |
| Wiring / composition | `packages/server/src/index.ts` (`boot()`) |
| WS fan-out | `packages/server/src/ws.ts` (extend only for new stream kinds) |
| Web UI views/components | `apps/web/src/components/` |
| Web client state | `apps/web/src/store.ts` (+ `reduce.ts` render model) |
| Client API wrappers | `apps/web/src/api.ts` |
| UI slot registrations | `registerSlot()` from `apps/web/src/slots.ts` |
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
`"exports": { ".": "./src/index.ts" }`), a `tsconfig.json` extending
`../../tsconfig.base.json`, `src/index.ts`, and `test/`. The service is a factory
function taking its dependencies as an options object — never importing the server:

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
  `prefs.ts`. Server-owned settings (shared across devices) go through a settings
  route + package store instead — decide by asking "should another device see this?".

### 3. Expose REST routes

Add `packages/server/src/routes/<name>.ts` exporting a `RouteHandler` factory. The
handler pattern-matches path+method and returns `true` when handled:

```ts
export function fooRoutes(foo: FooService): RouteHandler {
  return async ({ path, method, json, body }) => {
    if (path === "/api/foo" && method === "GET") { json(200, await foo.list()); return true; }
    return false;
  };
}
```

Register it in the `routes` array in `boot()`. Validate ownership on every mutating
endpoint (project/session ids must exist and match), reject path traversal, and never
derive URLs from the `Host` header. Throw `Object.assign(new Error(msg), { code })` for
typed failures.

### 4. Emit durable events + broadcast

If the feature produces model-visible or session-relevant state, inject an appender the
way `boot()` does for knowledge/schedule/review:

```ts
append: async (sessionId, type, data) => {
  const ev = await store.append(sessionId, type, data, { ignorable: true, producerPlugin: "foo" });
  broadcast.event(ev);
  return ev;
},
```

`store.append` allocates the per-session `seq` transactionally; `broadcast.event` fans
out over `/ws`. Clients that were offline recover the same events via gap-fill
(`GET /api/sessions/:id/events?afterSeq=` or the WS `subscribe` message) — you get
reconnect safety for free by staying on this path.

### 5. Build the UI

- Full-screen surface → add a component under `apps/web/src/components/`, extend the
  `AppView` union in `store.ts`, and add the view branch in `Main.tsx` + nav entry.
- Right-rail panel → extend the `RailPlugin` union and `ContextRail.tsx` (or contribute
  through the `contextRail.tabs` slot).
- Injection point inside existing UI → use `registerSlot(slot, id, render, order)` with
  a typed `UiSlot` (`composer.leading`, `session.message.actions`,
  `settings.pages`, `commandPalette.commands`, `workStatus.sections`, …). Adding a new
  slot means extending the `UiSlot` union in contracts and rendering
  `renderSlot("your.slot", props)` at the injection point — never importing feature
  components directly into `App.tsx`.
- Events → state: the client receives `{ type: "event" | "projection" }` messages; add
  reducer logic in `apps/web/src/reduce.ts` so the render model derives from events
  (same replay guarantee as the server).
- Commands & shortcuts → register palette commands (`apps/web/src/commands.ts`) and, if
  a default binding makes sense, a `CommandDescriptor.defaultShortcut`; users can rebind
  in Settings → Shortcuts.
- Settings → contribute a page through the `settings.pages` slot and item descriptors
  (`SettingsSearchItem`) so item-level settings search keeps working.

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
npm run build        # bundles apps/web with esbuild
npm start            # http://127.0.0.1:4400, spawns `opencode serve` per project
npm test             # node --test across all packages
```

Env: `PORT` (4400), `POLYTH_DATA_DIR` (./data), `POLYTH_SMALL_MODEL`
("provider/model" for auditors, commit messages, recaps), `POLYTH_FAKE_QUOTAS=1`,
`POLYTH_FAKE_BROWSER=1`, `POLYTH_CHROMIUM_PATH`, `POLYTH_TUNNEL_URL`,
`POLYTH_TRUSTED_PLUGIN_DIR`. OpenCode CLI (v1.18.x) must be on `PATH`
(`$HOME/.opencode/bin`); polyth (`npm i -g @polyth/web`) is used for
side-by-side parity comparison, not at runtime.
