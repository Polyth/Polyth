import { useEffect, useState } from "react";
import type { WidgetRenderContext } from "@polyth/web-sdk";
import { parsePlace, parsePlaces, zoneShift, type Place } from "../src/index.ts";
import type { GlanceStrings } from "../src/strings.ts";

export const DEFAULT_PLACES = "London, New York, Tokyo";

/** The current time, re-read on each whole second or minute. */
function useNow(stepMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => { setNow(new Date()); schedule(); }, stepMs - (Date.now() % stepMs) + 20);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [stepMs]);
  return now;
}

function timeText(locale: string, zone: string | undefined, at: Date, seconds = false): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  }).format(at);
}

/** "+7 h · Fri" — omitted pieces for the device's own zone. */
function shiftText(locale: string, zone: string, at: Date): string {
  const { minutes, days } = zoneShift(zone, at);
  const parts: string[] = [];
  if (minutes !== 0) {
    parts.push(new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "hour",
      unitDisplay: "narrow",
      signDisplay: "exceptZero",
      maximumFractionDigits: 2,
    }).format(minutes / 60));
  }
  if (days !== 0) parts.push(new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: "short" }).format(at));
  return parts.join(" · ");
}

interface ClockProps {
  context: WidgetRenderContext;
  strings: GlanceStrings;
  locale: string;
}

export function Clock({ context, strings, locale }: ClockProps) {
  const seconds = context.config.seconds === true;
  const showDate = context.config.date !== false && context.panelSize !== "compact";
  const now = useNow(seconds ? 1_000 : 60_000);
  const place = parsePlace(typeof context.config.place === "string" ? context.config.place : "");
  if (place.zone === null) {
    return (
      <div className="glance-tile glance-clock" data-unknown="true">
        <span className="glance-clock-time">--:--</span>
        <span className="glance-meta">{place.label} · {strings.unknown}</span>
      </div>
    );
  }
  const meta = [
    place.label || strings.local,
    showDate ? new Intl.DateTimeFormat(locale, { timeZone: place.zone, weekday: "short", day: "numeric", month: "short" }).format(now) : "",
    place.zone && context.panelSize !== "compact" ? shiftText(locale, place.zone, now) : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="glance-tile glance-clock">
      <time className="glance-clock-time" dateTime={now.toISOString()}>{timeText(locale, place.zone, now, seconds)}</time>
      <span className="glance-meta">{meta}</span>
    </div>
  );
}

function WorldRow({ place, now, strings, locale }: { place: Place; now: Date; strings: GlanceStrings; locale: string }) {
  const known = place.zone !== null;
  return (
    <li className="glance-world-row" data-unknown={known ? undefined : "true"}>
      <span className="glance-world-name">{place.label}</span>
      <span className="glance-meta">{known ? place.zone && shiftText(locale, place.zone, now) : strings.unknown}</span>
      <span className="glance-world-time">{known ? timeText(locale, place.zone ?? undefined, now) : "--:--"}</span>
    </li>
  );
}

export function WorldClock({ context, strings, locale }: ClockProps) {
  const now = useNow(60_000);
  const places = parsePlaces(typeof context.config.places === "string" ? context.config.places : DEFAULT_PLACES);
  if (places.length === 0) return <div className="glance-tile glance-world-empty">{strings.empty}</div>;
  return (
    <ul className="glance-tile glance-world">
      {places.map((place, index) => <WorldRow key={index} place={place} now={now} strings={strings} locale={locale} />)}
    </ul>
  );
}
