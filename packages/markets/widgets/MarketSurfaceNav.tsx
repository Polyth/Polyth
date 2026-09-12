import type { WebPackageHost } from "@polyth/web-sdk";

export type MarketSurfaceId =
  | "markets.overview"
  | "markets"
  | "markets.technicals"
  | "markets.calendar"
  | "markets.screener"
  | "markets.heatmap"
  | "markets.compare"
  | "markets.portfolio"
  | "markets.earnings"
  | "markets.filings";

export interface MarketSurfaceLink {
  id: MarketSurfaceId;
  label: string;
}

/** Canonical section order for the Markets frame. Rendered by
 *  MarketSurfaceNav so layout tests can exercise the real markup and classes. */
export const MARKET_SECTION_LINKS: readonly MarketSurfaceLink[] = [
  { id: "markets.overview", label: "Overview" },
  { id: "markets", label: "Research" },
  { id: "markets.technicals", label: "Technicals" },
  { id: "markets.calendar", label: "Calendar" },
  { id: "markets.screener", label: "Screener" },
  { id: "markets.heatmap", label: "Heatmap" },
  { id: "markets.compare", label: "Compare" },
  { id: "markets.portfolio", label: "Portfolio" },
  { id: "markets.earnings", label: "Earnings" },
  { id: "markets.filings", label: "Filings" },
];

/** Section switcher for the Markets frame. Scroll ownership, the edge fade,
 *  inline padding, touch containment and the hidden scrollbar come from the
 *  shared .ui-scroll-tabs primitive (apps/web styles.css); local CSS keeps
 *  layout only. */
export function MarketSurfaceNav({
  host,
  activeId,
}: {
  host: WebPackageHost;
  activeId: MarketSurfaceId;
}) {
  return (
    <nav className="markets-surface-nav ui-scroll-tabs" aria-label="Markets sections">
      {MARKET_SECTION_LINKS.map((link) => (
        <host.ui.components.Button
          key={link.id}
          size="sm"
          variant={activeId === link.id ? "quiet" : "ghost"}
          aria-current={activeId === link.id ? "page" : undefined}
          onClick={() => host.navigation.openWorkspacePane(link.id)}
        >
          {link.label}
        </host.ui.components.Button>
      ))}
    </nav>
  );
}
