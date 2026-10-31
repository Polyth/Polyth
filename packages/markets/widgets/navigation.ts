import type { WebPackageHost } from "@polyth/web-sdk";

export const MARKET_SECTION_LINKS = [
  { id: "markets.overview", label: "Overview", labelKey: "markets.nav.overview" },
  { id: "markets", label: "Research", labelKey: "markets.nav.research" },
  { id: "markets.technicals", label: "Technicals", labelKey: "markets.nav.technicals" },
  { id: "markets.calendar", label: "Calendar", labelKey: "markets.nav.calendar" },
  { id: "markets.screener", label: "Screener", labelKey: "markets.nav.screener" },
  { id: "markets.heatmap", label: "Heatmap", labelKey: "markets.nav.heatmap" },
  { id: "markets.compare", label: "Compare", labelKey: "markets.nav.compare" },
  { id: "markets.portfolio", label: "Portfolio", labelKey: "markets.nav.portfolio" },
  { id: "markets.earnings", label: "Earnings", labelKey: "markets.nav.earnings" },
  { id: "markets.filings", label: "Filings", labelKey: "markets.nav.filings" },
] as const;

export type MarketSurfaceId = typeof MARKET_SECTION_LINKS[number]["id"];
export interface MarketSurfaceLink {
  id: MarketSurfaceId;
  label: string;
}

export function isMarketSurfaceId(value: unknown): value is MarketSurfaceId {
  return MARKET_SECTION_LINKS.some((link) => link.id === value);
}

/** Device navigation only. Canonical project IDs are globally unique and
 * Space-owned; no shared global last-page key or session-history event. */
export function createMarketNavigation(host: Pick<WebPackageHost, "store" | "navigation">) {
  const remembered = new Map<string, MarketSurfaceId>();
  const key = (projectId: string) => `polyth.markets.lastSection.v1.${encodeURIComponent(projectId)}`;
  const remember = () => {
    const { activeProjectId, railPlugin } = host.store.getSnapshot();
    if (activeProjectId === null || !isMarketSurfaceId(railPlugin)
      || remembered.get(activeProjectId) === railPlugin) return;
    remembered.set(activeProjectId, railPlugin);
    try {
      localStorage.setItem(key(activeProjectId), railPlugin);
    } catch {
      // Keep close/reopen working when browser storage is unavailable.
    }
  };
  const dispose = host.store.subscribe(remember);
  remember();

  return {
    open: () => {
      const { activeProjectId } = host.store.getSnapshot();
      let section: MarketSurfaceId = "markets.overview";
      if (activeProjectId !== null) {
        const cached = remembered.get(activeProjectId);
        if (cached) section = cached;
        else {
          try {
            const saved = localStorage.getItem(key(activeProjectId));
            if (isMarketSurfaceId(saved)) section = saved;
          } catch {
            // Fresh projects and unavailable storage open Overview.
          }
        }
      }
      host.navigation.openWorkspacePane(section);
    },
    dispose,
  };
}
