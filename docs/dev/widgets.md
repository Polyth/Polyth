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
has a package surface + five widgets; Goals has a package surface + header
widgets).

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
| `capabilities` | Capability ids the widget relates to (metadata; capability launchers are auto-generated separately). |
| `zone` / `supportedZones` | Zone shorthand (`header/left/main/right/bottom/floating`) mapped to the workspace slots. |
| `recommendedSize`, `defaultSize`, `minSize`, `maxSize` | `{w,h}` grid cells. `recommendedSize` is what a newly-added widget gets (guidance, users may shrink it); `minSize`/`maxSize` are hard limits. |
| `audience`, `showIn` | `audience` = minimum user tier the widget is designed for (`simple`/`standard`/`power`); `showIn` = explicit allowlist, defaults to that tier and above. Placement is hidden for workspaces whose audience is excluded. |
| `scope` | Placement scope: `"global"` (appears across workspaces), `"workspace"` (this project only), `"plugin"` (plugin-managed). |
| `resizable`, `duplicatable`, `floating` | Capability flags (floating = draggable overlay placement). |
| `recommended` | Shows in the library's Recommended tab. |
| `settingsSchema` | JSON-Schema-shaped `{type:"object", properties:{…}}` describing per-instance settings; auto-rendered as form controls when `settingsRender` is absent. |
| `render(context)` | The widget body. |
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
  (`localStorage` key `polyth.widgetLayout.<projectId>`), **browser-local** —
  never session events, never server settings. Widget config is presentation
  preference, not model-visible state.
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
  `app.header.center`, `workspace.rail`, `sidebar.footer`, …) render placed
  widgets inline via `SlotHost` (`placedWidgetItems`). A widget can live in
  both worlds: e.g. `usage.session` defaults to `session.composer.before`
  and supports the workspace slots too.
- Keep `supportedSlots` honest: every slot you list must render your content
  correctly in its context (a session-scoped widget must handle `null`
  project/session in workspace slots).

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
  visibility (users may relocate, not hide).
- `audience`/`showIn` gate placement per workspace audience; the host
  derives the allowlist (`showIn` defaults to `audience` and above).

## 11. Styling

- All widget CSS lives in `packages/<feature>/widgets/styles.css`, scoped
  under the package root, canonical tokens only (`styles.md`).
- Widgets render inside containers of wildly different widths (composer,
  header strip, full canvas) — container queries are mandatory for layout
  that has any density choice. Never hardcode widget-internal dimensions
  that fight the grid; padding/gutters come from tokens.

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

- **`packages/usage/widgets/`** — the reference feature widget set: five
  widgets across kinds/zones (`usagePlugin.tsx`), per-instance schema
  settings (`SESSION_USAGE_SETTINGS` + custom `settingsRender`), session/
  project scope handling, loading/error/empty states, package CSS
  (`styles.css`), widget tests (`test/usageWidget.test.ts`).
- **`packages/goals/widgets/index.tsx`** — widgets defaulting to non-canvas
  slots (`session.header.actions`, `composer.leading`) with capability
  registration.
- **`packages/dictation/widgets/voice.tsx`** — a widget defaulting to
  `composer.leading` with custom slot settings.
- **`packages/fusion/widgets/index.tsx`** — a one-widget plugin registered
  alongside a system package-window surface.

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
