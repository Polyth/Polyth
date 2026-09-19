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
  `capabilities.ts`, `settings/registry.ts`,
  `packages/reducers.ts`, `packages/projectContext.ts`) and their hosts (`components/slots/SlotHost.ts`,
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
3. At boot, `apps/web/src/packages/webEntries.ts` loads `/packages-manifest.json`
   as catalog metadata only. `apps/web/src/packages/registry.ts`
   (`bootPackages()`) then fetches `/api/packages` and **activates only enabled
   packages**: attach CSS, import the module, create an activation scope, invoke
   the factory and installer. Disabled packages are not imported, styled, or
   executed. Disable disposes the activation scope, package cleanup, and that
   activation's styles.
4. The installer runs its registrations and **must return a dispose function**;
   registry.ts calls it when the package is disabled or unloaded.

Each package web entry is a separate esbuild bundle. Imports of the
documented generic shell modules (see §10) are externalized to the shell
bundle, so package code shares the shell's stateful stores, registries, and
helpers instead of cloning them.

### Frontend build freshness

Every completed web build writes `/build-id.json` and compiles the same build
id into the shell. `apps/web/src/buildFreshness.ts` checks that id only after
a real hidden/pagehide → visible/pageshow resume; cold boot and ordinary focus
changes never trigger a freshness reload. A stale standalone PWA navigates once
toward the current build generation so iOS cannot keep using a frozen
pre-rebuild shell with freshly rebuilt package assets. The check uses
`cache: "no-store"`; the service worker does not own application asset
caching.

The watcher is explicitly controllable. Runtime code may call
`setBuildFreshnessEnabled(false)` / `setBuildFreshnessEnabled(true)`; turning
it off immediately cancels pending retries and suppresses any in-flight reload.
For deployments that never want automatic freshness navigation, build with
`POLYTH_WEB_BUILD_FRESHNESS=0` (also accepts `false`, `off`, or
`disabled`). The default remains enabled.

### Package web entry skeleton (current API)

```tsx
// packages/<feature>/widgets/index.tsx
import "./styles.css";                       // bundled with the entry; applied only while the package is active
import { defineWebPackage } from "@polyth/web-sdk";
import MyView from "./MyView.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "myfeature",
      label: "My Feature", group: "Workspace", icon: "◈", order: 50,
      component: MyView }),
    host.capabilities.register({ id: "myfeature", label: "My feature",
      plainDescription: "One-line description for search.",
      keywords: ["my", "feature"], standardTier: "more", standardRank: 20,
      open: () => host.navigation.openSettingsPage("myfeature"),
      available: () => true }),
    host.projectContext.register({
      id: "myfeature.context",
      getSnapshot: (projectId) => ({
        title: "My feature",
        items: [{ label: "Project", value: projectId }],
        recommendedWidgetIds: ["myfeature.board"],
      }),
    }),
  ];
  // Host-owned contributions are also tracked by the activation scope, so a
  // forgotten unregister still disappears on disable. Still return cleanup
  // for timers, subscriptions, and non-host resources.
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
| Package home/window (dynamic, pinned, or fullscreen) | `host.surfaces.register(...)` with required system presentation metadata |
| User-placeable dashboard block | widget — `host.widgets.register` / `host.widgets.registerPlugin(...)` (see `widgets.md`) |
| Discoverable "open this feature" navigation entry | `host.capabilities.register(...)` |
| Widget Library ranking / recommended widgets | `WidgetDefinition.recommended` plus `host.projectContext` `recommendedWidgetIds` for the active project (never identity, never a firewall) |
| Live per-project package context | `host.projectContext.register` — a sync snapshot of package-owned state; core aggregates, packages persist |
| Client-side handling of a package event type | `host.reducers.register(eventType, reducer)` |
| Shared app-wide visual primitive (button, dialog, menu…) | host core UI (`apps/web/src/components/ui/` + `styles.css`) |
| Feature-specific reusable component | package-owned component in `packages/<feature>/widgets/` |
| New global extension seam (a slot that doesn't exist) | host/web-sdk change (§5) — not a per-feature decision |
| REST endpoint | feature `RouteHandler` via `polyth.serverEntry` (see `README.md`) |
| Model-visible durable state | session event (append before display) |
| Browser-only preference | `localStorage` under `polyth.<area>.<key>` when it is intentionally device-local |
| Project presentation preference | Local cache under the project key, mirrored through `/api/projects/:id/settings` (widget, panel, pane, workbench, capability/icon order, and workspace mode) |
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
  mounts `app.header.center`; the composer's `ModelPicker` mounts
  `modelPicker.header` for catalog-routing controls; `Sidebar.tsx` mounts the sidebar slots;
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

Package windows render through the declarative surface registry
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

- **System presentation is required for packages:** every package home adds a
  `presentation: { kind: "workspace", defaultRatio,
  minWidth, preferredMaxWidth, keepAlive, escape }` block, which makes them
  dockable beside Chat with the pane host. Contextual surfaces
  (Context/Knowledge/Usage/Events) leave `presentation` undefined.
  - Optional `dock: "side" | "bottom"` picks the edge a **pinned** pane
    attaches to. Omitted (or `"side"`) keeps the classic dock beside Chat with
    a vertical resize. `"bottom"` pins the pane as a full-width strip under the
    workspace, lifting Chat's composer above it, with a horizontal resize on
    the strip's top edge (`minHeight` bounds it). Dynamic and fullscreen modes
    ignore `dock`. Terminal and Schedule ship `dock: "bottom"`.
- Every registered surface renders through the host's single `ModuleView`
  structure: header, title/description, actions, close, body, and content
  wrapper. The host chooses `page`, `panel`, or `workspace` content behavior;
  package components return feature content only. Packages must not add
  `.view-page`, `.module-view*`, their own outer close/fullscreen controls, or
  a second page title. Package toolbars and detail headings remain content.
- `order` then `id` determine strip order; replacement is by id; disposal is
  identity-based.
- The `workspace.right.tabs` **slot** is bridged into rail surfaces
  (`slotSurfaces` in `surfaces.ts`): a slot contribution with
  `meta: { title, description, order, icon, capabilityId }` becomes a rail panel. This is
  the right mechanism when you already have a slot-shaped contribution
  (e.g. `packages/knowledge`'s Tracks panel).

### 4.3 Built-in workspace surface

`WorkspaceHost` is now internal shell infrastructure for the built-in Chat
surface only. Packages cannot register into it. A package home always uses
`host.surfaces.register` and opens with `host.navigation.openWorkspacePane(id)`;
this guarantees the shared header, actions, resize frame, focus handling, and
dynamic/pinned/fullscreen state machine.

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
  within the group; `component` is a plain React component. A compatibility
  route may set `nav: false` and `redirect: { pageId, target? }` so an older
  page id lands on the canonical page without composing a second surface.
- `registerItems([{ id, pageId, label, description, keywords, focusTarget }])`
  adds item-level search rows that deep-link to the page and focus the row
  (the row's element carries `data-settings-item={focusTarget}`).
- Pages are enabled/disabled with their package; the settings page you add is
  the surface for the feature's browser/server preferences — preferences
  still persist per the rules in `README.md` §2.

Harness-specific sections contribute to `settings.harness.detail` with
`harnessId`, `sectionId`, and `label` metadata. Their `order` controls navigation;
`handlesPendingChanges: true` identifies the section that reviews and applies
pending configuration. Harnesses renders these contributions and derives its
capability matrix from cheap `HarnessSnapshot` metadata. Native discovery is
requested only for the selected harness detail.

### 4.6 Web reducers (`host.reducers.register`)

Client-side reducers that run whenever an event of a matching `eventType`
arrives, in addition to the shell's built-in `reduce.ts` derivation. The
reducer must be pure and must not append events (it derives UI state only).
The type must be `domain/past-tense`. Currently no in-tree package uses this
seam — the built-in reducers in `reduce.ts` are the model to follow; keep the
reducer DOM-free so it can be unit-tested with `node:test`.

### 4.7 Workspace layout, package lifecycle, and project context

A Project is a stable container. Packages are independently enabled, activated,
and disposed. Several packages may contribute to one Project at the same time.

**Identity.** The owner package id (manifest / server descriptor, e.g.
`dictation`) controls lifecycle and ownership. Semantic contribution ids
(settings route `voice`, capability `voice`, widget group `voice`) are
caller-defined routing/grouping names. Aliases such as `dictation → voice`
affect enablement lookup (`isPackageEnabled("voice")`) — they do not rename
user-facing routes. Do not namespace every semantic id as `packageId:id`.

**Package web lifecycle.**

```
manifest discovered (metadata only)
  → server says enabled
  → CSS attached for this activation
  → module loaded
  → activation scope created
  → factory / installer
  → contributions live
  → disable
  → package cleanup + scope disposal + that activation's styles removed
```

Disabled packages do not import modules, run factories/installers, attach CSS,
or register contributions. Dynamic `import()` is treated as activation-like
and is not used for disabled packages. Failed activations are isolated and
retryable on a later enable/reconcile; they leave no partial CSS or
registrations.

**Collision.** Cross-owner replacement throws. Same-owner replacement is
allowed and identity-safe (a stale unregister cannot delete the new
registration). Reducers compose per event type and are not exclusive.

**Widget layout** is project-scoped presentation state. The local record
(`polyth.widgetLayout.<projectId>`) is the synchronous cache and is mirrored
to the server through `/api/projects/:id/settings`; missing storage seeds
`createDefaultWidgetLayout()` from the live catalog; existing storage is
preserved. `defaultVisible` (and `DEFAULT_VISIBLE` / `requiredVisible`) applies
when a widget is **first seen** by `ensureWidgets` / parse — including when a
package activates after the workspace already hydrated. Existing known widget
visibility is never reset. Recommendations never hide unrelated widgets.
Explicit **Reset workspace** in Customize is the destructive path.

Disabling a package unregisters live UI. Persisted layout placements remain
until the user edits them. Package-owned server data and local preferences are
not deleted.

**Project context** is a live, composable projection — not a Project Type and
not a persistence bag. Each package owns its functional state and may register
`host.projectContext` snapshots (`null` = not applicable). Core aggregates
them into the existing Context surface and merges `recommendedWidgetIds` into
Widget Library ranking together with `WidgetDefinition.recommended` and core
`RECOMMENDED_WIDGET_IDS`. Setup, when needed, is a non-blocking package-owned
action (settings, surface, or dialog). Opening a folder still goes straight to
a usable workspace and composer. The Git package is the in-tree example: it
projects the cached branch for the active project and recommends `git.recent`
without classifying the Project.

Opening a folder adds or activates the Project and focuses the composer; there
is no classification question.

### 4.8 Store, navigation, ui, errors (`host.store`, `host.navigation`, `host.ui`, `host.errors`)

- `host.store` exposes the shell's render state: `getSnapshot()`,
  `subscribe(listener)`, `select(selector)`. Prefer `select` for reactive
  reads; the snapshot shape is `WebStoreSnapshot` in the web-sdk.
- `host.navigation` — `setActiveView(view)` for built-in shell navigation,
  `openSettingsPage(pageId, target?)` (where a page-local target may carry
  `itemId` and `sectionId`),
  `openWorkspacePane(surfaceId, resource?)`, `closeWorkspacePane()`,
  `openRailSurface(surfaceId)`, `setOverlay(overlay | null)`.
- `host.ui.icons` — the canonical icon map (`apps/web/src/icons.tsx`);
  `host.ui.Dialog` — the shared accessible dialog (use it instead of a new
  modal primitive).
- `host.errors.friendly(action, cause)` — user-presentable error strings;
  use it for action failures instead of inventing a second phrasing.

### 4.9 API transport (`createApiTransport`)

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
  `__polythCapabilities` — legacy out-of-tree
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

- Every `host.*.register*` returns an `Unregister`. The activation scope also
  tracks host registrations and disposes them on package disable, even if a
  package author forgets one callback. Still return cleanup for timers and
  other non-host resources.
- Cross-owner collisions throw. Same-owner replacement is identity-safe; a
  superseded unregister is a no-op.
- Slot contributions and widget instances render inside their own error
  boundaries — a broken contribution disappears alone. A broken project-context
  snapshot is isolated the same way.
- Package catalog metadata loads for every installed web package; modules and
  CSS load only for enabled packages. A failed bundle logs and retries on a
  later enable without taking other packages down.

## 8. Tests expected for UI work

- Registry logic (pure, DOM-free): `apps/web/test/slots.test.ts`,
  `surfaces.test.ts`, `workspaceSurfaces.test.ts`, `widgetCatalog.test.ts`,
  `widgetLayout.test.ts`, `settingsRegistry.test.ts`, `capabilities.test.ts`.
- Entry loading: `apps/web/test/webEntries.test.ts`,
  `packageActivation.test.ts`, `packageLifecycle.test.ts`,
  `webPackageDiscovery.test.ts`, `packageRegistry.test.ts`,
  `packageContainment.test.ts` (boundaries), `packageWorkspace.test.ts`
  (filter/layout unit tests), `projectContext.test.ts`.
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
