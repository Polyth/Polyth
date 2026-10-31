// Desktop window chrome through a real React root and a fake preload bridge:
// Linux draws Polyth's caption buttons in window-manager order, macOS/Windows
// draw none, window state reaches <body>, every platform names the corner its
// caption controls own and no layout renders under it, Windows keeps its
// native caption overlay transparent, and native menu commands run shell
// commands.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
const { desktopCaptionSide, installDesktopIntegration } = await import("../src/desktop.tsx");
const { registerCommand } = await import("../src/commands.ts");
type Bridge = import("../src/desktopBridge.ts").PolythDesktopApi;
type WindowState = import("../src/desktopBridge.ts").DesktopWindowState;
type Command = import("../src/desktopBridge.ts").DesktopCommand;

const settings = {
  closeToTray: true, startMinimized: false, launchAtLogin: false, keepAwake: false, automaticUpdates: true,
  updateChannel: "stable" as const, lowResourceMode: false, softwareRendering: false, reduceAnimations: false, controlsPosition: "right" as "left" | "right", controlsTheme: "system" as const,
};

function fakeBridge(platform: string, info: Record<string, unknown> = {}) {
  const windowListeners = new Set<(state: WindowState) => void>();
  const commandListeners = new Set<(command: Command) => void>();
  const actions: string[] = [];
  const titlebars: unknown[] = [];
  const state: WindowState = { maximized: false, fullscreen: false, visible: true, focused: true };
  const bridge = {
    getInfo: async () => ({ platform, arch: "x64", appVersion: "0", opencodeVersion: "0", dataDir: "/d", logPath: "/l", packaged: false, trayAvailable: true, canLaunchAtLogin: false, keepAwakeActive: false, lowResourceMode: false, softwareRendering: false, ...info }),
    getSettings: async () => ({ ...settings }),
    getWindowState: async () => ({ ...state }),
    windowAction: async (action: string) => { actions.push(action); return { ...state }; },
    setTitleBarAppearance: async (appearance: unknown) => { titlebars.push(appearance); },
    onSettingsChanged: () => () => {},
    onUpdateState: () => () => {},
    onWindowState: (listener: (state: WindowState) => void) => { windowListeners.add(listener); return () => windowListeners.delete(listener); },
    onCommand: (listener: (command: Command) => void) => { commandListeners.add(listener); return () => commandListeners.delete(listener); },
  } as unknown as Bridge;
  return {
    bridge, actions, titlebars,
    emitState: (next: Partial<WindowState>) => { for (const l of windowListeners) l({ ...state, ...next }); },
    emitCommand: (command: Command) => { for (const l of commandListeners) l(command); },
  };
}

async function mount(platform: string) {
  const fake = fakeBridge(platform);
  (window as unknown as { polythDesktop?: Bridge }).polythDesktop = fake.bridge;
  document.body.innerHTML = `<div class="app"><header class="header"></header></div><div id="host"></div>`;
  const uninstall = installDesktopIntegration();
  const root = createRoot(document.getElementById("host")!);
  await act(async () => { root.render(createElement(SlotHost, { slot: "app.window.controls", context: {} })); });
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  return {
    ...fake,
    cleanup: async () => {
      await act(async () => root.unmount());
      uninstall();
      delete (window as unknown as { polythDesktop?: Bridge }).polythDesktop;
    },
  };
}

const labels = () => [...document.querySelectorAll(".desktop-window-button")].map((b) => b.getAttribute("aria-label"));

test("Linux renders vector caption buttons with close at the window corner", async () => {
  settings.controlsPosition = "right";
  const view = await mount("linux");
  try {
    assert.deepEqual(labels(), ["Minimize window", "Maximize window", "Hide window to tray"]);
    assert.equal(document.querySelectorAll(".desktop-window-button svg.desktop-window-glyph").length, 3);
    assert.equal(document.querySelector(".desktop-window-controls")?.getAttribute("role"), "group");
    (document.querySelector('[aria-label="Maximize window"]') as HTMLElement).click();
    assert.deepEqual(view.actions, ["toggle-maximize"]);
  } finally { await view.cleanup(); }

  settings.controlsPosition = "left";
  const left = await mount("linux");
  try {
    assert.deepEqual(labels(), ["Hide window to tray", "Minimize window", "Maximize window"]);
  } finally { await left.cleanup(); settings.controlsPosition = "right"; }
});

test("window state reaches <body> for maximized, fullscreen, and inactive chrome", async () => {
  const view = await mount("darwin");
  try {
    assert.equal(document.body.dataset.desktopPlatform, "darwin");
    assert.equal(document.querySelector(".desktop-window-controls"), null, "macOS keeps its traffic lights");
    await act(async () => view.emitState({ fullscreen: true, focused: false }));
    assert.equal(document.body.dataset.desktopFullscreen, "true");
    assert.equal(document.body.dataset.desktopFocused, "false");
    await act(async () => view.emitState({ maximized: true }));
    assert.equal(document.body.dataset.desktopMaximized, "true");
    assert.equal(document.body.dataset.desktopFullscreen, undefined);
  } finally { await view.cleanup(); }
  assert.equal(document.body.dataset.desktopMaximized, undefined, "teardown clears window state");
});

test("Windows draws no renderer buttons and keeps the native overlay transparent", async () => {
  const view = await mount("win32");
  try {
    assert.equal(document.querySelector(".desktop-window-controls"), null);
    // happy-dom has no canvas, so sampling declines rather than sending junk.
    for (const appearance of view.titlebars) {
      assert.match((appearance as { color: string }).color, /^#[0-9a-f]{6}00$/);
    }
  } finally { await view.cleanup(); }
  const desktop = await readFile(new URL("../src/desktop.tsx", import.meta.url), "utf8");
  // Fully transparent background: Windows paints only the glyphs over the
  // renderer's own surface. A shell that refuses alpha gets the opaque RGB.
  assert.match(desktop, /color: `\$\{toHex\(base\)\}00`/);
  assert.match(desktop, /appearance\.color\.slice\(0, 7\)/);
  // ...only when the shell rejected the colour itself (main's validator
  // message), and once only the opaque form took, it is the only one sent.
  assert.match(desktop, /if \(!\/Invalid title bar colors\/\.test\(String\(error\)\)\) throw error;/);
  assert.match(desktop, /api\.setTitleBarAppearance\(opaque\)\.then\(\(\) => \{ opaqueOnly = true; \}\)/);
  const chrome = await readFile(new URL("../../desktop/src/windowChrome.ts", import.meta.url), "utf8");
  assert.match(chrome, /throw new Error\("Invalid title bar colors"\)/);
  // The overlay is as tall as the caption band (the zone's own box), which on
  // Windows is the system's own caption height, mirrored by main.
  assert.match(desktop, /querySelector<HTMLElement>\("\.desktop-caption-zone"\)\?\.getBoundingClientRect\(\)\.height/);
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const caption = /body\.desktop-app\[data-desktop-platform="win32"\]\s*\{[^}]*--desktop-caption-h:\s*(\d+)px;/s.exec(styles)?.[1];
  assert.equal(caption, /WINDOWS_CAPTION_HEIGHT = (\d+);/.exec(chrome)?.[1]);
  assert.ok(Number(caption) < 40, "Electron stretches each 46 px button to the overlay height: never the header's");
});

test("each platform names the corner its caption controls own", async () => {
  assert.equal(desktopCaptionSide({ platform: undefined, controlsPosition: "right", fullscreen: false }), null);
  assert.equal(desktopCaptionSide({ platform: "darwin", controlsPosition: "right", fullscreen: false }), "left", "traffic lights sit left whatever the Linux setting says");
  assert.equal(desktopCaptionSide({ platform: "darwin", controlsPosition: "left", fullscreen: true }), null, "fullscreen hides the traffic lights");
  assert.equal(desktopCaptionSide({ platform: "win32", controlsPosition: "left", fullscreen: false }), "right");
  assert.equal(desktopCaptionSide({ platform: "win32", controlsPosition: "right", fullscreen: true, overlayLeft: 138 }), "left", "a mirrored system UI moves the overlay");
  assert.equal(desktopCaptionSide({ platform: "linux", controlsPosition: "left", fullscreen: true }), "left", "Polyth's own buttons stay in fullscreen");
  assert.equal(desktopCaptionSide({ platform: "linux", controlsPosition: "right", fullscreen: false }), "right");

  settings.controlsPosition = "left";
  const linux = await mount("linux");
  try {
    assert.equal(document.body.dataset.desktopCaption, "left");
    assert.equal(document.querySelectorAll("body > .desktop-caption-zone").length, 1, "one zone box, in <body>");
    assert.equal(document.querySelector(".desktop-caption-zone")?.getAttribute("aria-hidden"), "true");
  } finally { await linux.cleanup(); settings.controlsPosition = "right"; }
  assert.equal(document.body.dataset.desktopCaption, undefined, "teardown clears the caption side");

  const mac = await mount("darwin");
  try {
    assert.equal(document.body.dataset.desktopCaption, "left");
    assert.equal(document.querySelectorAll(".desktop-caption-zone").length, 1);
    await act(async () => mac.emitState({ fullscreen: true }));
    assert.equal(document.body.dataset.desktopCaption, undefined);
    await act(async () => mac.emitState({ fullscreen: false }));
    assert.equal(document.body.dataset.desktopCaption, "left");
    // Focus changes leave the side as it is, so they do not wake the
    // observers that re-measure the bar and resample the overlay; a real
    // change still lands.
    const writes = async (change: () => void) => {
      const records: string[] = [];
      const watch = new MutationObserver((batch) => { for (const r of batch) records.push(String(r.attributeName)); });
      watch.observe(document.body, { attributes: true, attributeFilter: ["data-desktop-caption"] });
      await act(async () => change());
      for (const r of watch.takeRecords()) records.push(String(r.attributeName));
      watch.disconnect();
      return records.length;
    };
    assert.equal(await writes(() => { mac.emitState({ focused: false }); mac.emitState({ focused: true }); }), 0);
    assert.ok(await writes(() => mac.emitState({ fullscreen: true })) > 0);
  } finally { await mac.cleanup(); }

  const windows = await mount("win32");
  try {
    assert.equal(document.body.dataset.desktopCaption, "right");
  } finally { await windows.cleanup(); }
});

test("nothing renders under the caption zone in the full-height layouts", async () => {
  const [styles, layout, header] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/shellLayout.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Header.tsx", import.meta.url), "utf8"),
  ]);
  // One geometry contract: a physical width at each top corner, a band height.
  assert.match(styles, /body\.desktop-app\s*\{[^}]*--desktop-caption-left:\s*0px;[^}]*--desktop-caption-right:\s*0px;/s);
  assert.match(styles, /body\.desktop-app\[data-desktop-caption="right"\] \.desktop-caption-zone\s*\{[^}]*width:\s*var\(--desktop-caption-right\)/s);
  assert.match(styles, /body\.desktop-app\[data-desktop-platform="win32"\]\s*\{[^}]*--desktop-caption-right:\s*calc\([^}]*env\(titlebar-area-width/s);
  // The overlay is transparent, so the header no longer fakes a solid band.
  assert.doesNotMatch(styles, /\[data-desktop-platform="win32"\] \.app > \.header:not\(\[data-top-rail-surface="floating"\]\)\s*\{[^}]*background/s);
  // The workspace starts where the band ends, above every look: with
  // Floating columns the band reaches past the bar.
  assert.match(layout, /body\.desktop-app:is\(\[data-shell-layout="columns"\], \[data-shell-layout="bare"\]\):not\(#\\#\) \.app-shell > \.workspace \{\s*margin-block-start: var\(--desktop-caption-band\) !important;/);
  // The navigator under the zone starts its content below the band; the
  // launcher column under it starts below the band entirely, in every
  // placement, above every look; the full-window layer always does.
  const caption = (side: string, dir: string, rest: string) =>
    `body.desktop-app[data-desktop-caption="${side}"]:is([data-shell-layout="columns"], [data-shell-layout="bare"])${rest.startsWith(":not") ? "" : " "}${rest.replace("DIR", dir)}`;
  for (const [side, dir] of [["left", "ltr"], ["right", "rtl"]] as const) {
    assert.ok(layout.includes(caption(side, dir, ".app-shell:dir(DIR) > .sidebar")), `navigator under a ${side} zone`);
  }
  // The navigator away from the zone keeps the title bar's drag band only:
  // the taller caption band is carved out of it.
  for (const [side, dir] of [["right", "ltr"], ["left", "rtl"]] as const) {
    assert.ok(layout.includes(caption(side, dir, ".app-shell:dir(DIR) > .sidebar::after")), `navigator away from a ${side} zone`);
  }
  assert.match(layout, /> \.sidebar::after \{[^}]*top: calc\(var\(--desktop-titlebar-h\) - var\(--shell-edge\)\);\s*height: calc\(var\(--desktop-caption-h\) - var\(--desktop-titlebar-h\)\);[^}]*-webkit-app-region: no-drag;/s);
  // Its resize handle overhangs that box: an interactive splitter is carved
  // out of every drag band like the other controls.
  assert.match(styles, /body\.desktop-app :is\([^)]*\[role="separator"\]\[aria-valuenow\],[^)]*\)\s*\{\s*-webkit-app-region: no-drag;/s);
  const docks = ":not(.railbar-dock-bottom):not(.railbar-pinned-narrow)";
  for (const [side, dir] of [["right", "ltr"], ["left", "rtl"]] as const) {
    assert.ok(layout.includes(caption(side, dir, `:not(#\\#) .app-shell:dir(DIR) > .railbar.railbar-open${docks}:not(:has(> .rail-fullscreen))`)), `open window under a ${side} zone`);
    assert.ok(layout.includes(caption(side, dir, `:not(#\\#) .app-shell:dir(DIR) > .railbar:not(.railbar-open)${docks}`)), `idle strip under a ${side} zone`);
    assert.ok(layout.includes(caption(side, dir, ":not(#\\#) .app-shell:dir(DIR) > .railbar:is(.railbar-dock-bottom, .railbar-pinned-narrow) > .rail-icon-col.plugin-strip")), `docked strip under a ${side} zone`);
    assert.ok(layout.includes(caption(side, dir, `:not(#\\#) .app-shell:dir(DIR) > .railbar[data-rail-motion="exiting"]:not(.railbar-open)${docks}:not(:has(> .rail-fullscreen))`)), `closing tablet window under a ${side} zone`);
  }
  assert.match(layout, /\.railbar\.railbar-open:not\(\.railbar-dock-bottom\):not\(\.railbar-pinned-narrow\):not\(:has\(> \.rail-fullscreen\)\) \{\s*margin-block-start: var\(--desktop-caption-band\) !important;/);
  assert.match(layout, /\.railbar:not\(\.railbar-open\):not\(\.railbar-dock-bottom\):not\(\.railbar-pinned-narrow\) \{\s*inset-block-start: var\(--desktop-caption-band\) !important;/);
  // A bottom or narrow dock keeps its full-height host: only its strip moves.
  assert.match(layout, /> \.rail-icon-col\.plugin-strip \{\s*inset-block-start: calc\(var\(--desktop-caption-band\) - var\(--shell-edge\)\);\s*height: auto;/);
  // A tablet-band window closes into the cluster below the band, its morph
  // clamped like the cluster; a closing dock's strip there (the host at the
  // shell's top) sits at the band itself.
  assert.match(layout, /\.railbar\[data-rail-motion="exiting"\][^{]*\{\s*margin-block-start: var\(--desktop-caption-band\) !important;/);
  assert.match(layout, /\.app-shell:dir\(ltr\) > \.railbar,[^{]*\{\s*--rail-cluster-clear: var\(--desktop-caption-band\);/);
  assert.match(layout, /:not\(\.railbar-open\) > \.rail-icon-col\.plugin-strip \{\s*inset-block-start: var\(--desktop-caption-band\);/);
  assert.match(layout, /\.app-shell > \.railbar:has\(> \.rail-fullscreen\) \{\s*top: var\(--desktop-caption-band\);/);
  assert.match(layout, /--desktop-caption-band: max\(var\(--shell-bar-block\), var\(--desktop-caption-h\)\)/);
  // Floating columns centre Polyth's Linux caption buttons on their first
  // row; the macOS traffic lights and the Windows caption buttons keep the
  // window's own top corner.
  assert.match(layout, /\[data-shell-floating="true"\][^{]*:not\(\[data-desktop-platform="darwin"\], \[data-desktop-platform="win32"\]\) \{\s*--desktop-caption-h: calc\(var\(--desktop-titlebar-h\) \+ 2 \* var\(--space-2\)\);/);
  // The island capsule hangs one --space-2 lower still: the band centres on
  // it, flush and floating.
  assert.match(layout, /body\.desktop-app\[data-shell-layout="columns"\]\[data-shell-bar="island"\]:not\(\[data-desktop-platform="darwin"\], \[data-desktop-platform="win32"\]\) \{\s*--desktop-caption-h: calc\(var\(--desktop-titlebar-h\) \+ 2 \* var\(--space-2\)\);/);
  assert.match(layout, /body\.desktop-app\[data-shell-floating="true"\]\[data-shell-layout="columns"\]\[data-shell-bar="island"\]:not\(\[data-desktop-platform="darwin"\], \[data-desktop-platform="win32"\]\) \{\s*--desktop-caption-h: calc\(var\(--desktop-titlebar-h\) \+ 4 \* var\(--space-2\)\);/);
  // The bar between the columns measures the zone with its other overlays.
  assert.match(header, /const CAPTION_ZONE = "\.desktop-caption-zone"/);
  assert.match(header, /\.\.\.document\.querySelectorAll<HTMLElement>\(CAPTION_ZONE\)/);
});

test("native menu commands run the shell's own commands", async () => {
  const ran: string[] = [];
  const offs = ["cmd.settings", "cmd.new", "cmd.search", "cmd.palette"].map((id) =>
    registerCommand({ id, label: id, run: () => { ran.push(id); } }));
  const view = await mount("linux");
  try {
    for (const command of ["open-settings", "new-session", "search-sessions", "command-palette"] as const) view.emitCommand(command);
    assert.deepEqual(ran, ["cmd.settings", "cmd.new", "cmd.search", "cmd.palette"]);
  } finally {
    await view.cleanup();
    for (const off of offs) off();
  }
});

test("caption controls sit below toasts/popovers and no full-window layer starts under them", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const tokens = await readFile(new URL("../src/tokens.css", import.meta.url), "utf8");
  const overlay = Number(/--z-overlay:\s*(\d+)/.exec(tokens)?.[1]);
  const toast = Number(/--z-toast:\s*(\d+)/.exec(tokens)?.[1]);
  const offset = Number(/--z-window-controls:\s*calc\(var\(--z-overlay\) \+ (\d+)\)/.exec(styles)?.[1]);
  // Above scrims/drawers so the window stays closable, below toasts, popovers, tooltips.
  assert.ok(overlay + offset > overlay && overlay + offset < toast, "controls layer between overlays and toasts");
  assert.match(styles, /\.desktop-window-controls\s*\{[^}]*z-index:\s*var\(--z-window-controls\)/s);
  assert.doesNotMatch(styles, /z-index:\s*10020/);
  // The caption band (the title bar, or taller where a layout hangs its first
  // row lower) is reserved by every layer that fills the window.
  assert.match(styles, /--desktop-titlebar-reserve:\s*var\(--desktop-caption-h\)/);
  for (const rule of [
    /body\.desktop-app :is\(\.dialog-backdrop, \.sheet-backdrop\)\s*\{[^}]*var\(--desktop-titlebar-reserve\)/s,
    /body\.desktop-app \.scrim\s*\{[^}]*var\(--desktop-titlebar-reserve\)/s,
    /body\.desktop-app \.scrim\.settings-scrim\s*\{[^}]*padding:\s*var\(--desktop-titlebar-reserve\)/s,
    /body\.desktop-app \.scrim\.settings-scrim > \.settings-shell\s*\{[^}]*height:\s*100%/s,
    /body\.desktop-app \.lock-screen\s*\{[^}]*var\(--desktop-titlebar-reserve\)/s,
    /body\.desktop-app \.sidebar\s*\{[^}]*top:\s*var\(--desktop-titlebar-reserve\)/s,
    /body\.desktop-app :is\(\.module-view--main, \.rail-fullscreen, \.panel-sheet\)\s*\{[^}]*var\(--desktop-titlebar-reserve\)/s,
  ]) assert.match(styles, rule);
});

test("Linux caption buttons wear the header's control vocabulary", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const desktop = await readFile(new URL("../src/desktop.tsx", import.meta.url), "utf8");
  // The cluster takes the header's own compact control geometry and fill
  // vocabulary, not a bespoke size or a hardcoded palette.
  assert.match(styles, /--desktop-controls-slot:\s*var\(--control-h-sm\)/);
  const button = /\.desktop-window-button\s*\{[^}]*\}/s.exec(styles)?.[0] ?? "";
  assert.match(button, /border-radius:\s*var\(--radius-control\)/);
  assert.match(button, /--desktop-window-button-fill:\s*var\(--surface-overlay\)/);
  assert.match(button, /--desktop-window-button-hover:\s*var\(--surface-overlay-hover\)/);
  assert.match(button, /--desktop-window-button-press:\s*var\(--surface-overlay-strong\)/);
  assert.match(button, /color:\s*var\(--desktop-window-button-ink\)/);
  assert.match(button, /background:\s*var\(--desktop-window-button-fill\)/);
  // With glass on, the cluster borrows the header's cut-glass chip material.
  assert.match(
    styles,
    /body:not\(\[data-glass="off"\]\) \.desktop-window-button\s*\{[^}]*--material-glass-border[^}]*--material-glass-readable-control-fill/s,
  );
  // Focus ring is the shared accent ring.
  assert.match(styles, /\.desktop-window-button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/s);
  // Close takes the shared danger pair, not a bespoke red.
  assert.match(styles, /\.desktop-window-button\.close(?::[^,{]*)?\s*\{[^}]*color:\s*var\(--red-ink\)[^}]*background:\s*var\(--red\)/s);
  assert.doesNotMatch(styles, /#e5484d/);
  assert.doesNotMatch(styles, /#c93b40/);
  // The native Windows overlay samples the header's control ink (--text-dim),
  // not its body text, so both platforms read the same.
  assert.match(desktop, /getPropertyValue\("--text-dim"\)/);
  assert.doesNotMatch(desktop, /parseRgba\(headerStyle\.color, context, color\)/);
});

async function mountSettings(info: Record<string, unknown>) {
  const fake = fakeBridge("darwin", info);
  (window as unknown as { polythDesktop?: Bridge }).polythDesktop = fake.bridge;
  document.body.innerHTML = `<div id="host"></div>`;
  const uninstall = installDesktopIntegration();
  const root = createRoot(document.getElementById("host")!);
  await act(async () => { root.render(createElement(SlotHost, { slot: "settings.pages", context: {} })); });
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  return async () => {
    await act(async () => root.unmount());
    uninstall();
    delete (window as unknown as { polythDesktop?: Bridge }).polythDesktop;
  };
}

const channelRow = () => document.querySelector('[data-settings-item="desktop.updateChannel"]') ?? null;

test("the macOS 12 build shows a fixed Stable update channel instead of the picker", async () => {
  const regular = await mountSettings({});
  try {
    assert.ok(channelRow(), "the update channel row renders");
    assert.ok(channelRow()?.querySelector('[aria-label="Update channel"]'), "regular builds can pick a channel");
  } finally { await regular(); }

  const legacy = await mountSettings({ macLegacyUpdates: true });
  try {
    const row = channelRow();
    assert.equal(row?.querySelector('[aria-label="Update channel"]'), null, "no channel picker on the macOS 12 feed");
    assert.equal(row?.querySelector(".set-row-value")?.textContent, "Stable");
    assert.match(row?.textContent ?? "", /macOS 12 build updates from stable releases only/);
  } finally { await legacy(); }
});
