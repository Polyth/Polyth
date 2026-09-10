import { useEffect, useState } from "react";
import type { MarketDataResult, MarketMacroSnapshot, MarketQuote } from "../src/types.ts";
import { marketsApi } from "./api.ts";
import type { MarketHandoffOption } from "./MarketsSurface.tsx";
import { buildOverviewHandoffText } from "./overviewContext.ts";

const CRYPTO_REFRESH_MS = 15_000;
const MARKET_LABELS: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^IXIC": "Nasdaq Composite",
  "^VIX": "VIX",
};

const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const aborted = (cause: unknown): boolean => cause instanceof DOMException && cause.name === "AbortError";

const number = (value: number, digits = 2): string => new Intl.NumberFormat(undefined, {
  maximumFractionDigits: digits,
}).format(value);

const price = (quote: MarketQuote): string => {
  if (!quote.currency) return number(quote.price, quote.price < 1 ? 4 : 2);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: quote.currency,
      maximumFractionDigits: quote.price < 1 ? 4 : 2,
    }).format(quote.price);
  } catch {
    return `${number(quote.price, quote.price < 1 ? 4 : 2)} ${quote.currency}`;
  }
};

const change = (value?: number): string => value === undefined
  ? "—"
  : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

const macroValue = (value: number, unit: "percent" | "percentage-point"): string =>
  unit === "percentage-point" ? `${value >= 0 ? "+" : ""}${value.toFixed(2)} pp` : `${value.toFixed(2)}%`;

export default function MarketOverviewSurface({
  active = true,
  handoffOptions = [],
  onOpen,
}: {
  active?: boolean;
  handoffOptions?: readonly MarketHandoffOption[];
  onOpen?: (symbol: string) => void;
}) {
  const [macro, setMacro] = useState<MarketMacroSnapshot | null>(null);
  const [crypto, setCrypto] = useState<MarketDataResult<MarketQuote[]> | null>(null);
  const [macroLoading, setMacroLoading] = useState(false);
  const [cryptoLoading, setCryptoLoading] = useState(false);
  const [macroError, setMacroError] = useState<string | null>(null);
  const [cryptoError, setCryptoError] = useState<string | null>(null);
  const [macroRefresh, setMacroRefresh] = useState(0);
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setMacroLoading(true);
    setMacroError(null);
    void marketsApi.macro(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setMacro(result);
      })
      .catch((cause) => {
        if (!aborted(cause)) setMacroError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setMacroLoading(false);
      });
    return () => controller.abort();
  }, [active, macroRefresh]);

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
      setCryptoError(null);
      try {
        const result = await marketsApi.crypto(controller.signal);
        if (!disposed) setCrypto(result);
      } catch (cause) {
        if (!disposed && !aborted(cause)) setCryptoError(errorMessage(cause));
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

  const askPolyth = async () => {
    const target = handoffOptions[0];
    if (!target || (!macro && !crypto)) return;
    setHandoffStatus("Sending…");
    try {
      await target.send(buildOverviewHandoffText(macro, crypto));
      setHandoffStatus(`Sent to ${target.label}`);
    } catch (cause) {
      setHandoffStatus(errorMessage(cause));
    }
  };

  const macroErrors = macro?.errors ?? [];

  return (
    <div className="markets-overview" aria-busy={macroLoading || cryptoLoading}>
      <header className="markets-overview-header">
        <div>
          <strong>Market overview</strong>
          <span>Macro regime, major U.S. indices, and liquid crypto in one glance.</span>
        </div>
        <div className="markets-overview-actions">
          <button type="button" disabled={macroLoading} onClick={() => setMacroRefresh((value) => value + 1)}>Refresh macro</button>
          <button type="button" disabled={handoffOptions.length === 0 || (!macro && !crypto)} onClick={() => void askPolyth()}>Ask Polyth</button>
        </div>
      </header>

      {handoffStatus && <div className="markets-overview-status" role="status">{handoffStatus}</div>}

      <section className="markets-overview-section">
        <div className="markets-overview-section-title">
          <strong>Macro</strong>
          <span>{macro?.generatedAt ? `Snapshot ${new Date(macro.generatedAt).toLocaleString()}` : "FRED + market quotes"}</span>
        </div>
        {macroError && <div className="markets-overview-notice" role="status">{macroError}</div>}
        <div className="markets-overview-macro-grid">
          {(macro?.indicators ?? []).map((indicator) => (
            <div key={indicator.id} className="markets-overview-metric">
              <span>{indicator.label}</span>
              <strong>{macroValue(indicator.value, indicator.unit)}</strong>
              <small>{indicator.asOf} · {indicator.source}</small>
            </div>
          ))}
          {macroLoading && !macro && <div className="markets-overview-empty">Loading macro data…</div>}
          {!macroLoading && !macroError && (macro?.indicators.length ?? 0) === 0 && <div className="markets-overview-empty">No macro indicators available.</div>}
        </div>
      </section>

      <section className="markets-overview-section">
        <div className="markets-overview-section-title">
          <strong>Major markets</strong>
          <span>Price and daily move</span>
        </div>
        <div className="markets-overview-market-grid">
          {(macro?.markets ?? []).map((quote) => (
            <button key={quote.symbol} type="button" onClick={() => onOpen?.(quote.symbol)}>
              <span>{MARKET_LABELS[quote.symbol] ?? quote.name ?? quote.symbol}</span>
              <strong>{price(quote)}</strong>
              <small className={(quote.changePercent ?? 0) >= 0 ? "positive" : "negative"}>{change(quote.changePercent)}</small>
            </button>
          ))}
        </div>
        {macroErrors.length > 0 && <div className="markets-overview-errors">Partial data: {macroErrors.join(" · ")}</div>}
      </section>

      <section className="markets-overview-section markets-overview-crypto-section">
        <div className="markets-overview-section-title">
          <strong>Crypto</strong>
          <span>{crypto ? `${crypto.data.length} Binance pairs · ${crypto.cache}` : "Binance · 15s while visible"}</span>
        </div>
        {cryptoError && <div className="markets-overview-notice" role="status">{cryptoError}</div>}
        <div className="markets-overview-crypto-table" aria-label="Crypto market board">
          {(crypto?.data ?? []).map((quote) => (
            <button key={quote.symbol} type="button" onClick={() => onOpen?.(quote.symbol)}>
              <span><strong>{quote.symbol.split("/")[0]}</strong><small>{quote.name}</small></span>
              <span>{price(quote)}</span>
              <span className={(quote.changePercent ?? 0) >= 0 ? "positive" : "negative"}>{change(quote.changePercent)}</span>
            </button>
          ))}
          {cryptoLoading && !crypto && <div className="markets-overview-empty">Loading crypto board…</div>}
          {!cryptoLoading && !cryptoError && (crypto?.data.length ?? 0) === 0 && <div className="markets-overview-empty">Crypto board unavailable.</div>}
        </div>
      </section>
    </div>
  );
}
