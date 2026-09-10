import { useEffect, useMemo, useState } from "react";
import {
  calendarSymbolSupported,
  type MarketEconomicEvent,
  type MarketEarningsCalendarEntry,
} from "../src/calendar.ts";
import type { MarketDataResult } from "../src/types.ts";
import { marketsApi } from "./api.ts";
import {
  buildEconomicCalendarHandoffText,
  buildEarningsCalendarHandoffText,
} from "./calendarContext.ts";
import type { MarketHandoffOption } from "./MarketsSurface.tsx";
import { useMarketWatchlists } from "./watchlistHooks.ts";

const TIME_ZONES = [
  { id: "local", label: "Local", zone: undefined },
  { id: "utc", label: "UTC", zone: "UTC" },
  { id: "new-york", label: "New York", zone: "America/New_York" },
  { id: "london", label: "London", zone: "Europe/London" },
] as const;

type CalendarTab = "economic" | "earnings";
type ImpactFilter = "medium" | "all";

const aborted = (cause: unknown): boolean => cause instanceof DOMException && cause.name === "AbortError";
const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const dateOnly = (value?: string): string => value
  ? new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(new Date(value))
  : "—";

const eps = (value?: number): string => value === undefined
  ? "—"
  : new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);

export default function MarketCalendarSurface({
  active = true,
  handoffOptions = [],
  onOpenResearch,
}: {
  active?: boolean;
  handoffOptions?: readonly MarketHandoffOption[];
  onOpenResearch?: (symbol: string) => void;
}) {
  const [tab, setTab] = useState<CalendarTab>("economic");
  const [impactFilter, setImpactFilter] = useState<ImpactFilter>("medium");
  const [timeZoneId, setTimeZoneId] = useState<(typeof TIME_ZONES)[number]["id"]>("local");
  const [economic, setEconomic] = useState<MarketDataResult<MarketEconomicEvent[]> | null>(null);
  const [earnings, setEarnings] = useState<MarketDataResult<MarketEarningsCalendarEntry[]> | null>(null);
  const [economicLoading, setEconomicLoading] = useState(false);
  const [earningsLoading, setEarningsLoading] = useState(false);
  const [economicError, setEconomicError] = useState<string | null>(null);
  const [earningsError, setEarningsError] = useState<string | null>(null);
  const [economicRefresh, setEconomicRefresh] = useState(0);
  const [earningsRefresh, setEarningsRefresh] = useState(0);
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null);

  const watchlists = useMarketWatchlists(active && tab === "earnings");
  const activeWatchlist = watchlists.data?.items.find((item) => item.id === watchlists.data?.activeId);
  const supportedSymbols = useMemo(
    () => (activeWatchlist?.symbols ?? []).filter(calendarSymbolSupported).slice(0, 100),
    [activeWatchlist],
  );
  const symbolsKey = supportedSymbols.join("\u0000");

  useEffect(() => {
    if (!active || tab !== "economic") return;
    const controller = new AbortController();
    setEconomicLoading(true);
    setEconomicError(null);
    void marketsApi.economicCalendar(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setEconomic(result);
      })
      .catch((cause) => {
        if (!aborted(cause)) setEconomicError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setEconomicLoading(false);
      });
    return () => controller.abort();
  }, [active, tab, economicRefresh]);

  useEffect(() => {
    if (!active || tab !== "earnings") return;
    if (!symbolsKey) {
      setEarnings(null);
      setEarningsError(null);
      return;
    }
    const controller = new AbortController();
    setEarningsLoading(true);
    setEarningsError(null);
    void marketsApi.earningsCalendar(supportedSymbols, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setEarnings(result);
      })
      .catch((cause) => {
        if (!aborted(cause)) setEarningsError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setEarningsLoading(false);
      });
    return () => controller.abort();
  }, [active, tab, symbolsKey, earningsRefresh]);

  const economicEvents = useMemo(() => {
    const events = economic?.data ?? [];
    return impactFilter === "all"
      ? events
      : events.filter((event) => event.impact === "High" || event.impact === "Medium");
  }, [economic, impactFilter]);

  const earningsEntries = useMemo(() => [...(earnings?.data ?? [])].sort((left, right) => {
    if (!left.nextEarningsAt && !right.nextEarningsAt) return left.symbol.localeCompare(right.symbol);
    if (!left.nextEarningsAt) return 1;
    if (!right.nextEarningsAt) return -1;
    return left.nextEarningsAt.localeCompare(right.nextEarningsAt) || left.symbol.localeCompare(right.symbol);
  }), [earnings]);

  const timeZone = TIME_ZONES.find((item) => item.id === timeZoneId)?.zone;
  const eventDate = useMemo(() => new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }), [timeZone]);

  const loading = tab === "economic" ? economicLoading : earningsLoading || watchlists.loading;
  const activeData = tab === "economic" ? economicEvents : earningsEntries;

  const refresh = () => {
    if (tab === "economic") setEconomicRefresh((value) => value + 1);
    else setEarningsRefresh((value) => value + 1);
  };

  const askPolyth = async () => {
    const target = handoffOptions[0];
    if (!target || loading || activeData.length === 0) return;
    setHandoffStatus("Sending…");
    try {
      const text = tab === "economic"
        ? buildEconomicCalendarHandoffText(economicEvents)
        : buildEarningsCalendarHandoffText(earningsEntries);
      await target.send(text);
      setHandoffStatus(`Sent to ${target.label}`);
    } catch (cause) {
      setHandoffStatus(message(cause));
    }
  };

  return (
    <div className="markets-calendar" aria-busy={loading}>
      <header className="markets-calendar-header">
        <div role="tablist" aria-label="Market calendar type">
          <button type="button" role="tab" aria-selected={tab === "economic"} onClick={() => setTab("economic")}>Economic</button>
          <button type="button" role="tab" aria-selected={tab === "earnings"} onClick={() => setTab("earnings")}>Earnings</button>
        </div>
        <div className="markets-calendar-actions">
          <button type="button" disabled={loading} onClick={refresh}>Refresh</button>
          <button type="button" disabled={loading || activeData.length === 0 || handoffOptions.length === 0} onClick={() => void askPolyth()}>Ask Polyth</button>
        </div>
      </header>

      {tab === "economic" ? (
        <>
          <div className="markets-calendar-toolbar">
            <div role="group" aria-label="Economic impact filter">
              <button type="button" aria-pressed={impactFilter === "medium"} onClick={() => setImpactFilter("medium")}>High + medium</button>
              <button type="button" aria-pressed={impactFilter === "all"} onClick={() => setImpactFilter("all")}>All</button>
            </div>
            <label>
              <span>Timezone</span>
              <select value={timeZoneId} onChange={(event) => setTimeZoneId(event.target.value as typeof timeZoneId)}>
                {TIME_ZONES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <span className="markets-calendar-cache">{economic ? `${economic.cache} · ${new Date(economic.cachedAt).toLocaleTimeString()}` : "Weekly schedule"}</span>
          </div>
          {economicError && <div className="markets-calendar-notice" role="status">{economicError}</div>}
          <div className="markets-calendar-table-wrap">
            <table className="markets-calendar-table">
              <thead><tr>
                <th scope="col">Date</th>
                <th scope="col">Ccy</th>
                <th scope="col">Impact</th>
                <th scope="col">Event</th>
                <th scope="col">Forecast</th>
                <th scope="col">Previous</th>
                <th scope="col">Actual</th>
              </tr></thead>
              <tbody>
                {economicEvents.map((event, index) => (
                  <tr key={`${event.date}:${event.currency}:${event.title}:${index}`}>
                    <td>{eventDate.format(new Date(event.date))}</td>
                    <td><strong>{event.currency}</strong></td>
                    <td><span className={`markets-calendar-impact ${event.impact.toLowerCase()}`}>{event.impact}</span></td>
                    <td>{event.title}</td>
                    <td>{event.forecast ?? "—"}</td>
                    <td>{event.previous ?? "—"}</td>
                    <td>{event.actual ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {economicLoading && !economic && <div className="markets-calendar-empty">Loading economic calendar…</div>}
            {!economicLoading && !economicError && economicEvents.length === 0 && <div className="markets-calendar-empty">No events match this filter.</div>}
          </div>
        </>
      ) : (
        <>
          <div className="markets-calendar-toolbar">
            <span>{activeWatchlist ? activeWatchlist.name : "Active watchlist"}</span>
            <span>{supportedSymbols.length} supported US symbols</span>
            <span className="markets-calendar-cache">{earnings ? `${earnings.cache} · ${new Date(earnings.cachedAt).toLocaleTimeString()}` : "Watchlist earnings"}</span>
          </div>
          {watchlists.error && <div className="markets-calendar-notice" role="status">{watchlists.error}</div>}
          {earningsError && <div className="markets-calendar-notice" role="status">{earningsError}</div>}
          <div className="markets-calendar-table-wrap">
            <table className="markets-calendar-table markets-calendar-earnings">
              <thead><tr>
                <th scope="col">Symbol</th>
                <th scope="col">Next earnings</th>
                <th scope="col">Last earnings</th>
                <th scope="col">EPS est.</th>
              </tr></thead>
              <tbody>
                {earningsEntries.map((entry) => (
                  <tr key={entry.symbol}>
                    <th scope="row"><button type="button" onClick={() => onOpenResearch?.(entry.symbol)}>{entry.symbol}</button></th>
                    <td>{dateOnly(entry.nextEarningsAt)}</td>
                    <td>{dateOnly(entry.lastEarningsAt)}</td>
                    <td>{eps(entry.epsForecast)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(earningsLoading || watchlists.loading) && !earnings && <div className="markets-calendar-empty">Loading watchlist earnings…</div>}
            {!loading && !earningsError && supportedSymbols.length === 0 && <div className="markets-calendar-empty">No supported US symbols in the active watchlist.</div>}
            {!loading && supportedSymbols.length > 0 && earningsEntries.length === 0 && <div className="markets-calendar-empty">No earnings calendar data available.</div>}
          </div>
        </>
      )}

      {handoffStatus && <div className="markets-calendar-status" role="status">{handoffStatus}</div>}
    </div>
  );
}
