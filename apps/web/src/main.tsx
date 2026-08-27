// Tiny entry: load the stored locale's catalog chunk BEFORE the app graph
// evaluates. Module-level tr() constants (surface titles, command names)
// capture strings at import time, so they must run after the merge.
import { ensureLocale, getLocaleSnapshot } from "./i18n/index.ts";
import { prefetchAuthStatus } from "./authPrefetch.ts";

// The auth round-trip races the locale + bootstrap chunk loads instead of
// running after first render (the bootstrap chunk itself is modulepreload-ed
// from index.html, so its bytes also arrive in parallel).
prefetchAuthStatus();
await ensureLocale(getLocaleSnapshot());
await import("./bootstrap.tsx");
