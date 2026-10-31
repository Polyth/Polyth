// Appearance leads each family of sizes with one control and opens the
// per-part rows on demand (or for a search hit on one of them); the tablet bar
// waits behind a button outside tablet width; composer buttons and swipe
// navigation live on the pages that own them; schemes have one picker.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/", width: 1280, height: 900 });
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, getComputedStyle: dom.getComputedStyle.bind(dom),
  matchMedia: dom.matchMedia.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppearancePage } = await import("../src/components/settings/pages.tsx");
const sizes = await import("../src/components/settings/appearanceSizes.ts");
const { getState, updateSettings } = await import("../src/store.ts");
const { TEXT_SIZE_MIN } = await import("../src/settings.ts");
const { UI_DEFAULTS, getUiSettings, setUiSettings } = await import("../src/uiPrefs.ts");
const { searchSettingsItems } = await import("../src/settings/registry.ts");
const { tr } = await import("../src/i18n/index.ts");

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
// Never hand a happy-dom node to assert.equal (see skinSettings.test.ts).
const present = (node: unknown) => node !== null && node !== undefined;

async function mount(props: Record<string, unknown> = {}) {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  await act(async () => root.render(createElement(AppearancePage, props)));
  await flush();
  return {
    host,
    item: (id: string) => host.querySelector(`[data-settings-item="${id}"]`),
    button: (label: string, scope = "") => [...host.querySelectorAll(`${scope} button`)]
      .find((button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label) as unknown as HTMLButtonElement | undefined,
    async click(element: { click(): void } | undefined) {
      assert.ok(present(element));
      await act(async () => element!.click());
      await flush();
    },
    async unmount() { await act(async () => root.unmount()); host.remove(); },
  };
}

const PER_SIZE_ROWS = [
  "appearance.chatFontSize", "appearance.fontSize", "appearance.headerFontSize",
  "appearance.subheaderFontSize", "appearance.terminalFontSize", "appearance.editorFontSize",
];

test.after(async () => { await dom.happyDOM.close(); });

test("one step moves every text size, each inside its own range", () => {
  const base = { fontSize: 14, chatFontSize: 15, headerFontSize: 22, subheaderFontSize: 16, terminalFontSize: 14, editorFontSize: 14 };
  assert.deepEqual(sizes.shiftTextSizes(base, 2), {
    fontSize: 16, chatFontSize: 17, headerFontSize: 24, subheaderFontSize: 18, terminalFontSize: 16, editorFontSize: 16,
  });
  const smallest = sizes.shiftTextSizes(base, -10);
  assert.equal(smallest.fontSize, TEXT_SIZE_MIN);
  assert.equal(smallest.headerFontSize, sizes.HEADER_SIZE_MIN, "the header keeps its own floor");
});

test("rail presets: standard is the defaults, and hand-set rails match none", () => {
  const standard = sizes.railPresetSizes("standard");
  assert.deepEqual(standard, {
    leftRailSize: UI_DEFAULTS.leftRailSize,
    rightRailSize: UI_DEFAULTS.rightRailSize,
    topRailSize: UI_DEFAULTS.topRailSize,
    railSpacing: UI_DEFAULTS.railSpacing,
  });
  for (const preset of sizes.RAIL_PRESETS) assert.equal(sizes.railPresetOf(sizes.railPresetSizes(preset)), preset);
  const compact = sizes.railPresetSizes("compact");
  const large = sizes.railPresetSizes("large");
  for (const key of ["leftRailSize", "rightRailSize", "topRailSize", "railSpacing"] as const) {
    assert.ok(compact[key] < standard[key] && standard[key] < large[key], key);
  }
  assert.equal(sizes.railPresetOf({ ...standard, rightRailSize: standard.rightRailSize + 5 }), null);
});

test("per-size rows open on demand, and a routed target opens its group", async () => {
  setUiSettings(sizes.railPresetSizes("standard"));
  const page = await mount();
  try {
    assert.ok(present(page.item("appearance.textSize")));
    for (const id of [...PER_SIZE_ROWS, "appearance.railSpacing"]) assert.equal(present(page.item(id)), false, `${id} starts closed`);
    const toggle = page.button(tr("settings.pages.textSizesEach"));
    assert.equal(toggle?.getAttribute("aria-expanded"), "false");
    await page.click(toggle);
    assert.equal(toggle?.getAttribute("aria-expanded"), "true");
    for (const id of PER_SIZE_ROWS) assert.ok(present(page.item(id)), id);
  } finally {
    await page.unmount();
  }
  // Settings search lands on a hidden row by handing the page its target.
  const routed = await mount({ settingsTarget: { itemId: "appearance.railSpacing" } });
  try {
    assert.ok(present(routed.item("appearance.railSpacing")));
    assert.equal(present(routed.item("appearance.fontSize")), false, "only the target's group opens");
  } finally {
    await routed.unmount();
  }
});

test("the leading text control moves all six sizes together", async () => {
  updateSettings({ fontSize: 14, chatFontSize: 15 });
  setUiSettings({ headerFontSize: 22, subheaderFontSize: 16, terminalFontSize: 14, editorFontSize: 14 });
  const page = await mount();
  try {
    await page.click(page.button(tr("settings.parts.increase", { label: tr("settings.pages.textSize") })));
    assert.equal(getState().settings.chatFontSize, 16);
    assert.equal(getState().settings.fontSize, 15);
    const ui = getUiSettings();
    assert.deepEqual(
      [ui.headerFontSize, ui.subheaderFontSize, ui.terminalFontSize, ui.editorFontSize],
      [23, 17, 15, 15],
    );
  } finally {
    await page.unmount();
  }
});

test("a rail preset sets every rail; hand-set rails press none and show their sizes", async () => {
  setUiSettings(sizes.railPresetSizes("standard"));
  const scope = '[data-settings-item="appearance.railSizes"]';
  const page = await mount();
  try {
    assert.equal(page.button(tr("settings.pages.railSizeStandard"), scope)?.getAttribute("aria-pressed"), "true");
    await page.click(page.button(tr("settings.pages.railSizeLarge"), scope));
    const ui = getUiSettings();
    assert.deepEqual(
      { leftRailSize: ui.leftRailSize, rightRailSize: ui.rightRailSize, topRailSize: ui.topRailSize, railSpacing: ui.railSpacing },
      sizes.railPresetSizes("large"),
    );
    assert.equal(page.button(tr("settings.pages.railSizeLarge"), scope)?.getAttribute("aria-pressed"), "true");
  } finally {
    await page.unmount();
  }
  setUiSettings({ rightRailSize: 125 });
  const custom = await mount();
  try {
    assert.equal(custom.host.querySelectorAll(`${scope} button[aria-pressed="true"]`).length, 0);
    assert.ok(present(custom.item("appearance.rightRailSize")), "hand-set rails open their own sizes");
  } finally {
    await custom.unmount();
    setUiSettings(sizes.railPresetSizes("standard"));
  }
});

test("outside tablet width the tablet bar waits behind Show; a link from the bar opens it", async () => {
  const page = await mount();
  try {
    assert.ok(present(page.item("appearance.compactShortcuts")));
    assert.equal(present(page.host.querySelector(".compact-shortcuts")), false);
    await page.click(page.button(tr("settings.pages.showDetails"), '[data-settings-item="appearance.compactShortcuts"]'));
    assert.ok(present(page.host.querySelector(".compact-shortcuts")));
  } finally {
    await page.unmount();
  }
  const linked = await mount({ settingsTarget: { itemId: "appearance.compactShortcuts" } });
  try {
    assert.ok(present(linked.host.querySelector(".compact-shortcuts")));
  } finally {
    await linked.unmount();
  }
});

test("schemes have one picker, and a style's own scheme names its style", async () => {
  updateSettings({ theme: "liquid-glass", themeStyle: "liquid-glass", accentColor: "", appearanceMode: "light" });
  const page = await mount();
  try {
    assert.equal(present(page.host.querySelector(".theme-swatch-strip")), false);
    await page.click(page.host.querySelector(".theme-picker-current") as unknown as HTMLButtonElement);
    const option = (name: string) => [...dom.document.querySelectorAll('.theme-picker-list [role="option"]')]
      .find((row) => row.querySelector("strong")?.textContent === name);
    const polyth = option("Polyth");
    assert.ok(present(polyth));
    assert.ok(polyth!.querySelector("small")?.textContent?.includes(tr("settings.pages.nativeToStyle", { style: "Polyth" })));
    assert.equal(option("Midnight")?.querySelector("small")?.textContent?.includes(" · "), false, "a plain palette has no note");
  } finally {
    await page.unmount();
  }
});

test("composer buttons and swipe navigation live on the pages that own them", async () => {
  const pages = await read("../src/components/settings/pages.tsx");
  const body = (name: string) => {
    const start = pages.indexOf(`export function ${name}(`);
    assert.ok(start >= 0, name);
    const end = pages.indexOf("\nexport function ", start + 1);
    return pages.slice(start, end < 0 ? undefined : end);
  };
  assert.match(body("GeneralPage"), /itemId="general\.swipeNavigation"/);
  assert.match(body("ChatPage"), /itemId="chat\.showDictate"/);
  assert.match(body("ChatPage"), /itemId="chat\.showQuickActions"/);
  assert.doesNotMatch(body("AppearancePage"), /swipeNavigation|showDictate|showQuickActions/);

  const labels = { general: "General", appearance: "Appearance", chat: "Chat" };
  const pageOf = (query: string, id: string) => searchSettingsItems(query, labels).find((hit) => hit.item.id === id)?.item.pageId;
  assert.equal(pageOf("dictation", "chat.showDictate"), "chat");
  assert.equal(pageOf("swipe", "general.swipeNavigation"), "general");
  assert.equal(searchSettingsItems("dictation", labels).some((hit) => hit.item.pageId === "appearance"), false);
});
