// Settings that only work on another kind of screen wait behind one closed
// group per device at the end of their page: a desktop does not list phone
// gestures, a phone does not list the desktop window layout. This device's
// settings stay open in place above. A group opens on a press or for a search
// hit / deep link on one of its settings.
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
const { AppearancePage, BehaviorPage, GeneralPage } = await import("../src/components/settings/pages.tsx");
const { ChatPage } = await import("../src/components/settings/ChatSettingsPage.tsx");
const { getShellMode } = await import("../src/responsiveShell.ts");
const { tr } = await import("../src/i18n/index.ts");

// Never hand a happy-dom node to assert.equal (see skinSettings.test.ts).
const present = (node: unknown) => node !== null && node !== undefined;

type Page = typeof AppearancePage | typeof GeneralPage | typeof ChatPage | typeof BehaviorPage;
type Device = "desktop" | "tablet" | "phone";

async function mount(page: Page, props: Record<string, unknown> = {}) {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  await act(async () => root.render(createElement(page, props)));
  await flush();
  const group = (device: Device) => host.querySelector(`.settings-other-devices[data-device="${device}"]`);
  const toggle = (device: Device) => group(device)?.querySelector(".settings-other-devices-toggle") as unknown as HTMLButtonElement | null;
  return {
    host,
    item: (id: string) => host.querySelector(`[data-settings-item="${id}"]`),
    /** The id lives inside this device's group. */
    grouped: (id: string, device: Device) => present(group(device)?.querySelector(`[data-settings-item="${id}"]`)),
    /** Opens a Chat summary row by its id. */
    async openRow(row: string) {
      const head = host.querySelector(`[data-disclosure-row="${row}"] > button`) as unknown as HTMLButtonElement | null;
      assert.ok(present(head), `row ${row}`);
      await act(async () => head!.click());
      await flush();
    },
    hasRow: (row: string) => present(host.querySelector(`[data-disclosure-row="${row}"]`)),
    /** The other-devices groups in page order, by device. */
    devices: () => [...host.querySelectorAll(".settings-other-devices")].map((node) => node.getAttribute("data-device")),
    group,
    title: (device: Device) => group(device)?.querySelector(".settings-section-title")?.textContent ?? "",
    summary: (device: Device) => group(device)?.querySelector(".settings-other-devices-toggle .settings-section-hint")?.textContent ?? "",
    toggle,
    async open(device: Device) {
      const button = toggle(device);
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

const titled = (device: Device) => tr("settings.devices.title", { devices: tr(`settings.devices.${device}` as const) });

test.after(async () => { await dom.happyDOM.close(); });

test("desktop: phone and tablet gestures wait in one closed group per device at the end of General", async () => {
  await viewport(1280, 900);
  assert.equal(getShellMode(), "wide");
  const page = await mount(GeneralPage);
  try {
    assert.ok(present(page.item("general.language")), "this device's settings stay in place");
    assert.deepEqual(page.devices(), ["tablet", "phone"], "largest screen first");
    assert.equal(page.title("tablet"), titled("tablet"));
    assert.equal(page.title("phone"), titled("phone"));
    // A block for both devices is listed in each, so every group is complete.
    assert.equal(page.summary("tablet"), tr("settings.pages.swipeNavigation"));
    assert.equal(page.summary("phone"), [tr("settings.pages.swipeNavigation"), tr("settings.devices.rowSwipes")].join(" · "));
    for (const device of ["tablet", "phone"] as const) assert.equal(page.toggle(device)?.getAttribute("aria-expanded"), "false");
    for (const id of ["general.swipeNavigation", "general.rowSwipeLeading", "general.rowSwipeFull"]) {
      assert.equal(present(page.item(id)), false, `${id} starts hidden`);
    }
    await page.open("phone");
    assert.equal(page.toggle("phone")?.getAttribute("aria-expanded"), "true");
    assert.equal(page.toggle("tablet")?.getAttribute("aria-expanded"), "false", "groups open one by one");
    // Open, the settings themselves replace the summary; the chevron rides the title line.
    assert.equal(page.summary("phone"), "", "an open group drops its summary line");
    assert.notEqual(page.summary("tablet"), "", "a closed group keeps it");
    assert.ok(present(page.toggle("phone")?.querySelector(".settings-other-devices-title-line .settings-other-devices-chevron")));
    assert.equal(page.group("phone")?.querySelector(".settings-other-devices-body > p"), null, "no note above the settings");
    const controls = page.toggle("phone")?.getAttribute("aria-controls");
    assert.ok(controls && present(dom.document.getElementById(controls)), "the button names the body it opens");
    for (const id of ["general.swipeNavigation", "general.rowSwipeLeading", "general.rowSwipeTrailing", "general.rowSwipeFull"]) {
      assert.ok(page.grouped(id, "phone"), `${id} opens inside the phone group`);
    }
    assert.equal(page.grouped("general.swipeNavigation", "tablet"), false);
    // Loose rows sit straight under the group's heading: no repeated section title.
    assert.equal(page.host.querySelectorAll(".settings-other-devices-body .settings-section-title").length, 0);
    await page.open("tablet");
    assert.ok(page.grouped("general.swipeNavigation", "tablet"));
    assert.equal(page.grouped("general.rowSwipeFull", "tablet"), false, "phone-only rows stay out of the tablet group");
    await page.open("phone");
    assert.equal(page.grouped("general.rowSwipeFull", "phone"), false, "a second press closes it");
  } finally {
    await page.unmount();
  }
});

test("a search hit on a hidden setting opens its group", async () => {
  await viewport(1280, 900);
  const page = await mount(GeneralPage, { settingsTarget: { itemId: "general.rowSwipeFull" } });
  try {
    assert.equal(page.toggle("phone")?.getAttribute("aria-expanded"), "true");
    assert.equal(page.toggle("tablet")?.getAttribute("aria-expanded"), "false", "only the group holding the hit opens");
    assert.ok(page.grouped("general.rowSwipeFull", "phone"));
    assert.equal(page.host.querySelector(".settings-other-devices-body")?.getAttribute("data-motion"), null, "a routed open lands settled");
  } finally {
    await page.unmount();
  }
  const shared = await mount(GeneralPage, { settingsTarget: { itemId: "general.swipeNavigation" } });
  try {
    // A setting in two groups opens the first, so the deep link lands once.
    assert.equal(shared.toggle("tablet")?.getAttribute("aria-expanded"), "true");
    assert.equal(shared.toggle("phone")?.getAttribute("aria-expanded"), "false");
    assert.equal(shared.host.querySelectorAll('[data-settings-item="general.swipeNavigation"]').length, 1);
  } finally {
    await shared.unmount();
  }
  const appearance = await mount(AppearancePage, { settingsTarget: { itemId: "appearance.compactShortcuts" } });
  try {
    assert.ok(appearance.grouped("appearance.compactShortcuts", "tablet"), "the tablet bar's own link opens it on a desktop");
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
      assert.equal(page.grouped(id, "tablet"), false);
    }
    assert.deepEqual(page.devices(), ["tablet"]);
    assert.equal(page.title("tablet"), titled("tablet"));
    assert.equal(page.summary("tablet"), tr("settings.pages.compactShortcuts"), "rails shown above are not listed again");
    assert.equal(present(page.item("appearance.compactShortcuts")), false);
  } finally {
    await page.unmount();
  }
});

test("phone: desktop and tablet settings close up in a group each; gestures show in place", async () => {
  await viewport(390, 844);
  assert.equal(getShellMode(), "phone");
  const appearance = await mount(AppearancePage);
  try {
    assert.deepEqual(appearance.devices(), ["desktop", "tablet"]);
    assert.equal(appearance.title("desktop"), titled("desktop"));
    assert.equal(appearance.title("tablet"), titled("tablet"));
    assert.equal(appearance.summary("desktop"), [
      tr("settings.shellLayout.title"), tr("settings.pages.railSizes"), tr("settings.pages.statusBar"),
    ].join(" · "));
    assert.equal(appearance.summary("tablet"), [
      tr("settings.pages.railSizes"), tr("settings.pages.statusBar"), tr("settings.pages.compactShortcuts"),
    ].join(" · "));
    for (const id of ["appearance.windowLayout", "appearance.railSizes", "appearance.statusBar", "appearance.compactShortcuts"]) {
      assert.equal(present(appearance.item(id)), false, `${id} starts hidden`);
    }
    assert.ok(present(appearance.item("appearance.density")), "settings for every screen stay");
    const density = appearance.item("appearance.density")!;
    assert.ok(density.compareDocumentPosition(appearance.group("desktop")!) & 4, "this device's settings come first");
    await appearance.open("desktop");
    for (const id of ["appearance.windowLayout", "appearance.mirrorLayout", "appearance.railSizes", "appearance.statusBar"]) {
      assert.ok(appearance.grouped(id, "desktop"), `${id} opens inside the desktop group`);
    }
    assert.equal(appearance.grouped("appearance.compactShortcuts", "desktop"), false, "the tablet toolbar is not a desktop setting");
    // Loose rows come first under the group's heading, so "Layout" is never
    // titled twice on the page; whole sections follow a heading level down.
    const titles = () => [...appearance.host.querySelectorAll(".settings-other-devices-body .settings-section-title")].map((title) => `${title.tagName}:${title.textContent}`);
    assert.deepEqual(titles(), [`H4:${tr("settings.shellLayout.title")}`]);
    const body = appearance.group("desktop")!.querySelector(".settings-other-devices-body");
    const rows = body?.querySelector(".settings-other-devices-rows");
    assert.ok(rows?.querySelector('[data-settings-item="appearance.railSizes"]'), "rails rows are loose");
    assert.ok(rows && rows.compareDocumentPosition(body!.querySelector(".settings-section")!) & 4, "loose rows lead");
    await appearance.open("desktop");
    await appearance.open("tablet");
    for (const id of ["appearance.railSizes", "appearance.statusBar", "appearance.compactShortcuts"]) {
      assert.ok(appearance.grouped(id, "tablet"), `${id} opens inside the tablet group`);
    }
    assert.equal(appearance.grouped("appearance.windowLayout", "tablet"), false, "the window layout is not a tablet setting");
    assert.deepEqual(titles(), [`H4:${tr("settings.pages.compactShortcuts")}`]);
    // The tablet editor's own list heading follows its section one level down.
    const listHeading = appearance.host.querySelector(".settings-other-devices-body .compact-shortcuts-heading");
    assert.equal(listHeading?.tagName, "H5");
  } finally {
    await appearance.unmount();
  }
  const general = await mount(GeneralPage);
  try {
    assert.deepEqual(general.devices(), [], "nothing on General is for another device");
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
    assert.deepEqual(appearance.devices(), ["desktop"]);
    assert.equal(appearance.title("desktop"), titled("desktop"));
    assert.equal(appearance.summary("desktop"), tr("settings.shellLayout.title"));
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
    assert.deepEqual(general.devices(), ["phone"]);
    assert.equal(general.title("phone"), titled("phone"));
    assert.equal(general.summary("phone"), tr("settings.devices.rowSwipes"));
    assert.equal(present(general.item("general.rowSwipeLeading")), false);
  } finally {
    await general.unmount();
    await viewport(1280, 900);
  }
});

const join = (...keys: string[]) => keys.map((key) => tr(key as "settings.pages.promptRail")).join(" · ");

test("chat: each screen keeps its own send key, prompt navigation and title; the rest wait per device", async () => {
  // Phone: its send key, the narrow bookmark and the title row.
  await viewport(390, 844);
  let chat = await mount(ChatPage);
  try {
    assert.deepEqual(chat.devices(), ["desktop", "tablet"]);
    assert.equal(chat.summary("desktop"), join("settings.pages.desktopSendShortcut", "settings.pages.promptRail", "settings.pages.promptBookmarkDesktop"));
    assert.equal(chat.summary("tablet"), join("settings.pages.desktopSendShortcut"));
    assert.ok(chat.hasRow("header"), "the phone's title has its row");
    await chat.openRow("send");
    assert.ok(present(chat.item("chat.mobileSendShortcut")));
    assert.equal(present(chat.item("chat.sendOnEnter")), false, "the keyboard's key waits");
    assert.ok(present(chat.item("chat.sendHoldDraft")), "the hold works everywhere");
    await chat.openRow("navigation");
    assert.ok(present(chat.item("chat.pinLatestPrompt")));
    for (const id of ["chat.promptNavigator", "chat.promptBookmarkDesktop"]) assert.equal(present(chat.item(id)), false, `${id} waits`);
    await chat.open("desktop");
    for (const id of ["chat.sendOnEnter", "chat.promptNavigator", "chat.promptBookmarkDesktop"]) {
      assert.ok(chat.grouped(id, "desktop"), `${id} in the desktop group`);
    }
  } finally {
    await chat.unmount();
  }
  // Tablet: the keyboard's key and the narrow bookmark; no rail, no phone title.
  await viewport(800, 1100);
  chat = await mount(ChatPage);
  try {
    assert.deepEqual(chat.devices(), ["desktop", "phone"]);
    assert.equal(chat.summary("desktop"), join("settings.pages.promptRail", "settings.pages.promptBookmarkDesktop"));
    assert.equal(chat.summary("phone"), join("settings.chatPage.phoneSendShortcut", "settings.chatPage.phoneSessionTitle"));
    assert.equal(chat.hasRow("header"), false);
    await chat.openRow("send");
    assert.ok(present(chat.item("chat.sendOnEnter")));
    assert.equal(present(chat.item("chat.mobileSendShortcut")), false);
  } finally {
    await chat.unmount();
  }
  // Desktop: the rail and the wide bookmark; the narrow bookmark is the tablet's and the phone's.
  await viewport(1280, 900);
  chat = await mount(ChatPage);
  try {
    assert.deepEqual(chat.devices(), ["tablet", "phone"]);
    assert.equal(chat.summary("tablet"), join("settings.pages.promptBookmarkMobile"));
    assert.equal(chat.summary("phone"), join("settings.chatPage.phoneSendShortcut", "settings.pages.promptBookmarkMobile", "settings.chatPage.phoneSessionTitle"));
    await chat.openRow("navigation");
    assert.ok(present(chat.item("chat.promptNavigator")));
    assert.ok(present(chat.item("chat.promptBookmarkDesktop")));
    assert.equal(present(chat.item("chat.pinLatestPrompt")), false);
  } finally {
    await chat.unmount();
  }
});

test("behavior: the pinned-window setting is the desktop's", async () => {
  await viewport(1280, 900);
  let page = await mount(BehaviorPage);
  try {
    assert.ok(present(page.item("behavior.sharedPinnedWindow")));
    assert.deepEqual(page.devices(), []);
  } finally {
    await page.unmount();
  }
  await viewport(390, 844);
  page = await mount(BehaviorPage);
  try {
    assert.deepEqual(page.devices(), ["desktop"]);
    assert.equal(page.summary("desktop"), tr("settings.pages.sharedPinnedWindow"));
    assert.equal(present(page.item("behavior.sharedPinnedWindow")), false);
    await page.open("desktop");
    assert.ok(page.grouped("behavior.sharedPinnedWindow", "desktop"));
    const titles = [...page.host.querySelectorAll(".settings-other-devices-body .settings-section-title")].map((title) => `${title.tagName}:${title.textContent}`);
    assert.deepEqual(titles, [`H4:${tr("settings.pages.sectionPackageWindows")}`]);
  } finally {
    await page.unmount();
    await viewport(1280, 900);
  }
});
