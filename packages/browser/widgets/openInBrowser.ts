import type { BrowserNavigateResponse, BrowserSessionDto } from "@polyth/session/web-api";
import { selectBrowserTab, sessionBrowserTabs } from "./browserTabs.ts";
import { publishBrowserTabUpdate } from "./browserSignals.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

/**
 * "Open in Browser" for a link found in chat. The user is the actor: it goes
 * through the same user navigation route as the address bar, so navigation
 * policy and per-origin approval still apply. A link that needs approval is
 * parked here and replayed by the viewer, which owns the approval card.
 */
export interface OpenInBrowserDeps {
  list(projectId: string): Promise<BrowserSessionDto[]>;
  create(input: {
    projectId: string;
    sessionId?: string;
    viewport: { width: number; height: number };
    colorScheme?: "light" | "dark";
  }): Promise<BrowserSessionDto>;
  navigate(id: string, url: string): Promise<BrowserNavigateResponse>;
  /** The viewer's remembered tab for this chat lane. */
  recalledTab(): string | null;
  rememberTab(id: string): void;
  openPane(): void;
  /** The app's resolved appearance; a new tab starts in the same scheme. */
  appearance?(): "light" | "dark" | null;
}

export interface OpenInBrowserTarget {
  projectId: string;
  sessionId: string | null;
}

export type OpenInBrowserResult =
  | { status: "opened"; tabId: string }
  | { status: "approval-required"; tabId: string };

const pending = new Map<string, string>();

/** Take (and clear) a navigation that was waiting on approval for this tab. */
export function takePendingNavigation(tabId: string): string | null {
  const url = pending.get(tabId) ?? null;
  pending.delete(tabId);
  return url;
}

export function parkPendingNavigation(tabId: string, url: string): void {
  pending.set(tabId, url);
  if (pending.size > 32) pending.delete(pending.keys().next().value as string);
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

export async function openUrlInBrowser(
  target: OpenInBrowserTarget,
  url: string,
  deps: OpenInBrowserDeps,
): Promise<OpenInBrowserResult> {
  if (!isHttpUrl(url)) throw new Error(tr("browser.links.onlyHttp"));
  // Reuse this chat lane's tab so repeated link clicks do not pile up tabs.
  const existing = selectBrowserTab(
    sessionBrowserTabs(await deps.list(target.projectId), target.projectId, target.sessionId)
      .filter((candidate) => candidate.status !== "failed"),
    deps.recalledTab(),
  );
  const colorScheme = deps.appearance?.() ?? null;
  const tab = existing ?? await deps.create({
    projectId: target.projectId,
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    viewport: DEFAULT_VIEWPORT,
    ...(colorScheme ? { colorScheme } : {}),
  });
  deps.rememberTab(tab.id);
  deps.openPane();
  const navigation = await deps.navigate(tab.id, url);
  // A viewer already showing this tab learns about the new page (or the
  // parked approval) from here: it did not issue the navigation itself.
  if ("approval" in navigation) {
    parkPendingNavigation(tab.id, url);
    publishBrowserTabUpdate(tab);
    return { status: "approval-required", tabId: tab.id };
  }
  publishBrowserTabUpdate(navigation);
  return { status: "opened", tabId: tab.id };
}
