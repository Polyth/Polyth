// Tiny entry: load the stored locale's catalog chunk BEFORE the app graph
// evaluates. Module-level tr() constants (surface titles, command names)
// capture strings at import time, so they must run after the merge.
// ES2023 array methods first: older WebViews (native iOS 15) lack them.
import "./arrayCompat.ts";
import { ensureLocale, getLocaleSnapshot } from "./i18n/index.ts";
import { prefetchAuthStatus } from "./authPrefetch.ts";
import { installBuildFreshnessWatcher } from "./buildFreshness.ts";
import { offerWebUpdate } from "./webUpdateNotice.ts";
import { isNativeMobile, prepareMobileLaunch } from "@polyth/mobile/runtime";
import { releaseLaunchCurtain, setLaunchLeaveCover } from "@polyth/mobile/launch";
import { launchVeil } from "./launchVeil.ts";
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
// Interface styles restyle every surface above, so they load last.
import "./shellLooks.css";
import "./chatMotion.ts";

// Installed before async boot so an iOS standalone PWA that resumes an old
// frozen WebView learns of the server's freshly rebuilt shell; the healthy
// page offers it (Reload / Later) instead of reloading under the person.
installBuildFreshnessWatcher(undefined, { offerReload: offerWebUpdate });

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
// Last resort: a page that never rendered (its app graph failed to load) must
// not hide behind its veil forever. A rendered page owns its veil.
setTimeout(() => {
  if (!document.getElementById("root")?.hasChildNodes()) void launchVeil.lift();
}, 15_000);
if (mobileLaunch.kind === "connect") {
  await ensureLocale(getLocaleSnapshot());
  const { renderMobileConnection } = await import("@polyth/mobile/connection");
  renderMobileConnection(mobileLaunch, { veil: launchVeil });
} else if (mobileLaunch.kind !== "navigating") {
  const authStatus = prefetchAuthStatus();
  await ensureLocale(getLocaleSnapshot());
  await authStatus.catch(() => undefined);
  await import("./bootstrap.tsx");
}
