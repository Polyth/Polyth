import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowController, type PingTarget } from "../src/controller.ts";
import { VERIFY_DELAY_MS } from "../src/decide.ts";
import type { CatalogModel } from "../src/models.ts";
import { defaultPlan, RESET_MARGIN_MS, START_MARGIN_MS, type WindowPlan } from "../src/plan.ts";
import { createPlanStore, type PlanStore } from "../src/store.ts";
import type { LimitSource } from "../src/windows.ts";

const HOUR = 60 * 60_000;
const PERIOD = 5 * HOUR;
const utc = (time: string, day = 5): number => Date.parse(`2026-11-${String(day).padStart(2, "0")}T${time}:00Z`);

const MODELS: CatalogModel[] = [
  { harnessId: "claude", providerID: "anthropic", modelID: "opus", name: "Opus" },
  { harnessId: "claude", providerID: "anthropic", modelID: "haiku", name: "Haiku" },
  { harnessId: "claude-work", providerID: "anthropic", modelID: "sonnet", name: "Sonnet" },
  { harnessId: "claude-work", providerID: "anthropic", modelID: "haiku", name: "Haiku" },
];

interface World {
  now: number;
  /** What the provider says at each read. */
  provider: Map<string, () => Partial<LimitSource>>;
  cached: Map<string, LimitSource>;
  sends: Array<{ target: PingTarget; at: number; spaceId: string }>;
  reads: string[];
  sendResult: (target: PingTarget, signal: AbortSignal) => Promise<void>;
  authorized: boolean;
  store: PlanStore;
}

const idle = (): Partial<LimitSource> => ({ windows: [{ id: "5h", label: "5h", used: 0, limit: 100, unit: "percent", periodMs: PERIOD }] });
const runningUntil = (resetsAt: number, used = 10): Partial<LimitSource> => ({
  windows: [{ id: "5h", label: "5h", used, limit: 100, unit: "percent", periodMs: PERIOD, resetsAt }],
});

function setup(t: test.TestContext, start: number): World & { controller: ReturnType<typeof createWindowController>; addPlan(sourceId: string, plan: WindowPlan): void } {
  const dir = mkdtempSync(join(tmpdir(), "limit-windows-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const world: World = {
    now: start,
    provider: new Map(),
    cached: new Map(),
    sends: [],
    reads: [],
    sendResult: async () => {},
    authorized: true,
    store: createPlanStore(dir),
  };
  const read = (sourceId: string): LimitSource => {
    const answer = world.provider.get(sourceId)?.() ?? {};
    const reading: LimitSource = { providerId: sourceId, windows: [], fetchedAt: world.now, stale: false, ...answer };
    world.cached.set(sourceId, reading);
    return reading;
  };
  const controller = createWindowController({
    now: () => world.now,
    sources: () => [...world.cached.values()],
    async refresh(sourceId) {
      world.reads.push(sourceId);
      return read(sourceId);
    },
    routeOf(source, models) {
      const harnessId = source.providerId;
      return { harnessId, models: models.filter((row) => row.harnessId === harnessId) };
    },
    models: async () => MODELS,
    authorized: () => world.authorized,
    async send(target, spaceId, signal) {
      world.sends.push({ target, at: world.now, spaceId });
      await world.sendResult(target, signal);
    },
    store: world.store,
  });
  return Object.assign(world, {
    controller,
    addPlan(sourceId: string, plan: WindowPlan) {
      world.store.savePlan(sourceId, { plan, spaceId: "space-a", updatedBy: "u", updatedAt: 0 });
      read(sourceId);
    },
  });
}

const resetPlan: WindowPlan = { ...defaultPlan("UTC"), mode: "reset" };
const hourPlan: WindowPlan = { ...defaultPlan("UTC"), mode: "hour", lead: 1 };

test("a due start reads first, writes down, sends the cheapest model, then reads it back", async (t) => {
  const world = setup(t, utc("04:00") + START_MARGIN_MS);
  world.provider.set("claude", idle);
  world.addPlan("claude", hourPlan);
  await world.controller.tick();
  assert.deepEqual(world.reads, ["claude"]);
  assert.deepEqual(world.sends.map((row) => [row.target.harnessId, row.target.model.modelID, row.spaceId]), [["claude", "haiku", "space-a"]]);
  const sent = world.store.records("claude", "all")[0]!;
  assert.equal(sent.outcome, "sent");
  assert.equal(sent.reason, "lead");

  // Not read back too soon: a sliding reset would still look unstarted.
  world.now += 60_000;
  await world.controller.tick();
  assert.equal(world.store.records("claude", "all")[0]!.outcome, "sent");

  const startedAt = sent.at;
  world.provider.set("claude", () => runningUntil(startedAt + PERIOD, 0));
  world.now = startedAt + VERIFY_DELAY_MS;
  await world.controller.tick();
  const done = world.store.records("claude", "all")[0]!;
  assert.equal(done.outcome, "started");
  assert.equal(done.resetAt, startedAt + PERIOD);
  assert.equal(world.sends.length, 1);
});

test("a person's window found by the fresh read cancels the start", async (t) => {
  const world = setup(t, utc("04:00") + START_MARGIN_MS);
  world.provider.set("claude", idle);
  world.addPlan("claude", hourPlan);
  // The cached snapshot still says idle; the provider now does not.
  world.provider.set("claude", () => runningUntil(utc("08:50")));
  await world.controller.tick();
  assert.equal(world.sends.length, 0);
  assert.equal(world.store.records("claude", "all").length, 0);
});

test("after a reset the next window goes out within one tick", async (t) => {
  const world = setup(t, utc("07:00"));
  world.provider.set("claude", () => runningUntil(utc("07:50")));
  world.addPlan("claude", resetPlan);
  await world.controller.tick();
  assert.equal(world.sends.length, 0);
  world.now = utc("07:50") + RESET_MARGIN_MS;
  world.controller.touch("claude");
  world.provider.set("claude", idle);
  await world.controller.tick();
  assert.equal(world.sends.length, 1);
  assert.equal(world.store.records("claude", "all")[0]!.reason, "reset");
});

test("a failed send is recorded with a redacted reason and never replayed at once", async (t) => {
  const world = setup(t, utc("08:00"));
  world.provider.set("claude", idle);
  world.addPlan("claude", resetPlan);
  world.sendResult = async () => { throw new Error("401 token=abc123 rejected\nsecond line"); };
  await world.controller.tick();
  const failed = world.store.records("claude", "all")[0]!;
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.error, "401 [redacted] rejected");
  world.now += 60_000;
  world.controller.touch("claude");
  await world.controller.tick();
  assert.equal(world.sends.length, 1);
  // After the backoff the plan may try again.
  world.sendResult = async () => {};
  world.now = failed.at + 10 * 60_000 + 1;
  world.controller.touch("claude");
  await world.controller.tick();
  assert.equal(world.sends.length, 2);
});

test("an empty answer still reached the model", async (t) => {
  const world = setup(t, utc("08:00"));
  world.provider.set("claude", idle);
  world.addPlan("claude", resetPlan);
  world.sendResult = async () => { throw Object.assign(new Error("empty"), { code: "invalid-response" }); };
  await world.controller.tick();
  assert.equal(world.store.records("claude", "all")[0]!.outcome, "sent");
});

test("a request left open by a crash is read back, not sent again", async (t) => {
  const world = setup(t, utc("08:00"));
  world.provider.set("claude", idle);
  world.addPlan("claude", resetPlan);
  world.store.putRecord("claude", "all", {
    id: "crash", at: utc("07:59"), windowId: "5h", periodMs: PERIOD, reason: "reset", providerID: "anthropic", modelID: "haiku", outcome: "sending",
  });
  await world.controller.tick();
  assert.equal(world.sends.length, 0);
  world.provider.set("claude", () => runningUntil(utc("07:59") + PERIOD, 0));
  world.now = utc("07:59") + VERIFY_DELAY_MS;
  world.controller.touch("claude");
  await world.controller.tick();
  assert.equal(world.store.records("claude", "all")[0]!.outcome, "started");
  assert.equal(world.sends.length, 0);
});

test("a failing read holds the start, then goes ahead on the last good reading", async (t) => {
  const world = setup(t, utc("08:00"));
  world.provider.set("claude", idle);
  world.addPlan("claude", resetPlan);
  world.provider.set("claude", () => ({ ...idle(), stale: true, error: { code: "fetch-failed", message: "down" } }));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await world.controller.tick();
    assert.equal(world.sends.length, 0, `attempt ${attempt}`);
    world.now += 30_001;
  }
  await world.controller.tick();
  assert.equal(world.sends.length, 1);
});

test("every account runs on its own harness and keeps its own record", async (t) => {
  const world = setup(t, utc("08:00"));
  world.provider.set("claude", idle);
  world.provider.set("claude-work", () => runningUntil(utc("11:00")));
  world.addPlan("claude", resetPlan);
  world.addPlan("claude-work", resetPlan);
  await world.controller.tick();
  assert.deepEqual(world.sends.map((row) => row.target.harnessId), ["claude"]);
  assert.equal(world.store.records("claude-work", "all").length, 0);
  world.provider.set("claude-work", idle);
  world.now = utc("11:00") + RESET_MARGIN_MS;
  world.controller.touch("claude-work");
  await world.controller.tick();
  assert.deepEqual(world.sends.map((row) => row.target.harnessId), ["claude", "claude-work"]);
  assert.equal(world.store.records("claude-work", "all").length, 1);
});

test("a chosen model is honored; one no longer offered falls back to the cheapest", async (t) => {
  const world = setup(t, utc("08:00"));
  world.provider.set("claude", idle);
  world.provider.set("claude-work", idle);
  world.addPlan("claude", { ...resetPlan, model: { providerID: "anthropic", modelID: "opus" } });
  world.addPlan("claude-work", { ...resetPlan, model: { providerID: "anthropic", modelID: "retired" } });
  await world.controller.tick();
  assert.deepEqual(world.sends.map((row) => [row.target.harnessId, row.target.model.modelID]).sort(), [["claude", "opus"], ["claude-work", "haiku"]]);
});

test("a plan that lost its owner does not run", async (t) => {
  const world = setup(t, utc("08:00"));
  world.provider.set("claude", idle);
  world.addPlan("claude", resetPlan);
  world.authorized = false;
  await world.controller.tick();
  assert.deepEqual([world.sends.length, world.reads.length], [0, 0]);
});

test("at most two requests run at a time", async (t) => {
  const world = setup(t, utc("08:00"));
  const ids = ["a", "b", "c", "d", "e"];
  let running = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  world.sendResult = () => new Promise<void>((resolve) => {
    running += 1;
    peak = Math.max(peak, running);
    releases.push(() => { running -= 1; resolve(); });
  });
  for (const id of ids) {
    MODELS.push({ harnessId: id, providerID: "p", modelID: "mini", name: "Mini" });
    world.provider.set(id, idle);
    world.addPlan(id, resetPlan);
  }
  t.after(() => { MODELS.splice(-ids.length); });
  const pass = world.controller.tick();
  while (world.sends.length < ids.length) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(running <= 2);
    releases.shift()?.();
  }
  await new Promise((resolve) => setImmediate(resolve));
  while (releases.length) releases.shift()!();
  await pass;
  assert.equal(peak, 2);
});

test("disabling aborts the request on its way", async (t) => {
  const world = setup(t, utc("08:00"));
  world.provider.set("claude", idle);
  world.addPlan("claude", resetPlan);
  let aborted = false;
  world.sendResult = (_target, signal) => new Promise<void>((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason as Error); });
  });
  const pass = world.controller.tick();
  while (!world.controller.busy("claude", "all")) await new Promise((resolve) => setImmediate(resolve));
  world.controller.stop();
  await pass;
  assert.equal(aborted, true);
  assert.equal(world.store.records("claude", "all")[0]!.outcome, "failed");
});

test("Start now refuses a running window, a used-up one and one still settling", async (t) => {
  const world = setup(t, utc("08:00"));
  world.provider.set("claude", () => runningUntil(utc("10:00")));
  world.addPlan("claude", defaultPlan("UTC"));
  assert.deepEqual(await world.controller.startNow("claude", "all", "space-a"), { problem: "running" });

  world.provider.set("claude", () => ({ windows: [{ id: "5h", label: "5h", used: 100, limit: 100, unit: "percent", periodMs: PERIOD, resetsAt: utc("10:00") }] }));
  assert.deepEqual(await world.controller.startNow("claude", "all", "space-a"), { problem: "exhausted" });

  world.provider.set("claude", idle);
  assert.deepEqual(await world.controller.startNow("claude", "missing", "space-a"), { problem: "not-found" });
  const first = await world.controller.startNow("claude", "all", "space-a");
  assert.ok("outcome" in first && first.outcome === "sent" && first.reason === "manual");
  assert.deepEqual(await world.controller.startNow("claude", "all", "space-a"), { problem: "settling" });
  assert.equal(world.sends.length, 1);
});

test("a Start now on an account with no plan is still read back", async (t) => {
  const world = setup(t, utc("08:00"));
  world.provider.set("claude", idle);
  world.cached.set("claude", { providerId: "claude", fetchedAt: world.now, stale: false, ...idle() } as LimitSource);
  // A pass before it has nothing to do and would look again only minutes later.
  await world.controller.tick();
  const sent = await world.controller.startNow("claude", "all", "space-a");
  assert.ok("outcome" in sent && sent.outcome === "sent");
  world.provider.set("claude", () => runningUntil(utc("08:00") + PERIOD, 0));
  world.now = utc("08:00") + VERIFY_DELAY_MS;
  await world.controller.tick();
  const done = world.store.records("claude", "all")[0]!;
  assert.equal(done.outcome, "started");
  assert.equal(world.sends.length, 1);
  // And with no plan nothing further ever goes out.
  world.provider.set("claude", idle);
  world.now = utc("20:00");
  world.controller.touch("claude");
  await world.controller.tick();
  assert.equal(world.sends.length, 1);
});

test("a plan that lost its owner is still read back but sends nothing", async (t) => {
  const world = setup(t, utc("08:00"));
  world.provider.set("claude", idle);
  world.addPlan("claude", resetPlan);
  world.store.putRecord("claude", "all", {
    id: "open", at: utc("07:59"), windowId: "5h", periodMs: PERIOD, reason: "reset", providerID: "anthropic", modelID: "haiku", outcome: "sent",
  });
  world.authorized = false;
  world.provider.set("claude", () => runningUntil(utc("07:59") + PERIOD, 0));
  world.now = utc("07:59") + VERIFY_DELAY_MS;
  await world.controller.tick();
  assert.equal(world.store.records("claude", "all")[0]!.outcome, "started");
  world.provider.set("claude", idle);
  world.now = utc("20:00");
  world.controller.touch("claude");
  await world.controller.tick();
  assert.equal(world.sends.length, 0);
});

test("the store survives a restart and drops what it cannot read", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "limit-windows-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = createPlanStore(dir);
  first.savePlan("claude", { plan: resetPlan, spaceId: "s", updatedBy: "u", updatedAt: 5, ownerUserId: "o" });
  first.putRecord("claude", "all", { id: "1", at: 1, windowId: "5h", periodMs: PERIOD, reason: "reset", providerID: "p", modelID: "m", outcome: "sending" });
  first.putRecord("claude", "all", { id: "1", at: 1, windowId: "5h", periodMs: PERIOD, reason: "reset", providerID: "p", modelID: "m", outcome: "sent" });
  for (let index = 2; index < 60; index += 1) {
    first.putRecord("claude", "other", { id: String(index), at: index, windowId: "5h", periodMs: PERIOD, reason: "reset", providerID: "p", modelID: "m", outcome: "started" });
  }
  const second = createPlanStore(dir);
  assert.deepEqual(second.plan("claude")?.plan, resetPlan);
  assert.equal(second.plan("claude")?.ownerUserId, "o");
  assert.equal(second.records("claude", "all").length, 1);
  assert.equal(second.records("claude", "all")[0]!.outcome, "sent");
  assert.equal(second.records("claude", "other").length, 40);
  assert.equal(second.records("claude", "other")[0]!.id, "59");
});
