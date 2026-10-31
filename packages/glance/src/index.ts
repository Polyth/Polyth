// Time-zone logic for the Glance clocks. Pure and DOM-free; the zone data is
// the platform's own (Intl), so nothing here needs a time-zone table.

const REGIONS = ["Europe", "America", "Asia", "Africa", "Australia", "Pacific", "Atlantic", "Indian", "Antarctica"];

function canonicalZone(candidate: string): string | null {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** A typed IANA id ("Asia/Tokyo") or city ("Tokyo", "new york", "Kyiv") →
 *  a zone the platform knows. IANA lookups ignore case, so a city only needs
 *  its region prefix. `null` when nothing matches. */
export function resolveZone(text: string): string | null {
  const name = text.trim().replace(/\s+/g, "_");
  if (!name) return null;
  for (const candidate of [name, ...REGIONS.map((region) => `${region}/${name}`)]) {
    const zone = canonicalZone(candidate);
    if (zone) return zone;
  }
  return null;
}

export interface Place {
  label: string;
  /** `undefined` = this device's zone; `null` = typed but unknown. */
  zone: string | null | undefined;
}

/** "Tokyo" or "Home = Europe/Lisbon"; empty = this device. */
export function parsePlace(text: string): Place {
  const item = text.trim();
  if (!item) return { label: "", zone: undefined };
  const split = item.indexOf("=");
  const zoneText = split > 0 ? item.slice(split + 1) : item;
  const label = split > 0
    ? item.slice(0, split).trim()
    : (zoneText.trim().split("/").pop() ?? zoneText).replace(/_/g, " ");
  return { label, zone: resolveZone(zoneText) };
}

export const MAX_PLACES = 12;

/** A comma (or semicolon / line) separated list of places. */
export function parsePlaces(text: string): Place[] {
  return text.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean).slice(0, MAX_PLACES).map(parsePlace);
}

/** The wall-clock reading in `zone` at `at`, as if it were UTC (whole minutes). */
function wallMinutes(zone: string | undefined, at: Date): number {
  const parts: Record<string, number> = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  for (const part of format.formatToParts(at)) parts[part.type] = Number(part.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!) / 60_000;
}

/** How far `zone` is from this device at `at`: minutes ahead (negative =
 *  behind) and calendar days ahead (-1, 0, 1). */
export function zoneShift(zone: string, at: Date, deviceZone?: string): { minutes: number; days: number } {
  const there = wallMinutes(zone, at);
  const here = wallMinutes(deviceZone, at);
  return { minutes: there - here, days: Math.floor(there / 1440) - Math.floor(here / 1440) };
}
