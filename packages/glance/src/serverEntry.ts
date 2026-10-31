import type { RouteHandler } from "@polyth/contracts";
import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { parseWeatherQuery, WEATHER_PATH } from "./weather.ts";
import { createWeatherService, type WeatherService } from "./weatherService.ts";

/** `GET /api/glance/weather?place=&units=c|f&lang=` — the weather tile's
 *  read. Open-Meteo is the only origin it reaches; no key, no stored state. */
export function glanceRoutes(weather: WeatherService): RouteHandler {
  return async (rc) => {
    if (rc.path !== WEATHER_PATH || rc.method !== "GET") return false;
    const report = await weather.report(rc.space.spaceId, parseWeatherQuery(rc.url.searchParams));
    rc.json(200, report);
    return true;
  };
}

// The clocks are web-only; the server owns the weather read. Paired devices
// stay out (default-deny), like the other local-only package routes.
export default function registerPackage(_host: ServerPackageHost): ServerPackage {
  return {
    remoteAccess: localOnlyRemoteAccess(["glance"]),
    routes: glanceRoutes(createWeatherService()),
  };
}
