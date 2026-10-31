import test from "node:test";
import assert from "node:assert/strict";
import type { RouteRequest } from "@polyth/contracts";
import { glanceRoutes } from "../src/serverEntry.ts";
import { parseForecast, parseGeocoding, parseWeatherQuery, weatherKind } from "../src/weather.ts";
import { createWeatherService, type WeatherTransport } from "../src/weatherService.ts";

const GEOCODE = {
  results: [{ name: "Kyiv", latitude: 50.45466, longitude: 30.5238, country: "Ukraine", admin1: "Kyiv City", timezone: "Europe/Kyiv" }],
};
const FORECAST = {
  timezone: "Europe/Kyiv",
  current: { temperature_2m: 7.4, apparent_temperature: 4.9, relative_humidity_2m: 81, weather_code: 3, is_day: 1, wind_speed_10m: 13.2 },
  daily: {
    time: ["2026-10-30", "2026-10-31", "bad", "2026-11-02"],
    weather_code: [3, 61, 0, 95],
    temperature_2m_max: [9.1, 8, 5, 6],
    temperature_2m_min: [3.2, 2, 1, 0],
    precipitation_probability_max: [10, 80, 0, null],
  },
};

/** A fake Open-Meteo: every request is recorded; DNS resolves to a public IP. */
function fakeOpenMeteo(answers: { geocode?: unknown; forecast?: unknown; status?: number } = {}) {
  const calls: URL[] = [];
  const transport: WeatherTransport = async (url) => {
    calls.push(url);
    const body = url.hostname.startsWith("geocoding") ? answers.geocode ?? GEOCODE : answers.forecast ?? FORECAST;
    return { status: answers.status ?? 200, headers: new Headers(), body: Buffer.from(JSON.stringify(body)) };
  };
  return { calls, transport, resolve: async () => ["93.184.216.34"] };
}

test("WMO codes group into the kinds the tile draws", () => {
  assert.deepEqual([0, 1, 2, 3, 45, 53, 63, 66, 73, 86, 81, 96, 1234].map(weatherKind),
    ["clear", "clear", "partly", "cloudy", "fog", "drizzle", "rain", "rain", "snow", "snow", "showers", "storm", "cloudy"]);
});

test("Open-Meteo answers parse into a place, the current reading and valid days", () => {
  assert.deepEqual(parseGeocoding(GEOCODE), {
    name: "Kyiv", detail: "Kyiv City, Ukraine", timezone: "Europe/Kyiv", latitude: 50.45466, longitude: 30.5238,
  });
  assert.equal(parseGeocoding({}), null);
  assert.equal(parseGeocoding({ results: [{ name: "Nowhere" }] }), null);
  const parsed = parseForecast(FORECAST)!;
  assert.deepEqual(parsed.now, { temperature: 7.4, feelsLike: 4.9, humidity: 81, wind: 13.2, kind: "cloudy", isDay: true });
  assert.deepEqual(parsed.days.map((day) => [day.date, day.kind, day.precipitation]),
    [["2026-10-30", "cloudy", 10], ["2026-10-31", "rain", 80], ["2026-11-02", "storm", null]]);
  assert.equal(parseForecast({ current: { temperature_2m: "warm" } }), null);
});

test("the query needs a short place; units and language fall back safely", () => {
  assert.deepEqual(parseWeatherQuery(new URLSearchParams("place=%20new%20%20york&units=f&lang=uk")), { place: "new york", units: "f", language: "uk" });
  assert.deepEqual(parseWeatherQuery(new URLSearchParams("place=Kyiv&units=kelvin&lang=../x")), { place: "Kyiv", units: "c", language: "en" });
  assert.throws(() => parseWeatherQuery(new URLSearchParams("place=")), { code: "invalid-input" });
  assert.throws(() => parseWeatherQuery(new URLSearchParams(`place=${"a".repeat(81)}`)), { code: "invalid-input" });
});

test("a report reaches only Open-Meteo, asks for the chosen units and is cached per Space", async () => {
  const net = fakeOpenMeteo();
  let clock = Date.parse("2026-10-30T10:00:00Z");
  const weather = createWeatherService({ transport: net.transport, resolve: net.resolve, now: () => clock });
  const report = await weather.report("space-a", { place: "Kyiv", units: "f", language: "uk" });
  assert.equal(report.place.name, "Kyiv");
  assert.equal(report.units, "f");
  assert.equal(report.days.length, 3);
  assert.deepEqual(net.calls.map((url) => url.origin), ["https://geocoding-api.open-meteo.com", "https://api.open-meteo.com"]);
  assert.equal(net.calls[0]!.searchParams.get("language"), "uk");
  assert.equal(net.calls[1]!.searchParams.get("temperature_unit"), "fahrenheit");
  assert.equal(net.calls[1]!.searchParams.get("wind_speed_unit"), "mph");

  await weather.report("space-a", { place: "kyiv", units: "f", language: "uk" });
  assert.equal(net.calls.length, 2, "same Space, same place: served from cache");
  await weather.report("space-b", { place: "Kyiv", units: "f", language: "uk" });
  assert.equal(net.calls.length, 4, "another Space does not see the first Space's lookups");

  clock += 16 * 60_000;
  await weather.report("space-a", { place: "Kyiv", units: "f", language: "uk" });
  assert.deepEqual(net.calls.slice(4).map((url) => url.hostname), ["api.open-meteo.com"], "a stale forecast refetches; the place stays cached");
});

test("an unknown place is not-found and an upstream failure is a calm unavailable", async () => {
  const empty = fakeOpenMeteo({ geocode: { results: [] } });
  await assert.rejects(createWeatherService(empty).report("s", { place: "Atlantis", units: "c", language: "en" }), { code: "not-found" });
  const down = fakeOpenMeteo({ status: 502 });
  await assert.rejects(createWeatherService(down).report("s", { place: "Kyiv", units: "c", language: "en" }), { code: "unavailable" });
  const privateDns = { ...fakeOpenMeteo(), resolve: async () => ["10.0.0.5"] };
  await assert.rejects(createWeatherService(privateDns).report("s", { place: "Kyiv", units: "c", language: "en" }), { code: "unavailable" });
  assert.equal(privateDns.calls.length, 0, "a private address is never connected to");
});

test("the route answers GET /api/glance/weather with the Space from the gateway", async () => {
  const seen: string[] = [];
  const route = glanceRoutes({
    report: async (spaceId, input) => {
      seen.push(`${spaceId}:${input.place}:${input.units}`);
      return { place: { name: input.place, detail: "", timezone: "" } } as never;
    },
  });
  let answer: unknown;
  const request = (method: string, path: string) => ({
    method,
    path: new URL(path, "http://local").pathname,
    url: new URL(path, "http://local"),
    space: { spaceId: "space-a" },
    json: (_code: number, body: unknown) => { answer = body; },
  }) as unknown as RouteRequest;
  assert.equal(await route(request("GET", "/api/glance/weather?place=Lisbon&units=c&spaceId=space-b")), true);
  assert.deepEqual(seen, ["space-a:Lisbon:c"]);
  assert.deepEqual(answer, { place: { name: "Lisbon", detail: "", timezone: "" } });
  assert.equal(await route(request("POST", "/api/glance/weather?place=Lisbon")), false);
  assert.equal(await route(request("GET", "/api/glance/other")), false);
});
