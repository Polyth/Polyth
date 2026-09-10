import "./styles.css";
import "./integration.css";
import "./widgetStyles.css";
import "./news.css";
import "./compare.css";
import "./portfolio.css";
import "./earnings.css";
import "./filings.css";
import "./overview.css";
import "./overviewWidget.css";
import "./screener.css";
import "./surfaceFrame.css";
import "./portfolioWidget.css";
import { createElement, useEffect, useState, type ReactNode } from "react";
import { defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import MarketsSurface, { type MarketHandoffOption } from "./MarketsSurface.tsx";
import MarketCompareSurface from "./MarketCompareSurface.tsx";
import MarketEarningsSurface from "./MarketEarningsSurface.tsx";
import MarketFilingsSurface from "./MarketFilingsSurface.tsx";
import MarketOverviewSurface from "./MarketOverviewSurface.tsx";
import { MarketOverviewWidget } from "./MarketOverviewWidget.tsx";
import MarketPortfolioSurface from "./MarketPortfolioSurface.tsx";
import { MarketPortfolioWidget } from "./MarketPortfolioWidget.tsx";
import MarketScreenerSurface from "./MarketScreenerSurface.tsx";
import { MarketAssetWidget, MarketNewsWidget, MarketWatchlistWidget } from "./MarketWidgets.tsx";
import { selectMarketSymbol } from "./selection.ts";

type MarketSurfaceId = "markets.overview" | "markets" | "markets.screener" | "markets.compare" | "markets.portfolio" | "markets.earnings" | "markets.filings";

function MarketSurfaceFrame({
  host,
  activeId,
  children,
}: {
  host: WebPackageHost;
  activeId: MarketSurfaceId;
  children: ReactNode;
}) {
  const links: Array<{ id: MarketSurfaceId; label: string }> = [
    { id: "markets.overview", label: "Overview" },
    { id: "markets", label: "Research" },
    { id: "markets.screener", label: "Screener" },
    { id: "markets.compare", label: "Compare" },
    { id: "markets.portfolio", label: "Portfolio" },
    { id: "markets.earnings", label: "Earnings" },
    { id: "markets.filings", label: "Filings" },
  ];
  return (
    <div className="markets-surface-frame">
      <nav className="markets-surface-nav" aria-label="Markets sections">
        {links.map((link) => (
          <button
            key={link.id}
            type="button"
            aria-current={activeId === link.id ? "page" : undefined}
            onClick={() => host.navigation.openWorkspacePane(link.id)}
          >
            {link.label}
          </button>
        ))}
      </nav>
      <div className="markets-surface-frame-body">{children}</div>
    </div>
  );
}

function openMarketSymbol(host: WebPackageHost, symbol: string): void {
  selectMarketSymbol(symbol);
  host.navigation.openWorkspacePane("markets");
}

function useMarketHandoffOptions(host: WebPackageHost): MarketHandoffOption[] {
  const [snapshot, setSnapshot] = useState(() => host.store.getSnapshot());
  useEffect(() => host.store.subscribe(() => setSnapshot(host.store.getSnapshot())), [host]);
  return snapshot.activeProjectId
    ? host.handoffTargets.list()
        .filter((target) => target.available())
        .map((target) => ({
          id: target.id,
          label: target.label,
          send: (text) => target.send({
            projectId: snapshot.activeProjectId!,
            sessionId: snapshot.activeSessionId,
            text,
          }),
        }))
    : [];
}

function HostedOverviewSurface({ host, active }: { host: WebPackageHost; active?: boolean }) {
  const handoffOptions = useMarketHandoffOptions(host);
  return (
    <MarketSurfaceFrame host={host} activeId="markets.overview">
      <MarketOverviewSurface
        active={active}
        handoffOptions={handoffOptions}
        onOpen={(symbol) => openMarketSymbol(host, symbol)}
      />
    </MarketSurfaceFrame>
  );
}

function HostedMarketsSurface({ host, active }: { host: WebPackageHost; active?: boolean }) {
  const handoffOptions = useMarketHandoffOptions(host);
  return (
    <MarketSurfaceFrame host={host} activeId="markets">
      <MarketsSurface active={active} handoffOptions={handoffOptions} />
    </MarketSurfaceFrame>
  );
}

function HostedScreenerSurface({ host, active }: { host: WebPackageHost; active?: boolean }) {
  const handoffOptions = useMarketHandoffOptions(host);
  return (
    <MarketSurfaceFrame host={host} activeId="markets.screener">
      <MarketScreenerSurface
        active={active}
        handoffOptions={handoffOptions}
        onOpen={(symbol) => openMarketSymbol(host, symbol)}
      />
    </MarketSurfaceFrame>
  );
}

function HostedCompareSurface({ host, active }: { host: WebPackageHost; active?: boolean }) {
  const handoffOptions = useMarketHandoffOptions(host);
  return (
    <MarketSurfaceFrame host={host} activeId="markets.compare">
      <MarketCompareSurface
        active={active}
        handoffOptions={handoffOptions}
        onOpen={(symbol) => openMarketSymbol(host, symbol)}
      />
    </MarketSurfaceFrame>
  );
}

function HostedPortfolioSurface({ host, active }: { host: WebPackageHost; active?: boolean }) {
  const handoffOptions = useMarketHandoffOptions(host);
  return (
    <MarketSurfaceFrame host={host} activeId="markets.portfolio">
      <MarketPortfolioSurface
        active={active}
        handoffOptions={handoffOptions}
        onOpen={(symbol) => openMarketSymbol(host, symbol)}
      />
    </MarketSurfaceFrame>
  );
}

function HostedEarningsSurface({ host, active }: { host: WebPackageHost; active?: boolean }) {
  const handoffOptions = useMarketHandoffOptions(host);
  return (
    <MarketSurfaceFrame host={host} activeId="markets.earnings">
      <MarketEarningsSurface
        active={active}
        handoffOptions={handoffOptions}
        onOpenResearch={(symbol) => openMarketSymbol(host, symbol)}
      />
    </MarketSurfaceFrame>
  );
}

function HostedFilingsSurface({ host, active }: { host: WebPackageHost; active?: boolean }) {
  const handoffOptions = useMarketHandoffOptions(host);
  return (
    <MarketSurfaceFrame host={host} activeId="markets.filings">
      <MarketFilingsSurface
        active={active}
        handoffOptions={handoffOptions}
        onOpenResearch={(symbol) => openMarketSymbol(host, symbol)}
      />
    </MarketSurfaceFrame>
  );
}

export default defineWebPackage((host) => () => {
  const openSymbol = (symbol: string) => openMarketSymbol(host, symbol);
  const openOverview = () => host.navigation.openWorkspacePane("markets.overview");
  const openPortfolio = () => host.navigation.openWorkspacePane("markets.portfolio");

  const off = [
    host.surfaces.register({
      id: "markets.overview",
      title: "Market overview",
      description: "Macro regime, major market indices, and liquid crypto in one glance.",
      capabilityId: "markets.overview",
      order: 51,
      component: (props) => createElement(HostedOverviewSurface, { host, active: props?.active }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.68,
        minWidth: 340,
        minHeight: 300,
        preferredMaxWidth: 1_100,
        keepAlive: true,
        escape: "close",
      },
      placement: {
        preferredRegion: "primary",
        allowedRegions: ["primary", "end", "bottom"],
        minInlineSize: 340,
        minBlockSize: 280,
        keepAlive: true,
      },
    }),
    host.surfaces.register({
      id: "markets",
      title: "Markets",
      description: "Research prices, charts, fundamentals, news, and market context.",
      capabilityId: "markets",
      order: 52,
      component: (props) => createElement(HostedMarketsSurface, { host, active: props?.active }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.62,
        minWidth: 340,
        minHeight: 300,
        preferredMaxWidth: 1_100,
        keepAlive: true,
        escape: "close",
      },
      placement: {
        preferredRegion: "primary",
        allowedRegions: ["primary", "end", "bottom"],
        minInlineSize: 340,
        minBlockSize: 280,
        keepAlive: true,
      },
    }),
    host.surfaces.register({
      id: "markets.screener",
      title: "Market screener",
      description: "Filter and sort US common stocks without per-symbol quote fan-out.",
      capabilityId: "markets.screener",
      order: 53,
      component: (props) => createElement(HostedScreenerSurface, { host, active: props?.active }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.72,
        minWidth: 360,
        minHeight: 300,
        preferredMaxWidth: 1_200,
        keepAlive: true,
        escape: "close",
      },
      placement: {
        preferredRegion: "primary",
        allowedRegions: ["primary", "end", "bottom"],
        minInlineSize: 360,
        minBlockSize: 280,
        keepAlive: true,
      },
    }),
    host.surfaces.register({
      id: "markets.compare",
      title: "Compare markets",
      description: "Compare price performance and fundamentals across market assets.",
      capabilityId: "markets.compare",
      order: 54,
      component: (props) => createElement(HostedCompareSurface, { host, active: props?.active }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.68,
        minWidth: 360,
        minHeight: 300,
        preferredMaxWidth: 1_180,
        keepAlive: true,
        escape: "close",
      },
      placement: {
        preferredRegion: "primary",
        allowedRegions: ["primary", "end", "bottom"],
        minInlineSize: 360,
        minBlockSize: 280,
        keepAlive: true,
      },
    }),
    host.surfaces.register({
      id: "markets.portfolio",
      title: "Portfolio",
      description: "Track holdings and build per-space market context without mixing currencies.",
      capabilityId: "markets.portfolio",
      order: 55,
      component: (props) => createElement(HostedPortfolioSurface, { host, active: props?.active }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.68,
        minWidth: 360,
        minHeight: 300,
        preferredMaxWidth: 1_180,
        keepAlive: true,
        escape: "close",
      },
      placement: {
        preferredRegion: "primary",
        allowedRegions: ["primary", "end", "bottom"],
        minInlineSize: 360,
        minBlockSize: 280,
        keepAlive: true,
      },
    }),
    host.surfaces.register({
      id: "markets.earnings",
      title: "Earnings",
      description: "Review historical EPS versus consensus and earnings surprise trends.",
      capabilityId: "markets.earnings",
      order: 56,
      component: (props) => createElement(HostedEarningsSurface, { host, active: props?.active }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.68,
        minWidth: 360,
        minHeight: 300,
        preferredMaxWidth: 1_050,
        keepAlive: true,
        escape: "close",
      },
      placement: {
        preferredRegion: "primary",
        allowedRegions: ["primary", "end", "bottom"],
        minInlineSize: 360,
        minBlockSize: 280,
        keepAlive: true,
      },
    }),
    host.surfaces.register({
      id: "markets.filings",
      title: "SEC filings",
      description: "Browse recent official EDGAR filings and hand filing context to Polyth.",
      capabilityId: "markets.filings",
      order: 57,
      component: (props) => createElement(HostedFilingsSurface, { host, active: props?.active }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.68,
        minWidth: 360,
        minHeight: 300,
        preferredMaxWidth: 1_100,
        keepAlive: true,
        escape: "close",
      },
      placement: {
        preferredRegion: "primary",
        allowedRegions: ["primary", "end", "bottom"],
        minInlineSize: 360,
        minBlockSize: 280,
        keepAlive: true,
      },
    }),
    host.widgets.registerPlugin({
      id: "markets",
      name: "Markets",
      widgets: [
        {
          id: "markets.overview",
          title: "Market overview",
          description: "Major markets and liquid crypto with lightweight visible-only refresh.",
          kind: "widget",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom", "workspace.floating"],
          recommendedSize: { w: 5, h: 6 },
          minSize: { w: 4, h: 4 },
          maxSize: { w: 8, h: 10 },
          audience: "simple",
          scope: "workspace",
          resizable: true,
          duplicatable: false,
          floating: true,
          recommended: true,
          defaultVisible: false,
          render: (context) => (
            <MarketOverviewWidget context={context} onOpenOverview={openOverview} onOpenSymbol={openSymbol} />
          ),
        },
        {
          id: "markets.asset",
          title: "Market asset",
          description: "Live-ish price and daily move for one market symbol.",
          kind: "widget",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom", "workspace.floating"],
          recommendedSize: { w: 4, h: 3 },
          minSize: { w: 3, h: 2 },
          maxSize: { w: 8, h: 6 },
          audience: "standard",
          scope: "workspace",
          resizable: true,
          duplicatable: true,
          floating: true,
          recommended: true,
          defaultVisible: false,
          settingsSchema: {
            type: "object",
            properties: {
              symbol: { type: "string", title: "Symbol", default: "SPY" },
            },
          },
          render: (context) => <MarketAssetWidget context={context} onOpen={openSymbol} />,
        },
        {
          id: "markets.watchlist",
          title: "Market watchlist",
          description: "Your active watchlist with current prices and daily moves.",
          kind: "widget",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom", "workspace.floating"],
          recommendedSize: { w: 5, h: 6 },
          minSize: { w: 3, h: 3 },
          maxSize: { w: 8, h: 12 },
          audience: "simple",
          scope: "workspace",
          resizable: true,
          duplicatable: false,
          floating: true,
          recommended: true,
          defaultVisible: false,
          render: (context) => <MarketWatchlistWidget context={context} onOpen={openSymbol} />,
        },
        {
          id: "markets.news",
          title: "Market news",
          description: "Recent stories for one market symbol from aggregated RSS feeds.",
          kind: "widget",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom", "workspace.floating"],
          recommendedSize: { w: 5, h: 6 },
          minSize: { w: 4, h: 3 },
          maxSize: { w: 9, h: 12 },
          audience: "standard",
          scope: "workspace",
          resizable: true,
          duplicatable: true,
          floating: true,
          recommended: true,
          defaultVisible: false,
          settingsSchema: {
            type: "object",
            properties: {
              symbol: { type: "string", title: "Symbol", default: "SPY" },
            },
          },
          render: (context) => <MarketNewsWidget context={context} />,
        },
        {
          id: "markets.portfolio-summary",
          title: "Portfolio",
          description: "Current portfolio value and daily move grouped by quote currency.",
          kind: "widget",
          defaultSlot: "workspace.right",
          supportedSlots: ["workspace.main", "workspace.right", "workspace.bottom", "workspace.floating"],
          recommendedSize: { w: 5, h: 6 },
          minSize: { w: 3, h: 3 },
          maxSize: { w: 8, h: 12 },
          audience: "standard",
          scope: "workspace",
          resizable: true,
          duplicatable: false,
          floating: true,
          recommended: true,
          defaultVisible: false,
          render: (context) => (
            <MarketPortfolioWidget context={context} onOpen={openSymbol} onOpenPortfolio={openPortfolio} />
          ),
        },
      ],
    }),
    host.workbench.profiles.register({
      id: "markets",
      label: "Markets",
      description: "Research markets beside a Polyth session.",
      order: 30,
      defaultLayout: {
        surfaces: [
          { surface: "markets.overview", region: "primary", active: true },
          { surface: "session", region: "end" },
        ],
      },
      presentation: { text: "data" },
    }),
    host.capabilities.register({
      id: "markets.overview",
      label: "Market overview",
      plainDescription: "View macro indicators, major U.S. markets, and liquid crypto in one place.",
      keywords: ["market", "overview", "macro", "crypto", "bitcoin", "rates", "inflation", "vix"],
      standardTier: "more",
      standardRank: 21,
      open: openOverview,
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets",
      label: "Markets",
      plainDescription: "Research stocks, ETFs, market news, and financial context.",
      keywords: ["market", "stocks", "finance", "quote", "investing", "research", "news"],
      standardTier: "more",
      standardRank: 22,
      open: () => host.navigation.openWorkspacePane("markets"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.screener",
      label: "Market screener",
      plainDescription: "Filter and sort US common stocks by sector, move, volume, and market cap.",
      keywords: ["market", "screener", "stocks", "filter", "sector", "volume", "market cap"],
      standardTier: "more",
      standardRank: 23,
      open: () => host.navigation.openWorkspacePane("markets.screener"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.compare",
      label: "Compare markets",
      plainDescription: "Compare prices, performance, valuation, and fundamentals across market assets.",
      keywords: ["market", "compare", "stocks", "finance", "performance", "valuation"],
      standardTier: "more",
      standardRank: 24,
      open: () => host.navigation.openWorkspacePane("markets.compare"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.portfolio",
      label: "Portfolio",
      plainDescription: "Track holdings, current value, daily move, and unrealized gain by quote currency.",
      keywords: ["market", "portfolio", "holdings", "investing", "positions", "pnl"],
      standardTier: "more",
      standardRank: 25,
      open: () => host.navigation.openWorkspacePane("markets.portfolio"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.earnings",
      label: "Earnings",
      plainDescription: "Review historical EPS versus consensus and earnings surprise trends.",
      keywords: ["market", "earnings", "eps", "surprise", "consensus", "estimates"],
      standardTier: "more",
      standardRank: 26,
      open: () => host.navigation.openWorkspacePane("markets.earnings"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.filings",
      label: "SEC filings",
      plainDescription: "Browse official SEC EDGAR filings and send filing context to Polyth.",
      keywords: ["market", "sec", "edgar", "filings", "10-k", "10-q", "8-k"],
      standardTier: "more",
      standardRank: 27,
      open: () => host.navigation.openWorkspacePane("markets.filings"),
      available: () => true,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
