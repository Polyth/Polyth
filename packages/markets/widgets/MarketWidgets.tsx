import type { WidgetRenderContext } from "@polyth/web-sdk";
import { useMarketWatchlists, useQuoteBatch } from "./watchlistHooks.ts";

const fmtPrice = (value: number, currency?: string): string => {
  try {
    return new Intl.NumberFormat(undefined, {
      ...(currency ? { style: "currency", currency } : {}),
      maximumFractionDigits: value < 1 ? 4 : 2,
    }).format(value);
  } catch {
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
};

const fmtChange = (value?: number): string => value === undefined ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

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
      aria-label={`Open ${symbol} in Markets`}
    >
      <span className="markets-widget-symbol">{symbol}</span>
      <strong>{quote ? fmtPrice(quote.price, quote.currency) : loading ? "Loading…" : "—"}</strong>
      <span className="markets-widget-change">{quote ? fmtChange(quote.changePercent) : error ? "Unavailable" : "—"}</span>
      {quote?.source && <small>{quote.source} · {quote.freshness}</small>}
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

  if (!active && watchlists.loading) return <div className="markets-widget-empty">Loading watchlist…</div>;
  if (watchlists.error && !active) return <div className="markets-widget-empty">Watchlist unavailable</div>;
  if (!active || symbols.length === 0) return <div className="markets-widget-empty">Add assets from Markets to build a watchlist.</div>;

  return (
    <div className="markets-watchlist-widget">
      {symbols.map((symbol) => {
        const quote = quotes.get(symbol)?.data;
        const direction = (quote?.changePercent ?? 0) >= 0 ? "positive" : "negative";
        return (
          <button key={symbol} type="button" disabled={context.editing} onClick={() => onOpen(symbol)}>
            <span className="markets-widget-symbol">{symbol}</span>
            <strong>{quote ? fmtPrice(quote.price, quote.currency) : loading ? "…" : "—"}</strong>
            <span className={direction}>{quote ? fmtChange(quote.changePercent) : "—"}</span>
          </button>
        );
      })}
      {(active.symbols.length > symbols.length) && <small>+{active.symbols.length - symbols.length} more</small>}
    </div>
  );
}
