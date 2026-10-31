import { useEffect, useMemo, useState } from "react";
import type { MarketScreenerDirection, MarketScreenerPage, MarketScreenerQuery, MarketScreenerSort } from "../src/screener.ts";
import { marketsApi } from "./api.ts";
import type { MarketHandoffOption } from "./MarketsSurface.tsx";
import { buildScreenerHandoffText } from "./screenerContext.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { formatCompact, formatDecimal, formatMarketTime, formatPercent } from "./format.ts";
import { cacheLabel } from "./labels.ts";

const PAGE_SIZE = 50;
const REFRESH_MS = 30_000;

const aborted = (cause: unknown): boolean => cause instanceof DOMException && cause.name === "AbortError";
const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const compact = (value?: number): string => formatCompact(value);
const decimal = (value?: number): string => formatDecimal(value, 2);
const percent = (value?: number): string => formatPercent(value);

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
    setLoading(true);
    const load = async () => {
      if (disposed || running || document.visibilityState === "hidden") return;
      running = true;
      controller?.abort();
      controller = new AbortController();
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
    if (loading || !target || !page?.rows.length) return;
    setHandoffStatus(tr("markets.common.sending"));
    try {
      await target.send(buildScreenerHandoffText(page, query));
      setHandoffStatus(tr("markets.common.sentTo", { target: target.label }));
    } catch (cause) {
      setHandoffStatus(message(cause));
    }
  };

  const header = (key: MarketScreenerSort, label: string) => (
    <button type="button" onClick={() => changeSort(key)} aria-label={tr("markets.screener.sortBy", { label })}>
      {label}{sort === key ? (direction === "desc" ? " ↓" : " ↑") : ""}
    </button>
  );

  const end = Math.min(offset + PAGE_SIZE, page?.total ?? 0);
  return (
    <div className="markets-screener" aria-busy={loading}>
      <div className="markets-screener-toolbar">
        <label>
          <span>{tr("markets.common.sector")}</span>
          <select value={sector} onChange={(event) => { setSector(event.target.value); setOffset(0); }}>
            <option value="">{tr("markets.common.allSectors")}</option>
            {(page?.sectors ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label>
          <span>{tr("markets.screener.chgMin")}</span>
          <input type="number" step="any" placeholder="0" value={changeMin} onChange={(event) => { setChangeMin(event.target.value); setOffset(0); }} />
        </label>
        <label>
          <span>{tr("markets.screener.mcapMin")}</span>
          <input type="number" min="0" step="any" placeholder="10" value={marketCapMin} onChange={(event) => { setMarketCapMin(event.target.value); setOffset(0); }} />
        </label>
        <label>
          <span>{tr("markets.screener.volumeMin")}</span>
          <input type="number" min="0" step="any" placeholder="1" value={volumeMin} onChange={(event) => { setVolumeMin(event.target.value); setOffset(0); }} />
        </label>
        <div className="markets-screener-actions">
          <button type="button" onClick={reset}>{tr("markets.screener.reset")}</button>
          <button type="button" disabled={loading || !page?.rows.length || handoffOptions.length === 0} onClick={() => void askPolyth()}>{tr("markets.common.askPolyth")}</button>
        </div>
      </div>

      <div className="markets-screener-meta">
        <span>{loading && !page ? tr("markets.screener.loading") : page ? tr("markets.screener.resultsCache", { total: formatDecimal(page.total, 0), cache: cacheLabel(page.cache) }) : tr("markets.screener.usStocks")}</span>
        {page?.generatedAt && <span>{formatMarketTime(page.generatedAt)}</span>}
      </div>
      {handoffStatus && <div className="markets-screener-status" role="status">{handoffStatus}</div>}
      {error && <div className="markets-screener-notice" role="status">{error}</div>}

      <div className="markets-screener-table-wrap">
        <table className="markets-screener-table">
          <thead><tr>
            <th scope="col">{header("symbol", tr("markets.common.symbol"))}</th>
            <th scope="col">{tr("markets.screener.company")}</th>
            <th scope="col">{tr("markets.common.sector")}</th>
            <th scope="col">{header("price", tr("markets.screener.last"))}</th>
            <th scope="col">{header("changePercent", tr("markets.screener.chg"))}</th>
            <th scope="col">{header("volume", tr("markets.screener.volume"))}</th>
            <th scope="col">{header("marketCap", tr("markets.screener.mcap"))}</th>
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
        {!loading && !error && page?.rows.length === 0 && <div className="markets-screener-empty">{tr("markets.screener.noMatches")}</div>}
      </div>

      <div className="markets-screener-pagination">
        <span>{page?.total ? tr("markets.screener.range", { start: formatDecimal(offset + 1, 0), end: formatDecimal(end, 0), total: formatDecimal(page.total, 0) }) : tr("markets.screener.zeroResults")}</span>
        <div>
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{tr("markets.screener.previous")}</button>
          <button type="button" disabled={!page || end >= page.total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>{tr("markets.screener.next")}</button>
        </div>
      </div>
    </div>
  );
}
