// Main-window desktop update notice through a real React root and a fake
// preload bridge: the state found before mount is announced, a found release
// offers Download (or the release page on manual builds), a ready one offers
// Restart, and a dismissal hides one stage of one version only.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  matchMedia: dom.matchMedia.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: SlotHost } = await import("../src/components/slots/SlotHost.ts");
const { installDesktopIntegration } = await import("../src/desktop.tsx");
const { desktopUpdateNoticeView, DESKTOP_UPDATE_NOTICE_DISMISSED_KEY } = await import("../src/desktopUpdateNotice.tsx");
const { default: NotificationStack } = await import("../src/notify/NotificationStack.tsx");
const { getNotifications } = await import("../src/notify/store.ts");
type Bridge = import("../src/desktopBridge.ts").PolythDesktopApi;
type UpdateState = import("../src/desktopBridge.ts").DesktopUpdateState;

const settings = {
  closeToTray: true, startMinimized: false, launchAtLogin: false, keepAwake: false, automaticUpdates: true,
  lowResourceMode: false, softwareRendering: false, reduceAnimations: false, controlsPosition: "right" as const, controlsTheme: "system" as const,
};

function fakeBridge(initial: UpdateState | null) {
  const updateListeners = new Set<(state: UpdateState) => void>();
  const calls: string[] = [];
  const bridge = {
    getInfo: async () => ({ platform: "win32", arch: "x64", appVersion: "0.1.100", opencodeVersion: "0", dataDir: "/d", logPath: "/l", packaged: true, trayAvailable: true, canLaunchAtLogin: false, keepAwakeActive: false, lowResourceMode: false, softwareRendering: false }),
    getSettings: async () => ({ ...settings }),
    getWindowState: async () => ({ maximized: false, fullscreen: false, visible: true, focused: true }),
    setTitleBarAppearance: async () => {},
    onSettingsChanged: () => () => {},
    onWindowState: () => () => {},
    onCommand: () => () => {},
    onUpdateState: (listener: (state: UpdateState) => void) => { updateListeners.add(listener); return () => updateListeners.delete(listener); },
    ...(initial ? { getUpdateState: async () => ({ ...initial }) } : {}),
    downloadUpdate: async () => { calls.push("download"); return initial!; },
    installUpdate: async () => { calls.push("install"); },
  } as unknown as Bridge;
  return {
    bridge, calls,
    emit: (state: UpdateState) => { for (const l of updateListeners) l(state); },
  };
}

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
};

async function mount(initial: UpdateState | null) {
  const fake = fakeBridge(initial);
  (window as unknown as { polythDesktop?: Bridge }).polythDesktop = fake.bridge;
  document.body.innerHTML = `<div id="host"></div><div id="stack"></div>`;
  const uninstall = installDesktopIntegration();
  const root = createRoot(document.getElementById("host")!);
  const stack = createRoot(document.getElementById("stack")!);
  await act(async () => {
    root.render(createElement(SlotHost, { slot: "app.window.controls", context: {} }));
    stack.render(createElement(NotificationStack));
  });
  await settle();
  return {
    ...fake,
    emitState: async (state: UpdateState) => { await act(async () => fake.emit(state)); },
    cleanup: async () => {
      await act(async () => root.unmount());
      uninstall();
      await act(async () => stack.unmount());
      delete (window as unknown as { polythDesktop?: Bridge }).polythDesktop;
    },
  };
}

const notice = () => document.querySelector(".notify-card[data-update-kind]");
const noticeText = () => notice()?.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll(".notify-card[data-update-kind] button")]
  .find((b) => b.textContent === label || b.getAttribute("aria-label") === label) as HTMLElement | undefined;

test("view: only found, downloading and ready releases with a version are announced", () => {
  assert.equal(desktopUpdateNoticeView({ phase: "checking", message: "" }, null), null);
  assert.equal(desktopUpdateNoticeView({ phase: "up-to-date", message: "", version: "0.1.137" }, null), null);
  assert.equal(desktopUpdateNoticeView({ phase: "error", message: "boom" }, null), null);
  assert.equal(desktopUpdateNoticeView({ phase: "available", message: "" }, null), null, "no version, nothing to name");
  assert.deepEqual(desktopUpdateNoticeView({ phase: "available", message: "", version: "0.1.137" }, null),
    { kind: "available", version: "0.1.137", dismissal: "found:0.1.137" });
  assert.equal(desktopUpdateNoticeView({ phase: "available", message: "", version: "0.1.137", installMode: "manual" }, null)?.kind, "manual");
  assert.deepEqual(desktopUpdateNoticeView({ phase: "downloading", message: "", version: "0.1.137", percent: 250 }, null),
    { kind: "downloading", version: "0.1.137", dismissal: "found:0.1.137", progress: 1 });
  assert.equal(desktopUpdateNoticeView({ phase: "downloaded", message: "", version: "0.1.137" }, "found:0.1.137")?.dismissal, "ready:0.1.137",
    "dismissing the found stage does not hide the ready one");
  assert.equal(desktopUpdateNoticeView({ phase: "downloaded", message: "", version: "0.1.137" }, "ready:0.1.137"), null);
  assert.equal(desktopUpdateNoticeView({ phase: "available", message: "", version: "0.1.138" }, "ready:0.1.137")?.version, "0.1.138",
    "a newer version shows again");
});

test("view: the desktop's small update window carries progress and restart while it is open", () => {
  assert.equal(desktopUpdateNoticeView({ phase: "downloading", message: "", version: "0.1.137", percent: 40, progressWindow: true }, null), null);
  assert.equal(desktopUpdateNoticeView({ phase: "downloaded", message: "", version: "0.1.137", progressWindow: true }, null), null);
  assert.equal(desktopUpdateNoticeView({ phase: "installing", message: "", version: "0.1.137" }, null)?.kind, "installing",
    "the handover stays visible until the small window takes over");
  assert.equal(desktopUpdateNoticeView({ phase: "installing", message: "", version: "0.1.137" }, "found:0.1.137")?.kind, "installing",
    "an earlier dismissal of the found stage must not hide the handover");
  assert.equal(desktopUpdateNoticeView({ phase: "installing", message: "", version: "0.1.137", progressWindow: true }, null), null);
  assert.equal(desktopUpdateNoticeView({ phase: "downloaded", message: "", version: "0.1.137", progressWindow: false }, null)?.kind, "downloaded",
    "Later in the small window leaves the restart reminder to this notice");
});

test("a ready update found before the window mounted offers Restart", async () => {
  localStorage.clear();
  const view = await mount({ phase: "downloaded", message: "", version: "0.1.137", installMode: "in-app" });
  try {
    assert.ok(notice(), "the update is a notification of the shared stack");
    assert.equal(notice()?.getAttribute("role"), "group");
    assert.equal(notice()?.getAttribute("data-update-kind"), "downloaded");
    assert.match(noticeText(), /Polyth 0\.1\.137 is ready to install/);
    await act(async () => button("Restart to update")!.click());
    assert.deepEqual(view.calls, ["install"]);
  } finally { await view.cleanup(); }
  assert.equal(getNotifications().items.length, 0, "uninstall withdraws the notification");
});

test("restarting shows an installing card until the small window owns the progress", async () => {
  localStorage.clear();
  const view = await mount({ phase: "downloaded", message: "", version: "0.1.137", installMode: "in-app" });
  try {
    await view.emitState({ phase: "installing", message: "", version: "0.1.137", installMode: "in-app" });
    assert.equal(notice()?.getAttribute("data-update-kind"), "installing");
    assert.match(noticeText(), /Installing Polyth 0\.1\.137/);
    assert.match(noticeText(), /closing, installing the update/);
    assert.equal(button("Restart to update"), undefined, "the handover cannot be triggered twice");
    assert.ok(document.querySelector(".notify-card[data-update-kind] .notify-glyph .ui-spinner"), "an indeterminate spinner is visible");
    assert.equal(document.querySelector(".notify-card[data-update-kind] .notify-close"), null, "the handover cannot be dismissed away");

    await view.emitState({ phase: "installing", message: "", version: "0.1.137", installMode: "in-app", progressWindow: true });
    assert.equal(notice(), null, "the small update window carries the progress once it exists");
  } finally { await view.cleanup(); }
});

test("found → downloading → ready follows live state, and Later hides only that stage", async () => {
  localStorage.clear();
  const view = await mount(null);
  try {
    assert.equal(notice(), null, "older shells without the getter wait for an event");
    await view.emitState({ phase: "available", message: "", version: "0.1.137", installMode: "in-app" });
    assert.match(noticeText(), /Polyth 0\.1\.137 is available/);
    await act(async () => button("Download")!.click());
    assert.deepEqual(view.calls, ["download"]);

    await view.emitState({ phase: "downloading", message: "", version: "0.1.137", percent: 40, installMode: "in-app" });
    assert.equal(notice()?.getAttribute("data-update-kind"), "downloading");
    assert.equal(document.querySelector(".notify-card[data-update-kind] [role=progressbar]")?.getAttribute("aria-valuenow"), "40");
    // Progress ticks update the card in place: same record, same place, no re-announcement.
    const record = () => getNotifications().items.find((item) => item.id === "host.desktop-update");
    const seq = record()?.seq;
    await view.emitState({ phase: "downloading", message: "", version: "0.1.137", percent: 70, installMode: "in-app" });
    assert.equal(document.querySelector(".notify-card[data-update-kind] [role=progressbar]")?.getAttribute("aria-valuenow"), "70");
    assert.equal(record()?.seq, seq, "a tick is an update, not a fresh notification");
    await act(async () => button("Dismiss update notice")!.click());
    assert.equal(notice(), null);
    assert.equal(localStorage.getItem(DESKTOP_UPDATE_NOTICE_DISMISSED_KEY), "found:0.1.137");

    await view.emitState({ phase: "downloaded", message: "", version: "0.1.137", installMode: "in-app" });
    assert.equal(notice()?.getAttribute("data-update-kind"), "downloaded", "a finished download announces itself again");
    await act(async () => button("Later")!.click());
    assert.equal(notice(), null);
  } finally { await view.cleanup(); }
});

test("manual-install builds send the user to the release page", async () => {
  localStorage.clear();
  const view = await mount({ phase: "available", message: "", version: "0.1.137", installMode: "manual" });
  try {
    assert.match(noticeText(), /updates by hand/);
    await act(async () => button("Open download page")!.click());
    assert.deepEqual(view.calls, ["download"], "main opens the release page for manual builds");
  } finally { await view.cleanup(); }
});
