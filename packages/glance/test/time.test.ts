import test from "node:test";
import assert from "node:assert/strict";
import { parsePlace, parsePlaces, resolveZone, zoneShift } from "../src/index.ts";

test("a city, a lower-case city or an IANA id resolves to a zone; nonsense does not", () => {
  assert.equal(resolveZone("Asia/Tokyo"), "Asia/Tokyo");
  assert.equal(resolveZone("tokyo"), "Asia/Tokyo");
  assert.equal(resolveZone("new york"), "America/New_York");
  assert.ok(resolveZone("Kyiv")?.startsWith("Europe/Ki"));
  assert.equal(resolveZone("UTC"), "UTC");
  assert.equal(resolveZone("Atlantis"), null);
  assert.equal(resolveZone("  "), null);
});

test("places take the city as their name unless one is given", () => {
  assert.deepEqual(parsePlace("America/New_York"), { label: "New York", zone: "America/New_York" });
  assert.deepEqual(parsePlace("Дім = Europe/Lisbon"), { label: "Дім", zone: "Europe/Lisbon" });
  assert.deepEqual(parsePlace(""), { label: "", zone: undefined });
  assert.deepEqual(parsePlace("Atlantis"), { label: "Atlantis", zone: null });
  assert.deepEqual(parsePlaces("London, Tokyo;\n").map((place) => place.label), ["London", "Tokyo"]);
});

test("the shift from the device counts minutes and calendar days", () => {
  const at = new Date("2026-10-30T22:30:00Z");
  assert.deepEqual(zoneShift("Asia/Tokyo", at, "UTC"), { minutes: 9 * 60, days: 1 });
  assert.deepEqual(zoneShift("Asia/Kolkata", at, "UTC"), { minutes: 5.5 * 60, days: 1 });
  assert.deepEqual(zoneShift("America/New_York", at, "UTC"), { minutes: -4 * 60, days: 0 });
  assert.deepEqual(zoneShift("UTC", at, "UTC"), { minutes: 0, days: 0 });
});
