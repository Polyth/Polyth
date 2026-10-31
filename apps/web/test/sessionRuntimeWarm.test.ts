import assert from "node:assert/strict";
import test from "node:test";
import { createSessionRuntimeWarm } from "../src/sessionRuntimeWarm.ts";

function rig(options: { failWarm?: boolean } = {}) {
  let clock = 0;
  let active: string | null = "a";
  let visible = true;
  const calls: Array<[string, "open" | "warm"]> = [];
  const errors: string[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 1;
  const warm = createSessionRuntimeWarm({
    activate: async (sessionId, intent) => {
      calls.push([sessionId, intent]);
      if (intent === "warm" && options.failWarm) throw new Error("warm failed");
    },
    activeSessionId: () => active,
    visible: () => visible,
    onOpenError: (sessionId) => { errors.push(sessionId); },
    now: () => clock,
    setTimer: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, callback });
      return id;
    },
    clearTimer: (handle) => { timers.delete(handle as number); },
    dwellMs: 20_000,
    throttleMs: 60_000,
  });
  const advance = async (ms: number) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.callback();
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    warm, calls, errors, advance,
    pendingTimers: () => timers.size,
    setActive: (id: string | null) => { active = id; },
    setVisible: (value: boolean) => { visible = value; },
  };
}

test("opening a chat asks only for the open pass; the runtime warms after the dwell", async () => {
  const r = rig();
  r.warm.opened("a");
  assert.deepEqual(r.calls, [["a", "open"]]);
  await r.advance(19_999);
  assert.deepEqual(r.calls, [["a", "open"]], "no warm before the dwell");
  await r.advance(1);
  assert.deepEqual(r.calls, [["a", "open"], ["a", "warm"]]);
});

test("browsing through chats warms none of them", async () => {
  const r = rig();
  for (const id of ["a", "b", "c", "d"]) {
    r.setActive(id);
    r.warm.opened(id);
    await r.advance(3_000);
  }
  r.setActive(null);
  await r.advance(60_000);
  assert.deepEqual(r.calls.map(([, intent]) => intent), ["open", "open", "open", "open"]);
  assert.equal(r.pendingTimers(), 0);
});

test("leaving a chat before the dwell or hiding the app skips its warm", async () => {
  const r = rig();
  r.warm.opened("a");
  r.setActive("b");
  await r.advance(20_000);
  assert.deepEqual(r.calls, [["a", "open"]], "a chat no longer shown is not warmed");

  const hidden = rig();
  hidden.warm.opened("a");
  hidden.setVisible(false);
  await hidden.advance(20_000);
  assert.deepEqual(hidden.calls, [["a", "open"]], "a backgrounded app warms nothing");
});

test("typing warms at once, then at most once per throttle window", async () => {
  const r = rig();
  r.warm.opened("a");
  r.warm.typing("a");
  assert.deepEqual(r.calls, [["a", "open"], ["a", "warm"]]);
  await r.advance(20_000);
  r.warm.typing("a");
  assert.equal(r.calls.length, 2, "the dwell is cancelled and typing inside the window is free");
  await r.advance(40_000);
  r.warm.typing("a");
  assert.deepEqual(r.calls.at(-1), ["a", "warm"], "a new window warms again and keeps the runtime alive");
  assert.equal(r.calls.length, 3);
  r.warm.typing("b");
  assert.equal(r.calls.length, 3, "only the chat on screen is warmed");
});

test("a failed warm stays silent and lets the next keystroke retry; a failed open is reported", async () => {
  const r = rig({ failWarm: true });
  r.warm.opened("a");
  r.warm.typing("a");
  await r.advance(0);
  r.warm.typing("a");
  assert.deepEqual(r.calls.map(([, intent]) => intent), ["open", "warm", "warm"]);
  assert.deepEqual(r.errors, []);

  let opened = 0;
  const failing = createSessionRuntimeWarm({
    activate: async () => { opened += 1; throw new Error("open failed"); },
    activeSessionId: () => "a",
    visible: () => true,
    onOpenError: (sessionId) => { r.errors.push(sessionId); },
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  failing.opened("a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened, 1);
  assert.deepEqual(r.errors, ["a"]);
});
