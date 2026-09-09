import { useEffect, useMemo, useState } from "react";
import type {
  MarketCandleSeries,
  MarketDataResult,
  MarketFundamentals,
  MarketQuote,
  MarketRange,
  MarketSearchResult,
} from "../src/types.ts";
import { marketsApi } from "./api.ts";
import { buildCloseLine } from "./chart.ts";

const RANGES: readonly MarketRange[] = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"];

const price = (value: number, currency?: string): string => {
  if (!currency) return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: value < 10 ? 2 : 2,
      maximumFractionDigits: value < 1 ? 4 : 2,
    }).format(value);
  } catch {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${currency}`;
  }
};

const compactNumber = (value?: number): string => value === undefined
  ? "—"
  : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(value);

const decimal = (value?: number): string => value === undefined
  ? "—"
  : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

const percent = (value?: number): string => value === undefined
  ? "—"
  : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

const abortError = (cause: unknown): boolean => cause instanceof DOMException && cause.name === "AbortError";

interface MarketsSurfaceProps {
  active?: boolean;
}

export default function MarketsSurface({ active = true }: MarketsSurfaceProps) {
  const [symbol, setSymbol] = useState("SPY");
  const [query, setQuery] = useState("SPY");
  const [range, setRange] = useState<MarketRange>("1M");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<MarketSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [quote, setQuote] = useState<MarketDataResult<MarketQuote> | null>(null);
  const [fundamentals, setFundamentals] = useState<MarketDataResult<MarketFundamentals> | null>(null);
  const [candles, setCandles] = useState<MarketDataResult<MarketCandleSeries> | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [assetLoading, setAssetLoading] = useState(false);
  const [chartLoading, setChartLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!active || !searchOpen || query.trim().length < 2) {
      setSearching(false);
      if (!searchOpen) setSearchResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      void marketsApi.search(query.trim(), controller.signal)
        .then((result) => setSearchResults(result.data.slice(0, 8)))
        .catch((cause) => {
          if (!abortError(cause)) setSearchResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, query, searchOpen]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setAssetLoading(true);
    setAssetError(null);
    void Promise.allSettled([
      marketsApi.quotes([symbol], controller.signal),
      marketsApi.fundamentals(symbol, controller.signal),
    ]).then(([quoteResult, fundamentalsResult]) => {
      if (controller.signal.aborted) return;
      const failures: string[] = [];
      if (quoteResult.status === "fulfilled" && quoteResult.value.items[0]) {
        setQuote(quoteResult.value.items[0]);
      } else {
        setQuote(null);
        failures.push(quoteResult.status === "rejected" ? String(quoteResult.reason) : "Quote unavailable");
      }
      if (fundamentalsResult.status === "fulfilled") {
        setFundamentals(fundamentalsResult.value);
      } else {
        setFundamentals(null);
      }
      setAssetError(failures[0] ?? null);
      setAssetLoading(false);
    });
    return () => controller.abort();
  }, [active, symbol, refresh]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setChartLoading(true);
    setChartError(null);
    void marketsApi.candles(symbol, range, controller.signal)
      .then(setCandles)
      .catch((cause) => {
        if (abortError(cause)) return;
        setCandles(null);
        setChartError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setChartLoading(false);
      });
    return () => controller.abort();
  }, [active, symbol, range, refresh]);

  const line = useMemo(() => buildCloseLine(candles?.data.candles ?? []), [candles]);
  const direction = (quote?.data.changePercent ?? (line ? line.last - line.first : 0)) >= 0 ? "positive" : "negative";

  const selectSymbol = (next: string) => {
    const normalized = next.trim().toUpperCase();
    if (!normalized) return;
    setSymbol(normalized);
    setQuery(normalized);
    setSearchOpen(false);
    setSearchResults([]);
  };

  return (
    <div className="markets-surface" aria-busy={assetLoading || chartLoading}>
      <div className="markets-toolbar">
        <form
          className="markets-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            selectSymbol(searchResults[0]?.symbol ?? query);
          }}
        >
          <div className="markets-search-field">
            <input
              aria-label="Search markets"
              autoComplete="off"
              placeholder="Search symbol or company"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setSearchOpen(false);
              }}
            />
            <button type="submit">Open</button>
            {searchOpen && (searching || searchResults.length > 0) && (
              <div className="markets-search-results" role="listbox" aria-label="Market search results">
                {searching && searchResults.length === 0 && <div className="markets-search-state">Searching…</div>}
                {searchResults.map((result) => (
                  <button
                    key={`${result.exchange ?? ""}:${result.symbol}`}
                    type="button"
                    role="option"
                    aria-selected={result.symbol === symbol}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectSymbol(result.symbol)}
                  >
                    <span className="markets-search-symbol">{result.symbol}</span>
                    <span className="markets-search-name">{result.name}</span>
                    <span className="markets-search-exchange">{result.exchange ?? result.assetType}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </form>
        <button className="markets-refresh" type="button" onClick={() => setRefresh((value) => value + 1)}>
          Refresh
        </button>
      </div>

      <section className="markets-asset" aria-live="polite">
        <div className="markets-asset-heading">
          <div>
            <div className="markets-symbol-row">
              <strong>{symbol}</strong>
              {quote?.data.exchange && <span>{quote.data.exchange}</span>}
            </div>
            <div className="markets-company">{quote?.data.name ?? (assetLoading ? "Loading…" : "Market asset")}</div>
          </div>
          <div className={`markets-price ${direction}`}>
            <strong>{quote ? price(quote.data.price, quote.data.currency) : "—"}</strong>
            <span>{percent(quote?.data.changePercent)}</span>
          </div>
        </div>
        {assetError && <div className="markets-notice" role="status">{assetError}</div>}

        <div className="markets-range" aria-label="Chart range">
          {RANGES.map((item) => (
            <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>
          ))}
        </div>

        <div className={`markets-chart ${direction}`}>
          {line ? (
            <svg viewBox="0 0 1000 260" preserveAspectRatio="none" role="img" aria-label={`${symbol} ${range} price trend`}>
              <path d={line.path} />
            </svg>
          ) : (
            <div className="markets-chart-state">{chartLoading ? "Loading chart…" : chartError ?? "Chart unavailable"}</div>
          )}
          {line && (
            <div className="markets-chart-scale" aria-hidden="true">
              <span>{price(line.maximum, quote?.data.currency)}</span>
              <span>{price(line.minimum, quote?.data.currency)}</span>
            </div>
          )}
        </div>

        <div className="markets-fundamentals">
          <Metric label="Market cap" value={compactNumber(fundamentals?.data.marketCap ?? quote?.data.marketCap)} />
          <Metric label="P/E" value={decimal(fundamentals?.data.pe)} />
          <Metric label="EPS" value={decimal(fundamentals?.data.eps)} />
          <Metric label="Dividend" value={fundamentals?.data.dividendYield === undefined ? "—" : `${(fundamentals.data.dividendYield * 100).toFixed(2)}%`} />
          <Metric label="Beta" value={decimal(fundamentals?.data.beta)} />
          <Metric label="Shares" value={compactNumber(fundamentals?.data.sharesOutstanding)} />
        </div>

        <div className="markets-meta">
          <span>{fundamentals?.data.sector ?? quote?.data.assetType ?? "Market data"}</span>
          <span>{quote ? `${quote.data.source} · ${quote.data.freshness}` : "Sources use fallback providers"}</span>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="markets-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
