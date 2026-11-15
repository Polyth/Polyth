// Tiny entry: load the stored locale's catalog chunk BEFORE the app graph
// evaluates. Module-level tr() constants (surface titles, command names)
// capture strings at import time, so they must run after the merge.
// ES2023 array methods first: older WebViews (native iOS 15) lack them.
import "./arrayCompat.ts";
import { ensureLocale, getLocaleSnapshot } from "./i18n/index.ts";
import { prefetchAuthStatus } from "./authPrefetch.ts";
import { authBootstrapPhase } from "./authBootstrap.ts";
import { preconnectSync, syncSocketUrl } from "./syncPreconnect.ts";
import { installBuildFreshnessWatcher } from "./buildFreshness.ts";
import { installInputModality } from "./inputModality.ts";
import { offerWebUpdate } from "./webUpdateNotice.ts";
import {
  isNativeMobile,
  isPolythLinkLoopbackOrigin,
  prepareMobileLaunch,
  returnToMobileConnectionHub,
} from "@polyth/mobile/runtime";
import { releaseLaunchCurtain, setLaunchLeaveCover } from "@polyth/mobile/launch";
import { launchVeil, reloadBehindVeil } from "./launchVeil.ts";
import {
  UNRENDERED_LAUNCH_MS,
  UNRENDERED_RELOAD_KEY,
  unrenderedLaunchFallback,
} from "./launchFailsafe.ts";
import { desktopBridge } from "./desktopBridge.ts";
import "./styles.css";
import "./moduleContent.css";
import "./composerAdaptive.css";
import "./components/mobile/MobileComposerRail.css";
import "./composerAddMenu.css";
import "./workspacePanelPremium.css";
import "./workspacePanelWidgetFixes.css";
import "./workspacePanelEditor.css";
import "./workspaceGallery.css";
import "./workspaceCatalog.css";
import "./railEditor.css";
import "./motion.css";
import "./stackNavigation.css";
import "./surfaceMotion.css";
import "./railDrag.css";
import "./mobileViewport.css";
import "./sessionLoad.css";
// Theme style recipes come next: they re-bind the primitives above.
import "./fluentTheme.css";
import "./macosTheme.css";
import "./liquidGlassTheme.css";
// Window layout geometry (shellLayout.ts) composes with every theme style.
import "./shellLayout.css";
import "./desktopServerList.css";
// Interface styles restyle every surface above, so they load last.
import "./shellLooks.css";
import "./chatMotion.ts";

// Installed before async boot so an iOS standalone PWA that resumes an old
// frozen WebView learns of the server's freshly rebuilt shell; the healthy
// page offers it (Reload / Later) instead of reloading under the person.
installBuildFreshnessWatcher(undefined, { offerReload: offerWebUpdate });

// Touch vs keyboard, read by CSS that hides script-restored focus rings after a tap.
installInputModality();

// Last resort: a page that never rendered must neither hide behind its veil
// forever nor lift it onto an empty page (launchFailsafe.ts). Armed before the
// first await, so a boot stuck on a native call or a Link read is covered too.
// A rendered page owns its veil.
setTimeout(() => {
  if (document.getElementById("root")?.hasChildNodes()) return;
  recoverUnrenderedLaunch();
}, UNRENDERED_LAUNCH_MS);

function recoverUnrenderedLaunch(): void {
  const now = Date.now();
  let lastReloadAt: number | null = null;
  try {
    const stored = Number(sessionStorage.getItem(UNRENDERED_RELOAD_KEY));
    if (stored > 0) lastReloadAt = stored;
  } catch { /* storage unavailable: treat as never reloaded */ }
  const fallback = unrenderedLaunchFallback({
    native: isNativeMobile(),
    loopback: isPolythLinkLoopbackOrigin(location.origin),
    lastReloadAt,
    now,
  });
  if (fallback === "hub") {
    void returnToMobileConnectionHub(`${location.pathname}${location.search}${location.hash}`, { resume: true });
  } else if (fallback === "reload") {
    try { sessionStorage.setItem(UNRENDERED_RELOAD_KEY, String(now)); } catch { /* reload once anyway */ }
    reloadBehindVeil();
  } else {
    void launchVeil.lift();
  }
}

// Auth and locale start in parallel. The app graph itself waits for auth
// prefetch so a remembered multi-user session restores its browser-local
// account namespace before account-scoped modules evaluate.
const mobileLaunch = await prepareMobileLaunch();
// This page's own launch veil is already painted and identical to
// the native launch screen, so the native one hands over to it invisibly. From
// here on the page decides when the veil lifts (the Connection Hub while it
// connects, launchReveal.ts once the workspace has settled).
if (isNativeMobile()) {
  setLaunchLeaveCover(() => launchVeil.restore());
  void launchVeil.ready().then(() => releaseLaunchCurtain());
}
if (desktopBridge()?.surface === "hub") {
  // The desktop app's server list, on its own origin with no server behind it.
  await ensureLocale(getLocaleSnapshot());
  const { renderDesktopServerList } = await import("./components/DesktopServerList.tsx");
  renderDesktopServerList();
} else if (mobileLaunch.kind === "connect") {
  await ensureLocale(getLocaleSnapshot());
  const { renderMobileConnection } = await import("@polyth/mobile/connection");
  renderMobileConnection(mobileLaunch, { veil: launchVeil });
} else if (mobileLaunch.kind !== "navigating") {
  // The phone app's shell is served by its local Link proxy, which has no auth
  // status to inline, so reading it costs a full tunnel round trip. The proxy
  // serves this page only to a paired device with a valid session, so the
  // socket is dialed in parallel with that read. If the installation turns
  // out not to be ready, the server refuses the upgrade or nobody adopts the
  // socket, and init() dials afresh (adoptPreconnectedSync drops a failed one).
  if (isNativeMobile()) preconnectSync(syncSocketUrl());
  const authStatus = prefetchAuthStatus();
  // A ready, authorized installation dials /ws now, while the app graph below
  // still loads and evaluates; init() adopts the socket (syncPreconnect.ts).
  void authStatus.then((status) => {
    if (authBootstrapPhase(status) === "ready") preconnectSync(syncSocketUrl());
  }).catch(() => undefined);
  await ensureLocale(getLocaleSnapshot());
  await authStatus.catch(() => undefined);
  await import("./bootstrap.tsx");
}
