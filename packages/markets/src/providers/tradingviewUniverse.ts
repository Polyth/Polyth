import type { MarketUniverseLoader, MarketUniverseRow } from "../screener.ts";
import { createLimiter, fetchJson, finite, record, text, USER_AGENT, valueAt, type FetchLike } from "./http.ts";

export interface TradingViewUniverseOptions {
  fetch?: FetchLike;
  limit?: number;
}

export function createTradingViewUniverseLoader(options: TradingViewUniverseOptions = {}): MarketUniverseLoader {
  const fetchImpl = options.fetch ?? fetch;
  const limit = options.limit ?? 1_500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) throw new Error("TradingView universe limit must be 1-2000");
  const run = createLimiter(1);
  const headers = {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
    Referer: "https://www.tradingview.com/",
    Origin: "https://www.tradingview.com",
  };

  return () => run(async () => {
    const json = await fetchJson(fetchImpl, "https://scanner.tradingview.com/america/scan", {
      method: "POST",
      headers,
      body: JSON.stringify({
        columns: ["description", "close", "change", "market_cap_basic", "sector", "volume", "exchange"],
        filter: [
          { left: "type", operation: "equal", right: "stock" },
          { left: "typespecs", operation: "has", right: ["common"] },
        ],
        sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
        range: [0, limit],
      }),
    }, "tradingview universe");
    const rows = valueAt(json, "data");
    if (!Array.isArray(rows)) throw new Error("tradingview universe: malformed response");

    const universe: MarketUniverseRow[] = rows.flatMap((raw) => {
      const row = record(raw);
      const ticker = text(row?.s);
      const values = Array.isArray(row?.d) ? row.d : undefined;
      if (!ticker || !values) return [];
      const symbol = ticker.split(":")[1];
      if (!symbol) return [];
      const [name, price, changePercent, marketCap, sector, volume, exchange] = values;
      const exchangeText = text(exchange) ?? "";
      if (exchangeText.toUpperCase() === "OTC") return [];
      return [{
        symbol,
        name: text(name) ?? symbol,
        ...(finite(price) !== undefined ? { price: finite(price) } : {}),
        ...(finite(changePercent) !== undefined ? { changePercent: finite(changePercent) } : {}),
        ...(finite(volume) !== undefined ? { volume: finite(volume) } : {}),
        ...(finite(marketCap) !== undefined ? { marketCap: finite(marketCap) } : {}),
        sector: text(sector) ?? "Other",
        exchange: exchangeText,
        source: "tradingview",
      }];
    });
    if (universe.length === 0) throw new Error("tradingview universe: empty response");
    return universe;
  });
}
