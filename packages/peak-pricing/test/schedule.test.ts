import assert from "node:assert/strict";
import test from "node:test";
import {
  CHINA_HOLIDAYS_2026,
  DEEPSEEK_PRICING,
  formatLocalTime,
  formatRemaining,
  priceStateAt,
  pricingRouteFor,
  scheduleForProvider,
  type PricingSchedule,
} from "../src/index.ts";

const at = (iso: string): number => Date.parse(iso);
const state = (iso: string) => priceStateAt(at(iso));

test("peak windows follow the published UTC schedule on weekdays", () => {
  assert.equal(state("2026-10-19T00:59:00Z").phase, "off-peak");
  assert.equal(state("2026-10-19T01:00:00Z").phase, "peak");
  assert.equal(state("2026-10-19T03:59:59Z").phase, "peak");
  assert.equal(state("2026-10-19T04:00:00Z").phase, "off-peak");
  assert.equal(state("2026-10-19T06:00:00Z").phase, "peak");
  assert.equal(state("2026-10-19T10:00:00Z").phase, "off-peak");
});

test("weekends are off-peak in full, including Friday night through Monday", () => {
  assert.equal(state("2026-10-17T02:00:00Z").phase, "off-peak", "Saturday");
  assert.equal(state("2026-10-18T08:00:00Z").phase, "off-peak", "Sunday");
  const fridayEvening = state("2026-10-16T20:00:00Z");
  assert.equal(fridayEvening.phase, "off-peak");
  assert.equal(new Date(fridayEvening.until).toISOString(), "2026-10-19T01:00:00.000Z",
    "the countdown must reach Monday 01:00 UTC, not midnight");
  assert.equal(new Date(fridayEvening.since).toISOString(), "2026-10-16T10:00:00.000Z");
});

test("Chinese public holidays are off-peak in full and named", () => {
  const nationalDay = state("2026-10-02T02:00:00Z");
  assert.equal(nationalDay.phase, "off-peak");
  assert.equal(nationalDay.holiday?.name, "National Day");
  assert.equal(nationalDay.calendarYear, 2026);
  const springFestival = state("2026-02-16T02:00:00Z");
  assert.equal(springFestival.phase, "off-peak");
  assert.equal(springFestival.holiday?.name, "Spring Festival");
  // A makeup workday (Saturday 10 October 2026) is still a weekend: off-peak.
  assert.equal(state("2026-10-10T02:00:00Z").phase, "off-peak");
});

test("holiday boundaries use China's calendar, not the UTC date", () => {
  // 00:30 Beijing on 1 October is still 30 September in UTC, but the holiday
  // has already begun; 00:30 Beijing on 8 October is after it ended.
  const firstHours = state("2026-09-30T16:30:00Z");
  assert.equal(firstHours.phase, "off-peak");
  assert.equal(firstHours.holiday?.name, "National Day");
  const afterLastDay = state("2026-10-07T16:30:00Z");
  assert.equal(afterLastDay.phase, "off-peak");
  assert.equal(afterLastDay.holiday, undefined);
  // The 2027 notice is not published yet even though UTC is still 31 Dec.
  assert.equal(state("2026-12-31T16:30:00Z").calendarYear, undefined);
});

test("a holiday can merge into the weekend run: one countdown for the whole break", () => {
  // Thursday 1 October 2026 02:00 UTC sits inside National Day, whose last day
  // is 7 October (Wednesday); the run then continues to the next peak window.
  const during = state("2026-10-01T02:00:00Z");
  assert.equal(during.phase, "off-peak");
  assert.equal(new Date(during.until).toISOString(), "2026-10-08T01:00:00.000Z");
});

test("a future schedule whose peak window wraps UTC midnight still counts correctly", () => {
  const wrapping: PricingSchedule = {
    id: "wrapping-test",
    providers: ["wrapping-test"],
    peakWindows: [{ startMinute: 22 * 60, endMinute: 2 * 60 }],
    peakWeekdays: [1, 2, 3, 4, 5, 6, 7],
    excludesChineseHolidays: false,
    source: "synthetic wrap test",
    sourceUrl: "https://example.com/pricing",
  };
  const late = priceStateAt(at("2026-10-19T23:00:00Z"), wrapping);
  assert.equal(late.phase, "peak");
  assert.equal(new Date(late.since).toISOString(), "2026-10-19T22:00:00.000Z");
  assert.equal(new Date(late.until).toISOString(), "2026-10-20T02:00:00.000Z");
  assert.equal(priceStateAt(at("2026-10-20T01:59:59Z"), wrapping).phase, "peak");
  const justAfter = priceStateAt(at("2026-10-20T02:00:00Z"), wrapping);
  assert.equal(justAfter.phase, "off-peak");
  assert.equal(new Date(justAfter.since).toISOString(), "2026-10-20T02:00:00.000Z");
  assert.equal(new Date(justAfter.until).toISOString(), "2026-10-20T22:00:00.000Z");
});

test("every sampled instant reports a self-consistent phase interval", () => {
  // Covers the National Day break, its weekend tail and normal weekday windows.
  const start = at("2026-09-25T00:00:00Z");
  const end = at("2026-10-12T00:00:00Z");
  for (let now = start; now < end; now += 17 * 60_000) {
    const current = priceStateAt(now);
    assert.ok(current.since <= now, `since must not be after ${new Date(now).toISOString()}`);
    assert.ok(now < current.until, `until must be after ${new Date(now).toISOString()}`);
    assert.equal(
      priceStateAt(current.until - 1).phase,
      current.phase,
      `phase must hold through ${new Date(current.until).toISOString()}`,
    );
    assert.notEqual(
      priceStateAt(current.until).phase,
      current.phase,
      `phase must change at ${new Date(current.until).toISOString()}`,
    );
    assert.notEqual(
      priceStateAt(current.since - 1).phase,
      current.phase,
      `phase must have changed at ${new Date(current.since).toISOString()}`,
    );
  }
});

test("outside a published calendar only weekday windows apply, and the state says so", () => {
  const unknown = state("2027-03-02T02:00:00Z");
  assert.equal(unknown.phase, "peak");
  assert.equal(unknown.calendarYear, undefined);
  assert.equal(unknown.holiday, undefined);
});

test("the phase edges are exact at both ends of the day", () => {
  const endOfYear = state("2026-12-31T23:59:00Z");
  assert.equal(endOfYear.phase, "off-peak");
  assert.equal(new Date(endOfYear.until).toISOString(), "2027-01-01T01:00:00.000Z");
  const monday = state("2026-10-19T00:30:00Z");
  assert.equal(new Date(monday.until).toISOString(), "2026-10-19T01:00:00.000Z");
});

test("provider identity decides the schedule; the harness only widens it", () => {
  assert.equal(scheduleForProvider("deepseek")?.id, "deepseek");
  assert.equal(scheduleForProvider("deepseek-official")?.id, "deepseek");
  assert.equal(scheduleForProvider("deepseek-work", "deepseek-work")?.id, "deepseek",
    "an extra DeepSeek login still bills on DeepSeek's clock");
  assert.equal(scheduleForProvider("openrouter", "deepseek"), undefined,
    "a DeepSeek harness pointed at another provider is not DeepSeek billing");
  assert.equal(scheduleForProvider("deepseek", "opencode")?.id, "deepseek");
  assert.equal(scheduleForProvider("openai", "codex"), undefined);
  assert.equal(scheduleForProvider("anthropic", "claude"), undefined);
  assert.equal(scheduleForProvider(undefined), undefined);
  assert.equal(scheduleForProvider(""), undefined);
  // A provider name that merely contains "deepseek" is a different provider.
  assert.equal(scheduleForProvider("deepseek-reseller-x"), undefined);
});

test("a resold DeepSeek model is a reference match, not a billing claim", () => {
  const resold = pricingRouteFor({
    providerID: "openrouter",
    harnessId: "opencode",
    modelID: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
  });
  assert.equal(resold?.schedule.id, "deepseek");
  assert.equal(resold?.billing, "model");
  assert.equal(pricingRouteFor({ providerID: "openrouter", modelID: "openai/gpt-5.2", name: "GPT-5.2" }), undefined);
  assert.equal(pricingRouteFor({ providerID: "deepseek-official", modelID: "deepseek-flash" })?.billing, "provider");
});

test("remaining time keeps one stable shape per magnitude", () => {
  assert.equal(formatRemaining(0), "0s");
  assert.equal(formatRemaining(999), "1s");
  assert.equal(formatRemaining(45_000), "45s");
  assert.equal(formatRemaining(90_000), "1m 30s");
  assert.equal(formatRemaining(4 * 3600_000 + 12 * 60_000), "4h 12m");
  assert.equal(formatRemaining(2 * 86_400_000 + 5 * 3600_000), "2d 05h");
});

test("local transition times are rendered in the viewer's zone", () => {
  const utc = formatLocalTime(Date.UTC(2026, 9, 19, 10, 0), "en-GB");
  assert.match(utc, /^\d{2}:\d{2}$/);
  const shifted = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" })
    .format(new Date(Date.UTC(2026, 9, 19, 10, 0)));
  assert.equal(shifted, "13:00");
});

test("the encoded holiday calendar carries its provenance and full coverage", () => {
  assert.equal(CHINA_HOLIDAYS_2026.from, "2026-01-01");
  assert.equal(CHINA_HOLIDAYS_2026.to, "2026-12-31");
  assert.match(CHINA_HOLIDAYS_2026.source, /State Council/);
  assert.equal(CHINA_HOLIDAYS_2026.ranges.length, 7);
  for (const range of CHINA_HOLIDAYS_2026.ranges) {
    assert.match(range.from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(range.to, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(range.from <= range.to, `${range.name} is ordered`);
    assert.ok(range.from >= CHINA_HOLIDAYS_2026.from && range.to <= CHINA_HOLIDAYS_2026.to);
  }
});

test("the schedule quotes the provider's own windows", () => {
  assert.deepEqual(DEEPSEEK_PRICING.peakWindows, [
    { startMinute: 60, endMinute: 240 },
    { startMinute: 360, endMinute: 600 },
  ]);
  assert.deepEqual(DEEPSEEK_PRICING.peakWeekdays, [1, 2, 3, 4, 5]);
  assert.match(DEEPSEEK_PRICING.sourceUrl, /^https:\/\/api-docs\.deepseek\.com\//);
});

const UK_UNITS = { day: "{n} дн", hour: "{n} год", minute: "{n} хв", second: "{n} с" };

test("countdowns localize their part names without changing the shape", () => {
  assert.equal(formatRemaining(81 * 60_000, UK_UNITS), "1 год 21 хв");
  assert.equal(formatRemaining(3 * 86_400_000 + 9 * 3600_000, UK_UNITS), "3 дн 09 год");
  assert.equal(formatRemaining(59_000, UK_UNITS), "59 с");
  assert.equal(formatRemaining(12 * 60_000 + 5_000, UK_UNITS), "12 хв 05 с");
  // English stays the default shape.
  assert.equal(formatRemaining(81 * 60_000), "1h 21m");
});

test("the public API has no countdown width reserve", async () => {
  const api = await import("../src/index.ts");
  assert.equal("remainingReserve" in api, false);
  assert.equal(typeof api.formatRemaining, "function");
});
