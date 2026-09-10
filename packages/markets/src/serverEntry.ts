import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { registerDefaultMarketProviders } from "./defaultProviders.ts";
import { loadPortfolio, savePortfolio, snapshotPortfolio } from "./portfolio.ts";
import { createMarketsService, type MarketsService } from "./service.ts";
import type { MarketRange } from "./types.ts";
import { loadWatchlists, saveWatchlists } from "./watchlists.ts";

export const marketsServiceKey = serverServiceKey<MarketsService>("markets");

const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const badRequest = (json: (status: number, value: unknown) => void, message: string): true => {
  json(400, { error: "invalid-input", message });
  return true;
};

const isInvalidInput = (cause: unknown): boolean => (cause as { code?: string })?.code === "invalid-input";

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
          if (isInvalidInput(cause)) return badRequest(json, errorMessage(cause));
          throw cause;
        }
        return true;
      }
      return false;
    }

    if (path === "/api/markets/portfolio") {
      const storage = host.spaceStorage(space);
      if (method === "GET") {
        json(200, await loadPortfolio(storage));
        return true;
      }
      if (method === "PUT") {
        try {
          json(200, await savePortfolio(storage, await body()));
        } catch (cause) {
          if (isInvalidInput(cause)) return badRequest(json, errorMessage(cause));
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

    if (path === "/api/markets/portfolio/snapshot") {
      const portfolio = await loadPortfolio(host.spaceStorage(space));
      json(200, await snapshotPortfolio(markets, portfolio));
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

    if (path === "/api/markets/news") {
      const symbol = url.searchParams.get("symbol") ?? "";
      if (!symbol.trim()) return badRequest(json, "symbol is required");
      json(200, await markets.news(symbol));
      return true;
    }

    if (path === "/api/markets/earnings") {
      const symbol = url.searchParams.get("symbol") ?? "";
      if (!symbol.trim()) return badRequest(json, "symbol is required");
      json(200, await markets.earnings(symbol));
      return true;
    }

    if (path === "/api/markets/filings") {
      const symbol = url.searchParams.get("symbol") ?? "";
      if (!symbol.trim()) return badRequest(json, "symbol is required");
      const forms = [...new Set((url.searchParams.get("forms") ?? "10-K,10-Q,8-K")
        .split(",")
        .map((form) => form.trim().toUpperCase())
        .filter(Boolean))];
      if (forms.length === 0 || forms.length > 12 || forms.some((form) => !/^[A-Z0-9-]{1,12}$/.test(form))) {
        return badRequest(json, "forms must contain 1-12 SEC form names");
      }
      const limit = Number(url.searchParams.get("limit") ?? "12");
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return badRequest(json, "limit must be 1-50");
      if (markets.providers.providerIds("filings").length === 0) {
        json(503, {
          error: "configuration-required",
          message: "SEC filings require POLYTH_SEC_USER_AGENT with a declared application/contact identity.",
        });
        return true;
      }
      const result = await markets.filings(symbol);
      json(200, {
        ...result,
        data: result.data.filter((filing) => forms.includes(filing.form.toUpperCase())).slice(0, limit),
      });
      return true;
    }

    if (path === "/api/markets/context") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const range = url.searchParams.get("range") ?? "1M";
      if (!symbol.trim()) return badRequest(json, "symbol is required");
      json(200, await markets.context(symbol, range as MarketRange));
      return true;
    }

    if (path === "/api/markets/compare") {
      const requested = url.searchParams.get("symbols") ?? "";
      const symbols = [...new Set(requested.split(",").map((symbol) => symbol.trim()).filter(Boolean))];
      const range = url.searchParams.get("range") ?? "1M";
      if (symbols.length < 2) return badRequest(json, "comparison requires at least 2 symbols");
      if (symbols.length > 8) return badRequest(json, "comparison supports at most 8 symbols");
      try {
        json(200, await markets.compare(symbols, range as MarketRange));
      } catch (cause) {
        if (isInvalidInput(cause)) return badRequest(json, errorMessage(cause));
        throw cause;
      }
      return true;
    }

    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const markets = createMarketsService();
  registerDefaultMarketProviders(markets, { secUserAgent: process.env.POLYTH_SEC_USER_AGENT });
  host.services.provide(marketsServiceKey, markets);
  return {
    routes: marketsRoutes(host, markets),
    remoteAccess: localOnlyRemoteAccess(["markets"]),
  };
}
