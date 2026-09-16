import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { authBootstrapPhase } from "./authBootstrap.ts";
import { fetchAuthStatus } from "./authClient.ts";
import { Button } from "./components/ui/index.ts";
import { tr } from "./i18n/index.ts";
import { consumeAuthPrefetch } from "./authPrefetch.ts";
import { init, navigateBackInApp, openNativeAppPath, setSyncForeground } from "./init.ts";
import { flushClientPersistence } from "./clientPersistence.ts";
import { initializeClientReliabilityContext } from "./reliabilityContext.ts";
import { exposeSlots } from "./slots.ts";
import { exposeSurfaces } from "./surfaces.ts";
import { exposeCapabilities } from "./capabilities.ts";
import { installShell } from "./shell.ts";
import { installCommandSlotBridge } from "./commandBridge.ts";
import { installNativeConnectionCommands } from "./nativeConnections.ts";
import { applySettingsToDom } from "./settings.ts";
import { applyUiSettings } from "./uiPrefs.ts";
import { setNativeKeyboardInset, startMobileViewport } from "./mobileViewport.ts";
import {
  closeWorkspacePane,
  getState,
  setOverlay,
  setRailPlugin,
  setSidebarOpen,
} from "./store.ts";
import { installBuiltinMiniWidgets } from "./widgets/builtinMiniWidgets.tsx";
import { installSystemWidgets } from "./widgets/systemWidgets.tsx";
import { exposeAreas } from "./widgets/areas.ts";
import { installBuiltinAreas } from "./widgets/builtinAreas.ts";
import { installCapabilityWidgets } from "./widgets/capabilityWidgets.tsx";
import { installNotificationCentre } from "./components/NotificationCentre.tsx";
import { installRuntimeEpochBanner } from "./components/RuntimeEpochBanner.tsx";
import { installDesktopIntegration } from "./desktop.tsx";
import { exposeWidgets } from "./widgets/catalog.ts";
import { bootPackages } from "./packages/registry.ts";
import { getLocaleSnapshot, subscribeLocale } from "./i18n/index.ts";
import App from "./App.tsx";
import LockScreen from "./components/LockScreen.tsx";
import SetupScreen from "./components/SetupScreen.tsx";
import { dismissTopEscapeLayer } from "./useEscape.ts";
import { isWorkspaceSurface, listSurfaces } from "./surfaces.ts";
import { installNativeMobileIntegration } from "@polyth/mobile/native";
import { handleNativeBack } from "./nativeMobile.ts";
import { applyBackgroundToDom } from "./backgrounds.ts";
import { openPendingNativePushAfterHydration, reconcileNativePushForeground } from "./nativePush.ts";

applySettingsToDom(getState().settings);
applyUiSettings();
applyBackgroundToDom();
startMobileViewport();
exposeSlots();
exposeSurfaces();
exposeCapabilities();
exposeWidgets();
exposeAreas();
installBuiltinAreas();
installBuiltinMiniWidgets();
installSystemWidgets();
installCapabilityWidgets();
installNotificationCentre();
installRuntimeEpochBanner();
installDesktopIntegration();
installNativeMobileIntegration({
  handleBack: () => {
    const current = getState();
    const activeRail = current.railPlugin === null
      ? undefined
      : listSurfaces().find((surface) => surface.id === current.railPlugin);
    const workspacePaneOpen = activeRail !== undefined && isWorkspaceSurface(activeRail);
    return handleNativeBack(
      {
        overlayOpen: current.overlay !== null,
        drawerOpen: current.sidebarOpen,
        workspacePaneOpen,
        railOpen: current.railPlugin !== null && !workspacePaneOpen,
      },
      {
        dismissEscapeLayer: dismissTopEscapeLayer,
        closeOverlay: () => setOverlay(null),
        closeDrawer: () => setSidebarOpen(false),
        closeWorkspacePane,
        closeRail: () => setRailPlugin(null),
        navigateBack: navigateBackInApp,
      },
    );
  },
  openDeepLink: openNativeAppPath,
  setForeground: (active) => {
    setSyncForeground(active);
    void reconcileNativePushForeground(active).catch(() => undefined);
  },
  setKeyboardInset: setNativeKeyboardInset,
});
installShell();
installNativeConnectionCommands();
installCommandSlotBridge();

// No package, private REST preload or WebSocket is admitted until the server
// proves both canonical identity and a fully started application runtime.
let booted = false;
const bootOnce = (): void => {
  if (booted) return;
  booted = true;
  void bootPackages().catch((error: unknown) =>
    console.error("[polyth] web package boot failed", error));
  void init().then(openPendingNativePushAfterHydration).catch(() => undefined);
};

type BootstrapPhase = "checking" | "setup" | "locked" | "ready" | "unavailable";

function Root() {
  const [phase, setPhase] = useState<BootstrapPhase>("checking");
  const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);

  useEffect(() => {
    let cancelled = false;
    let invalidated = false;
    void (consumeAuthPrefetch() ?? fetchAuthStatus())
      .then(async (status) => {
        if (cancelled || invalidated) return;
        const nextPhase = authBootstrapPhase(status);
        if (nextPhase === "ready") {
          await initializeClientReliabilityContext();
          if (cancelled || invalidated) return;
          await reconcileNativePushForeground(true).catch(() => undefined);
        }
        if (!cancelled && !invalidated) setPhase(nextPhase);
      })
      .catch(() => { if (!cancelled && !invalidated) setPhase("unavailable"); });
    const onAuthRequired = () => { invalidated = true; setPhase("locked"); };
    window.addEventListener("polyth:auth-required", onAuthRequired);
    return () => {
      cancelled = true;
      window.removeEventListener("polyth:auth-required", onAuthRequired);
    };
  }, []);

  useEffect(() => {
    const flush = () => { void flushClientPersistence().catch((error) => {
      console.warn("[polyth] client recovery metadata was not fully persisted", error);
    }); };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  useEffect(() => { if (phase === "ready") bootOnce(); }, [phase]);

  if (phase === "checking") return null;
  if (phase === "unavailable") return (
    <div className="lock-screen">
      <div className="lock-card">
        <h1>{tr("lockscreen.polythIsLocked")}</h1>
        <p className="lock-hint" role="status">{tr("lockscreen.couldnTReachTheServer")}</p>
        <Button onClick={() => location.reload()}>{tr("common.retry")}</Button>
      </div>
    </div>
  );
  if (phase === "setup") return <SetupScreen key={locale} />;
  if (phase === "locked") {
    return <LockScreen key={locale} onUnlocked={() => location.reload()} />;
  }
  return <App key={locale} />;
}

createRoot(document.getElementById("root") as HTMLElement).render(<Root />);
