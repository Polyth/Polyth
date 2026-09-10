import { useEffect, useState } from "react";
import type { WidgetRenderContext } from "@polyth/web-sdk";
import type { MarketDataResult, MarketMacroSnapshot, MarketQuote } from "../src/types.ts";
import { marketsApi } from "./api.ts";

const CRYPTO_REFRESH_MS = 30_000;
const MARKET_LABELS: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^IXIC": "Nasdaq",
  "^VIX": "VIX",
};

const price = (quote: MarketQuote): string => {
  if (quote.assetType === "index") {
    return quote.price.toLocaleString(undefined, { maximumFractionDigits: quote.price < 1 ? 4 : 2 });
  }
  try {
    return quote.currency
      ? new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: quote.currency,
          maximumFractionDigits: quote.price < 1 ? 4 : 2,
        }).format(quote.price)
      : quote.price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  } catch {
    return `${quote.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}${quote.currency ? ` ${quote.currency}` : ""}`;
  }
};

const change = (value?: number): string => value === undefined ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

export function MarketOverviewWidget({
  context,
  onOpenOverview,
  onOpenSymbol,
}: {
  context: WidgetRenderContext;
  onOpenOverview(): void;
  onOpenSymbol(symbol: string): void;
}) {
  const active = !context.editing;
  const [macro, setMacro] = useState<MarketMacroSnapshot | null>(null);
  const [crypto, setCrypto] = useState<MarketDataResult<MarketQuote[]> | null>(null);
  const [macroLoading, setMacroLoading] = useState(false);
  const [cryptoLoading, setCryptoLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setMacroLoading(true);
    void marketsApi.macro(controller.signal)
      .then(setMacro)
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setMacroLoading(false);
      });
    return () => controller.abort();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let running = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (disposed || running || document.visibilityState === "hidden") return;
      running = true;
      controller = new AbortController();
      setCryptoLoading(true);
      try {
        const result = await marketsApi.crypto(controller.signal);
        if (!disposed) setCrypto(result);
      } catch {
        // Keep the last good crypto board; the full overview exposes details.
      } finally {
        running = false;
        if (!disposed) setCryptoLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), CRYPTO_REFRESH_MS);
    const visible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active]);

  const markets = macro?.markets ?? [];
  const coins = (crypto?.data ?? []).slice(0, 3);
  if ((macroLoading || cryptoLoading) && markets.length === 0 && coins.length === 0) {
    return <div className="markets-widget-empty">Loading market overview…</div>;
  }

  return (
    <div className="markets-overview-widget">
      <button className="markets-overview-widget-title" type="button" disabled={context.editing} onClick={onOpenOverview}>
        <strong>Market overview</strong>
        <span>Open</span>
      </button>
      <div className="markets-overview-widget-grid">
        {markets.slice(0, 3).map((quote) => (
          <button key={quote.symbol} type="button" disabled={context.editing} onClick={() => onOpenSymbol(quote.symbol)}>
            <span>{MARKET_LABELS[quote.symbol] ?? quote.symbol}</span>
            <strong>{price(quote)}</strong>
            <small className={(quote.changePercent ?? 0) >= 0 ? "positive" : "negative"}>{change(quote.changePercent)}</small>
          </button>
        ))}
        {coins.map((quote) => (
          <button key={quote.symbol} type="button" disabled={context.editing} onClick={() => onOpenSymbol(quote.symbol)}>
            <span>{quote.symbol.split("/")[0]}</span>
            <strong>{price(quote)}</strong>
            <small className={(quote.changePercent ?? 0) >= 0 ? "positive" : "negative"}>{change(quote.changePercent)}</small>
          </button>
        ))}
      </div>
      {markets.length === 0 && coins.length === 0 && <div className="markets-widget-empty">Overview unavailable.</div>}
    </div>
  );
}
