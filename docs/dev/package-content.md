# Package window content contract

The package contributes content and capabilities. Polyth owns the window header, background, exterior padding, scrolling boundary, responsive spacing and window controls. See also `styles.md`, `components.md`, and `ui.md`.

## Content layout is not window placement

A `presentation.kind: "workspace"` window is not necessarily an edge-to-edge editor. Floating, pinned, fullscreen, and workbench region placement must not decide the page's gutters.

`webPackageHost.surfaces.register()` supplies `page` content layout by default through the public SDK's `withDefaultSurfaceContent()`. Existing and new packages inherit the shared page rhythm without duplicating CSS classes or remembering another required property. The adapter preserves component identity, owner metadata, visibility/badge functions, placement, sizes, keep-alive and Escape policy. It does not wrap or remount the component.

Use `withSurfaceContent` from `@polyth/web-sdk/surface-content` only when declaring a different content layout:

```ts
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";

const presentation = withSurfaceContent({
  kind: "workspace",
  defaultRatio: 0.6,
  minWidth: 380,
  preferredMaxWidth: 760,
  keepAlive: true,
  escape: "content",
}, "workspace");
```

- `page`: forms, lists, dashboards and document-like content. Host page gutters, compact gutters in narrow windows, and one exterior scrolling owner.
- `panel`: a deliberately denser content layout using the shared small gutter.
- `workspace`: edge-to-edge editors, terminals, browser canvases and other split/viewport compositions. Internal panes own their scrolling. Files, Terminal, and Browser explicitly retain this mode.

Legacy core surfaces that do not use the package adapter retain their host-provided fallback. Do not add package IDs to the host to select a layout.

## Ownership boundary

`ModuleView` resolves the registered content mode for the active surface. The current ContextRail and the staged workbench share this resolution. Region frames pass their active `surfaceId` separately from the region's own ID. This does not enable the staged workbench.

`apps/web/src/moduleContent.css` owns the page/panel content boundary. A single package root is not a second window: no duplicate outer padding, margin, border, backdrop or font family. This normalization is limited to the content root; nested feature sections, cards and controls remain intact. Shared empty states, alerts and `ui-*` primitives are excluded. The stylesheet contains no feature IDs and does not reset workspace/editor geometry.

Use the actual shared `host.ui.components.Button`, `Tabs`, inputs, selects, dialogs and other supported UI primitives for their semantics, geometry, focus, disabled and busy states. Do not recreate a Button by copying its CSS. Navigation between different surfaces keeps `nav` and `aria-current="page"`; it is not an ARIA tablist without corresponding tabpanels. Markets uses shared Buttons for all ten section destinations.

The full package UI kit (`packages/web-sdk/src/index.ts`, wired in `apps/web/src/packages/hostUiParts.tsx`):

- `host.ui.components`: `Button`, `IconButton`, `Menu`, `Tabs` + `TabPanel` (ids from `host.ui.tabIds`), `TextInput`, `Textarea`, `Checkbox`, `Switch`, `Select`, `Picker`, `Badge`, `Spinner`, `Skeleton`, `Notice`, `EmptyState`, `Icon`, `Dialog` (the framed dialog: header, scrolling body, `footer` action row; `host.ui.Dialog` stays the bare modal engine), `SettingsSection` / `SettingsRow` (the Settings window layout) and `MediaViewer`.
- `host.ui.iconSet`: the action glyphs listed in `WEB_ICON_NAMES` (including `ZoomInIcon`, `ZoomOutIcon`, `FitIcon`, `BackIcon`). Add a name there and to the host map instead of drawing a package SVG. `host.ui.icons` keeps the legacy domain marks, typed by name (`WEB_LEGACY_ICON_NAMES`); other keys read as optional.
- `host.ui.confirm(message, options)`: the host confirmation alert.
- `MediaViewer` is the attachment viewer (paging, swipe, pinch/wheel zoom, pull to dismiss, strip). A package extends it rather than copying it: `index`/`onIndexChange` for a controlled position, `renderOverlay` for marks drawn over exactly the fitted image inside the zoomed frame (percentages map to image pixels), `aside` for a side panel (stacked under the stage on phones), `actions` for a row of package controls (each direct child becomes a glass island) and `gesturesDisabled` while the person draws on the overlay. Gallery's annotation viewer is the reference.
- A package whose files import UI at module scope binds it once with `bindHostUi(getHost, owner)` from `@polyth/web-sdk` (Task trackers: `hostUi` in `widgets/store.ts`); parts resolve from the configured host at render time. Never re-export shell components from `apps/web`.

Every control is typed with its real props (`WebButtonProps`, `WebIconButtonProps`, `WebMenuProps`, `WebTabsProps`, `WebSelectProps`, …); let a `Menu` trigger take its type from `children` instead of annotating it `Record<string, unknown>`. A contract change here is checked with each consuming package's own `tsconfig.json` (`apps/web` does not typecheck package widgets as strictly). Every member past the original controls is optional on `WebPackageHost` for older hosts; `apps/web/test/packageUiParts.test.ts` proves the current host supplies them.

Keep scrolling on the stable `.rail-body` / `.wb-surface-mount`, not the frame shared by several tabs. Workbench state capture includes the mount node's own offsets in addition to descendant scrollers. Hidden/inert surfaces must stay hidden. Never key a component on layout mode, dimensions, saving status or placement.

## Regression checks

```sh
node --experimental-strip-types --test packages/web-sdk/test/surfaceContent.test.ts packages/web-sdk/test/defaultSurfaceContent.test.ts
POLYTH_CHROMIUM_PATH=/usr/bin/chromium node --experimental-strip-types --test apps/web/test/packageContentLayout.test.ts
```

The browser contract test loads all `packages/*/widgets/**/*.css` in both sorted and reverse order. It exercises page/panel gutters at 360, 680 and 1000px in direct, rail and workbench mount structures, hostile root chrome, hidden bodies, horizontal overflow, and shared Markets button styling. It uses the repository's existing `playwright-core` convention and skips when no Chromium executable is available; a skipped test is not a browser pass.

These fixtures are not a visual sign-off of connected feature screens. Before merging, run the full web checks and inspect real package windows with empty/loading/error/populated content, long labels, light/dark themes, larger fonts, changed corner radii and each supported placement. Verify editor focus, terminal sessions, browser canvases, per-surface scroll and inner split panes. Settings pages, dialogs and dashboard widgets also need their own real-screen review; the surface adapter does not automatically validate their contents.
