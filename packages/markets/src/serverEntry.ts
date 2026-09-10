import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { MarketCalendarService } from "./calendar.ts";
import { registerDefaultMarketProviders } from "./defaultProviders.ts";
import { loadPortfolio, savePortfolio, snapshotPortfolio } from "./portfolio.ts";
import { createForexFactoryEconomicCalendarLoader } from "./providers/economicCalendar.ts";
import { createTradingViewEarningsCalendarLoader } from "./providers/tradingviewCalendar.ts";
import { createTradingViewUniverseLoader } from "./providers/tradingviewUniverse.ts";
import {
  MarketUniverseService,
  type MarketScreenerDirection,
  type MarketScreenerQuery,
  type MarketScreenerSort,
} from "./screener.ts";
import {
  createMarketsService,
  normalizeQuery,
  normalizeRange,
  normalizeSymbol,
  type MarketsService,
} from "./service.ts";
import { loadWatchlists, saveWatchlists } from "./watchlists.ts";

export const marketsServiceKey = serverServiceKey<MarketsService>("markets");

const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const badRequest = (json: (status: number, value: unknown) => void, message: string): true => {
  json(400, { error: "invalid-input", message });
  return true;
};

const isInvalidInput = (cause: unknown): boolean => (cause as { code?: string })?.code === "invalid-input";

const parseInput = <T>(parse: () => T): { ok: true; value: T } | { ok: false; message: string } => {
  try {
    return { ok: true, value: parse() };
  } catch (cause) {
    return { ok: false, message: errorMessage(cause) };
  }
};

const numberParam = (url: URL, name: string): number | undefined => {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw Object.assign(new Error(`${name} must be finite`), { code: "invalid-input" });
  return value;
};

export function marketsRoutes(
  host: Pick<ServerPackageHost, "spaceStorage">,
  markets: MarketsService,
  universe?: Pick<MarketUniverseService, "screen" | "heatmap">,
  calendar?: Pick<MarketCalendarService, "economic" | "earnings">,
): NonNullable<ServerPackage["routes"]> {
  return async (request) => {
    const { path } = request;
    if (!path.startsWith("/api/markets")) return false;
    const { method, url, body, json, space } = request;

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

    if (path === "/api/markets/calendar/economic") {
      if (!calendar) {
        json(503, { error: "unavailable", message: "economic calendar is unavailable" });
        return true;
      }
      json(200, await calendar.economic());
      return true;
    }

    if (path === "/api/markets/calendar/earnings") {
      if (!calendar) {
        json(503, { error: "unavailable", message: "earnings calendar is unavailable" });
        return true;
      }
      const symbols = (url.searchParams.get("symbols") ?? "")
        .split(",")
        .map((symbol) => symbol.trim())
        .filter(Boolean);
      if (symbols.length === 0) return badRequest(json, "symbols is required");
      try {
        json(200, await calendar.earnings(symbols));
      } catch (cause) {
        if (isInvalidInput(cause)) return badRequest(json, errorMessage(cause));
        throw cause;
      }
      return true;
    }

    if (path === "/api/markets/heatmap") {
      if (!universe) {
        json(503, { error: "unavailable", message: "market heatmap is unavailable" });
        return true;
      }
      try {
        const sector = url.searchParams.get("sector")?.trim();
        const limit = numberParam(url, "limit");
        json(200, await universe.heatmap({
          ...(sector ? { sector } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }));
      } catch (cause) {
        if (isInvalidInput(cause)) return badRequest(json, errorMessage(cause));
        throw cause;
      }
      return true;
    }

    if (path === "/api/markets/screener") {
      if (!universe) {
        json(503, { error: "unavailable", message: "market screener is unavailable" });
        return true;
      }
      try {
        const sector = url.searchParams.get("sector")?.trim();
        const changeMin = numberParam(url, "changeMin");
        const marketCapMin = numberParam(url, "marketCapMin");
        const volumeMin = numberParam(url, "volumeMin");
        const sort = url.searchParams.get("sort");
        const direction = url.searchParams.get("dir");
        const offset = numberParam(url, "offset");
        const limit = numberParam(url, "limit");
        const query: MarketScreenerQuery = {
          ...(sector ? { sector } : {}),
          ...(changeMin !== undefined ? { changeMin } : {}),
          ...(marketCapMin !== undefined ? { marketCapMin } : {}),
          ...(volumeMin !== undefined ? { volumeMin } : {}),
          ...(sort ? { sort: sort as MarketScreenerSort } : {}),
          ...(direction ? { direction: direction as MarketScreenerDirection } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        };
        json(200, await universe.screen(query));
      } catch (cause) {
        if (isInvalidInput(cause)) return badRequest(json, errorMessage(cause));
        throw cause;
      }
      return true;
    }

    if (path === "/api/markets/macro") {
      json(200, await markets.macro());
      return true;
    }

    if (path === "/api/markets/crypto") {
      json(200, await markets.crypto());
      return true;
    }

    if (path === "/api/markets/portfolio/snapshot") {
      const portfolio = await loadPortfolio(host.spaceStorage(space));
      json(200, await snapshotPortfolio(markets, portfolio));
      return true;
    }

    if (path === "/api/markets/quote") {
      const requested = url.searchParams.get("symbols") ?? url.searchParams.get("symbol") ?? "";
      const rawSymbols = requested.split(",").map((symbol) => symbol.trim()).filter(Boolean);
      if (rawSymbols.length === 0) return badRequest(json, "symbols is required");
      if (rawSymbols.length > 50) return badRequest(json, "at most 50 symbols may be requested at once");
      const parsed = parseInput(() => [...new Set(rawSymbols.map(normalizeSymbol))]);
      if (!parsed.ok) return badRequest(json, parsed.message);

      const settled = await Promise.all(parsed.value.map(async (symbol) => {
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
      const rawQuery = url.searchParams.get("q") ?? "";
      if (!rawQuery.trim()) return badRequest(json, "q is required");
      const parsed = parseInput(() => normalizeQuery(rawQuery));
      if (!parsed.ok) return badRequest(json, parsed.message);
      json(200, await markets.search(parsed.value));
      return true;
    }

    if (path === "/api/markets/candles") {
      const rawSymbol = url.searchParams.get("symbol") ?? "";
      if (!rawSymbol.trim()) return badRequest(json, "symbol is required");
      const parsed = parseInput(() => ({
        symbol: normalizeSymbol(rawSymbol),
        range: normalizeRange(url.searchParams.get("range") ?? "6M"),
      }));
      if (!parsed.ok) return badRequest(json, parsed.message);
      json(200, await markets.candles(parsed.value.symbol, parsed.value.range));
      return true;
    }

    if (path === "/api/markets/fundamentals") {
      const rawSymbol = url.searchParams.get("symbol") ?? "";
      if (!rawSymbol.trim()) return badRequest(json, "symbol is required");
      const parsed = parseInput(() => normalizeSymbol(rawSymbol));
      if (!parsed.ok) return badRequest(json, parsed.message);
      json(200, await markets.fundamentals(parsed.value));
      return true;
    }

    if (path === "/api/markets/news") {
      const rawSymbol = url.searchParams.get("symbol") ?? "";
      if (!rawSymbol.trim()) return badRequest(json, "symbol is required");
      const parsed = parseInput(() => normalizeSymbol(rawSymbol));
      if (!parsed.ok) return badRequest(json, parsed.message);
      json(200, await markets.news(parsed.value));
      return true;
    }

    if (path === "/api/markets/earnings") {
      const rawSymbol = url.searchParams.get("symbol") ?? "";
      if (!rawSymbol.trim()) return badRequest(json, "symbol is required");
      const parsed = parseInput(() => normalizeSymbol(rawSymbol));
      if (!parsed.ok) return badRequest(json, parsed.message);
      json(200, await markets.earnings(parsed.value));
      return true;
    }

    if (path === "/api/markets/filings") {
      const rawSymbol = url.searchParams.get("symbol") ?? "";
      if (!rawSymbol.trim()) return badRequest(json, "symbol is required");
      const parsedSymbol = parseInput(() => normalizeSymbol(rawSymbol));
      if (!parsedSymbol.ok) return badRequest(json, parsedSymbol.message);
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
      const result = await markets.filings(parsedSymbol.value);
      json(200, {
        ...result,
        data: result.data.filter((filing) => forms.includes(filing.form.toUpperCase())).slice(0, limit),
      });
      return true;
    }

    if (path === "/api/markets/context") {
      const rawSymbol = url.searchParams.get("symbol") ?? "";
      if (!rawSymbol.trim()) return badRequest(json, "symbol is required");
      const parsed = parseInput(() => ({
        symbol: normalizeSymbol(rawSymbol),
        range: normalizeRange(url.searchParams.get("range") ?? "1M"),
      }));
      if (!parsed.ok) return badRequest(json, parsed.message);
      json(200, await markets.context(parsed.value.symbol, parsed.value.range));
      return true;
    }

    if (path === "/api/markets/compare") {
      const requested = url.searchParams.get("symbols") ?? "";
      const rawSymbols = requested.split(",").map((symbol) => symbol.trim()).filter(Boolean);
      if (rawSymbols.length < 2) return badRequest(json, "comparison requires at least 2 symbols");
      if (rawSymbols.length > 8) return badRequest(json, "comparison supports at most 8 symbols");
      const parsed = parseInput(() => ({
        symbols: [...new Set(rawSymbols.map(normalizeSymbol))],
        range: normalizeRange(url.searchParams.get("range") ?? "1M"),
      }));
      if (!parsed.ok) return badRequest(json, parsed.message);
      if (parsed.value.symbols.length < 2) return badRequest(json, "comparison requires at least 2 unique symbols");
      json(200, await markets.compare(parsed.value.symbols, parsed.value.range));
      return true;
    }

    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const markets = createMarketsService();
  const universe = new MarketUniverseService(createTradingViewUniverseLoader());
  const calendar = new MarketCalendarService(
    createForexFactoryEconomicCalendarLoader(),
    createTradingViewEarningsCalendarLoader(),
  );
  registerDefaultMarketProviders(markets, { secUserAgent: process.env.POLYTH_SEC_USER_AGENT });
  host.services.provide(marketsServiceKey, markets);
  return {
    routes: marketsRoutes(host, markets, universe, calendar),
    remoteAccess: localOnlyRemoteAccess(["markets"]),
  };
}
