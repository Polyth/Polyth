// Settings that only work on another kind of screen wait behind one closed
// group at the end of their page: a desktop does not list phone gestures, a
// phone does not list the desktop window layout. The group opens on a press or
// for a search hit / deep link on one of its settings.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/", width: 1280, height: 900 });
// happy-dom matches no comma-separated query list, and the phone shell query
// is one ("narrow, or short on a coarse pointer"): answer each part on its own.
const nativeMatchMedia = dom.matchMedia.bind(dom);
type Listener = Parameters<MediaQueryList["addEventListener"]>[1];
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => {
    const parts = query.split(",").map((part) => nativeMatchMedia(part.trim()) as unknown as MediaQueryList);
    if (parts.length === 1) return parts[0];
    return {
      media: query,
      get matches() { return parts.some((part) => part.matches); },
      addEventListener: (type: "change", listener: Listener) => { for (const part of parts) part.addEventListener(type, listener); },
      removeEventListener: (type: "change", listener: Listener) => { for (const part of parts) part.removeEventListener(type, listener); },
    };
  },
});
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, getComputedStyle: dom.getComputedStyle.bind(dom),
  matchMedia: dom.matchMedia, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppearancePage, GeneralPage } = await import("../src/components/settings/pages.tsx");
const { getShellMode } = await import("../src/responsiveShell.ts");
const { tr } = await import("../src/i18n/index.ts");

// Never hand a happy-dom node to assert.equal (see skinSettings.test.ts).
const present = (node: unknown) => node !== null && node !== undefined;

type Page = typeof AppearancePage | typeof GeneralPage;

async function mount(page: Page, props: Record<string, unknown> = {}) {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  await act(async () => root.render(createElement(page, props)));
  await flush();
  const group = () => host.querySelector(".settings-other-devices");
  const toggle = () => host.querySelector(".settings-other-devices-toggle") as unknown as HTMLButtonElement | null;
  return {
    host,
    item: (id: string) => host.querySelector(`[data-settings-item="${id}"]`),
    /** The id lives inside the other-devices group. */
    grouped: (id: string) => present(host.querySelector(`.settings-other-devices [data-settings-item="${id}"]`)),
    group,
    title: () => host.querySelector(".settings-other-devices .settings-section-title")?.textContent ?? "",
    summary: () => host.querySelector(".settings-other-devices-toggle .settings-section-hint")?.textContent ?? "",
    toggle,
    async open() {
      const button = toggle();
      assert.ok(present(button));
      await act(async () => button!.click());
      await flush();
    },
    async unmount() { await act(async () => root.unmount()); host.remove(); },
  };
}

async function viewport(width: number, height: number) {
  await act(async () => { dom.happyDOM.setViewport({ width, height }); });
}

const devices = (first: string, second: string) => tr("settings.devices.title", {
  devices: tr("settings.devices.pair", { first: tr(first as "settings.devices.phone"), second: tr(second as "settings.devices.phone") }),
});

test.after(async () => { await dom.happyDOM.close(); });

test("desktop: phone and tablet gestures wait closed at the end of General", async () => {
  await viewport(1280, 900);
  assert.equal(getShellMode(), "wide");
  const page = await mount(GeneralPage);
  try {
    assert.ok(present(page.item("general.language")), "this device's settings stay in place");
    assert.ok(present(page.group()));
    assert.equal(page.title(), devices("settings.devices.phone", "settings.devices.tablet"));
    assert.equal(page.summary(), [tr("settings.pages.swipeNavigation"), tr("settings.devices.rowSwipes")].join(" · "));
    assert.equal(page.toggle()?.getAttribute("aria-expanded"), "false");
    for (const id of ["general.swipeNavigation", "general.rowSwipeLeading", "general.rowSwipeFull"]) {
      assert.equal(present(page.item(id)), false, `${id} starts hidden`);
    }
    await page.open();
    assert.equal(page.toggle()?.getAttribute("aria-expanded"), "true");
    const controls = page.toggle()?.getAttribute("aria-controls");
    assert.ok(controls && present(dom.document.getElementById(controls)), "the button names the body it opens");
    for (const id of ["general.swipeNavigation", "general.rowSwipeLeading", "general.rowSwipeTrailing", "general.rowSwipeFull"]) {
      assert.ok(page.grouped(id), `${id} opens inside the group`);
    }
    // Loose rows sit straight under the group's heading: no repeated section title.
    assert.equal(page.host.querySelectorAll(".settings-other-devices-body .settings-section-title").length, 0);
    await page.open();
    assert.equal(present(page.item("general.swipeNavigation")), false, "a second press closes it");
  } finally {
    await page.unmount();
  }
});

test("a search hit on a hidden setting opens its group", async () => {
  await viewport(1280, 900);
  const page = await mount(GeneralPage, { settingsTarget: { itemId: "general.rowSwipeFull" } });
  try {
    assert.equal(page.toggle()?.getAttribute("aria-expanded"), "true");
    assert.ok(page.grouped("general.rowSwipeFull"));
    assert.equal(page.host.querySelector(".settings-other-devices-body")?.getAttribute("data-motion"), null, "a routed open lands settled");
  } finally {
    await page.unmount();
  }
  const appearance = await mount(AppearancePage, { settingsTarget: { itemId: "appearance.compactShortcuts" } });
  try {
    assert.ok(appearance.grouped("appearance.compactShortcuts"), "the tablet bar's own link opens it on a desktop");
    assert.ok(present(appearance.host.querySelector(".compact-shortcuts")));
  } finally {
    await appearance.unmount();
  }
});

test("desktop: Appearance keeps the window settings and hides the tablet toolbar", async () => {
  await viewport(1280, 900);
  const page = await mount(AppearancePage);
  try {
    for (const id of ["appearance.windowLayout", "appearance.mirrorLayout", "appearance.railSizes", "appearance.statusBar"]) {
      assert.ok(present(page.item(id)), `${id} in place`);
      assert.equal(page.grouped(id), false);
    }
    assert.equal(page.title(), tr("settings.devices.title", { devices: tr("settings.devices.tablet") }));
    assert.equal(page.summary(), tr("settings.pages.compactShortcuts"));
    assert.equal(present(page.item("appearance.compactShortcuts")), false);
  } finally {
    await page.unmount();
  }
});

test("phone: desktop and tablet settings close up; gestures show in place", async () => {
  await viewport(390, 844);
  assert.equal(getShellMode(), "phone");
  const appearance = await mount(AppearancePage);
  try {
    assert.equal(appearance.title(), devices("settings.devices.desktop", "settings.devices.tablet"));
    assert.equal(appearance.summary(), [
      tr("settings.shellLayout.title"), tr("settings.pages.railSizes"), tr("settings.pages.statusBar"), tr("settings.pages.compactShortcuts"),
    ].join(" · "));
    for (const id of ["appearance.windowLayout", "appearance.railSizes", "appearance.statusBar", "appearance.compactShortcuts"]) {
      assert.equal(present(appearance.item(id)), false, `${id} starts hidden`);
    }
    assert.ok(present(appearance.item("appearance.density")), "settings for every screen stay");
    await appearance.open();
    for (const id of ["appearance.windowLayout", "appearance.mirrorLayout", "appearance.railSizes", "appearance.statusBar", "appearance.compactShortcuts"]) {
      assert.ok(appearance.grouped(id), `${id} opens inside the group`);
    }
    // Loose rows come first under the group's heading, so "Layout" is never
    // titled twice on the page; whole sections follow a heading level down.
    const titles = [...appearance.host.querySelectorAll(".settings-other-devices-body .settings-section-title")].map((title) => `${title.tagName}:${title.textContent}`);
    assert.deepEqual(titles, [`H4:${tr("settings.shellLayout.title")}`, `H4:${tr("settings.pages.compactShortcuts")}`]);
    // The tablet editor's own list heading follows its section one level down.
    const listHeading = appearance.host.querySelector(".settings-other-devices-body .compact-shortcuts-heading");
    assert.equal(listHeading?.tagName, "H5");
    const body = appearance.host.querySelector(".settings-other-devices-body");
    const rows = body?.querySelector(".settings-other-devices-rows");
    assert.ok(rows?.querySelector('[data-settings-item="appearance.railSizes"]'), "rails rows are loose");
    assert.ok(rows && rows.compareDocumentPosition(body!.querySelector(".settings-section")!) & 4, "loose rows lead");
  } finally {
    await appearance.unmount();
  }
  const general = await mount(GeneralPage);
  try {
    assert.equal(present(general.group()), false, "nothing on General is for another device");
    for (const id of ["general.swipeNavigation", "general.rowSwipeLeading", "general.rowSwipeFull"]) assert.ok(present(general.item(id)), id);
  } finally {
    await general.unmount();
  }
});

test("tablet: only the desktop window layout and phone row swipes wait", async () => {
  await viewport(800, 1100);
  assert.equal(getShellMode(), "compact");
  const appearance = await mount(AppearancePage);
  try {
    assert.equal(appearance.title(), tr("settings.devices.title", { devices: tr("settings.devices.desktop") }));
    for (const id of ["appearance.railSizes", "appearance.statusBar", "appearance.compactShortcuts"]) {
      assert.ok(present(appearance.item(id)), `${id} in place`);
    }
    assert.equal(present(appearance.item("appearance.windowLayout")), false);
  } finally {
    await appearance.unmount();
  }
  const general = await mount(GeneralPage);
  try {
    assert.ok(present(general.item("general.swipeNavigation")), "screen swipes work on a tablet");
    assert.equal(general.title(), tr("settings.devices.title", { devices: tr("settings.devices.phone") }));
    assert.equal(present(general.item("general.rowSwipeLeading")), false);
  } finally {
    await general.unmount();
    await viewport(1280, 900);
  }
});
