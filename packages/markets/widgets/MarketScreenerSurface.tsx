import { useEffect, useMemo, useState } from "react";
import type { MarketScreenerDirection, MarketScreenerPage, MarketScreenerQuery, MarketScreenerSort } from "../src/screener.ts";
import { marketsApi } from "./api.ts";
import type { MarketHandoffOption } from "./MarketsSurface.tsx";
import { buildScreenerHandoffText } from "./screenerContext.ts";

const PAGE_SIZE = 50;
const REFRESH_MS = 30_000;

const aborted = (cause: unknown): boolean => cause instanceof DOMException && cause.name === "AbortError";
const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const compact = (value?: number): string => value === undefined ? "—" : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(value);
const decimal = (value?: number): string => value === undefined ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: value < 1 ? 4 : 2 }).format(value);
const percent = (value?: number): string => value === undefined ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

const optionalNumber = (value: string, scale = 1): number | undefined => {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * scale : undefined;
};

export default function MarketScreenerSurface({
  active = true,
  handoffOptions = [],
  onOpen,
}: {
  active?: boolean;
  handoffOptions?: readonly MarketHandoffOption[];
  onOpen?: (symbol: string) => void;
}) {
  const [sector, setSector] = useState("");
  const [changeMin, setChangeMin] = useState("");
  const [marketCapMin, setMarketCapMin] = useState("");
  const [volumeMin, setVolumeMin] = useState("");
  const [sort, setSort] = useState<MarketScreenerSort>("marketCap");
  const [direction, setDirection] = useState<MarketScreenerDirection>("desc");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<MarketScreenerPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null);

  const query = useMemo<MarketScreenerQuery>(() => ({
    ...(sector ? { sector } : {}),
    ...(optionalNumber(changeMin) !== undefined ? { changeMin: optionalNumber(changeMin) } : {}),
    ...(optionalNumber(marketCapMin, 1e9) !== undefined ? { marketCapMin: optionalNumber(marketCapMin, 1e9) } : {}),
    ...(optionalNumber(volumeMin, 1e6) !== undefined ? { volumeMin: optionalNumber(volumeMin, 1e6) } : {}),
    sort,
    direction,
    offset,
    limit: PAGE_SIZE,
  }), [sector, changeMin, marketCapMin, volumeMin, sort, direction, offset]);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let running = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (disposed || running || document.visibilityState === "hidden") return;
      running = true;
      controller?.abort();
      controller = new AbortController();
      setLoading(true);
      setError(null);
      try {
        const result = await marketsApi.screener(query, controller.signal);
        if (!disposed) setPage(result);
      } catch (cause) {
        if (!disposed && !aborted(cause)) setError(message(cause));
      } finally {
        running = false;
        if (!disposed) setLoading(false);
      }
    };
    const initial = window.setTimeout(() => void load(), 180);
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const visible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, queryKey]);

  const reset = () => {
    setSector("");
    setChangeMin("");
    setMarketCapMin("");
    setVolumeMin("");
    setSort("marketCap");
    setDirection("desc");
    setOffset(0);
  };

  const changeSort = (next: MarketScreenerSort) => {
    setOffset(0);
    if (sort === next) setDirection((value) => value === "desc" ? "asc" : "desc");
    else {
      setSort(next);
      setDirection(next === "symbol" ? "asc" : "desc");
    }
  };

  const askPolyth = async () => {
    const target = handoffOptions[0];
    if (!target || !page?.rows.length) return;
    setHandoffStatus("Sending…");
    try {
      await target.send(buildScreenerHandoffText(page, query));
      setHandoffStatus(`Sent to ${target.label}`);
    } catch (cause) {
      setHandoffStatus(message(cause));
    }
  };

  const header = (key: MarketScreenerSort, label: string) => (
    <button type="button" onClick={() => changeSort(key)} aria-label={`Sort by ${label}`}>
      {label}{sort === key ? (direction === "desc" ? " ↓" : " ↑") : ""}
    </button>
  );

  const end = Math.min(offset + PAGE_SIZE, page?.total ?? 0);
  return (
    <div className="markets-screener" aria-busy={loading}>
      <div className="markets-screener-toolbar">
        <label>
          <span>Sector</span>
          <select value={sector} onChange={(event) => { setSector(event.target.value); setOffset(0); }}>
            <option value="">All sectors</option>
            {(page?.sectors ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label>
          <span>Chg% min</span>
          <input inputMode="decimal" placeholder="0" value={changeMin} onChange={(event) => { setChangeMin(event.target.value); setOffset(0); }} />
        </label>
        <label>
          <span>MCap min $B</span>
          <input inputMode="decimal" placeholder="10" value={marketCapMin} onChange={(event) => { setMarketCapMin(event.target.value); setOffset(0); }} />
        </label>
        <label>
          <span>Volume min M</span>
          <input inputMode="decimal" placeholder="1" value={volumeMin} onChange={(event) => { setVolumeMin(event.target.value); setOffset(0); }} />
        </label>
        <div className="markets-screener-actions">
          <button type="button" onClick={reset}>Reset</button>
          <button type="button" disabled={!page?.rows.length || handoffOptions.length === 0} onClick={() => void askPolyth()}>Ask Polyth</button>
        </div>
      </div>

      <div className="markets-screener-meta">
        <span>{loading && !page ? "Loading market…" : page ? `${page.total} results · ${page.cache}` : "US common stocks"}</span>
        {page?.generatedAt && <span>{new Date(page.generatedAt).toLocaleTimeString()}</span>}
      </div>
      {handoffStatus && <div className="markets-screener-status" role="status">{handoffStatus}</div>}
      {error && <div className="markets-screener-notice" role="status">{error}</div>}

      <div className="markets-screener-table-wrap">
        <table className="markets-screener-table">
          <thead><tr>
            <th scope="col">{header("symbol", "Symbol")}</th>
            <th scope="col">Company</th>
            <th scope="col">Sector</th>
            <th scope="col">{header("price", "Last")}</th>
            <th scope="col">{header("changePercent", "Chg%")}</th>
            <th scope="col">{header("volume", "Volume")}</th>
            <th scope="col">{header("marketCap", "MCap")}</th>
          </tr></thead>
          <tbody>
            {(page?.rows ?? []).map((row) => (
              <tr key={`${row.exchange}:${row.symbol}`}>
                <th scope="row"><button type="button" onClick={() => onOpen?.(row.symbol)}>{row.symbol}</button></th>
                <td>{row.name}</td>
                <td>{row.sector}</td>
                <td>{decimal(row.price)}</td>
                <td className={row.changePercent === undefined ? undefined : row.changePercent >= 0 ? "positive" : "negative"}>{percent(row.changePercent)}</td>
                <td>{compact(row.volume)}</td>
                <td>{compact(row.marketCap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !error && page?.rows.length === 0 && <div className="markets-screener-empty">No companies match these filters.</div>}
      </div>

      <div className="markets-screener-pagination">
        <span>{page?.total ? `${offset + 1}–${end} of ${page.total}` : "0 results"}</span>
        <div>
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
          <button type="button" disabled={!page || end >= page.total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
        </div>
      </div>
    </div>
  );
}
