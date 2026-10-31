import type { BrowserSessionDto } from "@polyth/contracts";

/** A fresh chat has its own lane; it must never adopt another session's tab. */
export function sessionBrowserTabs(tabs: BrowserSessionDto[], projectId: string, sessionId: string | null): BrowserSessionDto[] {
  return tabs.filter((tab) => tab.projectId === projectId
    && (tab.sessionId ?? null) === sessionId && tab.status !== "closed");
}

export function selectBrowserTab(tabs: BrowserSessionDto[], selectedId: string | null): BrowserSessionDto | null {
  return tabs.find((tab) => tab.id === selectedId) ?? tabs[0] ?? null;
}

/** The host supplies its Account/Space/project/session presentation namespace. */
export function recalledBrowserTab(presentationKey: string): string | null {
  try { return localStorage.getItem(presentationKey); } catch { return null; }
}

export function rememberBrowserTab(presentationKey: string, tabId: string | null): void {
  try {
    if (tabId) localStorage.setItem(presentationKey, tabId);
    else localStorage.removeItem(presentationKey);
  } catch { /* storage is optional presentation state */ }
}
