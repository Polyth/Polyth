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
import "./heatmap.css";
import "./technicals.css";
import "./calendar.css";
import "./surfaceFrame.css";
import "./portfolioWidget.css";
import { createElement, useEffect, useState, type ReactNode } from "react";
import { defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import MarketsSurface, { type MarketHandoffOption } from "./MarketsSurface.tsx";
import MarketCalendarSurface from "./MarketCalendarSurface.tsx";
import MarketCompareSurface from "./MarketCompareSurface.tsx";
import MarketEarningsSurface from "./MarketEarningsSurface.tsx";
import MarketFilingsSurface from "./MarketFilingsSurface.tsx";
import MarketHeatmapSurface from "./MarketHeatmapSurface.tsx";
import MarketOverviewSurface from "./MarketOverviewSurface.tsx";
import { MarketOverviewWidget } from "./MarketOverviewWidget.tsx";
import MarketPortfolioSurface from "./MarketPortfolioSurface.tsx";
import { MarketPortfolioWidget } from "./MarketPortfolioWidget.tsx";
import MarketScreenerSurface from "./MarketScreenerSurface.tsx";
import MarketTechnicalSurface from "./MarketTechnicalSurface.tsx";
import { MarketAssetWidget, MarketNewsWidget, MarketWatchlistWidget } from "./MarketWidgets.tsx";
import { MarketSurfaceNav, type MarketSurfaceId } from "./MarketSurfaceNav.tsx";
import { selectMarketSymbol } from "./selection.ts";
import { createMarketNavigation } from "./navigation.ts";

function MarketSurfaceFrame({
  host,
  activeId,
  children,
}: {
  host: WebPackageHost;
  activeId: MarketSurfaceId;
  children: ReactNode;
}) {
  return (
    <div className="markets-surface-frame">
      <MarketSurfaceNav host={host} activeId={activeId} />
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

function HostedTechnicalSurface({ host, active }: { host: WebPackageHost; active?: boolean }) {
  const handoffOptions = useMarketHandoffOptions(host);
  return (
    <MarketSurfaceFrame host={host} activeId="markets.technicals">
      <MarketTechnicalSurface
        active={active}
        handoffOptions={handoffOptions}
        onOpenResearch={(symbol) => openMarketSymbol(host, symbol)}
      />
    </MarketSurfaceFrame>
  );
}

function HostedCalendarSurface({ host, active }: { host: WebPackageHost; active?: boolean }) {
  const handoffOptions = useMarketHandoffOptions(host);
  return (
    <MarketSurfaceFrame host={host} activeId="markets.calendar">
      <MarketCalendarSurface
        active={active}
        handoffOptions={handoffOptions}
        onOpenResearch={(symbol) => openMarketSymbol(host, symbol)}
      />
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

function HostedHeatmapSurface({ host, active }: { host: WebPackageHost; active?: boolean }) {
  const handoffOptions = useMarketHandoffOptions(host);
  return (
    <MarketSurfaceFrame host={host} activeId="markets.heatmap">
      <MarketHeatmapSurface
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
  const t = (key: string, values?: Record<string, string | number>) => host.ui?.locale?.translate?.(key, values) ?? tr(key as Parameters<typeof tr>[0], values);
  const navigation = createMarketNavigation(host);
  const openSymbol = (symbol: string) => openMarketSymbol(host, symbol);
  const openOverview = () => host.navigation.openWorkspacePane("markets.overview");
  const openPortfolio = () => host.navigation.openWorkspacePane("markets.portfolio");

  const off = [
    host.surfaces.register({
      id: "markets.overview",
      title: t("markets.surface.overview.title"),
      description: t("markets.surface.overview.description"),
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
      title: t("markets.surface.research.title"),
      description: t("markets.surface.research.description"),
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
      id: "markets.technicals",
      title: t("markets.surface.technicals.title"),
      description: t("markets.surface.technicals.description"),
      capabilityId: "markets.technicals",
      order: 53,
      component: (props) => createElement(HostedTechnicalSurface, { host, active: props?.active }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.68,
        minWidth: 340,
        minHeight: 300,
        preferredMaxWidth: 1_050,
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
      id: "markets.calendar",
      title: t("markets.surface.calendar.title"),
      description: t("markets.surface.calendar.description"),
      capabilityId: "markets.calendar",
      order: 54,
      component: (props) => createElement(HostedCalendarSurface, { host, active: props?.active }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.72,
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
      id: "markets.screener",
      title: t("markets.surface.screener.title"),
      description: t("markets.surface.screener.description"),
      capabilityId: "markets.screener",
      order: 55,
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
      id: "markets.heatmap",
      title: t("markets.surface.heatmap.title"),
      description: t("markets.surface.heatmap.description"),
      capabilityId: "markets.heatmap",
      order: 56,
      component: (props) => createElement(HostedHeatmapSurface, { host, active: props?.active }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.76,
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
      title: t("markets.surface.compare.title"),
      description: t("markets.surface.compare.description"),
      capabilityId: "markets.compare",
      order: 57,
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
      title: t("markets.surface.portfolio.title"),
      description: t("markets.surface.portfolio.description"),
      capabilityId: "markets.portfolio",
      order: 58,
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
      title: t("markets.surface.earnings.title"),
      description: t("markets.surface.earnings.description"),
      capabilityId: "markets.earnings",
      order: 59,
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
      title: t("markets.surface.filings.title"),
      description: t("markets.surface.filings.description"),
      capabilityId: "markets.filings",
      order: 60,
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
      name: t("markets.plugin.title"),
      widgets: [
        {
          id: "markets.overview",
          title: t("markets.widget.overview.title"),
          description: t("markets.widget.overview.description"),
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
          title: t("markets.widget.asset.title"),
          description: t("markets.widget.asset.description"),
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
              symbol: { type: "string", title: t("markets.widget.symbolSetting"), default: "SPY" },
            },
          },
          render: (context) => <MarketAssetWidget context={context} onOpen={openSymbol} />,
        },
        {
          id: "markets.watchlist",
          title: t("markets.widget.watchlist.title"),
          description: t("markets.widget.watchlist.description"),
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
          title: t("markets.widget.news.title"),
          description: t("markets.widget.news.description"),
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
              symbol: { type: "string", title: t("markets.widget.symbolSetting"), default: "SPY" },
            },
          },
          render: (context) => <MarketNewsWidget context={context} />,
        },
        {
          id: "markets.portfolio-summary",
          title: t("markets.widget.portfolio.title"),
          description: t("markets.widget.portfolio.description"),
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
      label: t("markets.plugin.title"),
      description: t("markets.profile.description"),
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
      label: t("markets.surface.overview.title"),
      plainDescription: t("markets.capability.overview.description"),
      keywords: ["market", "overview", "macro", "crypto", "bitcoin", "rates", "inflation", "vix"],
      rail: false,
      standardTier: "technical",
      standardRank: 21,
      open: openOverview,
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets",
      label: t("markets.surface.research.title"),
      plainDescription: t("markets.capability.research.description"),
      keywords: ["market", "stocks", "finance", "quote", "investing", "research", "news"],
      standardTier: "more",
      standardRank: 21,
      defaultRails: { finance: "top" },
      open: navigation.open,
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.technicals",
      label: t("markets.surface.technicals.title"),
      plainDescription: t("markets.capability.technicals.description"),
      keywords: ["market", "technical", "rsi", "macd", "moving average", "bollinger", "momentum"],
      rail: false,
      standardTier: "technical",
      standardRank: 23,
      open: () => host.navigation.openWorkspacePane("markets.technicals"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.calendar",
      label: t("markets.surface.calendar.title"),
      plainDescription: t("markets.capability.calendar.description"),
      keywords: ["market", "calendar", "economic", "earnings", "cpi", "fomc", "nfp", "events"],
      rail: false,
      standardTier: "technical",
      standardRank: 24,
      open: () => host.navigation.openWorkspacePane("markets.calendar"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.screener",
      label: t("markets.surface.screener.title"),
      plainDescription: t("markets.capability.screener.description"),
      keywords: ["market", "screener", "stocks", "filter", "sector", "volume", "market cap"],
      rail: false,
      standardTier: "technical",
      standardRank: 25,
      open: () => host.navigation.openWorkspacePane("markets.screener"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.heatmap",
      label: t("markets.surface.heatmap.title"),
      plainDescription: t("markets.capability.heatmap.description"),
      keywords: ["market", "heatmap", "sector", "performance", "market cap", "breadth"],
      rail: false,
      standardTier: "technical",
      standardRank: 26,
      open: () => host.navigation.openWorkspacePane("markets.heatmap"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.compare",
      label: t("markets.surface.compare.title"),
      plainDescription: t("markets.capability.compare.description"),
      keywords: ["market", "compare", "stocks", "finance", "performance", "valuation"],
      rail: false,
      standardTier: "technical",
      standardRank: 27,
      open: () => host.navigation.openWorkspacePane("markets.compare"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.portfolio",
      label: t("markets.surface.portfolio.title"),
      plainDescription: t("markets.capability.portfolio.description"),
      keywords: ["market", "portfolio", "holdings", "investing", "positions", "pnl"],
      rail: false,
      standardTier: "technical",
      standardRank: 28,
      open: () => host.navigation.openWorkspacePane("markets.portfolio"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.earnings",
      label: t("markets.surface.earnings.title"),
      plainDescription: t("markets.capability.earnings.description"),
      keywords: ["market", "earnings", "eps", "surprise", "consensus", "estimates"],
      rail: false,
      standardTier: "technical",
      standardRank: 29,
      open: () => host.navigation.openWorkspacePane("markets.earnings"),
      available: () => true,
    }),
    host.capabilities.register({
      id: "markets.filings",
      label: t("markets.surface.filings.title"),
      plainDescription: t("markets.capability.filings.description"),
      keywords: ["market", "sec", "edgar", "filings", "10-k", "10-q", "8-k"],
      rail: false,
      standardTier: "technical",
      standardRank: 30,
      open: () => host.navigation.openWorkspacePane("markets.filings"),
      available: () => true,
    }),
    navigation.dispose,
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
