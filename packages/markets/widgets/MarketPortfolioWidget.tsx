import { useEffect, useState } from "react";
import type { WidgetRenderContext } from "@polyth/web-sdk";
import type { MarketPortfolioSnapshot } from "../src/portfolio.ts";
import { marketsApi } from "./api.ts";

const REFRESH_MS = 30_000;

const money = (value: number, currency: string): string => {
  if (currency === "UNKNOWN") return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`;
  }
};

export function MarketPortfolioWidget({
  context,
  onOpen,
  onOpenPortfolio,
}: {
  context: WidgetRenderContext;
  onOpen(symbol: string): void;
  onOpenPortfolio(): void;
}) {
  const [snapshot, setSnapshot] = useState<MarketPortfolioSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (context.editing) return;
    let disposed = false;
    let controller: AbortController | null = null;

    const load = async () => {
      if (disposed || document.visibilityState === "hidden") return;
      controller?.abort();
      controller = new AbortController();
      setLoading(true);
      try {
        const next = await marketsApi.portfolioSnapshot(controller.signal);
        if (!disposed) setSnapshot(next);
      } catch {
        if (!disposed) setSnapshot(null);
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
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
  }, [context.editing]);

  if (loading && !snapshot) return <div className="markets-widget-empty">Loading portfolio…</div>;
  if (!snapshot) return <div className="markets-widget-empty">Portfolio unavailable.</div>;
  if (snapshot.positions.length === 0) {
    return (
      <button className="markets-portfolio-widget-empty" type="button" disabled={context.editing} onClick={onOpenPortfolio}>
        Add holdings to build portfolio context.
      </button>
    );
  }

  return (
    <div className="markets-portfolio-widget">
      <button className="markets-portfolio-widget-summary" type="button" disabled={context.editing} onClick={onOpenPortfolio}>
        {snapshot.currencies.slice(0, 2).map((summary) => (
          <span key={summary.currency}>
            <small>{summary.currency}</small>
            <strong>{money(summary.marketValue, summary.currency)}</strong>
          </span>
        ))}
        {snapshot.currencies.length > 2 && <small>+{snapshot.currencies.length - 2} currencies</small>}
      </button>
      <div className="markets-portfolio-widget-positions">
        {snapshot.positions.slice(0, 5).map((position) => (
          <button key={position.holding.symbol} type="button" disabled={context.editing} onClick={() => onOpen(position.holding.symbol)}>
            <span className="markets-widget-symbol">{position.holding.symbol}</span>
            <strong>{position.marketValue === undefined || !position.currency ? "—" : money(position.marketValue, position.currency)}</strong>
            <span className={position.dailyChange === undefined ? undefined : position.dailyChange >= 0 ? "positive" : "negative"}>
              {position.dailyChange === undefined || !position.currency ? "—" : money(position.dailyChange, position.currency)}
            </span>
          </button>
        ))}
      </div>
      {snapshot.positions.length > 5 && <small>+{snapshot.positions.length - 5} more</small>}
    </div>
  );
}
