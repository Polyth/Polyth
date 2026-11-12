// The design-system parts the web SDK hands packages (hostUiParts.tsx): every
// promised glyph exists, and `bindHostUi` resolves components, glyphs, tab ids
// and the confirmation from whichever host is configured when they are used.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WEB_ICON_NAMES, WEB_LEGACY_ICON_NAMES, bindHostUi } = await import("@polyth/web-sdk");
const { Icon: legacyIcons } = await import("../src/icons.tsx");
const { hostConfirm, hostIconSet, hostTabIds, hostUiComponents } = await import("../src/packages/hostUiParts.tsx");
const icons = await import("../src/components/ui/icons.ts");

test("every glyph the SDK promises comes from the shell's icon set", () => {
  for (const name of WEB_ICON_NAMES) assert.ok(hostIconSet[name], name);
  for (const name of WEB_LEGACY_ICON_NAMES) assert.equal(typeof legacyIcons[name], "function", `legacy mark ${name}`);
  assert.equal(hostIconSet.FitIcon, icons.ScanIcon, "fit frames the image");
  assert.equal(hostIconSet.ZoomOutIcon, icons.ZoomOutIcon);
  assert.equal(hostIconSet.BackIcon, icons.BackIcon);
  for (const name of ["Dialog", "Switch", "Spinner", "Badge", "MediaViewer", "Notice", "Picker", "SettingsRow", "SettingsSection", "TabPanel"] as const) {
    assert.ok(hostUiComponents[name], name);
  }
  assert.equal(hostTabIds.panel("tt", "board"), "tt-panel-board");
  assert.equal(typeof hostConfirm, "function");
});

test("bound host UI resolves at render time and names a missing part", async () => {
  let host: unknown = null;
  const ui = bindHostUi(() => host as never, "Probe");
  const { Badge } = ui.components;
  const { CloseIcon } = ui.iconSet;
  assert.equal(ui.components.Badge, Badge, "one stable wrapper per part");
  assert.throws(() => ui.tabIds.tab("a", "b"), /Probe: host\.ui\.tabIds is unavailable/);
  await assert.rejects(ui.confirm("Sure?"), /Probe: host\.ui\.confirm is unavailable/);

  const asked: string[] = [];
  host = {
    ui: {
      components: { Badge: ({ children }: { children: string }) => createElement("b", { className: "probe-badge" }, children) },
      iconSet: { CloseIcon: () => createElement("i", { className: "probe-close" }) },
      tabIds: { tab: (base: string, id: string) => `${base}:${id}`, panel: () => "" },
      confirm: async (message: string) => { asked.push(message); return true; },
    },
  };
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(createElement("div", null, createElement(Badge, { children: "New" }), createElement(CloseIcon))); });
    assert.equal(container.querySelector(".probe-badge")?.textContent, "New");
    assert.ok(container.querySelector(".probe-close"));
    assert.equal(ui.tabIds.tab("a", "b"), "a:b");
    assert.equal(await ui.confirm("Sure?"), true);
    assert.deepEqual(asked, ["Sure?"]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
