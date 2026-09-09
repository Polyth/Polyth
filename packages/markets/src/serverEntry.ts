import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { registerDefaultMarketProviders } from "./defaultProviders.ts";
import { createMarketsService, type MarketsService } from "./service.ts";
import type { MarketRange } from "./types.ts";
import { loadWatchlists, saveWatchlists } from "./watchlists.ts";

export const marketsServiceKey = serverServiceKey<MarketsService>("markets");

const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const badRequest = (json: (status: number, value: unknown) => void, message: string): true => {
  json(400, { error: "invalid-input", message });
  return true;
};

export function marketsRoutes(
  host: Pick<ServerPackageHost, "spaceStorage">,
  markets: MarketsService,
): NonNullable<ServerPackage["routes"]> {
  return async ({ path, method, url, body, json, space }) => {
    if (!path.startsWith("/api/markets")) return false;

    if (path === "/api/markets/watchlists") {
      const storage = host.spaceStorage(space);
      if (method === "GET") {
        json(200, await loadWatchlists(storage));
        return true;
      }
      if (method === "PUT") {
        try {
          json(200, await saveWatchlists(storage, await body()));
        } catch (cause) {
          if ((cause as { code?: string }).code === "invalid-input") return badRequest(json, errorMessage(cause));
          throw cause;
        }
        return true;
      }
      return false;
    }

    if (method !== "GET") return false;

    if (path === "/api/markets/providers") {
      json(200, { providers: markets.providers.healthSnapshot() });
      return true;
    }

    if (path === "/api/markets/quote") {
      const requested = url.searchParams.get("symbols") ?? url.searchParams.get("symbol") ?? "";
      const symbols = [...new Set(requested.split(",").map((symbol) => symbol.trim()).filter(Boolean))];
      if (symbols.length === 0) return badRequest(json, "symbols is required");
      if (symbols.length > 50) return badRequest(json, "at most 50 symbols may be requested at once");

      const settled = await Promise.all(symbols.map(async (symbol) => {
        try {
          return { ok: true as const, symbol, result: await markets.quote(symbol) };
        } catch (cause) {
          return { ok: false as const, symbol, message: errorMessage(cause) };
        }
      }));
      const items = settled.filter((item) => item.ok).map((item) => item.result);
      const errors = settled.filter((item) => !item.ok).map((item) => ({ symbol: item.symbol, message: item.message }));
      json(items.length === 0 ? 502 : 200, { items, errors });
      return true;
    }

    if (path === "/api/markets/search") {
      const query = url.searchParams.get("q") ?? "";
      if (!query.trim()) return badRequest(json, "q is required");
      json(200, await markets.search(query));
      return true;
    }

    if (path === "/api/markets/candles") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const range = url.searchParams.get("range") ?? "6M";
      if (!symbol.trim()) return badRequest(json, "symbol is required");
      json(200, await markets.candles(symbol, range as MarketRange));
      return true;
    }

    if (path === "/api/markets/fundamentals") {
      const symbol = url.searchParams.get("symbol") ?? "";
      if (!symbol.trim()) return badRequest(json, "symbol is required");
      json(200, await markets.fundamentals(symbol));
      return true;
    }

    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const markets = createMarketsService();
  registerDefaultMarketProviders(markets);
  host.services.provide(marketsServiceKey, markets);
  return {
    routes: marketsRoutes(host, markets),
    remoteAccess: localOnlyRemoteAccess(["markets"]),
  };
}
