import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { authBootstrapPhase, claimLinkSessionBounce, claimOwnerSessionRenewal } from "./authBootstrap.ts";
import { desktopBridge } from "./desktopBridge.ts";
import { fetchAuthStatus } from "./authClient.ts";
import { Button } from "./components/ui/index.ts";
import { POLYTH_MARK_SRC } from "./brandAsset.ts";
import { tr } from "./i18n/index.ts";
import { consumeAuthPrefetch } from "./authPrefetch.ts";
import { init, navigateBackInApp, openNativeAppPath, setSyncForeground } from "./init.ts";
import { flushClientPersistence } from "./clientPersistence.ts";
import { clientAccountPersistenceScope, initializeClientReliabilityContext } from "./reliabilityContext.ts";
import { hydrateNavigatorState } from "./navigatorState.ts";
import { exposeSlots } from "./slots.ts";
import { exposeSurfaces } from "./surfaces.ts";
import { exposeCapabilities } from "./capabilities.ts";
import { installShell } from "./shell.ts";
import { installCommandSlotBridge } from "./commandBridge.ts";
import { installNativeConnectionCommands } from "./nativeConnections.ts";
import { applySettingsToDom } from "./settings.ts";
import { applyUiSettings } from "./uiPrefs.ts";
import { setNativeKeyboardInset, setNativeKeyboardMotion, startMobileViewport } from "./mobileViewport.ts";
import {
  closePackageWindow,
  closeWorkspacePane,
  getState,
  setOverlay,
  setRailPlugin,
  setSidebarOpen,
} from "./store.ts";
import { getShellMode } from "./responsiveShell.ts";
import {
  getMobileWorkspaceNavigationSnapshot,
  hideMobileWorkspaceHome,
  showMobileWorkspaceHome,
} from "./mobileWorkspaceNavigation.ts";
import { packageLayerPresented, phoneBackTarget } from "./mobileLayerStack.ts";
import { installBuiltinMiniWidgets } from "./widgets/builtinMiniWidgets.tsx";
import { installSystemWidgets } from "./widgets/systemWidgets.tsx";
import { installStatusbarWidgets } from "./widgets/statusbarWidgets.tsx";
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
import { stepSettingsBack } from "./settingsPresentation.ts";
import { isWorkspaceSurface, listSurfaces } from "./surfaces.ts";
import { installNativeMobileIntegration } from "@polyth/mobile/native";
import { isNativeMobile, isPolythLinkLoopbackOrigin, returnToMobileConnectionHub } from "@polyth/mobile/runtime";
import { handleNativeBack } from "./nativeMobile.ts";
import { applyBackgroundToDom } from "./backgrounds.ts";
import { openPendingNativePushAfterHydration, reconcileNativePushForeground } from "./nativePush.ts";
import { installLiveActivity } from "./nativeLiveActivity.ts";
import { isClientSettingsSettled, subscribeClientSettingsSettled } from "./settingsSync.ts";
import { launchVeil, reloadBehindVeil } from "./launchVeil.ts";
import {
  noteLaunchHydrated,
  noteLaunchPackagesSettled,
  noteLaunchPhase,
  noteLaunchSettingsSettled,
  startLaunchReveal,
} from "./launchReveal.ts";

// On phones and in the native app the launch veil stays up until
// the workspace below it has settled (launchReveal.ts), then lifts once.
startLaunchReveal({ veil: launchVeil, waitingStatus: () => tr("launch.openingWorkspace") });
if (isClientSettingsSettled()) noteLaunchSettingsSettled();
else {
  const stopSettledWatch = subscribeClientSettingsSettled(() => {
    stopSettledWatch();
    noteLaunchSettingsSettled();
  });
}

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
installStatusbarWidgets();
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
    const phoneLayer = phoneBackTarget({
      phone: getShellMode() === "phone",
      homeOpen: getMobileWorkspaceNavigationSnapshot().homeOpen,
      packagePresented: packageLayerPresented(current),
    });
    return handleNativeBack(
      {
        overlayOpen: current.overlay !== null,
        drawerOpen: current.sidebarOpen,
        workspacePaneOpen,
        railOpen: current.railPlugin !== null && !workspacePaneOpen,
        phoneLayer,
      },
      {
        dismissEscapeLayer: dismissTopEscapeLayer,
        // Settings steps a phone page back to its list first.
        closeOverlay: () => { if (!stepSettingsBack()) setOverlay(null); },
        closeDrawer: () => setSidebarOpen(false),
        closeWorkspacePane,
        closeRail: () => setRailPlugin(null),
        // The same pop the on-screen Back control performs: name the layer
        // that becomes the foreground first, then retire the one on top.
        popPhoneLayer: (layer) => {
          if (layer === "workspace") {
            hideMobileWorkspaceHome();
            return;
          }
          showMobileWorkspaceHome();
          closePackageWindow();
        },
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
  setKeyboardMotion: setNativeKeyboardMotion,
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
    console.error("[polyth] web package boot failed", error)).finally(noteLaunchPackagesSettled);
  void init().then(openPendingNativePushAfterHydration).catch(() => undefined).finally(() => {
    noteLaunchHydrated();
    // After hydration, so the first Live Activity snapshot sees real
    // projections instead of ending one a previous process left for the same work.
    void installLiveActivity().catch(() => undefined);
  });
};

type BootstrapPhase = "checking" | "setup" | "restart" | "locked" | "ready" | "unavailable";

function Root() {
  const [phase, setPhase] = useState<BootstrapPhase>("checking");
  const [localOwner, setLocalOwner] = useState<boolean | undefined>(undefined);
  const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);

  useEffect(() => {
    let cancelled = false;
    let invalidated = false;
    void (consumeAuthPrefetch() ?? fetchAuthStatus())
      .then(async (status) => {
        if (cancelled || invalidated) return;
        const nextPhase = authBootstrapPhase(status);
        if (nextPhase === "locked" && status.accessMode === "local") {
          // A password-less owner's Desktop window gets its session from the
          // main process, never from a sign-in form.
          const renew = desktopBridge()?.renewOwnerSession;
          if (renew && claimOwnerSessionRenewal(status, sessionStorage) && await renew().catch(() => false)) {
            if (!cancelled && !invalidated) location.reload();
            return;
          }
        }
        if (cancelled || invalidated) return;
        if (nextPhase === "locked") setLocalOwner(status.accessMode === "local");
        if (nextPhase === "ready") {
          await initializeClientReliabilityContext();
          if (cancelled || invalidated) return;
          // The mobile app's shell origin starts empty on every launch: put
          // back what the navigators had open before they first read it.
          await hydrateNavigatorState(clientAccountPersistenceScope());
          if (cancelled || invalidated) return;
          await reconcileNativePushForeground(true).catch(() => undefined);
        }
        if (!cancelled && !invalidated) setPhase(nextPhase);
      })
      .catch(async (error: unknown) => {
        if (cancelled || invalidated) return;
        if (isNativeMobile() && isPolythLinkLoopbackOrigin(location.origin)
          && claimLinkSessionBounce(error, sessionStorage)) {
          await returnToMobileConnectionHub(
            `${location.pathname}${location.search}${location.hash}`,
            { resume: true },
          );
          return;
        }
        setPhase("unavailable");
      });
    const onAuthRequired = () => { invalidated = true; setLocalOwner(undefined); setPhase("locked"); };
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
  useEffect(() => { noteLaunchPhase(phase); }, [phase]);

  if (phase === "checking") return null;
  if (phase === "unavailable") return (
    <div className="lock-screen">
      <div className="lock-card">
        <img className="welcome-mark" src={POLYTH_MARK_SRC} alt="" aria-hidden="true" />
        <h1>{tr("lockscreen.polythIsLocked")}</h1>
        <p className="lock-hint" role="status">{tr("lockscreen.couldnTReachTheServer")}</p>
        <Button onClick={reloadBehindVeil}>{tr("common.retry")}</Button>
      </div>
    </div>
  );
  // Setup follows a language switch itself, keeping what was typed.
  if (phase === "setup") return <SetupScreen />;
  if (phase === "restart") return <SetupScreen restartRequired />;
  if (phase === "locked") {
    return <LockScreen key={locale} localOwner={localOwner} onUnlocked={reloadBehindVeil} />;
  }
  return <App key={locale} />;
}

createRoot(document.getElementById("root") as HTMLElement).render(<Root />);
