import { defineWebPackage } from "@polyth/web-sdk";
import marketsEntry from "./main.tsx";

export * from "./main.tsx";

/** Canonical package entry: compose Markets with project-owned starter
 * metadata while preserving every existing export from the implementation. */
export default defineWebPackage((host) => {
  const installMarkets = marketsEntry(host);
  return () => {
    const disposeMarkets = installMarkets();
    const disposeContext = host.projectContext.register({
      id: "markets.seed",
      order: 30,
      getSnapshot: () => ({
        title: "Markets",
        recommendedWidgetIds: ["markets.overview"],
      }),
    });
    return () => {
      disposeContext();
      disposeMarkets();
    };
  };
});
