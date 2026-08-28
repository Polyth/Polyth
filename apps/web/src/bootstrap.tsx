import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { api } from "@polyth/session/web-api";
import { consumeAuthPrefetch } from "./authPrefetch.ts";
import { init } from "./init.ts";
import { exposeSlots } from "./slots.ts";
import { exposeSurfaces } from "./surfaces.ts";
import { exposeCapabilities } from "./capabilities.ts";
import { installShell } from "./shell.ts";
import { installCommandSlotBridge } from "./commandBridge.ts";
import { exposeWorkspaceSurfaces } from "./workspace/surfaceRegistry.ts";
import { applySettingsToDom } from "./settings.ts";
import { applyUiSettings } from "./uiPrefs.ts";
import { startMobileViewport } from "./mobileViewport.ts";
import { getState } from "./store.ts";
import { installBuiltinMiniWidgets } from "./widgets/builtinMiniWidgets.tsx";
import { installNotificationCentre } from "./components/NotificationCentre.tsx";
import { installOpenCodeRestartControl } from "./components/OpenCodeRestartControl.tsx";
import { installReconnectPill } from "./components/ReconnectPill.tsx";
import { installDesktopIntegration } from "./desktop.tsx";
import { exposeWidgets } from "./widgets/catalog.ts";
import { bootPackages } from "./packages/registry.ts";
import { getLocaleSnapshot, subscribeLocale } from "./i18n/index.ts";
import App from "./App.tsx";
import LockScreen from "./components/LockScreen.tsx";
import "./styles.css";

applySettingsToDom(getState().settings);
applyUiSettings();
// UX-MOBILE-01: publish visual-viewport geometry before first paint so the
// sticky interaction zone is never laid out against a stale 100vh.
startMobileViewport();
exposeSlots();
exposeSurfaces();
exposeCapabilities();
exposeWorkspaceSurfaces();
exposeWidgets();
installBuiltinMiniWidgets();
// NTF-01: bell + panel arrive through the slot registry, never via App.tsx.
installNotificationCentre();
installOpenCodeRestartControl();
installReconnectPill();
// No-op in browsers; Electron's preload exposes the bridge that enables the
// desktop settings page and custom titlebar controls through existing slots.
installDesktopIntegration();
// Palette commands + keyboard shortcuts: one install, synced with the
// capability registry from then on (UX-PERSONAS: search sees every tool).
installShell();
installCommandSlotBridge();

// F16: init() loads REST data and opens /ws — it must not run until the
// server says this device is authorized (or that no password is set).
let booted = false;
const bootOnce = (): void => {
  if (booted) return;
  booted = true;
  void bootPackages().catch((error: unknown) =>
    console.error("[polyth] web package boot failed", error));
  init();
};

function Root() {
  const [phase, setPhase] = useState<"checking" | "locked" | "ready">("checking");
  const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);

  useEffect(() => {
    let cancelled = false;
    // main.tsx started this fetch before the app graph downloaded; falling
    // back to a fresh call covers re-mounts (locale switches remount Root).
    void (consumeAuthPrefetch() ?? api.authStatus())
      .then((s) => { if (!cancelled) setPhase(s.required && !s.authorized ? "locked" : "ready"); })
      // Status unreachable → proceed; init()'s own error banner reports it.
      .catch(() => { if (!cancelled) setPhase("ready"); });
    // Mid-session 401 (session revoked / password newly set) re-locks the UI.
    const onAuthRequired = () => setPhase("locked");
    window.addEventListener("polyth:auth-required", onAuthRequired);
    return () => {
      cancelled = true;
      window.removeEventListener("polyth:auth-required", onAuthRequired);
    };
  }, []);

  useEffect(() => { if (phase === "ready") bootOnce(); }, [phase]);

  if (phase === "checking") return null;
  if (phase === "locked") {
    // After a mid-session revoke the store/WS state is stale — reload for a
    // clean slate; on the initial lock just proceed into the normal boot.
    return <LockScreen key={locale} onUnlocked={() => { if (booted) location.reload(); else setPhase("ready"); }} />;
  }
  return <App key={locale} />;
}

createRoot(document.getElementById("root") as HTMLElement).render(<Root />);
