import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import MarketsSurface from "./MarketsSurface.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({
      id: "markets",
      title: "Markets",
      description: "Research prices, charts, fundamentals, and market context.",
      capabilityId: "markets",
      order: 52,
      component: (props) => createElement(MarketsSurface, props),
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
    host.capabilities.register({
      id: "markets",
      label: "Markets",
      plainDescription: "Research stocks, ETFs, and market data.",
      keywords: ["market", "stocks", "finance", "quote", "investing", "research"],
      standardTier: "more",
      standardRank: 22,
      open: () => host.navigation.openWorkspacePane("markets"),
      available: () => true,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
