import type { MarketEconomicCalendarLoader, MarketEconomicEvent, MarketEconomicImpact } from "../calendar.ts";
import { fetchJson, record, text, type FetchLike } from "./http.ts";

export interface EconomicCalendarOptions {
  fetch?: FetchLike;
}

const IMPACTS = new Set<MarketEconomicImpact>(["Low", "Medium", "High", "Holiday"]);
const clip = (value: string, max: number): string => value.length > max ? value.slice(0, max) : value;

export function createForexFactoryEconomicCalendarLoader(
  options: EconomicCalendarOptions = {},
): MarketEconomicCalendarLoader {
  const fetchImpl = options.fetch ?? fetch;

  return async () => {
    const json = await fetchJson(
      fetchImpl,
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
      {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(5_000),
      },
      "economic calendar",
    );
    if (!Array.isArray(json)) throw new Error("economic calendar: malformed response");

    const events: MarketEconomicEvent[] = [];
    for (const raw of json) {
      const row = record(raw);
      const title = text(row?.title)?.trim();
      const currency = text(row?.country)?.trim().toUpperCase();
      const dateText = text(row?.date)?.trim();
      if (!title || !currency || !dateText) continue;
      const date = new Date(dateText);
      if (Number.isNaN(date.getTime())) continue;
      const rawImpact = text(row?.impact)?.trim();
      const impact = IMPACTS.has(rawImpact as MarketEconomicImpact)
        ? rawImpact as MarketEconomicImpact
        : "Low";
      const forecast = text(row?.forecast)?.trim();
      const previous = text(row?.previous)?.trim();
      const actual = text(row?.actual)?.trim();
      events.push({
        title: clip(title, 160),
        currency: clip(currency, 12),
        date: date.toISOString(),
        impact,
        ...(forecast ? { forecast: clip(forecast, 48) } : {}),
        ...(previous ? { previous: clip(previous, 48) } : {}),
        ...(actual ? { actual: clip(actual, 48) } : {}),
        source: "forex-factory",
      });
    }
    events.sort((left, right) => left.date.localeCompare(right.date));
    if (events.length === 0) throw new Error("economic calendar: empty response");
    return events;
  };
}
