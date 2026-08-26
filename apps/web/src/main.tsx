// Tiny entry: load the stored locale's catalog chunk BEFORE the app graph
// evaluates. Module-level tr() constants (surface titles, command names)
// capture strings at import time, so they must run after the merge.
import { ensureLocale, getLocaleSnapshot } from "./i18n/index.ts";

await ensureLocale(getLocaleSnapshot());
await import("./bootstrap.tsx");
