// Mounted happy-dom tests for the Appearance skin tools: load a skin from a
// file, invalid/oversized files, the advisory low-contrast warning, the live
// preview toggle, and the 16-slot terminal palette editor.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, getComputedStyle: dom.getComputedStyle.bind(dom),
  matchMedia: dom.matchMedia.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppearancePage, ansiSlotName } = await import("../src/components/settings/pages.tsx");
const { PRESET_THEMES, accentRoles, applyThemeSetting, replaceCustomThemes, resolveTheme } = await import("../src/theme.ts");
const { getState, updateSettings } = await import("../src/store.ts");
const { DEFAULT_SETTINGS } = await import("../src/settings.ts");
const { tr } = await import("../src/i18n/index.ts");

const base = PRESET_THEMES[0]!;
// Valid 6-digit hex per slot (padStart: 0x0a0b0c.toString(16) is only 5 digits).
const ANSI = Array.from({ length: 16 }, (_, i) => `#${(0x101010 * (i % 15) + 0x0a0b0c).toString(16).padStart(6, "0")}`);
// Never hand a happy-dom node to assert.equal: a failure makes Node's
// AssertionError inspect it to depth 1000 across the whole Window graph,
// which grew to >12 GB before this guard existed.
const present = (node: unknown) => node !== null && node !== undefined;
const skin = (over: Record<string, unknown> = {}) => JSON.stringify({ id: "file-skin", name: "File skin", appearance: base.appearance, tokens: { ...base.tokens, bg: "#123456" }, ...over });

async function mount() {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(createElement(AppearancePage)));
  const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  await flush();
  const button = (key: Parameters<typeof tr>[0]) => {
    const found = [...host.querySelectorAll(".theme-import button")].find((item) => item.textContent?.trim() === tr(key));
    assert.ok(found, key);
    return found as unknown as HTMLButtonElement;
  };
  return {
    host, flush, button,
    fileInput: () => host.querySelector(".theme-import input[type=file]") as unknown as HTMLInputElement,
    textarea: () => host.querySelector("textarea.theme-import-input") as unknown as HTMLTextAreaElement,
    async load(name: string, body: string, size?: number) {
      const input = host.querySelector(".theme-import input[type=file]")!;
      const file = new dom.File([body], name, { type: "application/json" });
      if (size !== undefined) Object.defineProperty(file, "size", { value: size });
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      await act(async () => { input.dispatchEvent(new dom.Event("change", { bubbles: true })); });
      await flush();
    },
    async click(element: { click(): void }) { await act(async () => element.click()); await flush(); },
    async unmount() { await act(async () => root.unmount()); host.remove(); },
  };
}

test("the skin file input is labelled, hidden from tab order, and driven by a visible button", async () => {
  const page = await mount();
  try {
    const input = page.fileInput();
    assert.equal(input.getAttribute("aria-label"), tr("settings.pages.loadSkinFile"));
    assert.equal(input.getAttribute("tabindex"), "-1");
    assert.match(input.className, /sr-only/);
    assert.equal(input.getAttribute("accept"), ".json,application/json");
    assert.ok(page.button("settings.pages.loadSkinFile"));
    assert.equal(present(page.host.querySelector(".theme-ansi")), false, "no palette without a valid draft");
  } finally { await page.unmount(); }
});

test("loading a valid skin file fills the draft and shows all 16 named palette swatches", async () => {
  const page = await mount();
  try {
    await page.load("file-skin.json", skin({ ansi: ANSI }));
    assert.equal(JSON.parse(page.textarea().value).id, "file-skin");
    assert.equal(page.host.querySelector(".form-error")?.textContent ?? null, null);
    const swatches = [...page.host.querySelectorAll(".theme-ansi-grid input[type=color]")] as unknown as HTMLInputElement[];
    assert.equal(swatches.length, 16);
    assert.deepEqual(swatches.map((input) => input.value), ANSI);
    assert.equal(swatches[0]!.getAttribute("aria-label"), `${tr("settings.pages.ansiBlack")} (0)`);
    assert.equal(swatches[9]!.getAttribute("aria-label"), `${tr("settings.pages.ansiBright", { name: tr("settings.pages.ansiRed") })} (9)`);
    assert.equal(new Set(swatches.map((input) => input.getAttribute("aria-label"))).size, 16);
    assert.equal(page.host.querySelector(".theme-ansi legend")?.textContent, tr("settings.pages.terminalPalette"));
    assert.equal(ansiSlotName(15), tr("settings.pages.ansiBright", { name: tr("settings.pages.ansiWhite") }));
  } finally { await page.unmount(); }
});

test("invalid and oversized skin files report an error and offer no palette", async () => {
  const page = await mount();
  try {
    await page.load("broken.json", "{ \"id\": ");
    assert.ok(page.host.querySelector(".form-error[role=alert]")?.textContent);
    assert.equal(present(page.host.querySelector(".theme-ansi")), false);
    assert.equal(page.textarea().getAttribute("aria-invalid"), "true");
    assert.equal(page.textarea().getAttribute("dir"), "ltr", "skin JSON stays LTR in RTL locales");
    await page.load("huge.json", skin(), 300 * 1024);
    assert.equal(page.host.querySelector(".form-error")?.textContent, tr("settings.pages.skinFileTooLarge", { name: "huge.json" }));
  } finally { await page.unmount(); }
});

test("a low-contrast skin gets an advisory warning but can still be previewed", async () => {
  const page = await mount();
  try {
    await page.load("washed.json", skin({ tokens: { ...base.tokens, text: base.tokens.bg, muted: base.tokens.panel } }));
    const warning = page.host.querySelector(".form-warning[role=status]");
    assert.match(warning?.textContent ?? "", /text\/bg 1:1 < 4\.5:1/);
    assert.equal(page.button("settings.pages.previewTheme").disabled, false);
  } finally { await page.unmount(); }
});

test("preview is an explicit toggle that applies the draft and restores the saved theme", async () => {
  const page = await mount();
  const html = dom.document.documentElement;
  // The app applies the saved setting at boot; reapplyTheme() restores it.
  applyThemeSetting(PRESET_THEMES[0]!.id, "dark");
  try {
    const saved = html.style.getPropertyValue("--bg");
    await page.load("file-skin.json", skin());
    const preview = page.button("settings.pages.previewTheme");
    assert.equal(preview.getAttribute("aria-pressed"), "false");
    await page.click(preview);
    const end = page.button("settings.pages.endPreview");
    assert.equal(end.getAttribute("aria-pressed"), "true");
    assert.notEqual(html.style.getPropertyValue("--bg"), saved);
    assert.equal(html.dataset.theme, "file-skin");
    await page.click(end);
    assert.equal(page.button("settings.pages.previewTheme").getAttribute("aria-pressed"), "false");
    assert.equal(html.dataset.theme, PRESET_THEMES[0]!.id);
    assert.equal(html.style.getPropertyValue("--bg"), saved);
  } finally { await page.unmount(); }
});

test("a styled theme publishes its style on <html>; a plain palette clears it", () => {
  const html = dom.document.documentElement;
  applyThemeSetting("fluent", "dark");
  assert.equal(html.dataset.themeStyle, "fluent");
  assert.equal(html.dataset.appearance, "dark");
  assert.equal(html.style.getPropertyValue("--panel"), "#202020");
  assert.equal(html.style.getPropertyValue("--scrim"), "rgba(0, 0, 0, 0.3)");
  applyThemeSetting("big-sur", "dark");
  assert.equal(html.dataset.themeStyle, "macos");
  assert.equal(html.style.getPropertyValue("--panel"), "#2b2b2b");
  assert.equal(html.style.getPropertyValue("--hair"), "rgba(255, 255, 255, 0.1)");
  applyThemeSetting("liquid-glass", "dark");
  assert.equal(html.dataset.themeStyle, "liquid-glass");
  assert.equal(html.style.getPropertyValue("--panel"), "#2a2a2a");
  assert.equal(html.style.getPropertyValue("--hair"), "rgba(255, 255, 255, 0.08)");
  applyThemeSetting(PRESET_THEMES[0]!.id, "dark");
  assert.equal(html.dataset.themeStyle, undefined);
  assert.notEqual(html.style.getPropertyValue("--scrim"), "rgba(0, 0, 0, 0.3)");
});

test("a selected custom theme that arrives after boot (account sync) replaces the fallback", () => {
  const html = dom.document.documentElement;
  replaceCustomThemes([]);
  applyThemeSetting("synced-skin", base.appearance);
  assert.equal(html.dataset.theme, "liquid-glass", "an unknown id falls back to the base theme");
  replaceCustomThemes([{ ...JSON.parse(skin()), id: "synced-skin", style: "liquid-glass" }]);
  assert.equal(html.dataset.theme, "synced-skin");
  assert.equal(html.dataset.themeStyle, "liquid-glass");
  assert.equal(html.style.getPropertyValue("--bg"), "#123456");
  replaceCustomThemes([]);
  assert.equal(html.dataset.theme, "liquid-glass");
});

test("editing a palette swatch writes an ansi list into the draft; reset derives it again", async () => {
  const page = await mount();
  try {
    await page.load("file-skin.json", skin());
    const reset = page.button("settings.pages.useDerivedPalette");
    assert.equal(reset.disabled, true, "nothing to reset on a derived palette");
    const swatch = page.host.querySelector(".theme-ansi-grid input[type=color]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(swatch, "#ff0066");
      swatch.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await page.flush();
    const edited = JSON.parse(page.textarea().value) as { ansi?: string[] };
    assert.equal(edited.ansi?.length, 16);
    assert.equal(edited.ansi?.[0], "#ff0066");
    await page.click(page.button("settings.pages.useDerivedPalette"));
    assert.equal("ansi" in JSON.parse(page.textarea().value), false);
  } finally { await page.unmount(); }
});

test.after(async () => { await dom.happyDOM.close(); });

test("style, colour scheme and accent are separate choices in Appearance", async () => {
  const html = dom.document.documentElement;
  // A record from before the split: the Polyth palette in its own style.
  updateSettings({ theme: "fluent", themeStyle: "auto", accentColor: "", appearanceMode: "light" });
  const page = await mount();
  const card = (style: string) => page.host.querySelector(`.theme-style-card[data-style="${style}"]`) as unknown as HTMLButtonElement;
  const swatch = (label: string) => [...page.host.querySelectorAll("button.theme-accent-swatch")]
    .find((button) => button.getAttribute("aria-label") === label) as unknown as HTMLButtonElement;
  try {
    assert.equal(html.dataset.themeStyle, "fluent");
    assert.equal(card("fluent").getAttribute("aria-pressed"), "true");
    // Picking a scheme pins the style it shows: colours never bring a style.
    await page.click(page.host.querySelector(".theme-picker-current") as unknown as HTMLButtonElement);
    const midnight = [...dom.document.querySelectorAll('.theme-picker-list [role="option"]')]
      .find((option) => option.querySelector("strong")?.textContent === "Midnight");
    assert.ok(present(midnight));
    await page.click(midnight as unknown as HTMLButtonElement);
    assert.equal(html.dataset.theme, "midnight");
    assert.equal(html.dataset.themeStyle, "fluent");
    assert.equal(getState().settings.themeStyle, "fluent");
    // A style card restyles and keeps the scheme.
    await page.click(card("macos"));
    assert.equal(html.dataset.themeStyle, "macos");
    assert.equal(html.dataset.theme, "midnight");
    assert.equal(card("macos").getAttribute("aria-pressed"), "true");
    assert.equal(card("fluent").getAttribute("aria-pressed"), "false");
    // The macOS styles offer Apple's accents; one recolours the accent only.
    const panel = html.style.getPropertyValue("--panel");
    const purple = swatch(tr("settings.pages.accentPurple"));
    assert.ok(present(purple));
    await page.click(purple);
    assert.equal(purple.getAttribute("aria-pressed"), "true");
    assert.equal(html.style.getPropertyValue("--accent"), accentRoles("#a550a7", "light", "macos").accent);
    assert.equal(html.style.getPropertyValue("--panel"), panel);
    // Classic draws the scheme without a recipe; the scheme accent returns.
    await page.click(card("classic"));
    assert.equal(html.dataset.themeStyle, undefined);
    await page.click(page.host.querySelector("button.theme-accent-swatch.is-scheme") as unknown as HTMLButtonElement);
    assert.equal(getState().settings.accentColor, "");
    assert.equal(html.style.getPropertyValue("--accent"), resolveTheme("midnight", "light").tokens.accent);
    // The custom colour well is labelled and keyboard reachable.
    const well = page.host.querySelector(".theme-accent-swatch.is-custom input[type=color]");
    assert.equal(well?.getAttribute("aria-label"), tr("settings.pages.accentCustom"));
  } finally {
    await page.unmount();
    updateSettings({ theme: DEFAULT_SETTINGS.theme, themeStyle: DEFAULT_SETTINGS.themeStyle, accentColor: "" });
  }
});
