# Polyth widgets

A widget is a **user-placeable, user-configurable UI module** managed by the
widget system: users drag it into a zone (header, left, main, right, bottom,
floating), resize it, duplicate it, configure it, or hide it, per workspace.
Widgets are how Polyth makes a feature's information density user-controlled.

Read `ui.md` first (ownership + registration model), `components.md` for
component rules, `styles.md` for CSS. The public types live in
`packages/web-sdk/src/index.ts` (`WidgetDefinition`, `WidgetPlugin`,
`WidgetRenderContext`, `WidgetSettingsContext`); the host implementation is
`apps/web/src/widgets/catalog.ts` + `widgetLayout.ts` + `WidgetCanvas.tsx`.

## 1. When something should — and should not — be a widget

A widget is right when the content is **individually meaningful and
user-arrangeable**: a stat, a compact panel, a launcher, a summary. The
canonical signals:

- the content is useful in more than one place (session view, workspace
  header, right rail, dashboard) — that is what `supportedSlots` expresses;
- users should be able to show/hide/resize/duplicate it;
- it has (or could have) per-instance settings.

Do **not** use a widget when:

- the UI is an app module with its own navigation identity → **package
  surface** (`host.surfaces.register` with system presentation metadata);
- the UI is a small contribution at a fixed injection point (message
  actions, header buttons, palette commands) → **slot contribution**
  (`host.slots.register`);
- it is a settings/config surface → **settings page**
  (`host.settings.registerPage`);
- the content must be always-visible and non-user-configurable → plain
  feature UI inside a surface, not a widget;
- you need user-arrangeable placement **without** per-instance identity →
  re-read: every widget instance gets an `instanceId`; if that is meaningless
  for your content, a slot contribution is simpler.

Widget vs surface rule of thumb: a surface is "the feature's home"; a widget
is "a piece of a feature the user places where they want it". One feature
commonly has a system window surface **and** widgets (e.g. Usage
has a package surface + three scoped analytics widgets and a Limits widget;
Goals has a package surface + header widgets).

## 2. Where widget code lives

```
packages/<feature>/
  widgets/
    index.tsx            # package web entry: defineWebPackage + registrations
    myWidget.tsx         # widget render component + settings renderer
    styles.css           # package-scoped CSS (imported by index.tsx)
    ...
```

The definition object and the render/settings components live in the
package. Registration happens in `widgets/index.tsx` via
`host.widgets.registerPlugin(...)` (see §4). Built-in shell widgets register
in `apps/web/src/widgets/builtinWidgets.tsx` / `builtinMiniWidgets.tsx` —
that is host work, not the pattern for features.

## 3. Definition anatomy

The full field set (`WidgetDefinition` in the web-sdk; all optional except
`id`, `title`, `description`, `render`):

| Field | Meaning |
|---|---|
| `id` | Stable catalog id, `domain.name` style, unique across all plugins (registration throws on collision). |
| `title`, `description` | Catalog copy (shown in the Widget Library). |
| `kind` | `"widget"` (full chrome) or `"mini-widget"` (lightweight inline chrome). |
| `defaultSlot` | Where a fresh instance goes by default; any `UiSlot`, including non-canvas ones (`session.composer.before`, `session.header.actions`, `composer.leading`). Defaults from `zone`. |
| `supportedSlots` / `supportedZones` | Where users may place it. Must include `defaultSlot` (enforced). Non-workspace slots are placement targets too. |
| `defaultVisible` | Whether a new instance starts visible (used for recommended/builtin widgets; most package widgets ship `defaultVisible: false` so the user opts in from the library). |
| `requiredVisible` | Package-required: may be moved between supported slots but never hidden. |
| `order` | Placement seed ordering within a slot. |
| `category` | Library grouping string. |
| `capabilities` | Capability ids the widget relates to (metadata; capability launchers are auto-generated separately; a capability whose package ships its own placeable widget sets `launcherWidget: false` to skip the generated `capability:<id>` one). |
| `zone` / `supportedZones` | Zone shorthand (`header/left/main/right/bottom/floating`) mapped to the workspace slots. |
| `recommendedSize`, `defaultSize`, `minSize`, `maxSize` | `{w,h}` grid cells. `recommendedSize` is what a newly-added widget gets (guidance, users may shrink it); `minSize`/`maxSize` are hard limits. |
| `audience`, `showIn` | `audience` = minimum user tier the widget is designed for (`simple`/`standard`/`power`); `showIn` = explicit allowlist, defaults to that tier and above. Placement is hidden for workspaces whose audience is excluded. |
| `scope` | Placement scope: `"global"` (appears across workspaces), `"workspace"` (this project only), `"plugin"` (plugin-managed). |
| `resizable`, `duplicatable`, `floating` | Capability flags (floating = draggable overlay placement). |
| `recommended` | Shows in the library's Recommended tab. |
| `panelSizes`, `panelDefaultSize` | Sizes offered for the widget in the phone Workspace panel (`compact`, `standard`, `wide`, `large`) and the one a new panel item gets. Without them the panel offers `compact` and `standard`, `compact` first. The package declares its own pair; the host keeps no per-widget table. |
| `settingsSchema` | JSON-Schema-shaped `{type:"object", properties:{…}}` describing per-instance settings; auto-rendered as form controls when `settingsRender` is absent. |
| `isAvailable(context)` | Optional predicate. `false` means the widget has nothing to show in this context (for example a session card with no active session). Hosts that own widget chrome — the phone Workspace panel, the phone composer rail, placed UI slots, and the desktop Canvas — omit the whole instance outside edit mode, so an empty state is never painted; edit mode keeps it so it can still be moved or removed. |
| `render(context)` | The widget body. In the phone Workspace panel `context.panelSize` is the size the person chose (one of `panelSizes`), so a widget can draw a real glance for its smaller size instead of the same card cut shorter; other hosts leave it unset. |
| `settingsRender(context)` | Optional custom settings UI (gets `widgetId` too). |

## 4. Registration

```tsx
host.widgets.registerPlugin({
  id: "myfeature",
  name: "My Feature",
  widgets: [ /* WidgetDefinition[] */ ],
});
```

- `host.widgets.registerPlugin(plugin)` registers every widget in one call
  (duplicate ids within the plugin throw; ids owned by another plugin throw;
  `defaultSlot ∉ supportedSlots` throws) and returns one `Unregister`.
- `host.widgets.register(pluginId, definition)` registers a single widget.
- Registration also **merges the widget into the current workspace layout**
  (only if it was not already there): default slot, default size, default
  visibility. Users' persisted choices are never overwritten.
- `widgets` is optional on a plugin: a plugin can be capability-only.

### Minimal skeleton (current API)

```tsx
// packages/myfeature/widgets/myWidget.tsx
import type { WidgetRenderContext, WidgetSettingsContext } from "@polyth/web-sdk";

export function MyWidget({ config, updateConfig }: WidgetRenderContext) {
  return (
    <div className="myfeature-card">
      <strong>{String(config.title ?? "Untitled")}</strong>
    </div>
  );
}

export function MyWidgetSettings({ config, updateConfig }: WidgetSettingsContext) {
  return (
    <label className="myfeature-settings">
      Title
      <input value={String(config.title ?? "")}
        onChange={(e) => updateConfig({ ...config, title: e.target.value })} />
    </label>
  );
}
```

```tsx
// packages/myfeature/widgets/index.tsx
import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { MyWidget, MyWidgetSettings } from "./myWidget.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.widgets.registerPlugin({
      id: "myfeature",
      name: "My Feature",
      widgets: [
        {
          id: "myfeature.summary",
          title: "My summary",
          description: "One-line description for the Widget Library.",
          kind: "widget",
          defaultSlot: "workspace.main",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom"],
          category: "My Feature",
          defaultSize: { w: 6, h: 4 },
          minSize: { w: 3, h: 2 },
          maxSize: { w: 12, h: 50 },
          audience: "standard",
          scope: "workspace",
          resizable: true,
          defaultVisible: false,
          settingsSchema: {
            type: "object",
            properties: { title: { type: "string", title: "Title", default: "" } },
          },
          render: (context) => <MyWidget {...context} />,
          settingsRender: (context) => <MyWidgetSettings {...context} />,
        },
      ],
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
```

## 5. Lifecycle and disposal

- The installer runs when the package is enabled; `host.widgets.register*`
  returns an `Unregister` that removes the definitions. Persisted placements
  of a removed widget become inert (not rendered, no crash), and
  re-registering the same id re-seeds the layout if the placement is gone.
- Widget **instances** are owned by the layout, not by the component: the
  canvas and `SlotHost` render the widget's `render(context)` per instance.
- Unmount/remount is the host's job (keep-alive, tab switches, drag); the
  widget component must own its hooks and state, and must not assume it
  stays mounted.
- Widget render/settings components are wrapped in per-contribution error
  boundaries: a throwing widget disappears alone.

## 6. Render context

`WidgetRenderContext`:

- `projectId`, `sessionId` — current ids (may be `null`; render the
  "choose a project/session" empty state yourself, like the usage widgets).
- `composerModel` — only on the new-chat screen (`session.empty.widgets`):
  `{harnessId, providerID, modelID}` of the model its composer would start
  the chat on, when known (published by the composer through
  `composer/newChatModel.ts`; presentation only). Also passed to `isAvailable`.
- `editing` — true while the user is arranging the canvas (hide inline
  actions, show drag affordances).
- `instanceId` — stable per instance. Use it for instance-scoped identity
  (keys, per-instance transient state). **Do not** use it as the definition
  id.
- `config` — this instance's persisted settings (`Readonly<JsonObject>`).
- `updateConfig(next)` — replace this instance's config (pass a full
  object, typically `{ ...config, key: value }`).
- Plus any props the host supplies at the mount slot.

`WidgetSettingsContext` adds `widgetId` (the catalog definition id).

## 7. Config and settings

- Per-instance config is persisted in the widget layout
  (`localStorage` key `polyth.widgetLayout.<projectId>`) as a fast local cache
  and mirrored through the project presentation-settings route + WS broadcast.
  Pane/tab and Files/Git/Terminal navigation stays on this device. Widget
  layout remains presentation-only — never session events or model-visible state.
- `settingsSchema` is a JSON-Schema-shaped object; the canvas auto-renders
  boolean/string/enum controls from it when `settingsRender` is absent
  (`SchemaWidgetSettings` in `WidgetCanvas.tsx`). Provide `settingsRender`
  when the settings UI needs custom layout or cross-field logic.
- `updateConfig` merges nothing — pass the complete next object.

## 8. Scope, zones, slots

- **Zones** (canvas areas): `header`, `left`, `main`, `right`, `bottom`,
  `floating`; each maps to a workspace slot
  (`workspace.header`, `workspace.left`, `workspace.main`,
  `workspace.right`, `workspace.bottom`, `workspace.floating`).
- **Slots**: any `UiSlot` may be a placement target. Non-canvas slots
  (`session.composer.before`, `session.header.actions`, `composer.leading`,
  `app.header.center`, `app.statusbar.leading/trailing`, `workspace.rail`,
  `sidebar.rail`, `sidebar.footer`, …) render placed widgets inline via `SlotHost`
  (`placedWidgetItems`). A widget can live in
  both worlds: e.g. `usage.session` defaults to `session.composer.before`
  and supports the workspace slots too.
- **The new-chat screen is a board, not a layout slot.** A widget that lists
  `session.empty.widgets` in `supportedSlots` is added from New chat →
  Customize → *Add widget* to the account's board (`apps/web/src/heroBoard.ts`,
  synced as `core.hero-board`): one board for every project, each item
  optionally *Only in this project*, any number of copies when
  `duplicatable`, its own `config`, and one order shared with the built-ins
  (Shortcuts, Recent, Apps). The screen draws items as tiles of a 4-track grid
  (2 on a phone-wide column): `compact` ¼, `standard` ½, `wide`/`large` a full
  row (`large` taller). Sizes offered are the widget's `panelSizes`
  (`panelDefaultSize` first); a widget without them keeps a full-width row.
  The host's `SlotHost` for that slot renders only registered contributions
  (`placed={false}`); a visible layout placement there (an older client, the
  Canvas library) is adopted onto the board as an item of that project and
  hidden in the layout (`adoptLegacyHeroPlacements`). Nothing is added by
  default.
- **Zone pickers** (`CustomizeZoneButton` → `widgetsForZone`) list
  mini-widgets everywhere, and full widgets only in stacked areas
  (`orientation: "column"`, `sizeHint` not `"icon"` — today
  `session.composer.before` and `session.empty.widgets`). Icon rails, rows and
  canvases stay mini-only there; the canvas has its own "Add widgets" menu.
  The empty "Above the composer" area keeps an edit-mode pencil
  (`.composer-before-zone`, picker title "Above the composer") so a
  hidden-by-default widget such as `todos.progress` can be added from the
  chat; full widgets placed there share the composer's column width. Phones
  have no such pencil: there the widgets are added from Tools → Edit.
- Keep `supportedSlots` honest: every slot you list must render your content
  correctly in its context (a session-scoped widget must handle `null`
  project/session in workspace slots).

### A widget never navigates the workspace out from under the user

A widget is content inside a card. It must not change the workspace
presentation — no Chat/Canvas switch, no workspace pane, no primary view —
while the user interacts with it.

Package components that also exist as a workspace surface (Files is both
`files.explorer` and the `files` surface) must therefore take the
destination as a decision, not assume one:

- the **surface** uses the navigating store adapter (`openEditorFile`,
  `openWorkspacePane`, …): opening a file *is* opening the Files surface;
- the **widget** owns a pane host already, so it opens in place. Pass
  `embedded` to the shared coordinator (`EditorView`) so its clicks, pins,
  drops and symbol navigation stay inside the card, and publish the selection
  with the non-navigating `setEditorFile` (which also accepts a one-shot
  reveal range) so the status bar and file body still agree.

Cross-surface commands are the deliberate exception. A launcher, capability or
rail button is a request to go somewhere else, and so is a card whose content
*is* that summary — a "recent changes" list with no viewer of its own routes
into Source control, because there is nothing to open in place. The rule is
about interactions that have a real in-card destination.

### The Canvas is a workspace surface, not a separate app

Canvas is **off by default**. A project offers it only once the user asks for
it, and the deliberate controls are:

- the header view-tabs editor ([view tabs](ui.md#view-tabs)): adding the
  Canvas tile offers Canvas for the project, removing it withdraws it. The
  same editor offers optional package views such as Tasks
  ([optional profiles](ui.md#47-workspace-layout-package-lifecycle-and-project-context)); and
- `Settings → Engineering → Projects → Canvas` for the selected project.

`canvasEnabled` is a **project** presentation setting, so it travels with the
project like `widgetLayout`; which of Chat/Canvas a device is showing remains
device-local navigation state. Nothing opts a project in implicitly: arriving at
Canvas by any route — the menu, a hotkey, a restored session — is itself the
user asking for Canvas, and counts as opting the project in.
Withdrawing Canvas while the active device shows it returns that device to Chat
rather than stranding it behind a tab it can no longer reach, and the header
keeps rendering the Canvas tab while the current surface is Canvas so the way
back to Chat always exists.

The device-local project `workspaceMode` (`chat` | `widgets`) selects the **main
surface only**. `Edit workspace` is a separate device-local customization
capability: it leaves Chat or Canvas selected, and turning it off returns to
that same surface. It is not a Chat/Canvas/profile navigation button. The
desktop `header-profile` menu always exposes it by default, while the same
capability/widget path used by package launchers lets people place it in any
supported shell area or Workspace panel. Choosing Chat or Canvas explicitly
switches surfaces and exits Edit.

The phone Workspace panel is a full-screen destination: Back leads its header
(on the inline-start side, the way the Back swipe takes it) and an Edit
switch trails it. Editing is a mode, not a place — turning the switch off
returns to the panel in place, and Back (the button, the swipe or native Back)
leaves the whole panel through its exit in either mode; the header row is the
same in both, so the switch never moves the page. Edit opens the
arrangement with its controls on every item; its *Add widgets* card opens the
full-page Add page, and an empty Workspace offers that page directly (see
[UI architecture](ui.md#phone-workspace-editor)). Layout changes are saved as
they happen — a drag saves once, when the item lands — and Undo walks back the
editing session. The layout is one project record shared by every device
(`workspacePanel`), so a device that lacks an item's definition — its package
is still loading, disabled, or unavailable there — keeps the saved item, skips
it while rendering and while arranging, and saves it back in its slot on its
next edit. The native
app gets a fresh origin (empty cache) on every Link connection; an
uncustomized panel therefore recomputes its defaults when the project's rail
arrangement or kind arrives from the server.

Shell chrome is identical in both surfaces:

- the header top rail (capability launchers and the `app.header.center`
  widget area, in one order the person controls) renders in every wide
  workspace mode;
- the top-right header rail (`session.header.actions` +
  `app.header.actions`, Search, Settings and Notifications by default)
  renders in every wide workspace mode; its items drag to and from the top
  and right rails (see [UI architecture](ui.md#32-rail-and-zone-editor));
- the right rail (launchers, panel buttons and the `workspace.rail` widget
  area, in one order the person controls; nothing in it is pinned) is never
  hidden by workspace mode. A workspace pane is Chat's companion, so
  `openWorkspacePane` selects Chat before the pane opens: launching a tool
  from either rail while the Canvas is the main surface returns that surface
  to Chat and docks the pane beside it;
- an icon rail with nothing in it renders nothing at all. The top rail
  (with its divider), the right launcher strip (and the
  lane it reserves — `--rail-strip-width-right` drops to 0) and the tablet
  shortcut rail are omitted when they hold no launcher and no placed widget;
  the top and right rails reappear empty only in Edit so items can be added
  back, and while a launcher dragged from the other rail could land there. Likewise the Chat / Canvas / profile switch is omitted when it
  draws a single tab (Edit keeps it so its pencil can add tabs back);
- the user's selected workspace background (`appearance.background`) paints
  behind the Canvas exactly as it does behind Chat. The Canvas adds no opaque
  fill; the alignment dot grid appears over an image only while editing.
  Widget cards keep their own opaque surface so content stays readable.

The Canvas has no session sidebar, so the built-in conversation widget
(`core.chat`) carries its own session switcher: the project's most recent
sessions as tabs, `CHAT_SESSION_TAB_PAGE` (5) at a time with the rest behind
one control. A tab activates the canonical session
(`openSession(id, { showChat: false })`) — every session-scoped widget on the
Canvas follows, and the workspace stays on Canvas.

The shell `CustomizeZoneButton` editors are the shared rail editor described
in [UI architecture](ui.md#32-rail-and-zone-editor) (one home per icon; adding
an item shown elsewhere moves it). The Canvas add-widget menu follows the host
catalog-picker contract in [UI architecture](ui.md#31-host-catalog-pickers):
catalogs with more than four choices keep search and package filtering at the
top and group rows by owning package; one to four choices use the compact
action-strip layout without artificial category chrome. The Canvas picker adds
category, supported zones, and capability details before toggling canvas
visibility. The picker never renders an unplaced widget as live content;
placement and visibility mutations still go through `widgetLayout.ts`.

## 9. Sizing

- Grid cells (`w`×`h`). Provide sensible `defaultSize`/`recommendedSize` and
  honest `minSize`/`maxSize`; the host enforces limits and clamps persisted
  sizes.
- Content must be responsive to its own box (container queries — see
  `styles.md`); a widget never knows the viewport.
- `mini-widget`s are compact by design (header/rail placement).

## 10. Duplication, visibility, audience

- `duplicatable: true` lets users place multiple instances; each instance
  gets its own `instanceId` and its own config. If two instances of your
  widget would fight over shared state, either make state per-instance or
  set `duplicatable: false`.
- `defaultVisible` controls first placement; `requiredVisible` forces
  visibility (users may relocate, not hide). First placement is per project
  and direction-aware (`autoPlacesContribution` in
  `projectCompositionPlan.ts`): a package widget arriving in a project that
  already has a layout (package installed, enabled or newly relevant) is
  revealed only when the package's `projectAffinity` directions match the
  project's (Home Assistant shows itself in a Home project, not in an
  Engineering or untyped one); otherwise it is added hidden and stays in the
  library. A universal package (no directions) needs a recommendation to
  reveal *chrome* in a typed project, but its *session controls* — mini-widgets
  whose default slot is `session.header.actions`, `composer.leading` or
  `composer.trailing` (Goal, Auto-approve, Dictation) — keep `defaultVisible`
  in every project (`isSessionControl` in `widgetLayout.ts`); direction scope
  still applies to them. The top-right header rail is the exception: it is
  curated to Search, Settings and Notifications (`HEADER_RAIL_DEFAULT_WIDGETS`),
  so any other widget whose default slot is `session.header.actions` or
  `app.header.actions` starts hidden there, whatever its `defaultVisible`
  (the composer Goal and Auto-approve stay visible). Until the project's composition and the package catalog are known
  the widget is not seeded at all, because the guess would be persisted. A
  project without a layout starts from the standard arrangement. After first
  placement the user's visibility is never reset.
- Revealing a widget is the canvas's only "add" gesture, so it always lands
  at the **nearest free space at the top** of the grid — the first gap that
  fits, scanning rows top-down and then left-to-right
  (`topFreePosition` in `widgetLayout.ts`). The same re-homing applies when a
  widget is moved onto the canvas from a shell slot. Only widgets that hold
  canvas cells count as occupied: a visible mini-widget in `app.header.center`
  or `workspace.rail` carries a placeholder position and never blocks the
  grid. Duplicating keeps its anchor below the source instead, because the
  user picked that spot.
- `audience`/`showIn` gate placement per workspace audience; the host
  derives the allowlist (`showIn` defaults to `audience` and above).

## 11. Styling

- All widget CSS lives in `packages/<feature>/widgets/styles.css`, scoped
  under the package root, canonical tokens only (`styles.md`).
- Widgets render inside containers of wildly different widths (composer,
  header strip, full canvas) — container queries are mandatory for layout
  that has any density choice. Never hardcode widget-internal dimensions
  that fight the grid; padding/gutters come from tokens.
- Catalog titles identify widgets in the library and edit mode only. Normal
  canvas rendering stays title-free so content receives the card's full box.

## 12. Tests

- Pure widget logic (data shaping, config interpretation, settings
  defaults) belongs in `packages/<feature>/test/` — DOM-free,
  `node:assert`.
- Layout/placement/visibility math is covered by
  `apps/web/test/widgetLayout.test.ts`, `widgetPlacementPrimitives.test.ts`,
  `widgetCatalog.test.ts`, `widgetAreas.test.ts`; interaction by
  `widgetWorkspaceUx.test.ts`. Extend those only for host-side changes.
- A widget with non-trivial render-time derivation should export the pure
  part and unit-test it.

## 13. Canonical examples

- **`packages/usage/widgets/`** — the reference scoped analytics widget set:
  Session, Project and Global widgets plus the matching Usage surface. The
  three analytics widgets read the same server observation/query model, and
  the Limits widget (current harness/model, selected or all sources, seven
  display styles) reads the same limits service as the Limits page; no widget
  owns a second quota or cumulative-session statistics path. The server query
  boundary, observation semantics and limits widget behavior are documented in
  [`packages/usage/README.md`](../../packages/usage/README.md).
- **`packages/goals/widgets/index.tsx`** — widgets defaulting to non-canvas
  slots (`session.header.actions`, `composer.leading`) with capability
  registration.
- **`packages/dictation/widgets/voice.tsx`** — a widget defaulting to
  `composer.leading` with custom slot settings.
- **`packages/glance/widgets/`** — new-chat board tiles (Clock, World
  clock, Weather): `panelSizes` per tile, `settingsSchema`-only settings; the
  weather tile reads its package route, which owns the outbound call.
- **`packages/fusion/widgets/index.tsx`** — a one-widget plugin registered
  alongside a system package-window surface.
- **`packages/gallery/widgets/`** — a canvas widget that pairs a package-owned
  server route (`src/serverEntry.ts` reads project images through the files
  service) with an interactive canvas: folder picker, lazy grid, a lightbox
  with zoom/pan and normalized point/zone annotations, and a send flow that
  attaches the selected images to the active session for a chosen model.

## 14. Checklist (widget work)

- [ ] Widget is the right mechanism (§1) — not a surface/slot/settings page
- [ ] Definition has stable id, honest supportedSlots, sizes, audience
- [ ] `defaultVisible`/`requiredVisible` reflect package intent
- [ ] render handles null project/session and editing contexts
- [ ] Config read/written via context only; persisted as presentation
  preference, never logged
- [ ] settingsRender or settingsSchema provided; per-instance identity via
  instanceId
- [ ] CSS package-scoped, token-based, container-responsive
- [ ] Registered via `host.widgets.registerPlugin` in `widgets/index.tsx`
- [ ] Disposal returned; duplicate-instance behavior deliberate
- [ ] Pure logic tested; host-side changes update host widget tests
