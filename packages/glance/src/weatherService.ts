// Server side of the weather tile: one bounded GET per Open-Meteo call, each
// checked with @polyth/outbound `public-only` and connected through a socket
// pinned to the validated address. Answers are cached per Space (a city a
// Space looked up is that Space's business), briefly and with a size cap.
import { pinnedHttpRequest, resolvePublicHttpsUrl, type PinnedHttpRequest, type PinnedHttpResult, type Resolver } from "@polyth/outbound";
import {
  FORECAST_DAYS,
  parseForecast,
  parseGeocoding,
  type GeocodedPlace,
  type WeatherReport,
  type WeatherUnits,
} from "./weather.ts";

const GEOCODING = "https://geocoding-api.open-meteo.com";
const FORECAST = "https://api.open-meteo.com";
const ORIGINS = [GEOCODING, FORECAST];
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1024;
const PLACE_TTL_MS = 24 * 60 * 60_000;
const FORECAST_TTL_MS = 15 * 60_000;
const CACHE_LIMIT = 256;

export type WeatherTransport = (url: URL, pin: { address: string; family: 4 | 6 }, init: PinnedHttpRequest) => Promise<PinnedHttpResult>;

export interface WeatherServiceOptions {
  transport?: WeatherTransport;
  resolve?: Resolver;
  now?: () => number;
}

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** A tiny TTL map that also shares one in-flight read per key. */
function ttlCache<T>(ttlMs: number, now: () => number) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    entries.delete(key);
    const value = load();
    entries.set(key, { at: now(), value });
    value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key); });
    while (entries.size > CACHE_LIMIT) entries.delete(entries.keys().next().value!);
    return value;
  };
}

export function createWeatherService(options: WeatherServiceOptions = {}) {
  const transport = options.transport ?? pinnedHttpRequest;
  const now = options.now ?? Date.now;
  const places = ttlCache<GeocodedPlace | null>(PLACE_TTL_MS, now);
  const forecasts = ttlCache<WeatherReport>(FORECAST_TTL_MS, now);

  async function getJson(raw: string): Promise<unknown> {
    let result: PinnedHttpResult;
    try {
      const { url, pin } = await resolvePublicHttpsUrl(raw, ORIGINS, options.resolve);
      result = await transport(url, pin, {
        headers: { accept: "application/json", "user-agent": "Polyth/1.0 (+https://polyth.app)" },
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_BYTES,
      });
    } catch {
      throw fail("unavailable", "Open-Meteo could not be reached");
    }
    if (result.status !== 200) throw fail("unavailable", `Open-Meteo answered HTTP ${result.status}`);
    try {
      return JSON.parse(result.body.toString("utf8"));
    } catch {
      throw fail("unavailable", "Open-Meteo sent an unreadable answer");
    }
  }

  const geocode = (place: string, language: string): Promise<GeocodedPlace | null> => {
    const url = new URL("/v1/search", GEOCODING);
    url.search = new URLSearchParams({ name: place, count: "1", language, format: "json" }).toString();
    return getJson(url.href).then(parseGeocoding);
  };

  async function forecast(place: GeocodedPlace, units: WeatherUnits): Promise<WeatherReport> {
    const url = new URL("/v1/forecast", FORECAST);
    url.search = new URLSearchParams({
      latitude: place.latitude.toFixed(3),
      longitude: place.longitude.toFixed(3),
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      timezone: "auto",
      forecast_days: String(FORECAST_DAYS),
      temperature_unit: units === "f" ? "fahrenheit" : "celsius",
      wind_speed_unit: units === "f" ? "mph" : "kmh",
    }).toString();
    const parsed = parseForecast(await getJson(url.href));
    if (!parsed) throw fail("unavailable", "Open-Meteo sent no current weather");
    return {
      place: { name: place.name, detail: place.detail, timezone: place.timezone || parsed.timezone },
      units,
      now: parsed.now,
      days: parsed.days,
      fetchedAt: new Date(now()).toISOString(),
    };
  }

  return {
    /** The weather for a named place, as `spaceId` sees it. */
    async report(spaceId: string, input: { place: string; units: WeatherUnits; language: string }): Promise<WeatherReport> {
      const placeKey = `${spaceId}\n${input.language}\n${input.place.toLowerCase()}`;
      const place = await places(placeKey, () => geocode(input.place, input.language));
      if (!place) throw fail("not-found", "No place by that name");
      const key = `${spaceId}\n${place.latitude.toFixed(3)},${place.longitude.toFixed(3)}\n${input.units}\n${place.name}`;
      return forecasts(key, () => forecast(place, input.units));
    },
  };
}

export type WeatherService = ReturnType<typeof createWeatherService>;
