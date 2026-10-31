import type { WidgetRenderContext } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { useMarketNews, useMarketWatchlists, useQuoteBatch } from "./watchlistHooks.ts";
import { formatMarketDay, formatMarketPrice, formatPercent } from "./format.ts";
import { freshnessLabel } from "./labels.ts";

const configSymbol = (context: WidgetRenderContext): string => {
  const value = context.config.symbol;
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "SPY";
};

export function MarketAssetWidget({ context, onOpen }: {
  context: WidgetRenderContext;
  onOpen(symbol: string): void;
}) {
  const symbol = configSymbol(context);
  const { quotes, errors, loading } = useQuoteBatch([symbol], !context.editing);
  const quote = quotes.get(symbol)?.data;
  const error = errors.find((item) => item.symbol === symbol)?.message;
  const direction = (quote?.changePercent ?? 0) >= 0 ? "positive" : "negative";

  return (
    <button
      type="button"
      className={`markets-asset-widget ${direction}`}
      disabled={context.editing}
      onClick={() => onOpen(symbol)}
      aria-label={tr("markets.widget.openAssetAria", { symbol })}
    >
      <span className="markets-widget-symbol">{symbol}</span>
      <strong>{quote ? formatMarketPrice(quote.price, quote.currency) : loading ? tr("markets.common.loading") : "—"}</strong>
      <span className="markets-widget-change">{quote ? formatPercent(quote.changePercent) : error ? tr("markets.common.unavailable") : "—"}</span>
      {quote?.source && <small>{quote.source} · {freshnessLabel(quote.freshness)}</small>}
    </button>
  );
}

export function MarketWatchlistWidget({ context, onOpen }: {
  context: WidgetRenderContext;
  onOpen(symbol: string): void;
}) {
  const watchlists = useMarketWatchlists(!context.editing);
  const active = watchlists.data?.items.find((item) => item.id === watchlists.data?.activeId) ?? watchlists.data?.items[0];
  const symbols = active?.symbols.slice(0, 12) ?? [];
  const { quotes, loading } = useQuoteBatch(symbols, !context.editing && symbols.length > 0);

  if (!active && watchlists.loading) return <div className="markets-widget-empty">{tr("markets.widget.loadingWatchlist")}</div>;
  if (watchlists.error && !active) return <div className="markets-widget-empty">{tr("markets.widget.watchlistUnavailable")}</div>;
  if (!active || symbols.length === 0) return <div className="markets-widget-empty">{tr("markets.widget.emptyWatchlist")}</div>;

  return (
    <div className="markets-watchlist-widget">
      {symbols.map((symbol) => {
        const quote = quotes.get(symbol)?.data;
        const direction = (quote?.changePercent ?? 0) >= 0 ? "positive" : "negative";
        return (
          <button key={symbol} type="button" disabled={context.editing} onClick={() => onOpen(symbol)}>
            <span className="markets-widget-symbol">{symbol}</span>
            <strong>{quote ? formatMarketPrice(quote.price, quote.currency) : loading ? "…" : "—"}</strong>
            <span className={direction}>{quote ? formatPercent(quote.changePercent) : "—"}</span>
          </button>
        );
      })}
      {(active.symbols.length > symbols.length) && <small>{tr("markets.widget.moreCount", { count: active.symbols.length - symbols.length })}</small>}
    </div>
  );
}

export function MarketNewsWidget({ context }: { context: WidgetRenderContext }) {
  const symbol = configSymbol(context);
  const news = useMarketNews(symbol, !context.editing);
  const items = news.result?.data.slice(0, 5) ?? [];
  if (news.loading && items.length === 0) return <div className="markets-widget-empty">{tr("markets.widget.loadingNews", { symbol })}</div>;
  if (news.error && items.length === 0) return <div className="markets-widget-empty">{tr("markets.widget.newsUnavailable")}</div>;
  if (items.length === 0) return <div className="markets-widget-empty">{tr("markets.widget.noRecentNews", { symbol })}</div>;
  return (
    <div className="markets-news-widget">
      {items.map((item) => (
        <a key={`${item.source}:${item.url}`} href={item.url} target="_blank" rel="noreferrer">
          <strong>{item.title}</strong>
          <span>{item.publisher}{item.publishedAt ? ` · ${formatMarketDay(item.publishedAt)}` : ""}</span>
        </a>
      ))}
    </div>
  );
}
