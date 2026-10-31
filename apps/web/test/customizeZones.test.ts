import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import type { WidgetDef } from "../src/widgets/catalog.ts";
import { widgetsForZone } from "../src/widgets/zoneWidgets.ts";
import { createDefaultWidgetLayout, setWidgetVisible } from "../src/widgets/widgetLayout.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("bare Shift ignores text editing and disarms as soon as typing starts", async () => {
  const dom = new Window();
  let fineHover = true;
  let anyCoarse = false;
  Object.assign(globalThis, {
    window: dom as unknown as Window & typeof globalThis,
    document: dom.document as unknown as Document,
    Element: dom.Element,
  });
  Object.defineProperty(dom, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      get matches() {
        if (query.includes("any-pointer: coarse")) return anyCoarse;
        return fineHover && query.includes("hover: hover") && query.includes("pointer: fine");
      },
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useShiftArmed } = await import("../src/useShiftArmed.ts");
  const container = document.createElement("div");
  const input = document.createElement("textarea");
  const button = document.createElement("button");
  document.body.append(container, input, button);
  const root = createRoot(container);
  const Probe = () => createElement("span", null, useShiftArmed() ? "armed" : "idle");

  try {
    await act(async () => root.render(createElement(Probe)));
    input.focus();
    await act(async () => input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Shift", bubbles: true }) as unknown as Event));
    assert.equal(container.textContent, "idle");
    assert.equal(document.body.dataset.shiftHeld, undefined);

    button.focus();
    await act(async () => button.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Shift", bubbles: true }) as unknown as Event));
    assert.equal(container.textContent, "armed");
    assert.equal(document.body.dataset.shiftHeld, "true");
    assert.ok(button.hasAttribute("data-shift-quiet"), "only the focused element's ring is suppressed");

    input.focus();
    await act(async () => input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "A", bubbles: true }) as unknown as Event));
    assert.equal(container.textContent, "idle");
    assert.equal(document.body.dataset.shiftHeld, undefined);
    assert.equal(button.hasAttribute("data-shift-quiet"), false, "any other key gives the ring back");

    fineHover = false;
    button.focus();
    await act(async () => button.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Shift", bubbles: true }) as unknown as Event));
    assert.equal(container.textContent, "idle", "coarse/touch pointers must not arm Shift edit mode");
    assert.equal(document.body.dataset.shiftHeld, undefined);

    fineHover = true;
    anyCoarse = true;
    button.focus();
    await act(async () => button.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Shift", bubbles: true }) as unknown as Event));
    assert.equal(container.textContent, "idle", "hybrid tablets (any-pointer:coarse + fine hover) must not arm Shift");
    assert.equal(document.body.dataset.shiftHeld, undefined);

    anyCoarse = false;
    button.focus();
    await act(async () => button.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Shift", bubbles: true }) as unknown as Event));
    assert.equal(container.textContent, "armed", "mouse-only desktops still arm Shift");
    await act(async () => button.dispatchEvent(new dom.PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }) as unknown as Event));
    assert.equal(container.textContent, "idle", "touch pointerdown clears stuck virtual Shift");

    button.focus();
    await act(async () => button.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Shift", bubbles: true }) as unknown as Event));
    assert.equal(container.textContent, "armed");
    await act(async () => button.dispatchEvent(new dom.Event("touchstart", { bubbles: true }) as unknown as Event));
    assert.equal(container.textContent, "idle", "touchstart clears stuck virtual Shift without pointerType");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    input.remove();
    button.remove();
  }
});

test("Shift exposes editors without a resting gap or content overlap", async () => {
  const [styles, composer, header, rail, customize, hero, shift] = await Promise.all([
    read("../src/styles.css"),
    read("../src/components/Composer.tsx"),
    read("../src/components/Header.tsx"),
    read("../src/components/ContextRail.tsx"),
    read("../src/components/CustomizeZoneButton.tsx"),
    read("../src/components/mobile/HeroCustomize.tsx"),
    read("../src/useShiftArmed.ts"),
  ]);
  assert.match(shift, /canArmShiftPointer/);
  assert.match(shift, /SHIFT_MOUSE_POINTER_QUERY/);
  assert.match(shift, /ANY_COARSE_POINTER_QUERY/);
  // Customizable slots own the Shift/edit state; the icon rails draw their
  // placed widgets as drag items through one seam that follows it too.
  assert.match(header, /useRailWidgetItems\(\[TOP_RAIL_SLOT\]/);
  assert.match(header, /useRailWidgetItems\(HEADER_RAIL_SLOTS/);
  assert.match(rail, /useRailWidgetItems\(\[RIGHT_RAIL_SLOT\]/);
  assert.match(await read("../src/components/RailZoneWidgets.tsx"), /useCustomizeActive\(true\)/);
  assert.match(await read("../src/components/slots/SlotHost.ts"), /useCustomizeActive\(customizable\)/);
  assert.match(styles, /body\[data-shift-held\] \.customize-zone:hover/);
  assert.doesNotMatch(styles, /body\[data-shift-held\] \.customize-zone\s*[,\{]/);
  assert.match(styles, /body\[data-ui-editing\] \.customize-zone/);
  assert.match(styles, /body\[data-shift-held\] \.customize-zone:hover \.zone-customize-trigger/);
  assert.match(styles, /body\[data-ui-editing\] \.zone-customize-trigger/);
  assert.match(styles, /\.zone-customize-trigger\s*\{[^}]*visibility:\s*hidden/s);
  assert.doesNotMatch(
    styles,
    /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.zone-customize-trigger \{/,
    "customize pencils stay hidden on Electron and hybrid pointers, not only CSS hover:fine",
  );
  assert.match(styles, /\.customize-zone > \.zone-edit-button\s*\{[^}]*position:\s*absolute;/s);
  assert.match(styles, /body\[data-shift-held\] \.customize-zone:hover > \.zone-edit-button[\s\S]*position:\s*static;/);
  assert.match(styles, /\.placed-mini-widget\s*\{[^}]*display:\s*contents;/s);
  assert.match(styles, /\.placed-mini-widget\[data-widget-editing="true"\]:not\(:empty\)\s*\{[^}]*display:\s*inline-flex;/s);
  assert.match(styles, /\.conversation-composer-dock\s*>\s*\.placed-mini-widget\[data-widget-editing="true"\]\s*\{[^}]*display:\s*block;[^}]*width:\s*100%;/s);
  assert.match(styles, /\.rail-icon-scroll\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(rail, /className="rail-icon-scroll"[\s\S]*<CustomizeZoneButton/);

  const configRow = composer.indexOf('className="composer-config composer-config-row"');
  const actions = composer.indexOf('className="composer-actions customize-zone"');
  const trailing = composer.indexOf('slot="composer.trailing"');
  assert.ok(
    configRow > -1 && configRow < actions && actions < trailing,
    "the model/effort configuration row sits above the editor; trailing widgets stay in the right rail zone",
  );
  assert.ok(composer.indexOf('<CustomizeZoneButton slot="composer.trailing"', trailing) > trailing, "right zone exposes its editor");
  assert.match(header, /className="header-actions customize-zone"/);
  assert.match(header, /className="header-actions-rail"[\s\S]*<CustomizeZoneButton slot=\{HEADER_RAIL_SLOT\} slots=\{HEADER_RAIL_SLOTS\}/);
  assert.doesNotMatch(customize, /openSettingsPage/);
  assert.match(customize, /<RailEditor/);
  assert.match(customize, /placeCapability\(id/);
  assert.match(customize, /ownerPackageId: widget\.ownerPackageId \?\? widget\.pluginId/);
  assert.match(hero, /<ResponsiveOverlay[\s\S]*<HeroCustomizePanel/, "the new chat customizes through one panel");
  assert.match(hero, /<Switch checked=\{checked\}/, "every piece of the new chat is an on/off switch");
});

test("zone menus separate visible icons from available inactive icons", () => {
  const widgets: WidgetDef[] = [
    {
      id: "sample.active",
      pluginId: "sample",
      title: "Active",
      description: "Active icon",
      kind: "mini-widget",
      defaultSlot: "app.header.actions",
      supportedSlots: ["app.header.actions"],
      defaultVisible: true,
      render: () => null,
    },
    {
      id: "sample.inactive",
      pluginId: "sample",
      title: "Inactive",
      description: "Available icon",
      kind: "mini-widget",
      defaultSlot: "composer.trailing",
      supportedSlots: ["composer.trailing", "app.header.actions"],
      defaultVisible: true,
      render: () => null,
    },
  ];
  // The curated header rail starts hidden for anything but its defaults: the
  // package's header icon is offered, not shown, until the person adds it.
  const fresh = createDefaultWidgetLayout(widgets);
  assert.equal(fresh.widgets["sample.active"]?.visible, false);
  assert.deepEqual(widgetsForZone(widgets, fresh, ["app.header.actions"]).active, []);
  const groups = widgetsForZone(widgets, setWidgetVisible(fresh, "sample.active", true), ["app.header.actions"]);
  assert.deepEqual(groups.active.map((widget) => widget.id), ["sample.active"]);
  assert.deepEqual(groups.inactive.map((widget) => widget.id), ["sample.inactive"]);
});

test("a stacked area lists full widgets, while icon and row zones stay mini-only", async () => {
  const { installBuiltinAreas } = await import("../src/widgets/builtinAreas.ts");
  installBuiltinAreas();
  const widgets: WidgetDef[] = [{
    id: "sample.progress",
    pluginId: "sample",
    title: "Progress",
    description: "Session progress",
    defaultSlot: "session.composer.before",
    supportedSlots: ["session.composer.before", "app.header.actions", "app.statusbar.leading"],
    defaultVisible: false,
    render: () => null,
  }];
  const layout = createDefaultWidgetLayout(widgets);
  assert.deepEqual(widgetsForZone(widgets, layout, ["session.composer.before"]).inactive.map((widget) => widget.id), ["sample.progress"]);
  assert.deepEqual(widgetsForZone(widgets, layout, ["app.header.actions"]).inactive, []);
  assert.deepEqual(widgetsForZone(widgets, layout, ["app.statusbar.leading"]).inactive, []);
});

test("the empty Above-the-composer area keeps an edit-mode target", async () => {
  const surfaces = await read("../src/components/workspace/builtinSurfaces.tsx");
  assert.match(surfaces, /<div className="composer-before-zone customize-zone">\s*<CustomizeZoneButton slot="session\.composer\.before"/);
});

test("every rail and shell zone opens the one shared rail editor", async () => {
  const [customize, editor, css, main, rail, header, composer, sidebar, statusBar] = await Promise.all([
    read("../src/components/CustomizeZoneButton.tsx"),
    read("../src/components/RailEditor.tsx"),
    read("../src/railEditor.css"),
    read("../src/main.tsx"),
    read("../src/components/ContextRail.tsx"),
    read("../src/components/Header.tsx"),
    read("../src/components/Composer.tsx"),
    read("../src/components/Sidebar.tsx"),
    read("../src/components/StatusBar.tsx"),
  ]);
  // Desktop and tablet anchor a panel to the pencil; phones get a tall sheet.
  assert.match(customize, /<ResponsiveOverlay[\s\S]*phone="sheet"[\s\S]*sheetSize="tall"/);
  assert.match(customize, /<RailEditor slot=\{spec\.slot\}/);
  // Tier rails edit their own launchers; every other zone edits launcher widgets.
  assert.match(rail, /<CustomizeZoneButton[\s\S]*slot="workspace\.rail"[\s\S]*tier="more"/);
  assert.match(header, /<CustomizeZoneButton slot="app\.header\.center" tier="primary"/);
  assert.match(composer, /<CustomizeZoneButton slot="composer\.trailing"/);
  assert.match(sidebar, /<CustomizeZoneButton slot="sidebar\.toolbar"/);
  assert.match(statusBar, /actions=\{\[hideAction\(\)\]\}/);
  assert.doesNotMatch(customize, /extraEntries|CatalogPicker/, "no second, unordered checkbox catalog");
  // The editor: ordered shown rows (drag + Alt+Arrow through the shared rail
  // drag engine), then compact tool/widget tiles that move, never copy.
  assert.match(editor, /useRailDragZone\(\{[\s\S]*id: dragId \?\? `rail-editor:\$\{slot\}`[\s\S]*accepts: \(\) => false/);
  assert.match(editor, /data-rail-ghost="clone"/);
  assert.match(editor, /tr\("raileditor\.moveHere"/);
  assert.match(css, /\.rail-editor-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(84px, 1fr\)\)/s);
  assert.match(css, /\.rail-editor-body\s*\{[^}]*overflow-y:\s*auto/s, "only the body scrolls; header and footer stay put");
  assert.match(main, /import "\.\/railEditor\.css";/);
});
