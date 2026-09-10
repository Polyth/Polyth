import { useEffect, useMemo, useState } from "react";
import type { MarketComparison, MarketRange } from "../src/types.ts";
import { marketsApi } from "./api.ts";

const RANGES: readonly MarketRange[] = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"];
const MAX_SYMBOLS = 8;

const symbolsFromText = (value: string): string[] => [
  ...new Set(value.split(/[\s,]+/).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)),
];

const compactNumber = (value?: number): string => value === undefined
  ? "—"
  : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(value);

const decimal = (value?: number): string => value === undefined
  ? "—"
  : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

const percent = (value?: number): string => value === undefined
  ? "—"
  : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

const price = (value?: number, currency?: string): string => {
  if (value === undefined) return "—";
  if (!currency) return value.toLocaleString(undefined, { maximumFractionDigits: value < 1 ? 4 : 2 });
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: value < 1 ? 4 : 2,
    }).format(value);
  } catch {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${currency}`;
  }
};

const errorMessage = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const abortError = (cause: unknown): boolean => cause instanceof DOMException && cause.name === "AbortError";

export default function MarketCompareSurface({
  active = true,
  onOpen,
}: {
  active?: boolean;
  onOpen?: (symbol: string) => void;
}) {
  const [symbolsText, setSymbolsText] = useState("AAPL, MSFT, NVDA");
  const [range, setRange] = useState<MarketRange>("1M");
  const [comparison, setComparison] = useState<MarketComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const symbols = useMemo(() => symbolsFromText(symbolsText), [symbolsText]);
  const valid = symbols.length >= 2 && symbols.length <= MAX_SYMBOLS;

  useEffect(() => {
    if (!active || !valid) {
      setLoading(false);
      setComparison(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void marketsApi.compare(symbols, range, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setComparison(result);
        })
        .catch((cause) => {
          if (!abortError(cause)) {
            setComparison(null);
            setError(errorMessage(cause));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 150);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, range, symbols, valid]);

  return (
    <div className="markets-compare" aria-busy={loading}>
      <div className="markets-compare-toolbar">
        <label>
          <span>Symbols</span>
          <input
            aria-describedby="markets-compare-hint"
            autoComplete="off"
            value={symbolsText}
            onChange={(event) => setSymbolsText(event.target.value)}
            placeholder="AAPL, MSFT, NVDA"
          />
        </label>
        <div className="markets-compare-ranges" aria-label="Comparison range">
          {RANGES.map((item) => (
            <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>
              {item}
            </button>
          ))}
        </div>
      </div>

      <div id="markets-compare-hint" className={`markets-compare-hint${valid ? "" : " invalid"}`}>
        {symbols.length < 2
          ? "Enter at least two symbols."
          : symbols.length > MAX_SYMBOLS
            ? `Compare up to ${MAX_SYMBOLS} symbols at once.`
            : `${symbols.length} assets · ${range} performance`}
      </div>

      {error && <div className="markets-compare-notice" role="status">{error}</div>}

      <div className="markets-compare-table-wrap">
        <table className="markets-compare-table">
          <thead>
            <tr>
              <th scope="col">Asset</th>
              <th scope="col">Price</th>
              <th scope="col">{range}</th>
              <th scope="col">Market cap</th>
              <th scope="col">P/E</th>
              <th scope="col">EPS</th>
              <th scope="col">Beta</th>
            </tr>
          </thead>
          <tbody>
            {(comparison?.items ?? []).map((item) => {
              const change = item.performance?.changePercent;
              return (
                <tr key={item.symbol} title={item.errors.length ? item.errors.join("; ") : undefined}>
                  <th scope="row">
                    <button type="button" onClick={() => onOpen?.(item.symbol)}>
                      <strong>{item.symbol}</strong>
                      <span>{item.quote?.name ?? item.fundamentals?.sector ?? "Market asset"}</span>
                    </button>
                    {item.errors.length > 0 && <small aria-label="Some data unavailable">!</small>}
                  </th>
                  <td>{price(item.quote?.price, item.quote?.currency)}</td>
                  <td className={change === undefined ? undefined : change >= 0 ? "positive" : "negative"}>{percent(change)}</td>
                  <td>{compactNumber(item.fundamentals?.marketCap ?? item.quote?.marketCap)}</td>
                  <td>{decimal(item.fundamentals?.pe)}</td>
                  <td>{decimal(item.fundamentals?.eps)}</td>
                  <td>{decimal(item.fundamentals?.beta)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && !comparison && <div className="markets-compare-empty">Loading comparison…</div>}
        {!loading && valid && !comparison && !error && <div className="markets-compare-empty">Comparison unavailable.</div>}
        {!valid && <div className="markets-compare-empty">Add symbols above to compare prices and fundamentals.</div>}
      </div>
    </div>
  );
}
