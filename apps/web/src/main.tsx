// Tiny entry: load the stored locale's catalog chunk BEFORE the app graph
// evaluates. Module-level tr() constants (surface titles, command names)
// capture strings at import time, so they must run after the merge.
import { ensureLocale, getLocaleSnapshot } from "./i18n/index.ts";
import { prefetchAuthStatus } from "./authPrefetch.ts";
import { prepareMobileLaunch } from "@polyth/mobile/runtime";
import "./styles.css";

// The auth round-trip races the locale + bootstrap chunk loads instead of
// running after first render (the bootstrap chunk itself is modulepreload-ed
// from index.html, so its bytes also arrive in parallel).
const mobileLaunch = await prepareMobileLaunch();
if (mobileLaunch.kind === "connect") {
  await ensureLocale(getLocaleSnapshot());
  const { renderMobileConnection } = await import("@polyth/mobile/connection");
  renderMobileConnection(mobileLaunch);
} else if (mobileLaunch.kind !== "navigating") {
  prefetchAuthStatus();
  await ensureLocale(getLocaleSnapshot());
  await import("./bootstrap.tsx");
}
