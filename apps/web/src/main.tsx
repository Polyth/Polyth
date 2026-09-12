// Tiny entry: load the stored locale's catalog chunk BEFORE the app graph
// evaluates. Module-level tr() constants (surface titles, command names)
// capture strings at import time, so they must run after the merge.
import { ensureLocale, getLocaleSnapshot } from "./i18n/index.ts";
import { prefetchAuthStatus } from "./authPrefetch.ts";
import { prepareMobileLaunch } from "@polyth/mobile/runtime";
import "./styles.css";
import "./moduleContent.css";
import "./composerAdaptive.css";
import "./motion.css";
import "./chatMotion.ts";

// Auth and locale start in parallel. The app graph itself waits for auth
// prefetch so a remembered multi-user session restores its browser-local
// account namespace before account-scoped modules evaluate.
const mobileLaunch = await prepareMobileLaunch();
if (mobileLaunch.kind === "connect") {
  await ensureLocale(getLocaleSnapshot());
  const { renderMobileConnection } = await import("@polyth/mobile/connection");
  renderMobileConnection(mobileLaunch);
} else if (mobileLaunch.kind !== "navigating") {
  const authStatus = prefetchAuthStatus();
  await ensureLocale(getLocaleSnapshot());
  await authStatus.catch(() => undefined);
  await import("./bootstrap.tsx");
}
