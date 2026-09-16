import { defineWebPackage } from "@polyth/web-sdk";
import marketsEntry from "./index.tsx";

/** Compose the existing Markets UI with project-owned seed metadata. */
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
