import assert from "node:assert/strict";
import test from "node:test";
import { MINUTE, STALE_FINISH_MS } from "../src/timerModel.ts";
import { finishedCopy } from "../widgets/alerts.ts";
import { AUTO_ACK_MS, createTimerController, STATE_KEY, WINDOW_KEY, type ControllerDeps, type TimerController } from "../widgets/controller.ts";

const T0 = new Date(2026, 10, 23, 9, 0, 0).getTime();

class FakeStorage {
  map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
}

/** One shared clock and timer queue for every "tab" in a test. */
class World {
  now = T0;
  storage = new FakeStorage();
  private seq = 0;
  private timers = new Map<number, { at: number; run: () => void }>();

  tab(): { controller: TimerController; rings: string[]; silences: number } {
    const record = { rings: [] as string[], silences: 0 };
    const deps: ControllerDeps = {
      storage: this.storage,
      now: () => this.now,
      setTimer: (run, ms) => {
        const id = ++this.seq;
        this.timers.set(id, { at: this.now + ms, run });
        return id;
      },
      clearTimer: (handle) => { this.timers.delete(handle as number); },
      effects: {
        ring: (finished) => { record.rings.push(`${finished.mode}:${finished.step?.preset ?? finished.step?.name ?? "-"}`); },
        silence: () => { record.silences += 1; },
      },
    };
    const controller = createTimerController(deps);
    controller.check();
    return Object.assign(record, { controller });
  }

  /** Move the clock, firing due timers in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].run();
    }
    this.now = end;
  }
}

test("a running focus rings once at its end and the break waits", () => {
  const world = new World();
  const tab = world.tab();
  tab.controller.start();
  world.advance(25 * MINUTE - 1000);
  assert.deepEqual(tab.rings, []);
  world.advance(2000);
  assert.deepEqual(tab.rings, ["pomodoro:focus"]);
  const snapshot = tab.controller.getSnapshot();
  assert.equal(snapshot.timer.step, 1);
  assert.equal(snapshot.timer.status, "idle");
  assert.ok(snapshot.timer.finished);
});

test("with two tabs open only the first to notice rings; the other follows the state", () => {
  const world = new World();
  const first = world.tab();
  const second = world.tab();
  first.controller.start();
  // The second tab hears about the start through the storage event.
  second.controller.storageChanged(STATE_KEY);
  assert.equal(second.controller.getSnapshot().timer.status, "running");
  world.advance(25 * MINUTE + 100);
  assert.equal(first.rings.length + second.rings.length, 1);
  second.controller.storageChanged(STATE_KEY);
  first.controller.storageChanged(STATE_KEY);
  assert.equal(first.controller.getSnapshot().timer.step, 1);
  assert.equal(second.controller.getSnapshot().timer.step, 1);
});

test("a segment that ended long before the tab opened does not ring", () => {
  const world = new World();
  const tab = world.tab();
  tab.controller.start();
  tab.controller.dispose();
  world.now = T0 + 25 * MINUTE + STALE_FINISH_MS + 5000;
  const later = world.tab();
  assert.deepEqual(later.rings, []);
  const timer = later.controller.getSnapshot().timer;
  assert.equal(timer.step, 1);
  assert.equal(timer.finished?.stale, true);
});

test("an auto-started break keeps the notice for a while, then clears it", () => {
  const world = new World();
  const tab = world.tab();
  tab.controller.updateSettings({ autoStartBreaks: true });
  tab.controller.start();
  world.advance(25 * MINUTE + 50);
  assert.equal(tab.controller.getSnapshot().timer.status, "running");
  assert.ok(tab.controller.getSnapshot().timer.finished);
  world.advance(AUTO_ACK_MS + 100);
  assert.equal(tab.controller.getSnapshot().timer.finished, null);
  assert.equal(tab.controller.getSnapshot().timer.status, "running");
});

test("any control silences a ringing sound", () => {
  const world = new World();
  const tab = world.tab();
  tab.controller.start();
  world.advance(25 * MINUTE + 10);
  const before = tab.silences;
  tab.controller.acknowledge();
  assert.equal(tab.silences, before + 1);
  assert.equal(tab.controller.getSnapshot().timer.finished, null);
});

test("settings come from the account preference and reach an idle timer", () => {
  const world = new World();
  const tab = world.tab();
  let notified = 0;
  tab.controller.subscribeSettings(() => { notified += 1; });
  tab.controller.writeSettings({ focusMin: 50, soundId: "bell" }); // an older saved shape
  assert.equal(notified, 1);
  assert.equal(tab.controller.readSettings().soundId, "bell");
  assert.equal(tab.controller.readSettings().cycleId, "c-legacy");
  assert.equal(tab.controller.getSnapshot().timer.remainingMs, 50 * MINUTE);
  // Writing the same value again is not a change.
  tab.controller.writeSettings(tab.controller.readSettings());
  assert.equal(notified, 1);
});

test("changing a ready-made cycle saves the person's own copy and keeps the timer on its step", () => {
  const world = new World();
  const tab = world.tab();
  tab.controller.start();
  world.advance(25 * MINUTE + 50); // focus → short break (step 1)
  tab.controller.start();
  tab.controller.updateStep("builtin:pomodoro", 1, { name: "  Stretch\n", minutes: 7 });
  const settings = tab.controller.readSettings();
  assert.equal(settings.cycles.length, 1);
  const copy = settings.cycles[0]!;
  assert.equal(settings.cycleId, copy.id);
  assert.equal(copy.preset, "pomodoro");
  assert.equal(copy.steps[1]!.name, "Stretch");
  assert.equal(copy.steps[1]!.minutes, 7);
  const timer = tab.controller.getSnapshot().timer;
  assert.equal(timer.cycleId, copy.id);
  assert.equal(timer.step, 1);
  assert.equal(timer.status, "running", "an edit never stops the running segment");
  // Further edits change the copy in place.
  tab.controller.renameCycle(copy.id, "Mine");
  assert.equal(tab.controller.readSettings().cycles.length, 1);
  assert.equal(tab.controller.readSettings().cycles[0]!.name, "Mine");
});

test("moving and removing steps keeps the timer on the step it was on", () => {
  const world = new World();
  const tab = world.tab();
  const id = tab.controller.createCycle("builtin:52-17");
  assert.ok(id);
  tab.controller.addStep(id); // 52 focus, 17 break, 25 focus
  tab.controller.selectStep(1);
  tab.controller.moveStep(id, 1, 2);
  assert.equal(tab.controller.getSnapshot().timer.step, 2);
  assert.deepEqual(tab.controller.readSettings().cycles[0]!.steps.map((item) => item.minutes), [52, 25, 17]);
  tab.controller.removeStep(id, 0);
  assert.equal(tab.controller.getSnapshot().timer.step, 1);
  assert.equal(tab.controller.getSnapshot().timer.remainingMs, 17 * MINUTE);
  tab.controller.duplicateStep(id, 1);
  assert.deepEqual(tab.controller.readSettings().cycles[0]!.steps.map((item) => item.minutes), [25, 17, 17]);
});

test("choosing or deleting cycles: a new choice starts at its first step, stopped", () => {
  const world = new World();
  const tab = world.tab();
  const id = tab.controller.createCycle();
  assert.ok(id);
  assert.equal(tab.controller.readSettings().cycleId, id);
  const created = tab.controller.readSettings().cycles[0]!;
  assert.deepEqual(created.steps.map((item) => [item.minutes, item.kind]), [[25, "focus"], [5, "break"]]);
  tab.controller.start();
  world.advance(5 * MINUTE);
  tab.controller.selectCycle("builtin:90-20");
  let timer = tab.controller.getSnapshot().timer;
  assert.equal(timer.status, "idle");
  assert.equal(timer.step, 0);
  assert.equal(timer.remainingMs, 90 * MINUTE);
  // Deleting the running own cycle falls back to the classic one.
  tab.controller.selectCycle(id);
  tab.controller.start();
  tab.controller.deleteCycle(id);
  timer = tab.controller.getSnapshot().timer;
  assert.equal(tab.controller.readSettings().cycles.length, 0);
  assert.equal(tab.controller.readSettings().cycleId, "builtin:pomodoro");
  assert.equal(timer.status, "idle");
  assert.equal(timer.remainingMs, 25 * MINUTE);
  // Ready-made cycles cannot be deleted.
  tab.controller.deleteCycle("builtin:pomodoro");
  assert.equal(tab.controller.readSettings().cycleId, "builtin:pomodoro");
});

test("time-up notices name the step that ended and the one that comes next", () => {
  const world = new World();
  const tab = world.tab();
  tab.controller.selectCycle("builtin:sit-stand");
  const id = tab.controller.readSettings().cycleId;
  tab.controller.updateStep(id, 0, { name: "Desk down" });
  const own = tab.controller.readSettings().cycleId;
  tab.controller.updateStep(own, 1, { name: "Desk up" });
  tab.controller.start();
  world.advance(40 * MINUTE + 50);
  const snapshot = tab.controller.getSnapshot();
  assert.ok(snapshot.timer.finished);
  const copy = finishedCopy(snapshot.timer.finished, snapshot);
  assert.match(copy.title, /Desk down/);
  assert.match(copy.body, /Desk up/);
  assert.match(copy.body, /20/);
  assert.match(copy.next ?? "", /Desk up/);
});

test("the countdown's name is saved tidy and announced when time is up", () => {
  const world = new World();
  const tab = world.tab();
  tab.controller.setCountdownLabel("  Tea \n");
  assert.equal(tab.controller.readSettings().countdownLabel, "Tea");
  tab.controller.setCountdown(3, true);
  world.advance(3 * MINUTE + 50);
  const snapshot = tab.controller.getSnapshot();
  assert.ok(snapshot.timer.finished);
  assert.match(finishedCopy(snapshot.timer.finished, snapshot).title, /Tea/);
  tab.controller.setCountdownLabel("");
  const plain = tab.controller.getSnapshot();
  assert.doesNotMatch(finishedCopy(snapshot.timer.finished, plain).title, /Tea/);
});

test("the window's visibility, shape and place persist on this device", () => {
  const world = new World();
  const tab = world.tab();
  assert.equal(tab.controller.getSnapshot().window.open, false);
  tab.controller.show();
  tab.controller.setCompact(true);
  tab.controller.setAnchor({ x: 0.25, y: 2 });
  const stored = JSON.parse(world.storage.getItem(WINDOW_KEY) ?? "{}");
  assert.deepEqual(stored, { open: true, compact: true, anchor: { x: 0.25, y: 1 } });
  const again = world.tab();
  assert.deepEqual(again.controller.getSnapshot().window, stored);
  // Opening settings unfolds a compact window.
  again.controller.setView("settings");
  assert.equal(again.controller.getSnapshot().window.compact, false);
  again.controller.hide();
  assert.equal(again.controller.getSnapshot().view, "timer");
});

test("dispose stops the pending end timer", () => {
  const world = new World();
  const tab = world.tab();
  tab.controller.start();
  tab.controller.dispose();
  world.advance(30 * MINUTE);
  assert.deepEqual(tab.rings, []);
});
