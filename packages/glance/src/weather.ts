// Weather data for the Glance tile: the request the widget sends, the report
// the server answers with, and the pure Open-Meteo parsing between them.
// Browser-safe; the network side lives in `weatherService.ts`.

export const WEATHER_PATH = "/api/glance/weather";
export const MAX_PLACE_LENGTH = 80;
export const FORECAST_DAYS = 5;

export type WeatherUnits = "c" | "f";

/** WMO weather codes grouped into what the tile draws and names. */
export type WeatherKind =
  | "clear"
  | "partly"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "showers"
  | "storm";

export interface WeatherPlace {
  name: string;
  /** Region and country, e.g. "Kyiv City, Ukraine"; empty when unknown. */
  detail: string;
  timezone: string;
}

export interface WeatherNow {
  temperature: number;
  feelsLike: number;
  humidity: number;
  /** km/h for `c`, mph for `f`. */
  wind: number;
  kind: WeatherKind;
  isDay: boolean;
}

export interface WeatherDay {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  kind: WeatherKind;
  max: number;
  min: number;
  /** Highest chance of precipitation that day, 0–100; null when unknown. */
  precipitation: number | null;
}

export interface WeatherReport {
  place: WeatherPlace;
  units: WeatherUnits;
  now: WeatherNow;
  days: WeatherDay[];
  /** When the server read Open-Meteo (ISO). */
  fetchedAt: string;
}

/** WMO code (Open-Meteo `weather_code`) → kind. Unknown codes read as cloudy. */
export function weatherKind(code: number): WeatherKind {
  if (code === 0 || code === 1) return "clear";
  if (code === 2) return "partly";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 80 && code <= 82) return "showers";
  if (code >= 95 && code <= 99) return "storm";
  return "cloudy";
}

/** The `place` and `units` query of a weather request, validated. */
export function parseWeatherQuery(params: URLSearchParams): { place: string; units: WeatherUnits; language: string } {
  const place = (params.get("place") ?? "").trim().replace(/\s+/g, " ");
  if (!place || place.length > MAX_PLACE_LENGTH) {
    throw Object.assign(new Error("Name a city of up to 80 characters"), { code: "invalid-input" });
  }
  const units: WeatherUnits = params.get("units") === "f" ? "f" : "c";
  const language = /^[a-z]{2}$/.test(params.get("lang") ?? "") ? params.get("lang")! : "en";
  return { place, units, language };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value: unknown): string => typeof value === "string" ? value.trim().slice(0, 120) : "";

export interface GeocodedPlace extends WeatherPlace {
  latitude: number;
  longitude: number;
}

/** The first usable hit of Open-Meteo's geocoding search, or null. */
export function parseGeocoding(body: unknown): GeocodedPlace | null {
  const results = record(body)?.results;
  if (!Array.isArray(results)) return null;
  for (const item of results) {
    const hit = record(item);
    const latitude = finite(hit?.latitude);
    const longitude = finite(hit?.longitude);
    const name = text(hit?.name);
    if (!hit || latitude === null || longitude === null || !name) continue;
    const detail = [text(hit.admin1), text(hit.country)].filter((part, index, all) => part && part !== name && all.indexOf(part) === index);
    return { name, detail: detail.join(", "), timezone: text(hit.timezone), latitude, longitude };
  }
  return null;
}

/** Open-Meteo's forecast answer → the tile's current reading and days.
 *  Null when the current block is missing or malformed. */
export function parseForecast(body: unknown): { now: WeatherNow; days: WeatherDay[]; timezone: string } | null {
  const root = record(body);
  const current = record(root?.current);
  const temperature = finite(current?.temperature_2m);
  const code = finite(current?.weather_code);
  if (!current || temperature === null || code === null) return null;
  const now: WeatherNow = {
    temperature,
    feelsLike: finite(current.apparent_temperature) ?? temperature,
    humidity: finite(current.relative_humidity_2m) ?? 0,
    wind: finite(current.wind_speed_10m) ?? 0,
    kind: weatherKind(code),
    isDay: current.is_day !== 0,
  };
  const daily = record(root?.daily);
  const dates = Array.isArray(daily?.time) ? daily.time : [];
  const column = (key: string): unknown[] => Array.isArray(daily?.[key]) ? daily[key] as unknown[] : [];
  const codes = column("weather_code");
  const maxes = column("temperature_2m_max");
  const mins = column("temperature_2m_min");
  const rain = column("precipitation_probability_max");
  const days: WeatherDay[] = [];
  for (let index = 0; index < Math.min(dates.length, FORECAST_DAYS); index += 1) {
    const date = text(dates[index]);
    const max = finite(maxes[index]);
    const min = finite(mins[index]);
    const dayCode = finite(codes[index]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || max === null || min === null || dayCode === null) continue;
    days.push({ date, kind: weatherKind(dayCode), max, min, precipitation: finite(rain[index]) });
  }
  return { now, days, timezone: text(root?.timezone) };
}
