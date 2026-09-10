import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { calculateMarketTechnicals, type MarketTechnicalSnapshot } from "../src/technicals.ts";
import type { MarketRange } from "../src/types.ts";
import { marketsApi } from "./api.ts";
import type { MarketHandoffOption } from "./MarketsSurface.tsx";
import { getMarketSymbol, subscribeMarketSymbol } from "./selection.ts";
import { buildTechnicalHandoffText } from "./technicalContext.ts";

const RANGES: readonly MarketRange[] = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"];

const aborted = (cause: unknown): boolean => cause instanceof DOMException && cause.name === "AbortError";
const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const number = (value?: number, digits = 2): string => value === undefined
  ? "—"
  : new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
const signed = (value?: number, digits = 2): string => value === undefined
  ? "—"
  : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
const distance = (price?: number, baseline?: number): string => {
  if (price === undefined || baseline === undefined || baseline === 0) return "—";
  const value = ((price - baseline) / baseline) * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
};

function signalLabel(value: string): string {
  return value === "unknown" ? "Not enough data" : value[0]!.toUpperCase() + value.slice(1);
}

export default function MarketTechnicalSurface({
  active = true,
  handoffOptions = [],
  onOpenResearch,
}: {
  active?: boolean;
  handoffOptions?: readonly MarketHandoffOption[];
  onOpenResearch?: (symbol: string) => void;
}) {
  const symbol = useSyncExternalStore(subscribeMarketSymbol, getMarketSymbol);
  const [range, setRange] = useState<MarketRange>("6M");
  const [snapshot, setSnapshot] = useState<MarketTechnicalSnapshot | null>(null);
  const [cacheLabel, setCacheLabel] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void marketsApi.candles(symbol, range, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setSnapshot(calculateMarketTechnicals(result.data));
        setCacheLabel(result.cache);
      })
      .catch((cause) => {
        if (!aborted(cause)) {
          setSnapshot(null);
          setError(message(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, symbol, range, refresh]);

  const latest = snapshot?.latest;
  const cards = useMemo(() => snapshot ? [
    {
      id: "trend",
      label: "Trend",
      value: signalLabel(snapshot.signals.trend),
      detail: `Price vs SMA20 ${distance(latest?.close, latest?.sma20)} · SMA50 ${distance(latest?.close, latest?.sma50)}`,
      tone: snapshot.signals.trend,
    },
    {
      id: "rsi",
      label: "RSI 14",
      value: number(latest?.rsi14),
      detail: signalLabel(snapshot.signals.momentum),
      tone: snapshot.signals.momentum === "oversold" ? "bearish" : snapshot.signals.momentum === "overbought" ? "bullish" : "neutral",
    },
    {
      id: "macd",
      label: "MACD",
      value: signed(latest?.macdHistogram, 3),
      detail: `${signalLabel(snapshot.signals.macd)} histogram · line ${signed(latest?.macd, 3)} · signal ${signed(latest?.macdSignal, 3)}`,
      tone: snapshot.signals.macd,
    },
    {
      id: "bands",
      label: "Bollinger",
      value: signalLabel(snapshot.signals.bollinger),
      detail: `Upper ${number(latest?.bollingerUpper)} · mid ${number(latest?.bollingerMiddle)} · lower ${number(latest?.bollingerLower)}`,
      tone: "neutral",
    },
  ] : [], [snapshot, latest]);

  const askPolyth = async () => {
    const target = handoffOptions[0];
    if (loading || !target || !snapshot) return;
    setHandoffStatus("Sending…");
    try {
      await target.send(buildTechnicalHandoffText(snapshot));
      setHandoffStatus(`Sent to ${target.label}`);
    } catch (cause) {
      setHandoffStatus(message(cause));
    }
  };

  return (
    <div className="markets-technicals" aria-busy={loading}>
      <header className="markets-technicals-header">
        <div>
          <strong>{symbol} technicals</strong>
          <span>Derived locally from the existing candle series.</span>
        </div>
        <div className="markets-technicals-actions">
          <button type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
          <button type="button" onClick={() => onOpenResearch?.(symbol)}>Research</button>
          <button type="button" disabled={loading || !snapshot || handoffOptions.length === 0} onClick={() => void askPolyth()}>Ask Polyth</button>
        </div>
      </header>

      <div className="markets-technicals-ranges" aria-label="Technical analysis range">
        {RANGES.map((item) => (
          <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>
        ))}
      </div>

      <div className="markets-technicals-meta">
        <span>{snapshot ? `${snapshot.points.length} derived points · ${cacheLabel}` : `${range} candle context`}</span>
        {snapshot?.asOf && <span>{new Date(snapshot.asOf).toLocaleString()}</span>}
        {snapshot?.source && <span>{snapshot.source}</span>}
      </div>
      {handoffStatus && <div className="markets-technicals-status" role="status">{handoffStatus}</div>}
      {error && <div className="markets-technicals-notice" role="status">{error}</div>}

      <div className="markets-technicals-body">
        <div className="markets-technicals-signal-grid">
          {cards.map((card) => (
            <div key={card.id} className={`markets-technicals-signal ${card.tone}`}>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <small>{card.detail}</small>
            </div>
          ))}
          {loading && !snapshot && <div className="markets-technicals-empty">Calculating indicators…</div>}
        </div>

        {snapshot && (
          <section className="markets-technicals-metrics">
            <div className="markets-technicals-section-title">
              <strong>Latest values</strong>
              <span>Descriptive, not predictive</span>
            </div>
            <dl>
              <div><dt>Close</dt><dd>{number(latest?.close, latest && latest.close < 1 ? 4 : 2)}</dd></div>
              <div><dt>SMA 20</dt><dd>{number(latest?.sma20)}</dd></div>
              <div><dt>SMA 50</dt><dd>{number(latest?.sma50)}</dd></div>
              <div><dt>EMA 20</dt><dd>{number(latest?.ema20)}</dd></div>
              <div><dt>RSI 14</dt><dd>{number(latest?.rsi14)}</dd></div>
              <div><dt>MACD</dt><dd>{signed(latest?.macd, 3)}</dd></div>
              <div><dt>Signal 9</dt><dd>{signed(latest?.macdSignal, 3)}</dd></div>
              <div><dt>Histogram</dt><dd>{signed(latest?.macdHistogram, 3)}</dd></div>
              <div><dt>BB upper</dt><dd>{number(latest?.bollingerUpper)}</dd></div>
              <div><dt>BB middle</dt><dd>{number(latest?.bollingerMiddle)}</dd></div>
              <div><dt>BB lower</dt><dd>{number(latest?.bollingerLower)}</dd></div>
            </dl>
          </section>
        )}

        {!loading && !error && !snapshot && <div className="markets-technicals-empty">Technical data unavailable.</div>}
      </div>
    </div>
  );
}
