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
        ring: (finished) => { record.rings.push(`${finished.mode}:${finished.phase}`); },
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
  assert.equal(snapshot.timer.phase, "short");
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
  assert.equal(first.controller.getSnapshot().timer.phase, "short");
  assert.equal(second.controller.getSnapshot().timer.phase, "short");
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
  assert.equal(timer.phase, "short");
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
  tab.controller.writeSettings({ focusMin: 50, soundId: "bell" });
  assert.equal(notified, 1);
  assert.equal(tab.controller.readSettings().focusMin, 50);
  assert.equal(tab.controller.readSettings().soundId, "bell");
  assert.equal(tab.controller.getSnapshot().timer.remainingMs, 50 * MINUTE);
  // Writing the same value again is not a change.
  tab.controller.writeSettings(tab.controller.readSettings());
  assert.equal(notified, 1);
});

test("a label is saved tidy to the account preference and an empty one restores the built-in name", () => {
  const world = new World();
  const tab = world.tab();
  let notified = 0;
  tab.controller.subscribeSettings(() => { notified += 1; });
  tab.controller.setLabel("focus", "  Landing   page\n");
  assert.equal(tab.controller.readSettings().focusLabel, "Landing page");
  assert.equal(notified, 1);
  // The same label again is not a change; other phases keep theirs.
  tab.controller.setLabel("focus", "Landing page");
  assert.equal(notified, 1);
  assert.equal(tab.controller.readSettings().shortLabel, "");
  tab.controller.setLabel("focus", "");
  assert.equal(tab.controller.readSettings().focusLabel, "");
  assert.equal(notified, 2);
});

test("time-up notices announce a labelled segment by its label", () => {
  const world = new World();
  const tab = world.tab();
  tab.controller.setLabel("countdown", "Tea");
  tab.controller.setCountdown(3, true);
  world.advance(3 * MINUTE + 50);
  const snapshot = tab.controller.getSnapshot();
  assert.ok(snapshot.timer.finished);
  assert.match(finishedCopy(snapshot.timer.finished, snapshot).title, /Tea/);
  tab.controller.setLabel("countdown", "");
  const plain = tab.controller.getSnapshot();
  assert.doesNotMatch(finishedCopy(snapshot.timer.finished, plain).title, /Tea/);
});

test("changing the number of intervals mid-cycle keeps the cycle consistent", () => {
  const world = new World();
  const tab = world.tab();
  tab.controller.updateSettings({ rounds: 4 });
  for (let round = 0; round < 3; round += 1) {
    tab.controller.start();
    world.advance(25 * MINUTE + 50);
    if (round < 2) {
      tab.controller.skip(); // skip the break straight back to focus
    }
  }
  assert.equal(tab.controller.getSnapshot().timer.cycleDone, 3);
  // Fewer intervals than already done: the count clamps and the next focus closes the cycle.
  tab.controller.updateSettings({ rounds: 2 });
  assert.equal(tab.controller.getSnapshot().timer.cycleDone, 2);
  tab.controller.skip();
  tab.controller.start();
  world.advance(25 * MINUTE + 50);
  assert.equal(tab.controller.getSnapshot().timer.phase, "long");
  // More intervals: the cycle grows, nothing done is lost.
  tab.controller.updateSettings({ rounds: 6 });
  assert.equal(tab.controller.getSnapshot().timer.cycleDone, 2);
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
