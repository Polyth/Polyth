import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  desktopBridge,
  type DesktopCommand,
  type DesktopInfo,
  type DesktopSettings,
  type DesktopTitleBarAppearance,
  type DesktopUpdateState,
  type DesktopWindowState,
} from "./desktopBridge.ts";
import { runCommand } from "./commands.ts";
import { registerSlot } from "./slots.ts";
import { ReadonlyRow, Row, Seg, Toggle } from "./components/settings/parts.tsx";
import { Button, confirmAlert } from "./components/ui/index.ts";
import { POLYTH_MARK_SRC } from "./brandAsset.ts";
import { DesktopUpdateNotice } from "./desktopUpdateNotice.tsx";
import { installDesktopKeepAwake } from "./desktopKeepAwake.tsx";
import { tr, type TranslationKey } from "./i18n/index.ts";

const DEFAULTS: DesktopSettings = {
  closeToTray: true,
  startMinimized: false,
  launchAtLogin: false,
  keepAwake: false,
  keepAwakeMode: "working",
  automaticUpdates: true,
  updateChannel: "stable",
  lowResourceMode: false,
  softwareRendering: false,
  reduceAnimations: false,
  controlsPosition: "right",
  controlsTheme: "system",
};

const UPDATE_CHANNEL_OPTIONS = (): Array<[DesktopSettings["updateChannel"], string]> => [
  ["stable", tr("desktop.settings.channelStable")],
  ["test", tr("desktop.settings.channelTest")],
  ["nightly", tr("desktop.settings.channelNightly")],
];
const UPDATE_CHANNEL_HINTS: Record<DesktopSettings["updateChannel"], TranslationKey> = {
  stable: "desktop.settings.channelStableHint",
  test: "desktop.settings.channelTestHint",
  nightly: "desktop.settings.channelNightlyHint",
};

/** The desktop shell marks both <body> (most rules key on it) and <html>:
 *  rules about the document root key on `html[data-desktop-app]` instead of
 *  `html:has(body.desktop-app)`, which made <html> a `:has()` subject the
 *  engine re-matches on DOM insertions — and every <html> restyle here
 *  restyles the whole app (docs/dev/styles.md, "Motion and restyle cost"). */
const markDesktopApp = (on: boolean): void => {
  document.body.classList.toggle("desktop-app", on);
  if (on) document.documentElement.dataset.desktopApp = "true";
  else delete document.documentElement.dataset.desktopApp;
};

const applyDesktopChrome = (settings: DesktopSettings): void => {
  markDesktopApp(true);
  document.body.dataset.desktopControlsPosition = settings.controlsPosition;
  document.body.dataset.desktopControlsTheme = settings.controlsTheme;
  document.body.dataset.desktopLowResource = String(settings.lowResourceMode);
  document.documentElement.dataset.reduceAnimations = String(settings.reduceAnimations);
  window.dispatchEvent(new CustomEvent("polyth:desktop-performance-changed", {
    detail: {
      lowResourceMode: settings.lowResourceMode,
      reduceAnimations: settings.reduceAnimations,
    },
  }));
  applyCaptionSide();
};

const applyDesktopPlatform = (platform: DesktopInfo["platform"]): void => {
  document.body.dataset.desktopPlatform = platform;
  applyCaptionSide();
};

export type DesktopCaptionSide = "left" | "right";

/** The top corner of the window the caption controls own, or none: macOS
 *  traffic lights sit on the left and hide in fullscreen; the Windows overlay
 *  takes the side its titlebar area leaves free (right, unless the system
 *  mirrors it); Polyth's Linux buttons take the side the person chose. */
export function desktopCaptionSide(input: {
  platform: string | undefined;
  controlsPosition: string | undefined;
  fullscreen: boolean;
  /** Windows: the left edge of the overlay's free titlebar area. */
  overlayLeft?: number;
}): DesktopCaptionSide | null {
  if (!input.platform) return null;
  if (input.platform === "darwin") return input.fullscreen ? null : "left";
  if (input.platform === "win32") return (input.overlayLeft ?? 0) > 0 ? "left" : "right";
  return input.controlsPosition === "left" ? "left" : "right";
}

type WindowControlsOverlayApi = EventTarget & { getTitlebarAreaRect?: () => DOMRect };
const windowControlsOverlay = (): WindowControlsOverlayApi | undefined =>
  (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayApi }).windowControlsOverlay;

/** Publish the caption side as data-desktop-caption: styles.css sizes the
 *  caption zone from it and the layouts keep their content out of it. */
const applyCaptionSide = (): void => {
  const { dataset } = document.body;
  let overlayLeft = 0;
  if (dataset.desktopPlatform === "win32") {
    try { overlayLeft = windowControlsOverlay()?.getTitlebarAreaRect?.().x ?? 0; } catch { /* no overlay API */ }
  }
  const side = desktopCaptionSide({
    platform: dataset.desktopPlatform,
    controlsPosition: dataset.desktopControlsPosition,
    fullscreen: dataset.desktopFullscreen === "true",
    overlayLeft,
  });
  // Unchanged stays untouched: every write wakes the observers that re-measure
  // the bar and resample the overlay, and focus changes come through here.
  if (side === (dataset.desktopCaption ?? null)) return;
  if (side) dataset.desktopCaption = side;
  else delete dataset.desktopCaption;
};

/** Window state lives on <body> so CSS — not each component — adapts the
 *  chrome: square corners when maximized/fullscreen, no traffic-light inset
 *  in macOS fullscreen, quieter caption buttons while the window is inactive. */
const applyWindowState = (state: DesktopWindowState): void => {
  const { dataset } = document.body;
  if (state.maximized) dataset.desktopMaximized = "true";
  else delete dataset.desktopMaximized;
  if (state.fullscreen) dataset.desktopFullscreen = "true";
  else delete dataset.desktopFullscreen;
  dataset.desktopFocused = String(state.focused);
  applyCaptionSide();
};

const clearWindowState = (): void => {
  const { dataset } = document.body;
  delete dataset.desktopMaximized;
  delete dataset.desktopFullscreen;
  delete dataset.desktopFocused;
  delete dataset.desktopCaption;
};

const NATIVE_CONTROL_PLATFORMS = new Set(["darwin", "win32"]);

/** Hairline caption glyphs drawn on a 10×10 grid so they stay crisp at every
 *  scale factor (text glyphs varied by font and baseline). */
const CaptionGlyph = ({ kind }: { kind: "minimize" | "maximize" | "restore" | "close" }) => (
  <svg className="desktop-window-glyph" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
    {kind === "minimize" && <path d="M1 5.5h8" />}
    {kind === "maximize" && <rect x="1.5" y="1.5" width="7" height="7" rx="1.25" />}
    {kind === "restore" && (
      <>
        <rect x="1.5" y="3.5" width="5" height="5" rx="1" />
        <path d="M3.5 3.5V2.75c0-.69.56-1.25 1.25-1.25h2.5c.69 0 1.25.56 1.25 1.25v2.5c0 .69-.56 1.25-1.25 1.25H6.5" />
      </>
    )}
    {kind === "close" && <path d="M1.75 1.75l6.5 6.5M8.25 1.75l-6.5 6.5" />}
  </svg>
);

const parseRgba = (value: string, context: CanvasRenderingContext2D, under: [number, number, number]): [number, number, number] => {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = `rgb(${under.join(",")})`;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
};

const toHex = ([r, g, b]: [number, number, number]): string =>
  `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

/** The native Windows caption overlay's appearance. Its background is fully
 *  transparent: Windows paints only the glyphs and their hover/press fills, so
 *  the buttons sit on whatever surface the layout puts in the caption zone —
 *  the header's material, a column's head, the workspace backdrop — instead
 *  of a rectangle of one sampled colour that matches none of them. The RGB
 *  under the zero alpha is the window background, the colour an older shell
 *  that refuses alpha paints instead. The glyphs take Polyth's own caption ink
 *  (--text-dim, the header's control colour), so the native overlay and the
 *  Linux buttons read the same. Canvas resolves every CSS colour syntax —
 *  hex, color-mix(), oklch — to sRGB bytes. */
export const sampleTitleBarAppearance = (app: HTMLElement): DesktopTitleBarAppearance | null => {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const appStyle = getComputedStyle(app);
  const base = parseRgba(appStyle.backgroundColor, context, [0, 0, 0]);
  const controlInk = getComputedStyle(document.documentElement).getPropertyValue("--text-dim").trim();
  const symbol = parseRgba(controlInk || appStyle.color, context, base);
  // The caption band (--desktop-caption-h, resolved by the zone's own box):
  // on Windows the system's own caption height, never the header's, since
  // Electron stretches each 46 px button to the overlay's full height.
  const band = document.querySelector<HTMLElement>(".desktop-caption-zone")?.getBoundingClientRect().height
    || Number.parseFloat(getComputedStyle(document.body).getPropertyValue("--desktop-titlebar-h"));
  return {
    color: `${toHex(base)}00`,
    symbolColor: toHex(symbol),
    height: Number.isFinite(band) && band > 0 ? Math.round(band) : 52,
  };
};

/** Windows draws its own caption buttons (Window Controls Overlay). Keep its
 *  glyphs in Polyth's caption ink across theme, glass, density, and zoom
 *  changes. Renders nothing. */
function NativeTitleBarSync() {
  const api = desktopBridge()!;
  useEffect(() => {
    let frame = 0;
    let last = "";
    // A shell that predates transparent overlays rejects the colour itself
    // (main's validator accepted only #rrggbb): it gets the window background
    // instead of keeping the old colour, and once that is what took, only
    // that. Any other failure (a reload, a closing window) retries later.
    let opaqueOnly = false;
    const send = (appearance: DesktopTitleBarAppearance, key: string) => {
      const opaque = { ...appearance, color: appearance.color.slice(0, 7) };
      const sent = opaqueOnly
        ? api.setTitleBarAppearance(opaque)
        : api.setTitleBarAppearance(appearance).catch((error: unknown) => {
          if (!/Invalid title bar colors/.test(String(error))) throw error;
          return api.setTitleBarAppearance(opaque).then(() => { opaqueOnly = true; });
        });
      return sent.catch(() => { if (last === key) last = ""; });
    };
    const sync = () => {
      frame = 0;
      const app = document.querySelector<HTMLElement>(".app");
      if (!app) return;
      const appearance = sampleTitleBarAppearance(app);
      if (!appearance) return;
      const key = JSON.stringify(appearance);
      if (key === last) return;
      last = key;
      void send(appearance, key);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    const attributes = new MutationObserver(schedule);
    attributes.observe(document.documentElement, { attributes: true });
    attributes.observe(document.body, { attributes: true });
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    window.addEventListener("polyth:theme", schedule);
    window.addEventListener("resize", schedule);
    scheme.addEventListener("change", schedule);
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      attributes.disconnect();
      window.removeEventListener("polyth:theme", schedule);
      window.removeEventListener("resize", schedule);
      scheme.removeEventListener("change", schedule);
    };
  }, [api]);
  return null;
}

function WindowControls() {
  const api = desktopBridge()!;
  const [settings, setSettings] = useState(DEFAULTS);
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [windowState, setWindowState] = useState<DesktopWindowState>({
    maximized: false,
    fullscreen: false,
    visible: true,
    focused: true,
  });

  useEffect(() => {
    void Promise.all([api.getSettings(), api.getInfo(), api.getWindowState()]).then(([next, desktopInfo, state]) => {
      setSettings(next);
      setInfo(desktopInfo);
      setWindowState(state);
      applyDesktopChrome(next);
      applyDesktopPlatform(desktopInfo.platform);
    });
    const offSettings = api.onSettingsChanged((next) => {
      setSettings(next);
      applyDesktopChrome(next);
    });
    const offWindow = api.onWindowState(setWindowState);
    return () => {
      offWindow();
      offSettings();
    };
  }, [api]);

  // The caption zone's box on every platform, mounted before the platform is
  // known: styles.css sizes it once data-desktop-caption names its side.
  const zone = <div className="desktop-caption-zone" aria-hidden="true" />;
  const captionZone = typeof document === "undefined" ? zone : createPortal(zone, document.body);
  if (!info) return captionZone;
  if (info.platform === "win32") return <>{captionZone}<NativeTitleBarSync /></>;
  if (NATIVE_CONTROL_PLATFORMS.has(info.platform)) return captionZone;

  const minimize = (
    <button
      key="minimize"
      type="button"
      className="desktop-window-button minimize"
      aria-label={tr("desktop.window.minimizeWindow")}
      title={tr("desktop.window.minimize")}
      onClick={() => void api.windowAction("minimize")}
    >
      <CaptionGlyph kind="minimize" />
    </button>
  );
  const maximize = (
    <button
      key="maximize"
      type="button"
      className="desktop-window-button maximize"
      aria-label={windowState.maximized ? tr("desktop.window.restoreWindow") : tr("desktop.window.maximizeWindow")}
      title={windowState.maximized ? tr("desktop.window.restore") : tr("desktop.window.maximize")}
      onClick={() => void api.windowAction("toggle-maximize").then(setWindowState)}
    >
      <CaptionGlyph kind={windowState.maximized ? "restore" : "maximize"} />
    </button>
  );
  const close = (
    <button
      key="close"
      type="button"
      className="desktop-window-button close"
      aria-label={settings.closeToTray ? tr("desktop.window.hideWindowToTray") : tr("desktop.window.closeWindow")}
      title={settings.closeToTray ? tr("desktop.window.hideToTray") : tr("common.close")}
      onClick={() => void api.windowAction("close")}
    >
      <CaptionGlyph kind="close" />
    </button>
  );
  // Leading controls follow the left-handed window-manager order (close
  // first, nearest the corner); trailing controls keep close at the corner.
  const buttons = settings.controlsPosition === "left" ? [close, minimize, maximize] : [minimize, maximize, close];
  const controls = (
    <div
      className={`desktop-window-controls desktop-window-controls-${settings.controlsPosition}`}
      data-controls-theme={settings.controlsTheme}
      role="group"
      aria-label={tr("desktop.window.controls")}
    >
      {buttons}
    </div>
  );
  return <>{captionZone}{typeof document === "undefined" ? controls : createPortal(controls, document.body)}</>;
}

function DesktopSettingsPage() {
  const api = desktopBridge()!;
  const [settings, setSettings] = useState(DEFAULTS);
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [update, setUpdate] = useState<DesktopUpdateState>({
    phase: "idle",
    message: tr("desktop.settings.readyToCheck"),
  });
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([api.getSettings(), api.getInfo()]).then(([next, desktopInfo]) => {
      setSettings(next);
      setInfo(desktopInfo);
      applyDesktopPlatform(desktopInfo.platform);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    const offSettings = api.onSettingsChanged((next) => {
      setSettings(next);
      applyDesktopChrome(next);
    });
    let live = true;
    const offUpdate = api.onUpdateState(setUpdate);
    void api.getUpdateState?.().then((current) => { if (live) setUpdate(current); }).catch(() => {});
    return () => {
      live = false;
      offUpdate();
      offSettings();
    };
  }, [api]);

  const save = <Key extends keyof DesktopSettings>(key: Key, value: DesktopSettings[Key]) => {
    setError("");
    void api.setSettings({ [key]: value }).then((next) => {
      setSettings(next);
      applyDesktopChrome(next);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const updateAction = () => {
    setError("");
    if (update.phase === "downloading") {
      void api.showUpdateProgress?.().catch(() => {});
      return;
    }
    const work = update.phase === "available"
      ? api.downloadUpdate()
      : update.phase === "downloaded"
        ? api.installUpdate().then(() => update)
        : api.checkForUpdates();
    void work.then((next) => setUpdate(next)).catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <div className="desktop-settings-page">
      <div className="desktop-settings-hero">
        <img className="polyth-mark" src={POLYTH_MARK_SRC} alt="" aria-hidden="true" />
        <div>
          <strong>Polyth Desktop</strong>
          <span>{tr("desktop.settings.heroBody")}</span>
        </div>
        <span className="tag">{info?.platform ?? tr("desktop.settings.platformFallback")} {info?.arch ?? ""}</span>
      </div>
      <Row
        label={tr("desktop.settings.closeToTray")}
        hint={tr("desktop.settings.closeToTrayHint")}
        itemId="desktop.closeToTray"
      >
        <Toggle on={settings.closeToTray} onChange={(value) => save("closeToTray", value)} label={tr("desktop.settings.closeToTray")} />
      </Row>
      {/* macOS traffic lights and the Windows caption overlay are the
          operating system's own; only Linux draws Polyth's buttons. */}
      {info && !NATIVE_CONTROL_PLATFORMS.has(info.platform) && (
        <>
          <Row
            label={tr("desktop.settings.windowButtons")}
            hint={tr("desktop.settings.windowButtonsHint")}
            itemId="desktop.controlsPosition"
          >
            <Seg
              value={settings.controlsPosition}
              options={[["left", tr("settings.pages.promptNavigatorSideLeft")], ["right", tr("settings.pages.promptNavigatorSideRight")]]}
              onChange={(value) => save("controlsPosition", value)}
            />
          </Row>
          <Row
            label={tr("desktop.settings.buttonTheme")}
            hint={tr("desktop.settings.buttonThemeHint")}
            itemId="desktop.controlsTheme"
          >
            <Seg
              value={settings.controlsTheme}
              options={[["system", tr("settings.pages.auto")], ["dark", tr("settings.pages.dark")], ["light", tr("settings.pages.light")]]}
              onChange={(value) => save("controlsTheme", value)}
            />
          </Row>
        </>
      )}
      <Row label={tr("desktop.settings.startHidden")} hint={tr("desktop.settings.startHiddenHint")} itemId="desktop.startMinimized">
        <Toggle on={settings.startMinimized} onChange={(value) => save("startMinimized", value)} label={tr("desktop.settings.startHidden")} />
      </Row>
      {info?.canLaunchAtLogin && (
        <Row label={tr("desktop.settings.launchAtLogin")} hint={tr("desktop.settings.launchAtLoginHint")} itemId="desktop.launchAtLogin">
          <Toggle on={settings.launchAtLogin} onChange={(value) => save("launchAtLogin", value)} label={tr("desktop.settings.launchAtLogin")} />
        </Row>
      )}
      <Row
        label={tr("desktop.settings.keepAwake")}
        hint={tr("desktop.settings.keepAwakeHint")}
        itemId="desktop.keepAwake"
      >
        <Toggle on={settings.keepAwake} onChange={(value) => save("keepAwake", value)} label={tr("desktop.settings.keepAwake")} />
      </Row>
      {settings.keepAwake && settings.keepAwakeMode !== undefined && (
        <Row
          label={tr("desktop.settings.keepAwakeWhen")}
          hint={settings.keepAwakeMode === "working"
            ? tr("desktop.settings.keepAwakeWorkingHint")
            : tr("desktop.settings.keepAwakeAlwaysHint")}
          itemId="desktop.keepAwakeMode"
        >
          <Seg
            value={settings.keepAwakeMode}
            options={[["working", tr("desktop.settings.keepAwakeWorking")], ["always", tr("settings.pages.statusBarAlways")]]}
            onChange={(value) => save("keepAwakeMode", value)}
          />
        </Row>
      )}
      <Row
        label={tr("desktop.settings.automaticUpdates")}
        hint={tr("desktop.settings.automaticUpdatesHint")}
        itemId="desktop.automaticUpdates"
      >
        <Toggle on={settings.automaticUpdates} onChange={(value) => save("automaticUpdates", value)} label={tr("desktop.settings.automaticUpdates")} />
      </Row>
      {info?.macLegacyUpdates ? (
        <ReadonlyRow
          label={tr("desktop.settings.updateChannel")}
          hint={tr("desktop.settings.updateChannelLegacyHint")}
          value={tr("desktop.settings.channelStable")}
          itemId="desktop.updateChannel"
        />
      ) : (
        <Row
          label={tr("desktop.settings.updateChannel")}
          hint={tr(UPDATE_CHANNEL_HINTS[settings.updateChannel])}
          itemId="desktop.updateChannel"
        >
          <Seg value={settings.updateChannel} options={UPDATE_CHANNEL_OPTIONS()} onChange={(value) => save("updateChannel", value)} label={tr("desktop.settings.updateChannel")} />
        </Row>
      )}
      <Row
        label={tr("desktop.settings.lowResource")}
        hint={tr("desktop.settings.lowResourceHint")}
        itemId="desktop.lowResourceMode"
      >
        <Toggle on={settings.lowResourceMode} onChange={(value) => save("lowResourceMode", value)} label={tr("desktop.settings.lowResource")} />
      </Row>
      <Row
        label={tr("desktop.settings.softwareRendering")}
        hint={tr("desktop.settings.softwareRenderingHint")}
        itemId="desktop.softwareRendering"
      >
        <Toggle on={settings.softwareRendering} onChange={(value) => save("softwareRendering", value)} label={tr("desktop.settings.softwareRendering")} />
      </Row>
      <Row
        label={tr("desktop.settings.reduceMotion")}
        hint={tr("desktop.settings.reduceMotionHint")}
        itemId="desktop.reduceAnimations"
      >
        <Toggle on={settings.reduceAnimations} onChange={(value) => save("reduceAnimations", value)} label={tr("desktop.settings.reduceMotion")} />
      </Row>
      <Row label={tr("desktop.settings.updateStatus")} hint={update.message} itemId="desktop.updates">
        <div className="desktop-update-action">
          {update.phase === "downloading" && <progress max={100} value={update.percent ?? 0} />}
          <Button
            size="sm"
            busy={update.phase === "checking" || update.phase === "installing"}
            disabled={update.phase === "checking" || update.phase === "installing" || update.phase === "disabled"
              || (update.phase === "downloading" && !api.showUpdateProgress)}
            onClick={updateAction}
          >
            {update.phase === "available"
              ? update.version ? tr("desktop.settings.downloadVersion", { version: update.version }) : tr("desktop.settings.downloadUpdate")
              : update.phase === "downloaded"
                ? tr("desktop.settings.restartInstall")
                : update.phase === "checking"
                  ? tr("desktop.settings.checking")
                  : update.phase === "downloading"
                    ? tr("desktop.settings.showProgress")
                    : update.phase === "installing"
                      ? tr("desktop.settings.installing")
                      : tr("desktop.settings.checkNow")}
          </Button>
        </div>
      </Row>
      <Row label={tr("desktop.settings.polythData")} hint={info?.dataDir ?? tr("desktop.settings.loadingPaths")} itemId="desktop.data">
        <Button size="sm" onClick={() => void api.openDataFolder()}>{tr("desktop.settings.openFolder")}</Button>
      </Row>
      <Row label={tr("desktop.settings.desktopLog")} hint={info?.logPath ?? tr("desktop.settings.loadingLogPath")}>
        <Button
          size="sm"
          disabled={!info}
          onClick={() => { if (info) void api.revealPath(info.logPath); }}
        >
          {tr("desktop.settings.revealLog")}
        </Button>
      </Row>
      <Row label={tr("desktop.settings.versions")}>
        <span className="mono">Polyth {info?.appVersion ?? "…"} · OpenCode {info?.opencodeVersion ?? "…"}</span>
      </Row>
      <Row label={tr("desktop.settings.trayIntegration")}>
        <span className={`tag ${info?.trayAvailable ? "connected" : ""}`}>{info?.trayAvailable ? tr("desktop.settings.trayReady") : tr("desktop.settings.trayUnavailable")}</span>
      </Row>
      <Row label={tr("desktop.settings.quit")} hint={tr("desktop.settings.quitHint")} itemId="desktop.quit">
        <Button
          size="sm"
          variant="danger"
          onClick={() => void confirmAlert(tr("desktop.settings.quitBody"), {
            title: tr("desktop.settings.quitTitle"),
            confirmLabel: tr("desktop.settings.quit"),
            destructive: true,
          }).then((confirmed) => {
            if (confirmed) void api.quit();
          })}
        >
          {tr("desktop.settings.quit")}
        </Button>
      </Row>
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  );
}

/** Native menu items run the same shell commands as the keymap and palette. */
const DESKTOP_COMMANDS: Readonly<Record<DesktopCommand, string>> = {
  "open-settings": "cmd.settings",
  "new-session": "cmd.new",
  "search-sessions": "cmd.search",
  "command-palette": "cmd.palette",
};

export function installDesktopIntegration(): () => void {
  const api = desktopBridge();
  if (!api) return () => {};
  markDesktopApp(true);
  void Promise.all([api.getSettings(), api.getInfo(), api.getWindowState()]).then(([next, desktopInfo, state]) => {
    applyDesktopChrome(next);
    applyDesktopPlatform(desktopInfo.platform);
    applyWindowState(state);
  });
  const offWindowState = api.onWindowState(applyWindowState);
  // The Windows overlay can trade sides (a mirrored system UI) or resize.
  const overlay = windowControlsOverlay();
  overlay?.addEventListener?.("geometrychange", applyCaptionSide);
  const offCommand = api.onCommand((command: DesktopCommand) => {
    runCommand(DESKTOP_COMMANDS[command]);
  });
  const unregisterControls = registerSlot(
    "app.window.controls",
    "desktop.window-controls",
    () => <WindowControls />,
    1_000,
  );
  // Desktop chrome like the window controls: portaled into <body>, so it shows
  // in every shell mode wherever the header is mounted.
  const unregisterUpdateNotice = registerSlot(
    "app.window.controls",
    "desktop.update-notice",
    () => <DesktopUpdateNotice />,
    1_001,
  );
  const uninstallKeepAwake = installDesktopKeepAwake(api);
  const unregisterSettings = registerSlot(
    "settings.pages",
    "desktop",
    () => <DesktopSettingsPage />,
    90,
    {
      label: tr("desktop.settings.pageLabel"),
      group: "System",
      icon: "▣",
      pageId: "desktop",
      settingsItems: [
        { id: "desktop.closeToTray", pageId: "desktop", label: tr("desktop.settings.closeToTray"), keywords: ["background", "system tray"], focusTarget: "desktop.closeToTray" },
        { id: "desktop.controlsPosition", pageId: "desktop", label: tr("desktop.settings.windowButtonPosition"), keywords: ["titlebar", "left", "right"], focusTarget: "desktop.controlsPosition" },
        { id: "desktop.controlsTheme", pageId: "desktop", label: tr("desktop.settings.windowButtonTheme"), keywords: ["titlebar", "light", "dark", "auto"], focusTarget: "desktop.controlsTheme" },
        { id: "desktop.startMinimized", pageId: "desktop", label: tr("desktop.settings.startHidden"), keywords: ["launch", "tray", "minimize"], focusTarget: "desktop.startMinimized" },
        { id: "desktop.launchAtLogin", pageId: "desktop", label: tr("desktop.settings.launchAtLogin"), keywords: ["startup", "autostart", "boot"], focusTarget: "desktop.launchAtLogin" },
        { id: "desktop.keepAwake", pageId: "desktop", label: tr("desktop.settings.keepAwake"), keywords: ["sleep", "suspend", "background", "coffee", "caffeinate"], focusTarget: "desktop.keepAwake" },
        { id: "desktop.keepAwakeMode", pageId: "desktop", label: tr("desktop.settings.keepAwakeWhen"), keywords: ["sleep", "agents", "working", "always"], focusTarget: "desktop.keepAwakeMode" },
        { id: "desktop.lowResourceMode", pageId: "desktop", label: tr("desktop.settings.lowResource"), keywords: ["memory", "cpu", "performance", "old device"], focusTarget: "desktop.lowResourceMode" },
        { id: "desktop.softwareRendering", pageId: "desktop", label: tr("desktop.settings.softwareRendering"), keywords: ["gpu", "hardware acceleration", "graphics driver", "glitch"], focusTarget: "desktop.softwareRendering" },
        { id: "desktop.reduceAnimations", pageId: "desktop", label: tr("desktop.settings.reduceMotion"), keywords: ["motion", "animation", "accessibility"], focusTarget: "desktop.reduceAnimations" },
        { id: "desktop.updates", pageId: "desktop", label: tr("desktop.settings.desktopUpdates"), keywords: ["github", "release", "automatic"], focusTarget: "desktop.updates" },
        { id: "desktop.data", pageId: "desktop", label: tr("desktop.settings.polythDataFolder"), keywords: ["native", "file manager"], focusTarget: "desktop.data" },
        { id: "desktop.quit", pageId: "desktop", label: tr("desktop.settings.quit"), keywords: ["exit", "stop", "tray"], focusTarget: "desktop.quit" },
      ],
    },
  );
  return () => {
    uninstallKeepAwake();
    offCommand();
    offWindowState();
    overlay?.removeEventListener?.("geometrychange", applyCaptionSide);
    unregisterSettings();
    unregisterUpdateNotice();
    unregisterControls();
    clearWindowState();
    markDesktopApp(false);
    delete document.body.dataset.desktopPlatform;
  };
}
