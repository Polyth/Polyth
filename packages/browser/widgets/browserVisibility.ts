export type BrowserVisibilityMode = "background" | "auto-show";

export const DEFAULT_BROWSER_VISIBILITY: BrowserVisibilityMode = "background";
const STORAGE_KEY = "polyth.browser.visibility.v1";
const listeners = new Set<() => void>();
let cached: BrowserVisibilityMode | undefined;

function read(): BrowserVisibilityMode {
  if (cached) return cached;
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    cached = value === "auto-show" ? "auto-show" : DEFAULT_BROWSER_VISIBILITY;
  } catch {
    cached = DEFAULT_BROWSER_VISIBILITY;
  }
  return cached;
}

export function getBrowserVisibility(): BrowserVisibilityMode {
  return read();
}

export function setBrowserVisibility(mode: BrowserVisibilityMode): void {
  cached = mode;
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* private mode */ }
  for (const listener of [...listeners]) listener();
}

export function subscribeBrowserVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
