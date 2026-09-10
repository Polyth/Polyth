import "./styles.css";
import "./integration.css";
import "./widgetStyles.css";
import "./news.css";
import "./compare.css";
import { createElement, useEffect, useState } from "react";
import { defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import MarketsSurface, { type MarketHandoffOption } from "./MarketsSurface.tsx";
import MarketCompareSurface from "./MarketCompareSurface.tsx";
import { MarketAssetWidget, MarketNewsWidget, MarketWatchlistWidget } from "./MarketWidgets.tsx";
import { selectMarketSymbol } from "./selection.ts";

function HostedMarketsSurface({ host, active }: { host: WebPackageHost; active?: boolean }) {
  const [snapshot, setSnapshot] = useState(() => host.store.getSnapshot());
  useEffect(() => host.store.subscribe(() => setSnapshot(host.store.getSnapshot())), [host]);

  const handoffOptions: MarketHandoffOption[] = snapshot.activeProjectId
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
  return <MarketsSurface active={active} handoffOptions={handoffOptions} />;
}

export default defineWebPackage((host) => () => {
  const openSymbol = (symbol: string) => {
    selectMarketSymbol(symbol);
    host.navigation.openWorkspacePane("markets");
  };

  const off = [
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
      id: "markets.compare",
      title: "Compare markets",
      description: "Compare price performance and fundamentals across market assets.",
      capabilityId: "markets.compare",
      order: 53,
      component: (props) => createElement(MarketCompareSurface, { active: props?.active, onOpen: openSymbol }),
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
    host.widgets.registerPlugin({
      id: "markets",
      name: "Markets",
      widgets: [
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
      ],
    }),
    host.workbench.profiles.register({
      id: "markets",
      label: "Markets",
      description: "Research markets beside a Polyth session.",
      order: 30,
      defaultLayout: {
        surfaces: [
          { surface: "markets", region: "primary", active: true },
          { surface: "session", region: "end" },
        ],
      },
      presentation: { text: "data" },
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
      id: "markets.compare",
      label: "Compare markets",
      plainDescription: "Compare prices, performance, valuation, and fundamentals across market assets.",
      keywords: ["market", "compare", "stocks", "finance", "performance", "valuation"],
      standardTier: "more",
      standardRank: 23,
      open: () => host.navigation.openWorkspacePane("markets.compare"),
      available: () => true,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
