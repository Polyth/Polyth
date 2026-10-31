import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { calculateMarketTechnicals, type MarketTechnicalSnapshot } from "../src/technicals.ts";
import type { MarketRange } from "../src/types.ts";
import { marketsApi } from "./api.ts";
import type { MarketHandoffOption } from "./MarketsSurface.tsx";
import { getMarketSymbol, subscribeMarketSymbol } from "./selection.ts";
import { buildTechnicalHandoffText } from "./technicalContext.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { formatDecimal, formatMarketDateTime, formatPercent, formatSignedNumber } from "./format.ts";
import { cacheLabel as localizedCacheLabel, signalLabel } from "./labels.ts";

const RANGES: readonly MarketRange[] = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"];

const aborted = (cause: unknown): boolean => cause instanceof DOMException && cause.name === "AbortError";
const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const number = (value?: number, digits = 2): string => formatDecimal(value, digits);
const signed = (value?: number, digits = 2): string => formatSignedNumber(value, digits);
const distance = (price?: number, baseline?: number): string => {
  if (price === undefined || baseline === undefined || baseline === 0) return "—";
  return formatPercent(((price - baseline) / baseline) * 100);
};

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
      label: tr("markets.technicals.cardTrend"),
      value: signalLabel(snapshot.signals.trend),
      detail: tr("markets.technicals.trendDetail", { sma20: distance(latest?.close, latest?.sma20), sma50: distance(latest?.close, latest?.sma50) }),
      tone: snapshot.signals.trend,
    },
    {
      id: "rsi",
      label: tr("markets.technicals.cardRsi"),
      value: number(latest?.rsi14),
      detail: signalLabel(snapshot.signals.momentum),
      tone: "neutral",
    },
    {
      id: "macd",
      label: tr("markets.technicals.cardMacd"),
      value: signed(latest?.macdHistogram, 3),
      detail: tr("markets.technicals.macdDetail", { state: signalLabel(snapshot.signals.macd), line: signed(latest?.macd, 3), signal: signed(latest?.macdSignal, 3) }),
      tone: snapshot.signals.macd,
    },
    {
      id: "bands",
      label: tr("markets.technicals.cardBollinger"),
      value: signalLabel(snapshot.signals.bollinger),
      detail: tr("markets.technicals.bandsDetail", { upper: number(latest?.bollingerUpper), middle: number(latest?.bollingerMiddle), lower: number(latest?.bollingerLower) }),
      tone: "neutral",
    },
  ] : [], [snapshot, latest]);

  const askPolyth = async () => {
    const target = handoffOptions[0];
    if (loading || !target || !snapshot) return;
    setHandoffStatus(tr("markets.common.sending"));
    try {
      await target.send(buildTechnicalHandoffText(snapshot));
      setHandoffStatus(tr("markets.common.sentTo", { target: target.label }));
    } catch (cause) {
      setHandoffStatus(message(cause));
    }
  };

  return (
    <div className="markets-technicals" aria-busy={loading}>
      <header className="markets-technicals-header">
        <div>
          <strong className="markets-header-title">{tr("markets.technicals.title", { symbol })}</strong>
          <span className="markets-header-note">{tr("markets.technicals.headerNote")}</span>
        </div>
        <div className="markets-technicals-actions">
          <button type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{tr("markets.common.refresh")}</button>
          <button type="button" onClick={() => onOpenResearch?.(symbol)}>{tr("markets.common.research")}</button>
          <button type="button" disabled={loading || !snapshot || handoffOptions.length === 0} onClick={() => void askPolyth()}>{tr("markets.common.askPolyth")}</button>
        </div>
      </header>

      <div className="markets-technicals-ranges" aria-label={tr("markets.technicals.rangeAria")}>
        {RANGES.map((item) => (
          <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>
        ))}
      </div>

      <div className="markets-technicals-meta">
        <span>{snapshot ? tr("markets.technicals.meta", { count: snapshot.points.length, cache: localizedCacheLabel(cacheLabel) }) : tr("markets.technicals.candleContext", { range })}</span>
        {snapshot?.asOf && <span>{formatMarketDateTime(snapshot.asOf)}</span>}
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
          {loading && !snapshot && <div className="markets-technicals-empty">{tr("markets.technicals.calculating")}</div>}
        </div>

        {snapshot && (
          <section className="markets-technicals-metrics">
            <div className="markets-technicals-section-title">
              <strong>{tr("markets.technicals.latestValues")}</strong>
              <span>{tr("markets.technicals.descriptive")}</span>
            </div>
            <dl>
              <div><dt>{tr("markets.technicals.close")}</dt><dd>{number(latest?.close, latest && latest.close < 1 ? 4 : 2)}</dd></div>
              <div><dt>{tr("markets.technicals.sma20")}</dt><dd>{number(latest?.sma20)}</dd></div>
              <div><dt>{tr("markets.technicals.sma50")}</dt><dd>{number(latest?.sma50)}</dd></div>
              <div><dt>{tr("markets.technicals.ema20")}</dt><dd>{number(latest?.ema20)}</dd></div>
              <div><dt>{tr("markets.technicals.cardRsi")}</dt><dd>{number(latest?.rsi14)}</dd></div>
              <div><dt>{tr("markets.technicals.cardMacd")}</dt><dd>{signed(latest?.macd, 3)}</dd></div>
              <div><dt>{tr("markets.technicals.signal9")}</dt><dd>{signed(latest?.macdSignal, 3)}</dd></div>
              <div><dt>{tr("markets.technicals.histogram")}</dt><dd>{signed(latest?.macdHistogram, 3)}</dd></div>
              <div><dt>{tr("markets.technicals.bbUpper")}</dt><dd>{number(latest?.bollingerUpper)}</dd></div>
              <div><dt>{tr("markets.technicals.bbMiddle")}</dt><dd>{number(latest?.bollingerMiddle)}</dd></div>
              <div><dt>{tr("markets.technicals.bbLower")}</dt><dd>{number(latest?.bollingerLower)}</dd></div>
            </dl>
          </section>
        )}

        {!loading && !error && !snapshot && <div className="markets-technicals-empty">{tr("markets.technicals.unavailable")}</div>}
      </div>
    </div>
  );
}
