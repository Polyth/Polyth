import test from "node:test";
import assert from "node:assert/strict";
import { decide, judgeStart, MAX_PINGS_PER_DAY, VERIFY_DELAY_MS, type PingRecord } from "../src/decide.ts";
import { defaultPlan, RESET_MARGIN_MS, START_MARGIN_MS, type WindowPlan } from "../src/plan.ts";
import { metersOf, type LimitSource, type LimitWindow } from "../src/windows.ts";

const HOUR = 60 * 60_000;
const utc = (time: string, day = 5): number => Date.parse(`2026-11-${String(day).padStart(2, "0")}T${time}:00Z`);
const PERIOD = 5 * HOUR;
const hourPlan: WindowPlan = { ...defaultPlan("UTC"), mode: "hour", lead: 1 };
const resetPlan: WindowPlan = { ...defaultPlan("UTC"), mode: "reset" };

const reading = (now: number, windows: Array<Partial<LimitWindow> & { id: string }>, patch: Partial<LimitSource> = {}): LimitSource => ({
  providerId: "claude",
  fetchedAt: now,
  stale: false,
  windows: windows.map((window) => ({ label: window.id, used: 0, limit: 100, unit: "percent", periodMs: PERIOD, ...window })),
  ...patch,
});

const record = (patch: Partial<PingRecord> = {}): PingRecord => ({
  id: "r",
  at: utc("04:00"),
  windowId: "5h",
  periodMs: PERIOD,
  reason: "lead",
  providerID: "anthropic",
  modelID: "haiku",
  outcome: "started",
  ...patch,
});

const decideAt = (now: number, plan: WindowPlan, source: LimitSource, records: PingRecord[] = []) =>
  decide({ plan, meter: metersOf(source)[0]!, source, records, now });

test("off stays off", () => {
  const now = utc("02:00");
  assert.deepEqual(decideAt(now, defaultPlan("UTC"), reading(now, [{ id: "5h" }])), { kind: "off" });
});

test("a skipped meter stays off", () => {
  const now = utc("02:00");
  assert.deepEqual(decideAt(now, { ...resetPlan, skipMeters: ["all"] }, reading(now, [{ id: "5h" }])), { kind: "off" });
});

test("idle before the boundary waits for it, then pings", () => {
  const before = utc("02:00");
  const wait = decideAt(before, hourPlan, reading(before, [{ id: "5h" }]));
  assert.equal(wait.kind, "wait");
  if (wait.kind === "wait") {
    assert.equal(wait.at, utc("04:00") + START_MARGIN_MS);
    assert.equal(wait.start?.reason, "lead");
  }
  const due = utc("04:00") + START_MARGIN_MS;
  const ping = decideAt(due, hourPlan, reading(due, [{ id: "5h" }]));
  assert.equal(ping.kind, "ping");
  if (ping.kind === "ping") assert.equal(ping.window.id, "5h");
});

test("a person's window pushes the start past its reset", () => {
  const now = utc("03:00");
  const decision = decideAt(now, resetPlan, reading(now, [{ id: "5h", used: 20, resetsAt: utc("07:50") }]));
  assert.equal(decision.kind, "wait");
  if (decision.kind === "wait") assert.equal(decision.at, utc("07:50") + RESET_MARGIN_MS);
});

test("right after a reset the next window is due", () => {
  const now = utc("07:50") + RESET_MARGIN_MS;
  assert.equal(decideAt(now, resetPlan, reading(now, [{ id: "5h", used: 20, resetsAt: utc("07:50") }])).kind, "ping");
});

test("a sent request is read back before anything else happens", () => {
  const now = utc("04:01");
  const open = record({ outcome: "sent", latencyMs: 4_000 });
  const decision = decideAt(now, resetPlan, reading(now, [{ id: "5h" }]), [open]);
  assert.equal(decision.kind, "verify");
  if (decision.kind === "verify") assert.equal(decision.at, open.at + 4_000 + VERIFY_DELAY_MS);
});

test("a request a crash left open is read back too, never sent again", () => {
  const now = utc("04:01");
  assert.equal(decideAt(now, resetPlan, reading(now, [{ id: "5h" }]), [record({ outcome: "sending" })]).kind, "verify");
});

test("a request still gets read back after the plan was turned off", () => {
  const now = utc("04:01");
  assert.equal(decideAt(now, defaultPlan("UTC"), reading(now, [{ id: "5h" }]), [record({ outcome: "sent" })]).kind, "verify");
});

test("a used-up window holds the meter until its reset", () => {
  const now = utc("04:00");
  const decision = decideAt(now, resetPlan, reading(now, [
    { id: "5h" },
    { id: "7d", used: 100, periodMs: 168 * HOUR, resetsAt: utc("17:00") },
  ]));
  assert.equal(decision.kind, "wait");
  if (decision.kind === "wait") {
    assert.equal(decision.hold, "exhausted");
    assert.equal(decision.at, utc("17:00"));
  }
});

test("a failed request backs off, longer each time", () => {
  const last = record({ at: utc("04:00"), outcome: "failed" });
  const soon = utc("04:05");
  const once = decideAt(soon, resetPlan, reading(soon, [{ id: "5h" }]), [last]);
  assert.equal(once.kind === "wait" && once.hold, "failing");
  assert.equal(once.kind === "wait" && once.at, utc("04:10"));
  const twice = decideAt(soon, resetPlan, reading(soon, [{ id: "5h" }]), [last, { ...last, id: "older", at: utc("03:50") }]);
  assert.equal(twice.kind === "wait" && twice.at, utc("04:30"));
  const later = utc("04:11");
  assert.equal(decideAt(later, resetPlan, reading(later, [{ id: "5h" }]), [last]).kind, "ping");
});

test("two answered requests that started nothing stop the meter for hours", () => {
  const first = record({ at: utc("04:00"), outcome: "no-effect" });
  const second = record({ id: "second", at: utc("04:03"), outcome: "no-effect" });
  const now = utc("04:10");
  assert.equal(decideAt(now, resetPlan, reading(now, [{ id: "5h" }]), [first]).kind, "ping");
  const held = decideAt(now, resetPlan, reading(now, [{ id: "5h" }]), [second, first]);
  assert.equal(held.kind === "wait" && held.hold, "no-effect");
  assert.equal(held.kind === "wait" && held.at, utc("04:03") + 12 * HOUR);
});

test("a day's budget is a hard stop whatever the readings say", () => {
  const now = utc("12:00");
  const records = Array.from({ length: MAX_PINGS_PER_DAY }, (_, index) =>
    record({ id: String(index), at: now - (index + 1) * 10 * 60_000, outcome: "started" }));
  const decision = decideAt(now, resetPlan, reading(now, [{ id: "5h" }]), records);
  assert.equal(decision.kind === "wait" && decision.hold, "budget");
  assert.equal(decision.kind === "wait" && decision.at, records.at(-1)!.at + 24 * HOUR);
});

test("a start nothing could confirm is taken at its word for one window", () => {
  const now = utc("05:00");
  const decision = decideAt(now, resetPlan, reading(now, [{ id: "5h" }]), [record({ outcome: "unconfirmed" })]);
  assert.equal(decision.kind, "wait");
  if (decision.kind === "wait") assert.equal(decision.at, utc("09:00") + RESET_MARGIN_MS);
});

test("no way to tell when a window ends: look again later", () => {
  const now = utc("05:00");
  const decision = decideAt(now, resetPlan, reading(now, [{ id: "5h", used: 40 }]));
  assert.equal(decision.kind === "wait" && decision.hold, "unknown-reset");
});

test("a reading after the start says what it did", () => {
  const at = utc("04:00");
  const later = at + VERIFY_DELAY_MS;
  const started = reading(later, [{ id: "5h", resetsAt: at + PERIOD }]);
  assert.deepEqual(judgeStart(record({ at }), started, later), { outcome: "started", resetAt: at + PERIOD });
  // Still a sliding reset, a full period ahead of the read.
  const slid = reading(later, [{ id: "5h", resetsAt: later + PERIOD }]);
  assert.deepEqual(judgeStart(record({ at }), slid, later), { outcome: "no-effect" });
  // Still no reset at all.
  assert.deepEqual(judgeStart(record({ at }), reading(later, [{ id: "5h" }]), later), { outcome: "no-effect" });
});

test("no fresh reading confirms nothing", () => {
  const at = utc("04:00");
  const later = at + VERIFY_DELAY_MS;
  assert.deepEqual(judgeStart(record({ at }), reading(later, [{ id: "5h", resetsAt: at + PERIOD }], { stale: true }), later), { outcome: "unconfirmed" });
  assert.deepEqual(judgeStart(record({ at }), reading(at - 1, [{ id: "5h", resetsAt: at + PERIOD }]), later), { outcome: "unconfirmed" });
  assert.deepEqual(judgeStart(record({ at }), reading(later, [{ id: "other" }]), later), { outcome: "unconfirmed" });
});
