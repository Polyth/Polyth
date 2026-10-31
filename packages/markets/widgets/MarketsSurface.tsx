import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type {
  MarketCandleSeries,
  MarketDataResult,
  MarketFundamentals,
  MarketNewsItem,
  MarketQuote,
  MarketRange,
  MarketSearchResult,
} from "../src/types.ts";
import { marketsApi } from "./api.ts";
import { buildCloseLine } from "./chart.ts";
import { buildMarketHandoffText, researchContextFromSnapshot } from "./context.ts";
import { getMarketSymbol, selectMarketSymbol, subscribeMarketSymbol } from "./selection.ts";
import { useMarketWatchlists } from "./watchlistHooks.ts";
import { isImeComposing } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { formatCompact, formatDecimal, formatMarketDateTime, formatMarketPrice, formatPercent, formatPercentValue } from "./format.ts";
import { assetTypeLabel, freshnessLabel } from "./labels.ts";

const RANGES: readonly MarketRange[] = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"];

const price = (value: number, currency?: string): string => formatMarketPrice(value, currency);
const compactNumber = (value?: number): string => formatCompact(value);
const decimal = (value?: number): string => formatDecimal(value);
const percent = (value?: number): string => formatPercent(value);

const abortError = (cause: unknown): boolean => cause instanceof DOMException && cause.name === "AbortError";
const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

export interface MarketHandoffOption {
  id: string;
  label: string;
  send(text: string): Promise<void>;
}

interface MarketsSurfaceProps {
  active?: boolean;
  handoffOptions?: readonly MarketHandoffOption[];
}

export default function MarketsSurface({ active = true, handoffOptions = [] }: MarketsSurfaceProps) {
  const symbol = useSyncExternalStore(subscribeMarketSymbol, getMarketSymbol);
  const [query, setQuery] = useState(symbol);
  const [range, setRange] = useState<MarketRange>("1M");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<MarketSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [quote, setQuote] = useState<MarketDataResult<MarketQuote> | null>(null);
  const [fundamentals, setFundamentals] = useState<MarketDataResult<MarketFundamentals> | null>(null);
  const [candles, setCandles] = useState<MarketDataResult<MarketCandleSeries> | null>(null);
  const [news, setNews] = useState<MarketDataResult<MarketNewsItem[]> | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [assetLoading, setAssetLoading] = useState(false);
  const [chartLoading, setChartLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const watchlists = useMarketWatchlists(active);

  useEffect(() => setQuery(symbol), [symbol]);

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
      marketsApi.news(symbol, controller.signal),
    ]).then(([quoteResult, fundamentalsResult, newsResult]) => {
      if (controller.signal.aborted) return;
      const failures: string[] = [];
      if (quoteResult.status === "fulfilled" && quoteResult.value.items[0]) {
        setQuote(quoteResult.value.items[0]);
      } else {
        setQuote(null);
        failures.push(quoteResult.status === "rejected" ? errorMessage(quoteResult.reason) : tr("markets.research.quoteUnavailable"));
      }
      setFundamentals(fundamentalsResult.status === "fulfilled" ? fundamentalsResult.value : null);
      setNews(newsResult.status === "fulfilled" ? newsResult.value : null);
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
        setChartError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setChartLoading(false);
      });
    return () => controller.abort();
  }, [active, symbol, range, refresh]);

  const line = useMemo(() => buildCloseLine(candles?.data.candles ?? []), [candles]);
  const direction = (quote?.data.changePercent ?? (line ? line.last - line.first : 0)) >= 0 ? "positive" : "negative";
  const activeWatchlist = watchlists.data?.items.find((item) => item.id === watchlists.data?.activeId) ?? watchlists.data?.items[0];
  const watching = activeWatchlist?.symbols.includes(symbol) ?? false;

  const selectSymbol = (next: string) => {
    const normalized = next.trim().toUpperCase();
    if (!normalized) return;
    selectMarketSymbol(normalized);
    setSearchOpen(false);
    setSearchResults([]);
  };

  const toggleWatch = async () => {
    if (!watchlists.data || !activeWatchlist) return;
    const items = watchlists.data.items.map((item) => item.id !== activeWatchlist.id
      ? item
      : {
          ...item,
          symbols: watching
            ? item.symbols.filter((candidate) => candidate !== symbol)
            : [...item.symbols, symbol],
        });
    await watchlists.save({ ...watchlists.data, items }).catch(() => undefined);
  };

  const sendHandoff = async (option: MarketHandoffOption) => {
    if (handoffBusy) return;
    setHandoffBusy(true);
    setHandoffError(null);
    try {
      let context;
      try {
        context = await marketsApi.context(symbol, range);
      } catch {
        context = researchContextFromSnapshot({
          symbol,
          range,
          ...(quote?.data ? { quote: quote.data } : {}),
          ...(fundamentals?.data ? { fundamentals: fundamentals.data } : {}),
          ...(candles?.data ? { candles: candles.data } : {}),
        });
      }
      await option.send(buildMarketHandoffText(context));
      setHandoffOpen(false);
    } catch (cause) {
      setHandoffError(errorMessage(cause));
    } finally {
      setHandoffBusy(false);
    }
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
              aria-label={tr("markets.research.searchAria")}
              autoComplete="off"
              placeholder={tr("markets.research.searchPlaceholder")}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onKeyDown={(event) => {
                if (isImeComposing(event)) return;
                if (event.key === "Escape") setSearchOpen(false);
              }}
            />
            <button type="submit">{tr("markets.research.open")}</button>
            {searchOpen && (searching || searchResults.length > 0) && (
              <div className="markets-search-results" role="listbox" aria-label={tr("markets.research.resultsAria")}>
                {searching && searchResults.length === 0 && <div className="markets-search-state">{tr("markets.research.searching")}</div>}
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
                    <span className="markets-search-exchange">{result.exchange ?? assetTypeLabel(result.assetType)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </form>
        <div className="markets-toolbar-actions">
          <button
            className="markets-watch-toggle"
            type="button"
            aria-pressed={watching}
            aria-label={tr(watching ? "markets.research.removeFromWatchlistAria" : "markets.research.addToWatchlistAria", { symbol })}
            disabled={!activeWatchlist}
            onClick={() => void toggleWatch()}
          >
            {watching ? "★" : "☆"}
          </button>
          <div className="markets-handoff">
            <button
              className="markets-ask"
              type="button"
              disabled={handoffOptions.length === 0 || handoffBusy}
              title={handoffOptions.length === 0 ? tr("markets.research.handoffDisabled") : undefined}
              aria-expanded={handoffOpen}
              onClick={() => setHandoffOpen((value) => !value)}
            >
              <span aria-hidden="true">↗</span> <span className="markets-ask-label">{tr("markets.common.askPolyth")}</span>
            </button>
            {handoffOpen && handoffOptions.length > 0 && (
              <div className="markets-handoff-menu" role="menu" aria-label={tr("markets.research.handoffMenuAria")}>
                {handoffOptions.map((option) => (
                  <button key={option.id} type="button" role="menuitem" onClick={() => void sendHandoff(option)}>
                    {option.label}
                  </button>
                ))}
                {handoffError && <small className="markets-handoff-error" role="status">{handoffError}</small>}
              </div>
            )}
          </div>
          <button className="markets-refresh" type="button" onClick={() => setRefresh((value) => value + 1)}>
            {tr("markets.common.refresh")}
          </button>
        </div>
      </div>

      <section className="markets-asset" aria-live="polite">
        <div className="markets-asset-heading">
          <div>
            <div className="markets-symbol-row">
              <strong>{symbol}</strong>
              {quote?.data.exchange && <span>{quote.data.exchange}</span>}
            </div>
            <div className="markets-company">{quote?.data.name ?? (assetLoading ? tr("markets.common.loading") : tr("markets.common.marketAsset"))}</div>
          </div>
          <div className={`markets-price ${direction}`}>
            <strong>{quote ? price(quote.data.price, quote.data.currency) : "—"}</strong>
            <span>{percent(quote?.data.changePercent)}</span>
          </div>
        </div>
        {assetError && <div className="markets-notice" role="status">{assetError}</div>}

        <div className="markets-range" aria-label={tr("markets.research.chartRangeAria")}>
          {RANGES.map((item) => (
            <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>
          ))}
        </div>

        <div className={`markets-chart ${direction}`}>
          {line ? (
            <svg viewBox="0 0 1000 260" preserveAspectRatio="none" role="img" aria-label={tr("markets.research.chartTrendAria", { symbol, range })}>
              <path d={line.path} />
            </svg>
          ) : (
            <div className="markets-chart-state">{chartLoading ? tr("markets.research.loadingChart") : chartError ?? tr("markets.research.chartUnavailable")}</div>
          )}
          {line && (
            <div className="markets-chart-scale" aria-hidden="true">
              <span>{price(line.maximum, quote?.data.currency)}</span>
              <span>{price(line.minimum, quote?.data.currency)}</span>
            </div>
          )}
        </div>

        <div className="markets-fundamentals">
          <Metric label={tr("markets.research.marketCap")} value={compactNumber(fundamentals?.data.marketCap ?? quote?.data.marketCap)} />
          <Metric label={tr("markets.research.pe")} value={decimal(fundamentals?.data.pe)} />
          <Metric label={tr("markets.research.eps")} value={decimal(fundamentals?.data.eps)} />
          <Metric label={tr("markets.research.dividend")} value={formatPercentValue(fundamentals?.data.dividendYield === undefined ? undefined : fundamentals.data.dividendYield * 100)} />
          <Metric label={tr("markets.research.beta")} value={decimal(fundamentals?.data.beta)} />
          <Metric label={tr("markets.research.shares")} value={compactNumber(fundamentals?.data.sharesOutstanding)} />
        </div>

        <div className="markets-meta">
          <span>{fundamentals?.data.sector ?? (quote?.data.assetType ? assetTypeLabel(quote.data.assetType) : tr("markets.common.marketData"))}</span>
          <span>{quote ? `${quote.data.source} · ${freshnessLabel(quote.data.freshness)}` : tr("markets.research.sourcesFallback")}</span>
        </div>

        <div className="markets-news">
          <div className="markets-news-header">
            <strong>{tr("markets.research.news")}</strong>
            <span>{news?.data.length ? tr("markets.research.recentCount", { count: news.data.length }) : tr("markets.research.newsSources")}</span>
          </div>
          <div className="markets-news-list">
            {(news?.data ?? []).slice(0, 8).map((item) => (
              <a key={`${item.source}:${item.url}`} href={item.url} target="_blank" rel="noreferrer">
                <strong>{item.title}</strong>
                <span>{item.publisher}{item.publishedAt ? ` · ${formatMarketDateTime(item.publishedAt)}` : ""}</span>
              </a>
            ))}
            {assetLoading && !news && <div className="markets-news-empty">{tr("markets.research.loadingNews")}</div>}
            {!assetLoading && (news?.data.length ?? 0) === 0 && <div className="markets-news-empty">{tr("markets.research.noNews")}</div>}
          </div>
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
