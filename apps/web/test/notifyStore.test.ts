// The notification store: identity (dedupe by id, update in place), the
// visible cap, pausable lifetimes and dismissal reasons.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);

const store = await import("../src/notify/store.ts");
const { notify, updateNotification, dismissNotification, pauseNotifications, resumeNotifications, getNotifications, resetNotifications, MAX_VISIBLE, MAX_RECORDS } = store;

const ids = () => getNotifications().items.map((item) => item.id);

function withClock(run: () => void): void {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  try {
    resetNotifications();
    run();
  } finally {
    resetNotifications();
    mock.timers.reset();
  }
}

test("the same id replaces in place and moves to the front; onDismiss is not called for a replacement", () => withClock(() => {
  const dismissed: string[] = [];
  notify({ id: "a", kind: "info", title: "A1", onDismiss: (reason) => dismissed.push(`a1:${reason}`) });
  notify({ id: "b", kind: "info", title: "B" });
  const before = getNotifications().items.find((item) => item.id === "a")!;
  notify({ id: "a", kind: "error", title: "A2" });
  assert.deepEqual(ids(), ["b", "a"], "one record per id, newest last");
  const after = getNotifications().items.find((item) => item.id === "a")!;
  assert.equal(after.title, "A2");
  assert.equal(after.kind, "error");
  assert.ok(after.revision > before.revision);
  assert.deepEqual(dismissed, []);
}));

test("update changes content without moving it and restarts the countdown only with a duration", () => withClock(() => {
  notify({ id: "p", kind: "progress", title: "Downloading", progress: 0.1 });
  notify({ id: "q", kind: "info", title: "Other" });
  assert.equal(getNotifications().items[0]!.duration, "sticky", "progress waits for its owner");
  const life = getNotifications().items[0]!.life;
  assert.equal(updateNotification("p", { progress: 0.6 }), true);
  assert.deepEqual(ids(), ["p", "q"], "update keeps its place");
  assert.equal(getNotifications().items[0]!.progress, 0.6);
  assert.equal(getNotifications().items[0]!.life, life, "no restart without a duration");

  updateNotification("p", { kind: "success", title: "Done", progress: null, duration: 2_000 });
  assert.equal(getNotifications().items[0]!.life, life + 1);
  mock.timers.tick(1_999);
  assert.ok(ids().includes("p"));
  mock.timers.tick(1);
  assert.equal(ids().includes("p"), false, "the restarted countdown ran out");
  assert.equal(updateNotification("gone", { title: "x" }), false);
}));

test("only the newest visible cards count down; a waiting one starts when it is promoted", () => withClock(() => {
  const reasons: string[] = [];
  for (let at = 0; at < MAX_VISIBLE + 1; at++) {
    notify({ id: `n${at}`, kind: "success", title: `N${at}`, duration: 1_000 + at, onDismiss: (reason) => reasons.push(`n${at}:${reason}`) });
  }
  mock.timers.tick(1_003);
  // n0 waited (not visible) while n1..n3 ran out; it starts only now.
  assert.deepEqual(ids(), ["n0"]);
  assert.deepEqual(reasons, ["n1:timeout", "n2:timeout", "n3:timeout"]);
  // Its own 1 000 ms run from its promotion, not from when it was shown.
  mock.timers.tick(990);
  assert.deepEqual(ids(), ["n0"]);
  mock.timers.tick(20);
  assert.deepEqual(ids(), []);
}));

test("pausing holds every countdown and resuming continues from what was left", () => withClock(() => {
  notify({ id: "e", kind: "error", title: "Boom" });
  assert.equal(getNotifications().items[0]!.duration, 7_000, "errors keep the 7 s lifetime");
  mock.timers.tick(5_000);
  pauseNotifications("hover");
  assert.equal(getNotifications().paused, true);
  mock.timers.tick(60_000);
  assert.deepEqual(ids(), ["e"], "nothing leaves while the person is on the stack");
  pauseNotifications("focus");
  resumeNotifications("hover");
  mock.timers.tick(60_000);
  assert.deepEqual(ids(), ["e"], "every pause source must end");
  resumeNotifications("focus");
  assert.equal(getNotifications().paused, false);
  mock.timers.tick(1_999);
  assert.deepEqual(ids(), ["e"]);
  mock.timers.tick(1);
  assert.deepEqual(ids(), []);
}));

test("dismissal reports why, sticky stays, and the record cap drops the oldest timed one", () => withClock(() => {
  const reasons: string[] = [];
  const handle = notify({ kind: "update", title: "Polyth 2 is ready", onDismiss: (reason) => reasons.push(reason) });
  assert.match(handle.id, /^notify-/);
  mock.timers.tick(600_000);
  assert.deepEqual(ids(), [handle.id], "updates are sticky by default");
  handle.update({ title: "Restart to update" });
  assert.equal(getNotifications().items[0]!.title, "Restart to update");
  assert.equal(dismissNotification(handle.id, "user"), true);
  assert.equal(dismissNotification(handle.id, "user"), false);
  handle.dismiss();
  assert.deepEqual(reasons, ["user"]);

  notify({ id: "keep", kind: "progress", title: "Sticky" });
  const dropped: string[] = [];
  for (let at = 0; at < MAX_RECORDS; at++) notify({ id: `t${at}`, kind: "info", title: `T${at}`, onDismiss: (reason) => dropped.push(`t${at}:${reason}`) });
  assert.equal(getNotifications().items.length, MAX_RECORDS);
  assert.ok(ids().includes("keep"), "a sticky record outlives the cap");
  assert.deepEqual(dropped, ["t0:overflow"]);
}));

test("an owner's throwing onDismiss never breaks the stack", () => withClock(() => {
  notify({ id: "x", kind: "hint", title: "Tip", onDismiss: () => { throw new Error("owner bug"); } });
  assert.doesNotThrow(() => dismissNotification("x", "user"));
  assert.deepEqual(ids(), []);
}));

test("a folded deck counts down only its front card; folded ones keep what they had left", () => withClock(() => {
  const { setNotificationDeckOpen, notificationRemaining } = store;
  notify({ id: "a", kind: "info", title: "A" });
  notify({ id: "b", kind: "info", title: "B" });
  notify({ id: "c", kind: "info", title: "C" });
  setNotificationDeckOpen(false);
  // (Ticked in two steps: a mocked tick moves the clock to its end first.)
  mock.timers.tick(5_000);
  mock.timers.tick(2_000);
  assert.deepEqual(ids(), ["a", "b"], "only the front card left");
  assert.equal(notificationRemaining("a"), 5_000, "a folded card was never read, so nothing was spent");
  // b became the front when c left (at 5 s) and only then started.
  assert.equal(notificationRemaining("b"), 3_000);
  mock.timers.tick(2_999);
  assert.deepEqual(ids(), ["a", "b"]);
  mock.timers.tick(1);
  assert.deepEqual(ids(), ["a"]);
  setNotificationDeckOpen(true);
  mock.timers.tick(2_000);
  assert.equal(notificationRemaining("a"), 3_000, "the hairline can resume from here");
}));

test("an open deck runs every visible card, and remaining tracks the countdown", () => withClock(() => {
  const { notificationRemaining } = store;
  notify({ id: "a", kind: "info", title: "A", duration: 4_000 });
  notify({ id: "s", kind: "update", title: "Sticky" });
  mock.timers.tick(1_500);
  assert.equal(notificationRemaining("a"), 2_500);
  assert.equal(notificationRemaining("s"), null, "sticky has no countdown");
  assert.equal(notificationRemaining("missing"), null);
}));

test("data keys outside lowercase words and dashes are dropped", () => withClock(() => {
  notify({ id: "d", kind: "info", title: "D", data: { ok: "1", "run-id": "x", "on click": "no", Upper: "no", "a\"b": "no" } });
  assert.deepEqual(getNotifications().items[0]!.data, { ok: "1", "run-id": "x" });
  updateNotification("d", { data: { "bad key": "y" } });
  assert.equal(getNotifications().items[0]!.data, undefined);
}));

test("clear all closes every dismissible notification and keeps the fixed ones", () => withClock(() => {
  const { dismissAllNotifications } = store;
  const reasons: string[] = [];
  for (let at = 0; at < 5; at++) notify({ id: `n${at}`, kind: "info", title: `N${at}`, onDismiss: (reason) => reasons.push(reason) });
  notify({ id: "fixed", kind: "progress", title: "Indexing", dismissible: false });
  assert.equal(dismissAllNotifications("user"), 5);
  assert.deepEqual(ids(), ["fixed"]);
  assert.deepEqual(reasons, ["user", "user", "user", "user", "user"]);
}));
