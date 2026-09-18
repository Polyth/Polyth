import { useEffect, useState } from "react";
import { desktopBridge, type DesktopInfo, type DesktopSettings, type DesktopUpdateState, type DesktopWindowState } from "./desktopBridge.ts";
import { registerSlot } from "./slots.ts";
import { Row, Seg, Toggle } from "./components/settings/parts.tsx";
import { Button, confirmAlert } from "./components/ui/index.ts";

const DEFAULTS: DesktopSettings = {
  closeToTray: true,
  startMinimized: false,
  launchAtLogin: false,
  keepAwake: false,
  automaticUpdates: true,
  lowResourceMode: false,
  reduceAnimations: false,
  controlsPosition: "right",
  controlsTheme: "system",
};

const applyDesktopChrome = (settings: DesktopSettings): void => {
  document.body.classList.add("desktop-app");
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
};

function WindowControls() {
  const api = desktopBridge()!;
  const [settings, setSettings] = useState(DEFAULTS);
  const [windowState, setWindowState] = useState<DesktopWindowState>({
    maximized: false,
    visible: true,
    focused: true,
  });

  useEffect(() => {
    void api.getSettings().then((next) => {
      setSettings(next);
      applyDesktopChrome(next);
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

  useEffect(() => {
    if (windowState.maximized) document.body.dataset.desktopMaximized = "true";
    else delete document.body.dataset.desktopMaximized;
    return () => { delete document.body.dataset.desktopMaximized; };
  }, [windowState.maximized]);

  return (
    <div
      className={`desktop-window-controls desktop-window-controls-${settings.controlsPosition}`}
      data-controls-theme={settings.controlsTheme}
      aria-label="Window controls"
    >
      <button
        type="button"
        className="desktop-window-button minimize"
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => void api.windowAction("minimize")}
      >
        <span aria-hidden="true">−</span>
      </button>
      <button
        type="button"
        className="desktop-window-button maximize"
        aria-label={windowState.maximized ? "Restore window" : "Maximize window"}
        title={windowState.maximized ? "Restore" : "Maximize"}
        onClick={() => void api.windowAction("toggle-maximize").then(setWindowState)}
      >
        <span aria-hidden="true">{windowState.maximized ? "❐" : "□"}</span>
      </button>
      <button
        type="button"
        className="desktop-window-button close"
        aria-label={settings.closeToTray ? "Hide window to tray" : "Close window"}
        title={settings.closeToTray ? "Hide to tray" : "Close"}
        onClick={() => void api.windowAction("close")}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

function DesktopSettingsPage() {
  const api = desktopBridge()!;
  const [settings, setSettings] = useState(DEFAULTS);
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [update, setUpdate] = useState<DesktopUpdateState>({
    phase: "idle",
    message: "Ready to check for updates.",
  });
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([api.getSettings(), api.getInfo()]).then(([next, desktopInfo]) => {
      setSettings(next);
      setInfo(desktopInfo);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    const offSettings = api.onSettingsChanged((next) => {
      setSettings(next);
      applyDesktopChrome(next);
    });
    const offUpdate = api.onUpdateState(setUpdate);
    return () => {
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
        <img className="polyth-mark" src="/icon-192.png" alt="" aria-hidden="true" />
        <div>
          <strong>Polyth Desktop</strong>
          <span>Native workspace controls, background operation, and secure bundled runtime.</span>
        </div>
        <span className="tag">{info?.platform ?? "desktop"} {info?.arch ?? ""}</span>
      </div>
      <Row
        label="Close to tray"
        hint="Closing the window keeps active agents and terminals running. Quit from the tray menu to stop Polyth."
        itemId="desktop.closeToTray"
      >
        <Toggle on={settings.closeToTray} onChange={(value) => save("closeToTray", value)} label="Close to tray" />
      </Row>
      <Row
        label="Window buttons"
        hint="Move the minimize, maximize, and close controls without changing the rest of the layout."
        itemId="desktop.controlsPosition"
      >
        <Seg value={settings.controlsPosition} options={[["left", "Left"], ["right", "Right"]]} onChange={(value) => save("controlsPosition", value)} />
      </Row>
      <Row
        label="Button theme"
        hint="System follows the operating-system appearance independently of your Polyth palette."
        itemId="desktop.controlsTheme"
      >
        <Seg value={settings.controlsTheme} options={[["system", "System"], ["dark", "Dark"], ["light", "Light"]]} onChange={(value) => save("controlsTheme", value)} />
      </Row>
      <Row label="Start hidden" hint="Launch into the system tray instead of showing the main window." itemId="desktop.startMinimized">
        <Toggle on={settings.startMinimized} onChange={(value) => save("startMinimized", value)} label="Start hidden" />
      </Row>
      {info?.canLaunchAtLogin && (
        <Row label="Launch at login" hint="Start Polyth when you sign in to this computer." itemId="desktop.launchAtLogin">
          <Toggle on={settings.launchAtLogin} onChange={(value) => save("launchAtLogin", value)} label="Launch at login" />
        </Row>
      )}
      <Row
        label="Keep awake"
        hint="Prevent the operating system from suspending Polyth while long-running agents are active."
        itemId="desktop.keepAwake"
      >
        <Toggle on={settings.keepAwake} onChange={(value) => save("keepAwake", value)} label="Keep awake" />
      </Row>
      <Row
        label="Automatic updates"
        hint="Check signed GitHub releases in the background. Downloads remain under your control."
        itemId="desktop.automaticUpdates"
      >
        <Toggle on={settings.automaticUpdates} onChange={(value) => save("automaticUpdates", value)} label="Automatic updates" />
      </Row>
      <Row
        label="Low resource mode"
        hint="Immediately disables motion and live glass blur. After restart, also uses software rendering, smaller caches and terminal scrollback, deferred OpenCode, and a smaller chat window."
        itemId="desktop.lowResourceMode"
      >
        <Toggle on={settings.lowResourceMode} onChange={(value) => save("lowResourceMode", value)} label="Low resource mode" />
      </Row>
      <Row
        label="Reduce motion"
        hint="Disable interface motion independently of performance mode. Glass is controlled in Appearance."
        itemId="desktop.reduceAnimations"
      >
        <Toggle on={settings.reduceAnimations} onChange={(value) => save("reduceAnimations", value)} label="Reduce motion" />
      </Row>
      <Row label="Update status" hint={update.message} itemId="desktop.updates">
        <div className="desktop-update-action">
          {update.phase === "downloading" && <progress max={100} value={update.percent ?? 0} />}
          <Button
            size="sm"
            busy={update.phase === "checking"}
            disabled={update.phase === "checking" || update.phase === "downloading" || update.phase === "disabled"}
            onClick={updateAction}
          >
            {update.phase === "available"
              ? `Download ${update.version ?? "update"}`
              : update.phase === "downloaded"
                ? "Restart & install"
                : update.phase === "checking"
                  ? "Checking…"
                  : "Check now"}
          </Button>
        </div>
      </Row>
      <Row label="Polyth data" hint={info?.dataDir ?? "Loading desktop paths…"} itemId="desktop.data">
        <Button size="sm" onClick={() => void api.openDataFolder()}>Open folder</Button>
      </Row>
      <Row label="Desktop log" hint={info?.logPath ?? "Loading log path…"}>
        <Button
          size="sm"
          disabled={!info}
          onClick={() => { if (info) void api.revealPath(info.logPath); }}
        >
          Reveal log
        </Button>
      </Row>
      <Row label="Versions">
        <span className="mono">Polyth {info?.appVersion ?? "…"} · OpenCode {info?.opencodeVersion ?? "…"}</span>
      </Row>
      <Row label="Tray integration">
        <span className={`tag ${info?.trayAvailable ? "connected" : ""}`}>{info?.trayAvailable ? "ready" : "unavailable"}</span>
      </Row>
      <Row label="Quit Polyth" hint="Stop the local server, active agents, and background desktop process." itemId="desktop.quit">
        <Button
          size="sm"
          variant="danger"
          onClick={() => void confirmAlert("Quit Polyth and stop all active desktop sessions?", {
            title: "Quit Polyth?",
            confirmLabel: "Quit Polyth",
            destructive: true,
          }).then((confirmed) => {
            if (confirmed) void api.quit();
          })}
        >
          Quit Polyth
        </Button>
      </Row>
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
  );
}

export function installDesktopIntegration(): () => void {
  const api = desktopBridge();
  if (!api) return () => {};
  document.body.classList.add("desktop-app");
  void api.getSettings().then(applyDesktopChrome);
  const unregisterControls = registerSlot(
    "app.window.controls",
    "desktop.window-controls",
    () => <WindowControls />,
    1_000,
  );
  const unregisterSettings = registerSlot(
    "settings.pages",
    "desktop",
    () => <DesktopSettingsPage />,
    90,
    {
      label: "Desktop",
      group: "System",
      icon: "▣",
      pageId: "desktop",
      settingsItems: [
        { id: "desktop.closeToTray", pageId: "desktop", label: "Close to tray", keywords: ["background", "system tray"], focusTarget: "desktop.closeToTray" },
        { id: "desktop.controlsPosition", pageId: "desktop", label: "Window button position", keywords: ["titlebar", "left", "right"], focusTarget: "desktop.controlsPosition" },
        { id: "desktop.controlsTheme", pageId: "desktop", label: "Window button theme", keywords: ["titlebar", "light", "dark"], focusTarget: "desktop.controlsTheme" },
        { id: "desktop.startMinimized", pageId: "desktop", label: "Start hidden", keywords: ["launch", "tray", "minimize"], focusTarget: "desktop.startMinimized" },
        { id: "desktop.launchAtLogin", pageId: "desktop", label: "Launch at login", keywords: ["startup", "autostart", "boot"], focusTarget: "desktop.launchAtLogin" },
        { id: "desktop.keepAwake", pageId: "desktop", label: "Keep awake", keywords: ["sleep", "suspend", "background"], focusTarget: "desktop.keepAwake" },
        { id: "desktop.lowResourceMode", pageId: "desktop", label: "Low resource mode", keywords: ["memory", "cpu", "gpu", "old device"], focusTarget: "desktop.lowResourceMode" },
        { id: "desktop.reduceAnimations", pageId: "desktop", label: "Reduce motion", keywords: ["motion", "animation", "accessibility"], focusTarget: "desktop.reduceAnimations" },
        { id: "desktop.updates", pageId: "desktop", label: "Desktop updates", keywords: ["github", "release", "automatic"], focusTarget: "desktop.updates" },
        { id: "desktop.data", pageId: "desktop", label: "Polyth data folder", keywords: ["native", "file manager"], focusTarget: "desktop.data" },
        { id: "desktop.quit", pageId: "desktop", label: "Quit Polyth", keywords: ["exit", "stop", "tray"], focusTarget: "desktop.quit" },
      ],
    },
  );
  return () => {
    unregisterSettings();
    unregisterControls();
    document.body.classList.remove("desktop-app");
  };
}
