# Glance

Small tiles for the new-chat screen's board (New chat → Customize → *Add
widget*). They also fit the Canvas (`workspace.main`, `workspace.right`).
The package ships off (Beta); nothing is placed until a person adds it.

## Widgets

- **Clock** (`glance.clock`, sizes `compact` / `standard`). One place:
  this device when empty, or a city / IANA zone. Settings: *Place*, *Show the
  date*, *Show seconds*. The standard size adds the date and the shift from
  this device ("+7 h", plus the weekday when the calendar day differs). Add
  copies for more cities.
- **World clock** (`glance.world`, sizes `standard` / `wide`). A list of up to
  12 places, comma-separated (default `London, New York, Tokyo`), each with its
  time and shift. Unknown places stay in the list as *Unknown place*.

- **Weather** (`glance.weather`, sizes `compact` / `standard` / `wide`). One
  city: the temperature and sky now; the standard size adds today's high/low,
  feels-like, wind and humidity; the wide size adds a five-day row. Settings:
  *Place* (`Kyiv`, `Київ`, `Home = Lisbon`), *Units* (`°C` km/h or `°F` mph).
  Empty place: the tile asks for one. Nothing is guessed from the device.

A place is `Tokyo`, `new york`, `Asia/Kolkata`, or `Name = zone`
(`Дім = Lisbon`) to give it a name. Cities resolve through the platform's own
`Intl` zone data (`resolveZone` in `src/index.ts`): an IANA id as typed, else
the name under each region prefix. Times use the interface locale's format.

Weather comes from [Open-Meteo](https://open-meteo.com) (no key) through the
package's one route, `GET /api/glance/weather?place=&units=c|f&lang=`
(`src/serverEntry.ts`). The browser never calls Open-Meteo: the server
geocodes the city, then reads the forecast, each request checked by
`@polyth/outbound` (`public-only`, pinned address, 10 s, 256 KiB) and
limited to the two Open-Meteo origins. The city name — never the device's
location — is what leaves Polyth. Answers are cached in memory per Space
(places 24 h, forecasts 15 min, 256 entries); the tile refreshes every 15 min
and waits 700 ms after typing. The route is local-only: paired devices are
refused (default-deny). Pure parsing: `src/weather.ts`; network:
`src/weatherService.ts`.

Config is per board item (presentation only, never session history). Strings: `src/strings.ts`. Tests: `test/time.test.ts`, `test/weather.test.ts`.
