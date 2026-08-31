# Polyth UI extension architecture

Authoritative guide for **where web UI code belongs and how it gets into the
running app**. Read this before adding or changing any feature web UI; read
`components.md` before creating or modifying a component, `widgets.md` before
adding a widget, and `styles.md` before touching CSS.

The rule in one sentence: **the host (`apps/web`) owns the shell and the
shared primitives; feature UI lives in its package and registers through
`@polyth/web-sdk`.** If you are about to edit `apps/web` to expose a feature,
you are almost certainly on the wrong path — re-read this document.

## 1. Core host vs package UI

`apps/web` owns:

- the application shell (`App.tsx`, `Main.tsx`, `Sidebar`, `Header`,
  `ContextRail`, `Timeline`, `Composer`, dialogs/overlays);
- the extension registries (`slots.ts`, `widgets/catalog.ts`, `surfaces.ts`,
  `workspace/surfaceRegistry.ts`, `capabilities.ts`, `settings/registry.ts`,
  `packages/reducers.ts`) and their hosts (`components/slots/SlotHost.ts`,
  `components/workspace/WorkspaceHost.ts`, `components/ContextRail.tsx`,
  `widgets/WidgetCanvas.tsx`);
- shared UI primitives (`components/ui/*`, `components/a11y/*`,
  `components/EmptyState.tsx`, `components/CopyButton.tsx`, …);
- canonical tokens and core CSS (`tokens.css`, `theme.ts`, `styles.css`);
- host-level behavior (navigation, routing, sync, mobile shell, auth).

Feature packages own:

- their feature UI components and views (`packages/<feature>/widgets/`);
- their package CSS (`packages/<feature>/widgets/styles.css`);
- their registrations (settings pages, surfaces, widgets, capabilities, slot
  contributions) — declared in `packages/<feature>/widgets/index.tsx`.

`@polyth/web-sdk` is **the supported feature/package UI integration seam**.
It is a bounded host handle: feature packages receive a `WebPackageHost` and
never import the host's internal registries to register themselves. The
`WebPackageHost` type and every registration shape are defined in
`packages/web-sdk/src/index.ts` — that file is the public API contract for
package UI, and the host implementation that backs it is
`apps/web/src/packages/webHost.ts`.

Feature packages **must not** patch host internals to expose their UI: no
edits to `App.tsx`, `Main.tsx`, host registries, or the host's built-in
contribution files. A feature's UI is "integrated" only when it is registered
through the web-sdk seam (see §3).

## 2. How a package's UI reaches the running app

1. The package declares `"polyth": { "webEntry": "./widgets/index.tsx" }` in
   its `package.json` (enforced by `apps/web/test/packageContainment.test.ts`).
2. The build (`npm run build`, `apps/web/buildPackages.ts` +
   `apps/web/webPackages.ts`) bundles that entry into
   `packages/<id>/dist/web/entry.js` (+ CSS) and the shell publishes
   `/packages-manifest.json` listing every package entry.
3. At boot, `apps/web/src/packages/webEntries.ts` fetches the manifest and
   imports every entry; `apps/web/src/packages/registry.ts` (`bootPackages()`)
   then calls each entry's default export — `defineWebPackage((host) => installer)`
   — only for packages enabled via `/api/packages`, and stores the returned
   installer.
4. The installer runs its registrations and **must return a dispose function**;
   registry.ts calls it when the package is disabled or unloaded.

Each package web entry is a separate esbuild bundle. Imports of the
documented generic shell modules (see §10) are externalized to the shell
bundle, so package code shares the shell's stateful stores, registries, and
helpers instead of cloning them.

### Package web entry skeleton (current API)

```tsx
// packages/<feature>/widgets/index.tsx
import "./styles.css";                       // package CSS loads with the entry
import { defineWebPackage } from "@polyth/web-sdk";
import MyView from "./MyView.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "myfeature", packageId: "myfeature",
      label: "My Feature", group: "Workspace", icon: "◈", order: 50,
      component: MyView }),
    host.capabilities.register({ id: "myfeature", label: "My feature",
      plainDescription: "One-line description for search.",
      keywords: ["my", "feature"], standardTier: "more", standardRank: 20,
      open: () => host.navigation.openSettingsPage("myfeature"),
      available: () => true }),
  ];
  // Deterministic disposal: reverse registration order; every register*()
  // returns an Unregister that is idempotent and identity-based.
  return () => off.toReversed().forEach((dispose) => dispose());
});
```

Note the shape: `defineWebPackage(entry)` where `entry(host)` returns an
**installer function** (the outer `() => { ... }`); the installer itself
returns the dispose function. Every `host.*.register*` call returns an
`Unregister`. Unregister order matters for dependencies (dispose
registrations in reverse order), and `combineUnregister` in
`apps/web/src/packages/settingsPage.ts` is the host's reference
implementation of the same pattern.

## 3. Decision table: which mechanism

| Need | Correct mechanism |
|---|---|
| Package settings page | `host.settings.registerPage(...)` (web-sdk) |
| Searchable rows inside any settings page | `host.settings.registerItems(...)` or `settingsItems` on the page |
| Small UI at an existing injection point (message actions, header, composer, timeline…) | `host.slots.register({ slot: <existing UiSlot>, … })` |
| Right-rail panel (Context/Knowledge/Usage/Events-style) | `host.surfaces.register(...)` (rail surface) |
| Full main-area module (AppView-style: Fusion, Walkthrough, Goals…) | `host.workspaceSurfaces.register(...)` (workspace surface) |
| User-placeable dashboard block | widget — `host.widgets.register` / `host.widgets.registerPlugin(...)` (see `widgets.md`) |
| Discoverable "open this feature" navigation entry | `host.capabilities.register(...)` |
| Client-side handling of a package event type | `host.reducers.register(eventType, reducer)` |
| Shared app-wide visual primitive (button, dialog, menu…) | host core UI (`apps/web/src/components/ui/` + `styles.css`) |
| Feature-specific reusable component | package-owned component in `packages/<feature>/widgets/` |
| New global extension seam (a slot that doesn't exist) | host/web-sdk change (§5) — not a per-feature decision |
| REST endpoint | feature `RouteHandler` via `polyth.serverEntry` (see `README.md`) |
| Model-visible durable state | session event (append before display) |
| Browser-only preference | `localStorage` under `polyth.<area>.<key>` (widget layout: `polyth.widgetLayout.<projectId>`) |
| Shared server setting (other devices must see it) | server/package settings persistence + route |

When two mechanisms look plausible, prefer the one with the smallest blast
radius: slot contribution over surface, surface over workspace surface,
settings page over new overlay. A widget is for user-configurable content;
if the content is not user-placeable/duplicatable, it is not a widget.

## 4. The seams in detail

### 4.1 Slot contributions (`host.slots.register`)

```tsx
host.slots.register({
  slot: "session.message.actions",   // a UiSlot from @polyth/contracts
  id: "myfeature.quote",             // stable, unique within the slot
  render: (props) => <QuoteAction {...props} />,
  order: 20,                         // optional; order then id, deterministically
  meta: { /* host-defined descriptors, e.g. commandPalette.commands payloads */ },
});
```

- The `UiSlot` union lives in `packages/contracts/src/index.ts`
  (`UI_SLOTS` runtime array, `UiSlot` type, `isUiSlot` guard). A slot exists
  only if it is in that list.
- **Who renders:** host components mount `SlotHost slot="…"` (e.g.
  `Timeline.tsx` mounts `session.timeline.before/after` and
  `session.message.actions`; `Composer.tsx` mounts `composer.leading`,
  `composer.trailing`, `composer.meta`, `composer.pending`; `Header.tsx`
  mounts `app.header.center`; `Sidebar.tsx` mounts the sidebar slots;
  `ContextRail.tsx` mounts `contextRail.tabs` and `workspace.rail`;
  `WorkStatus.tsx` mounts `workStatus.sections`). The command palette
  consumes `commandPalette.commands` through the command bridge
  (`apps/web/src/commandBridge.ts`). A contribution is visible only where
  the host renders that slot.
- **Ordering:** `order` then `id`, computed independently of registration
  time (deterministic across reloads).
- **Stable ids / replacement:** registration is replace-by-id within the
  slot; a later registration with the same id supersedes the earlier one.
- **Disposal:** the returned `Unregister` removes only its own registration;
  a superseded `off()` is a no-op.
- **Error isolation:** `SlotHost` wraps every contribution in its own
  `SlotBoundary` — one failing renderer disappears alone, never collapses the
  host or its siblings.
- **Context:** the host passes a bounded `props` record (e.g. the message,
  session summary, editing flag). Read the mount site to see what is
  available; never reach past it into host internals.

**When to add a new slot (host work):** only when no existing `UiSlot`
expresses the injection point, and the point is genuinely reusable (more than
one contributor plausible). Adding one end-to-end:

1. Add the name to `UI_SLOTS` in `packages/contracts/src/index.ts` (types +
   runtime value; find every `UiSlot` consumer — grep `@polyth/contracts`).
2. Mount `SlotHost slot="your.slot"` at the injection point in the owning
   host component (`apps/web/src/components/…`).
3. Contribute through `host.slots.register` from the feature package — never
   import the feature component into the host.

New slots are a public-contract change: update consumers and tests
(`apps/web/test/slots.test.ts` style) and document the slot's context in this
repo's docs.

### 4.2 Rail surfaces (`host.surfaces.register`)

Right-rail panels render through the declarative surface registry
(`apps/web/src/surfaces.ts`, hosted by `ContextRail.tsx`). A surface is a
component + navigation metadata; the host handles keep-alive mounting,
content-driven visibility, badges, and persisted widths.

```tsx
host.surfaces.register({
  id: "myfeature",
  title: "My Feature",
  description: "One-line purpose shown under the title.",
  shortLabel: "My",
  icon: () => <MyIcon />,
  capabilityId: "myfeature",   // navigation-metadata association only
  order: 42,
  component: MyPanel,          // a component; owns its hooks/state
  badge: (ctx) => count,       // optional strip badge
  visible: (ctx) => hasContent, // optional content-driven visibility
});
```

- **Contextual vs workspace panes:** canonical workspace surfaces (Files/Git/
  Terminal/Preview) add a `presentation: { kind: "workspace", defaultRatio,
  minWidth, preferredMaxWidth, keepAlive, escape }` block, which makes them
  dockable beside Chat with the pane host. Contextual surfaces
  (Context/Knowledge/Usage/Events) leave `presentation` undefined.
- `order` then `id` determine strip order; replacement is by id; disposal is
  identity-based.
- The `workspace.right.tabs` **slot** is bridged into rail surfaces
  (`slotSurfaces` in `surfaces.ts`): a slot contribution with
  `meta: { title, order, icon, capabilityId }` becomes a rail panel. This is
  the right mechanism when you already have a slot-shaped contribution
  (e.g. `packages/knowledge`'s Tracks panel).

### 4.3 Workspace surfaces (`host.workspaceSurfaces.register`)

Main-area modules (what used to be an `AppView` switch in `Main.tsx`) render
through `apps/web/src/workspace/surfaceRegistry.ts`, hosted by
`components/workspace/WorkspaceHost.ts`. The host provides the standard
project/session empty states — surfaces never invent their own.

```tsx
host.workspaceSurfaces.register({
  id: "myfeature",
  title: "My Feature",
  description: "One-line purpose under the module header.",
  order: 21,
  plugin: "myfeature",
  requires: "project",          // "none" | "project" | "session"
  component: MySurface,         // receives { projectId, sessionId }
});
```

- `requires` gates rendering: missing project → standard empty state; missing
  session (with project) → session empty state. Never hand-roll those.
- Fallback selection is deterministic (`order` then `id`, session preferred).
- Open programmatically with `host.navigation.setActiveView(id)` (legacy
  AppView ids such as `fusion`, `github`) or
  `host.navigation.openWorkspacePane(id)` for dockable rail panes.

### 4.4 Capabilities (`host.capabilities.register`)

One capability model feeds header, rails, command search, and Settings so
they can never disagree. Registration is metadata + open/available only — a
capability confers no authority (no filesystem/process/credential access).

```tsx
host.capabilities.register({
  id: "myfeature",
  label: "My feature",
  technicalLabel: "MyFeature",
  plainDescription: "Searchable plain-language description.",
  keywords: ["my", "feature", "alias"],
  standardTier: "more",          // "primary" | "more" | "technical"
  standardRank: 20,              // ordering within the tier
  open: () => host.navigation.openSettingsPage("myfeature"),
  available: () => true,
  unavailableReason: () => null, // optional honest reason when unavailable
});
```

### 4.5 Settings pages (`host.settings.registerPage`, `host.settings.registerItems`)

- `registerPage` contributes a page into the Settings modal
  (`settings.pages` slot under the hood). `group` is one of
  `"Workspace" | "Engineering" | "Customize" | "System"`; `order` sorts
  within the group; `component` is a plain React component.
- `registerItems([{ id, pageId, label, description, keywords, focusTarget }])`
  adds item-level search rows that deep-link to the page and focus the row
  (the row's element carries `data-settings-item={focusTarget}`).
- Pages are enabled/disabled with their package; the settings page you add is
  the surface for the feature's browser/server preferences — preferences
  still persist per the rules in `README.md` §2.

### 4.6 Web reducers (`host.reducers.register`)

Client-side reducers that run whenever an event of a matching `eventType`
arrives, in addition to the shell's built-in `reduce.ts` derivation. The
reducer must be pure and must not append events (it derives UI state only).
The type must be `domain/past-tense`. Currently no in-tree package uses this
seam — the built-in reducers in `reduce.ts` are the model to follow; keep the
reducer DOM-free so it can be unit-tested with `node:test`.

### 4.7 Store, navigation, ui, errors (`host.store`, `host.navigation`, `host.ui`, `host.errors`)

- `host.store` exposes the shell's render state: `getSnapshot()`,
  `subscribe(listener)`, `select(selector)`. Prefer `select` for reactive
  reads; the snapshot shape is `WebStoreSnapshot` in the web-sdk.
- `host.navigation` — `setActiveView(view)`, `openSettingsPage(pageId)`,
  `openWorkspacePane(surfaceId, resource?)`, `closeWorkspacePane()`,
  `openRailSurface(surfaceId)`, `setOverlay(overlay | null)`.
- `host.ui.icons` — the canonical icon map (`apps/web/src/icons.tsx`);
  `host.ui.Dialog` — the shared accessible dialog (use it instead of a new
  modal primitive).
- `host.errors.friendly(action, cause)` — user-presentable error strings;
  use it for action failures instead of inventing a second phrasing.

### 4.8 API transport (`createApiTransport`)

`createApiTransport({ baseUrl?, fetch?, onUnauthorized? })` gives package UI
a typed fetch wrapper over the REST surface (`get/post/put/patch/delete`,
`ApiError` with `status`/`code`). Use it for package-owned endpoints instead
of raw `fetch`.

## 5. Public vs internal API

**Public, package-facing (stable seams):**

- `@polyth/web-sdk` — everything in `packages/web-sdk/src/index.ts`.
- `@polyth/contracts` — types, `UiSlot`/`UI_SLOTS`, event shapes, widget
  descriptor types.
- `@polyth/plugins` — the server-side package host.

**Host implementation details (do not import from packages):**

- `apps/web/src/slots.ts`, `widgets/catalog.ts`, `surfaces.ts`,
  `workspace/surfaceRegistry.ts`, `capabilities.ts`, `settings/registry.ts`,
  `packages/*` registry internals — the web-sdk host wraps these; feature
  code goes through the host.
- `window.__polythSlots` / `__polythWidgets` / `__polythSurfaces` /
  `__polythWorkspaceSurfaces` / `__polythCapabilities` — legacy out-of-tree
  browser-script seams, still exported at boot for compatibility. In-tree
  packages must not use them; use `@polyth/web-sdk`.

## 6. Generic shell imports (the documented exception)

Package web code may import a **bounded set** of generic shell modules
(shared stores, i18n, UI primitives, pure helpers, the widget catalog/layout
types). The authoritative allowlist is the `GENERIC_SHELL_IMPORTS` set in
`apps/web/test/packageContainment.test.ts` — read it before importing
anything from `apps/web/src` in a package, and never extend it to smuggle a
feature implementation into the shell. Everything else (feature views,
feature state, feature API clients, feature helpers) belongs in the package.
The reverse rule is enforced too: `apps/web` imports feature packages only
from the documented shell integration points.

## 7. Disposal, lifecycle, and failure isolation

- Every `host.*.register*` returns an `Unregister`; collect them and return
  a combined disposer from the installer (reverse order).
- Registrations are replace-by-id; a superseded registration's unregister is
  a no-op.
- Slot contributions and widget instances render inside their own error
  boundaries — a broken contribution disappears alone.
- Package entries load lazily per manifest; a missing/stale bundle logs and
  is skipped without taking other packages down.
- The installer pattern means "component implemented" ≠ "feature integrated":
  integration is the registration in `widgets/index.tsx` plus the returned
  disposer.

## 8. Tests expected for UI work

- Registry logic (pure, DOM-free): `apps/web/test/slots.test.ts`,
  `surfaces.test.ts`, `workspaceSurfaces.test.ts`, `widgetCatalog.test.ts`,
  `widgetLayout.test.ts`, `settingsRegistry.test.ts`, `capabilities.test.ts`.
- Entry loading: `apps/web/test/webEntries.test.ts`,
  `webPackageDiscovery.test.ts`, `packageRegistry.test.ts`,
  `packageContainment.test.ts` (boundaries).
- Mounted-slot rendering: `slotHostMounted.test.ts`,
  `workspaceHostMounted.test.ts`, `widgetWorkspaceUx.test.ts`.
- Feature UI logic that is DOM-free lives in the package's own
  `packages/<feature>/test/` (plain `node:assert`, `node --test`).

## 9. Review checklist (web UI work)

- [ ] Correct owner: feature UI in `packages/<feature>/widgets/`, not `apps/web`
- [ ] Registration through `@polyth/web-sdk`, not host internals or `window.*`
- [ ] Existing `UiSlot` used; no host edits for a feature
- [ ] Existing primitive checked before creating another (see `components.md`)
- [ ] Canonical tokens used; CSS scoped to the package root (`styles.md`)
- [ ] Container/mobile behavior considered
- [ ] Focus/keyboard/error/loading/empty states considered where applicable
- [ ] Disposal implemented for every registration/subscription
- [ ] Model-visible content appended before display; UI state not logged
- [ ] Relevant tests added/updated; package containment respected
- [ ] All consumers checked after any shared contract change
