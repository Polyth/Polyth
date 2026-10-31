import { useEffect, useState, type ReactNode } from "react";
import { createApiTransport, type WidgetRenderContext } from "@polyth/web-sdk";
import { WEATHER_PATH, type WeatherKind, type WeatherReport, type WeatherUnits } from "../src/weather.ts";
import type { GlanceStrings } from "../src/strings.ts";

const transport = createApiTransport();
/** Typing in the settings field waits this long before asking the server. */
const TYPING_DELAY_MS = 700;
/** The server caches a forecast for 15 minutes; asking more often gains nothing. */
const REFRESH_MS = 15 * 60_000;

export const UNIT_CHOICES = ["°C", "°F"] as const;

// ---- icons: one stroked 24px glyph per kind, drawn in currentColor ----------

const CLOUD_HIGH = "M7 15h10a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 6.6 7.6 3.7 3.7 0 0 0 7 15z";
const CLOUD = "M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 10.1 4 4 0 0 0 7 18z";

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg className="glance-weather-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function WeatherIcon({ kind, day }: { kind: WeatherKind; day: boolean }) {
  switch (kind) {
    case "clear":
      return day
        ? <Glyph><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></Glyph>
        : <Glyph><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></Glyph>;
    case "partly":
      return (
        <Glyph>
          {day
            ? <path d="M8 3v1.2M3 8h1.2M4.5 4.5l.9.9M11.5 4.5l-.9.9M5.4 10.6A3.5 3.5 0 0 1 10.8 6" />
            : <path d="M10.5 5.2A4 4 0 0 0 5 10.3" />}
          <path d="M9 20h8a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 8 12.8 3.6 3.6 0 0 0 9 20z" />
        </Glyph>
      );
    case "fog":
      return <Glyph><path d={CLOUD_HIGH} /><path d="M4 18h16M6 21h12" /></Glyph>;
    case "drizzle":
      return <Glyph><path d={CLOUD_HIGH} /><path d="M9 18.5v.5M13 18.5v.5M11 21v.5M15 21v.5" /></Glyph>;
    case "rain":
    case "showers":
      return <Glyph><path d={CLOUD_HIGH} /><path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3" /></Glyph>;
    case "snow":
      return <Glyph><path d={CLOUD_HIGH} /><path d="M9 19h.01M13 19h.01M11 21.5h.01M15 21.5h.01M17 19h.01" strokeWidth={2.4} /></Glyph>;
    case "storm":
      return <Glyph><path d={CLOUD_HIGH} /><path d="M12.5 15.5l-2 3.5h3l-2 3.5" /></Glyph>;
    default:
      return <Glyph><path d={CLOUD} /></Glyph>;
  }
}

const KIND_KEY: Record<WeatherKind, keyof GlanceStrings> = {
  clear: "kindClear",
  partly: "kindPartly",
  cloudy: "kindCloudy",
  fog: "kindFog",
  drizzle: "kindDrizzle",
  rain: "kindRain",
  snow: "kindSnow",
  showers: "kindShowers",
  storm: "kindStorm",
};

// ---- data --------------------------------------------------------------------

type WeatherState =
  | { status: "loading"; report?: WeatherReport }
  | { status: "ready"; report: WeatherReport }
  | { status: "error"; reason: "not-found" | "offline"; report?: WeatherReport };

/** "Home = Lisbon" → a label and the city sent to the server. */
export function splitPlace(text: string): { label: string; city: string } {
  const split = text.indexOf("=");
  if (split <= 0) return { label: "", city: text.trim() };
  return { label: text.slice(0, split).trim(), city: text.slice(split + 1).trim() };
}

function useWeather(city: string, units: WeatherUnits, language: string): WeatherState {
  const [state, setState] = useState<WeatherState>({ status: "loading" });
  useEffect(() => {
    if (!city) return;
    const abort = new AbortController();
    const query = new URLSearchParams({ place: city, units, lang: language.split("-")[0]! });
    const load = () => {
      transport.get<WeatherReport>(`${WEATHER_PATH}?${query}`, { signal: abort.signal })
        .then((report) => setState({ status: "ready", report }))
        .catch((error: unknown) => {
          if (abort.signal.aborted) return;
          const reason = (error as { code?: unknown } | null)?.code === "not-found" ? "not-found" : "offline";
          setState((previous) => ({ status: "error", reason, report: reason === "offline" ? previous.report : undefined }));
        });
    };
    setState((previous) => ({ status: "loading", report: previous.report }));
    const first = setTimeout(load, TYPING_DELAY_MS);
    const refresh = setInterval(load, REFRESH_MS);
    return () => {
      abort.abort();
      clearTimeout(first);
      clearInterval(refresh);
    };
  }, [city, units, language]);
  return state;
}

// ---- view --------------------------------------------------------------------

interface WeatherProps {
  context: WidgetRenderContext;
  strings: GlanceStrings;
  locale: string;
}

const degrees = (locale: string, value: number) => `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)}°`;

function weekday(locale: string, date: string, index: number, strings: GlanceStrings): string {
  if (index === 0) return strings.today;
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export function Weather({ context, strings, locale }: WeatherProps) {
  const { label, city } = splitPlace(typeof context.config.place === "string" ? context.config.place : "");
  const units: WeatherUnits = context.config.units === "°F" ? "f" : "c";
  const state = useWeather(city, units, locale);
  const size = context.panelSize;
  if (!city) return <div className="glance-tile glance-weather-empty">{strings.weatherEmpty}</div>;
  const report = state.report;
  if (!report) {
    const message = state.status === "error" ? (state.reason === "not-found" ? strings.notFound : strings.offline) : "";
    return (
      <div className="glance-tile glance-weather" data-state={state.status}>
        <span className="glance-weather-temp">--°</span>
        <span className="glance-meta">{[label || city, message].filter(Boolean).join(" · ")}</span>
      </div>
    );
  }
  const { now, days } = report;
  const today = days[0];
  const name = label || report.place.name;
  const condition = strings[KIND_KEY[now.kind]];
  const range = today ? `${degrees(locale, today.max)} / ${degrees(locale, today.min)}` : "";
  const wind = new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units === "f" ? "mile-per-hour" : "kilometer-per-hour",
    unitDisplay: "short",
    maximumFractionDigits: 0,
  }).format(now.wind);
  return (
    <div
      className="glance-tile glance-weather"
      data-size={size}
      data-state={state.status}
      title={[report.place.name, report.place.detail].filter(Boolean).join(", ")}
    >
      <div className="glance-weather-now">
        <WeatherIcon kind={now.kind} day={now.isDay} />
        <span className="glance-weather-temp">{degrees(locale, now.temperature)}</span>
        <div className="glance-weather-text">
          <span className="glance-weather-name">{name}</span>
          <span className="glance-meta">
            {size === "compact" ? condition : [condition, range].filter(Boolean).join(" · ")}
          </span>
          {size !== "compact" && (
            <span className="glance-meta glance-weather-details">
              {[
                `${strings.feelsLike} ${degrees(locale, now.feelsLike)}`,
                `${strings.wind} ${wind}`,
                `${strings.humidity} ${Math.round(now.humidity)}%`,
              ].map((item, index) => <span key={index}>{index > 0 && " · "}<span>{item}</span></span>)}
            </span>
          )}
        </div>
      </div>
      {size === "wide" && days.length > 1 && (
        <ol className="glance-weather-days">
          {days.map((day, index) => (
            <li key={day.date} title={strings[KIND_KEY[day.kind]]}>
              <span className="glance-meta">{weekday(locale, day.date, index, strings)}</span>
              <WeatherIcon kind={day.kind} day />
              <span className="glance-weather-range">
                <strong>{degrees(locale, day.max)}</strong> {degrees(locale, day.min)}
              </span>
              <span className="glance-meta">{day.precipitation !== null && day.precipitation >= 10 ? `${Math.round(day.precipitation)}%` : " "}</span>
            </li>
          ))}
        </ol>
      )}
      {state.status === "error" && <span className="glance-meta glance-weather-stale">{strings.offline}</span>}
    </div>
  );
}
