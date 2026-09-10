import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { MarketHeatmapCell, MarketHeatmapQuery, MarketHeatmapSector, MarketHeatmapSnapshot } from "../src/heatmap.ts";
import { marketsApi } from "./api.ts";
import type { MarketHandoffOption } from "./MarketsSurface.tsx";
import { buildHeatmapHandoffText } from "./heatmapContext.ts";
import { layoutWeightedRects } from "./heatmapLayout.ts";

const HEATMAP_LIMIT = 250;
const REFRESH_MS = 30_000;
const SECTOR_HEADER_PX = 18;
const GAP_PX = 1;

const aborted = (cause: unknown): boolean => cause instanceof DOMException && cause.name === "AbortError";
const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const percent = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const compact = (value: number): string => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(value);

interface CanvasSize {
  width: number;
  height: number;
}

interface SectorRect {
  sector: MarketHeatmapSector;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CellRect {
  cell: MarketHeatmapCell;
  x: number;
  y: number;
  width: number;
  height: number;
}

function strength(value: number): string {
  const ratio = Math.min(1, Math.abs(value) / 5);
  return `${Math.round(18 + ratio * 64)}%`;
}

function layoutHeatmap(snapshot: MarketHeatmapSnapshot, size: CanvasSize): { sectors: SectorRect[]; cells: CellRect[] } {
  const sectors = layoutWeightedRects(
    snapshot.sectorSummaries.map((sector) => ({ weight: sector.marketCap, data: sector })),
    size.width,
    size.height,
  ).map((rect) => ({ ...rect, sector: rect.data }));
  const bySector = new Map<string, MarketHeatmapCell[]>();
  for (const cell of snapshot.cells) {
    const list = bySector.get(cell.sector) ?? [];
    list.push(cell);
    bySector.set(cell.sector, list);
  }
  const cells: CellRect[] = [];
  for (const sector of sectors) {
    const sectorCells = bySector.get(sector.sector.sector) ?? [];
    const header = sector.height >= 48 ? SECTOR_HEADER_PX : 0;
    const innerWidth = Math.max(0, sector.width - GAP_PX * 2);
    const innerHeight = Math.max(0, sector.height - header - GAP_PX * 2);
    const rects = layoutWeightedRects(
      sectorCells.map((cell) => ({ weight: cell.marketCap, data: cell })),
      innerWidth,
      innerHeight,
    );
    for (const rect of rects) {
      cells.push({
        cell: rect.data,
        x: sector.x + GAP_PX + rect.x,
        y: sector.y + header + GAP_PX + rect.y,
        width: Math.max(0, rect.width - GAP_PX),
        height: Math.max(0, rect.height - GAP_PX),
      });
    }
  }
  return { sectors, cells };
}

export default function MarketHeatmapSurface({
  active = true,
  handoffOptions = [],
  onOpen,
}: {
  active?: boolean;
  handoffOptions?: readonly MarketHandoffOption[];
  onOpen?: (symbol: string) => void;
}) {
  const [sector, setSector] = useState("");
  const [snapshot, setSnapshot] = useState<MarketHeatmapSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null);
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const query = useMemo<MarketHeatmapQuery>(() => ({
    ...(sector ? { sector } : {}),
    limit: HEATMAP_LIMIT,
  }), [sector]);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let running = false;
    let controller: AbortController | null = null;
    setLoading(true);
    const load = async () => {
      if (disposed || running || document.visibilityState === "hidden") return;
      running = true;
      controller = new AbortController();
      setError(null);
      try {
        const result = await marketsApi.heatmap(query, controller.signal);
        if (!disposed) setSnapshot(result);
      } catch (cause) {
        if (!disposed && !aborted(cause)) setError(message(cause));
      } finally {
        running = false;
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
  }, [active, queryKey]);

  const layout = useMemo(
    () => snapshot && size.width > 0 && size.height > 0 ? layoutHeatmap(snapshot, size) : { sectors: [], cells: [] },
    [snapshot, size],
  );

  const askPolyth = async () => {
    const target = handoffOptions[0];
    if (loading || !target || !snapshot?.cells.length) return;
    setHandoffStatus("Sending…");
    try {
      await target.send(buildHeatmapHandoffText(snapshot, query));
      setHandoffStatus(`Sent to ${target.label}`);
    } catch (cause) {
      setHandoffStatus(message(cause));
    }
  };

  return (
    <div className="markets-heatmap" aria-busy={loading}>
      <div className="markets-heatmap-toolbar">
        <label>
          <span>Sector</span>
          <select value={sector} onChange={(event) => setSector(event.target.value)}>
            <option value="">All sectors</option>
            {(snapshot?.sectors ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <div className="markets-heatmap-legend" aria-label="Heatmap legend">
          <span className="negative">−</span>
          <small>Daily move</small>
          <span className="positive">+</span>
        </div>
        <div className="markets-heatmap-actions">
          <button type="button" disabled={!sector} onClick={() => setSector("")}>All sectors</button>
          <button type="button" disabled={loading || !snapshot?.cells.length || handoffOptions.length === 0} onClick={() => void askPolyth()}>Ask Polyth</button>
        </div>
      </div>

      <div className="markets-heatmap-meta">
        <span>{snapshot ? `${snapshot.cells.length} shown · ${snapshot.total} eligible · ${snapshot.cache}` : "US common stocks"}</span>
        <span>Area = market cap</span>
        {snapshot?.generatedAt && <span>{new Date(snapshot.generatedAt).toLocaleTimeString()}</span>}
      </div>
      {handoffStatus && <div className="markets-heatmap-status" role="status">{handoffStatus}</div>}
      {error && <div className="markets-heatmap-notice" role="status">{error}</div>}

      <div className="markets-heatmap-canvas" ref={canvasRef} aria-label="Market sector heatmap">
        {layout.sectors.map((rect) => rect.width >= 64 && rect.height >= 48 ? (
          <button
            key={rect.sector.sector}
            className="markets-heatmap-sector-label"
            type="button"
            disabled={sector === rect.sector.sector}
            onClick={() => setSector(rect.sector.sector)}
            style={{
              left: rect.x + GAP_PX,
              top: rect.y + GAP_PX,
              width: Math.max(0, rect.width - GAP_PX * 2),
              height: SECTOR_HEADER_PX - GAP_PX,
            }}
            title={`${rect.sector.sector}: ${percent(rect.sector.weightedChangePercent)} weighted move`}
          >
            <span>{rect.sector.sector}</span>
            <small>{percent(rect.sector.weightedChangePercent)}</small>
          </button>
        ) : null)}
        {layout.cells.map((rect) => {
          const showSymbol = rect.width >= 38 && rect.height >= 20;
          const showMove = rect.width >= 56 && rect.height >= 34;
          const style = {
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            "--heat-strength": strength(rect.cell.changePercent),
          } as CSSProperties;
          return (
            <button
              key={`${rect.cell.exchange}:${rect.cell.symbol}`}
              className={`markets-heatmap-cell ${rect.cell.changePercent >= 0 ? "positive" : "negative"}`}
              type="button"
              onClick={() => onOpen?.(rect.cell.symbol)}
              style={style}
              aria-label={`${rect.cell.symbol}, ${rect.cell.name}, ${percent(rect.cell.changePercent)}, market cap ${compact(rect.cell.marketCap)}`}
              title={`${rect.cell.symbol} · ${rect.cell.name} · ${percent(rect.cell.changePercent)} · ${compact(rect.cell.marketCap)}`}
            >
              {showSymbol && <strong>{rect.cell.symbol}</strong>}
              {showMove && <span>{percent(rect.cell.changePercent)}</span>}
            </button>
          );
        })}
        {loading && !snapshot && <div className="markets-heatmap-empty">Loading market heatmap…</div>}
        {!loading && !error && snapshot?.cells.length === 0 && <div className="markets-heatmap-empty">No heatmap data available.</div>}
      </div>
    </div>
  );
}
