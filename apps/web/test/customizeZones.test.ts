import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import type { WidgetDef } from "../src/widgets/catalog.ts";
import { widgetsForZone } from "../src/widgets/zoneWidgets.ts";
import { createDefaultWidgetLayout } from "../src/widgets/widgetLayout.ts";

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

    input.focus();
    await act(async () => input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "A", bubbles: true }) as unknown as Event));
    assert.equal(container.textContent, "idle");
    assert.equal(document.body.dataset.shiftHeld, undefined);

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
    await act(async () => button.dispatchEvent(new dom.Event("touchstart", { bubbles: true })));
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
    read("../src/components/mobile/HeroWidgets.tsx"),
    read("../src/useShiftArmed.ts"),
  ]);
  assert.match(shift, /canArmShiftPointer/);
  assert.match(shift, /SHIFT_MOUSE_POINTER_QUERY/);
  assert.match(shift, /ANY_COARSE_POINTER_QUERY/);
  assert.match(header, /useCustomizeActive/);
  assert.match(styles, /body\[data-shift-held\] \.customize-zone:hover/);
  assert.doesNotMatch(styles, /body\[data-shift-held\] \.customize-zone\s*[,\{]/);
  assert.match(styles, /body\[data-ui-editing\] \.customize-zone/);
  assert.match(styles, /body\[data-shift-held\] \.customize-zone:hover \.zone-customize-trigger/);
  assert.match(styles, /body\[data-ui-editing\] \.zone-customize-trigger/);
  assert.match(styles, /\.customize-zone > \.zone-edit-button\s*\{[^}]*position:\s*absolute;/s);
  assert.match(styles, /body\[data-shift-held\] \.customize-zone:hover > \.zone-edit-button[\s\S]*position:\s*static;/);
  assert.match(styles, /\.placed-mini-widget\s*\{[^}]*display:\s*contents;/s);
  assert.match(styles, /\.placed-mini-widget\[data-widget-editing="true"\]:not\(:empty\)\s*\{[^}]*display:\s*inline-flex;/s);
  assert.match(styles, /\.conversation-composer-dock\s*>\s*\.placed-mini-widget\[data-widget-editing="true"\]\s*\{[^}]*display:\s*block;[^}]*width:\s*100%;/s);
  assert.match(styles, /\.rail-icon-scroll\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(rail, /className="rail-icon-scroll"[\s\S]*<CustomizeZoneButton/);

  const actions = composer.indexOf('className="composer-actions customize-zone"');
  const trailing = composer.indexOf('slot="composer.trailing"');
  const config = composer.indexOf('className="composer-config"', actions);
  assert.ok(actions < trailing && trailing < config, "trailing widgets live in the right composer zone");
  assert.ok(composer.indexOf('<CustomizeZoneButton slot="composer.trailing"', trailing) > trailing, "right zone exposes its editor");
  assert.match(header, /className="header-actions customize-zone"/);
  assert.match(header, /slot="app\.header\.actions"[\s\S]*customizable[\s\S]*<CustomizeZoneButton/);
  assert.doesNotMatch(customize, /openSettingsPage/);
  assert.match(customize, /kind: "checkbox"/);
  assert.match(hero, /<Menu[\s\S]*kind: "checkbox"|kind: "checkbox"[\s\S]*<Menu/);
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
  const groups = widgetsForZone(widgets, createDefaultWidgetLayout(widgets), ["app.header.actions"]);
  assert.deepEqual(groups.active.map((widget) => widget.id), ["sample.active"]);
  assert.deepEqual(groups.inactive.map((widget) => widget.id), ["sample.inactive"]);
});
