// The Send press (composer/sendPress.ts): every press ends in exactly one
// outcome, whichever of the platform's event paths reports it and whichever
// of them goes missing. The environment is a bare window that only dispatches
// events, so each case states the exact sequence a device produced.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  SEND_HOLD_GRACE_MS,
  SEND_HOLD_RELEASE_MS,
  SEND_TRAILING_CLICK_MS,
  attachSendPress,
  sendPressReport,
  sendPressTrace,
} from "../src/composer/sendPress.ts";

const RECT = { left: 100, top: 100, right: 136, bottom: 136, width: 36, height: 36 };
const ON = { clientX: 118, clientY: 118 };
const OFF = { clientX: 300, clientY: 300 };

function rig(t: TestContext, options: { holdMs?: number } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 1_000;
  let holdMs = options.holdMs ?? 500;
  const calls: string[] = [];
  const style: Record<string, string> = {};
  const elsewhere = { tagName: "TEXTAREA", classList: { item: () => "editor" } };
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.setTimeout = (run: () => void, ms: number) => setTimeout(run, ms);
  win.clearTimeout = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  const doc = new EventTarget() as EventTarget & Record<string, unknown>;
  const control = {
    ownerDocument: doc,
    dataset: {} as Record<string, string | undefined>,
    style: {
      setProperty: (name: string, value: string) => { style[name] = value; },
      removeProperty: (name: string) => { delete style[name]; },
    },
    disabled: false,
    offsetWidth: 36,
    tagName: "BUTTON",
    contains: (node: unknown) => node === control,
    getAttribute: () => null,
    getBoundingClientRect: () => RECT,
  };
  doc.defaultView = win;
  doc.visibilityState = "visible";
  doc.activeElement = elsewhere;
  doc.elementFromPoint = (x: number, y: number) => (x >= RECT.left && x <= RECT.right && y >= RECT.top && y <= RECT.bottom ? control : elsewhere);
  const detach = attachSendPress(control as unknown as HTMLElement, {
    holdMs: () => holdMs,
    onSend: () => calls.push("send"),
    onDraft: () => calls.push("draft"),
    onCue: () => calls.push("cue"),
    onCueDropped: () => calls.push("cue-dropped"),
  }, { now: () => clock });

  /** Dispatches one event as the page would hear it, stamped `stamp` (the
   *  input's own time; defaults to now). */
  const fire = (type: string, props: Record<string, unknown> = {}, stamp = clock) => {
    const event = new Event(type, { cancelable: true });
    const all: Record<string, unknown> = { target: control, timeStamp: stamp, ...props };
    for (const [name, value] of Object.entries(all)) Object.defineProperty(event, name, { value });
    (type === "visibilitychange" ? doc : win).dispatchEvent(event);
    return event;
  };
  const touch = (at = ON, target: unknown = control) => ({ changedTouches: [{ identifier: 7, target, ...at }] });
  return {
    calls,
    control,
    style,
    elsewhere,
    detach,
    doc,
    setHold: (ms: number) => { holdMs = ms; },
    /** Time passes and the page runs its timers. */
    wait: (ms: number) => {
      // One millisecond at a time, so a timer started by another is due when
      // it would be on a page.
      for (let step = 0; step < ms; step += 1) { clock += 1; t.mock.timers.tick(1); }
    },
    /** Time passes while the page is busy: nothing runs. */
    stall: (ms: number) => { clock += ms; },
    runTimers: (ms: number) => t.mock.timers.tick(ms),
    now: () => clock,
    down: (props: Record<string, unknown> = {}, stamp?: number) => fire("pointerdown", { pointerId: 1, pointerType: "touch", button: 0, ...ON, ...props }, stamp),
    up: (props: Record<string, unknown> = {}, stamp?: number) => fire("pointerup", { pointerId: 1, pointerType: "touch", ...ON, ...props }, stamp),
    cancel: (stamp?: number) => fire("pointercancel", { pointerId: 1, pointerType: "touch", ...ON }, stamp),
    move: (at: { clientX: number; clientY: number }) => fire("pointermove", { pointerId: 1, pointerType: "touch", ...at }),
    touchStart: () => fire("touchstart", touch()),
    touchEnd: (at = ON, stamp?: number) => fire("touchend", touch(at), stamp),
    touchCancel: () => fire("touchcancel", touch()),
    click: (props: Record<string, unknown> = {}) => fire("click", { detail: 1, ...ON, ...props }),
    fire,
  };
}

test("a tap sends once, and the click that follows it does nothing", (t) => {
  const r = rig(t);
  r.down(); r.touchStart();
  r.wait(60);
  r.up(); r.touchEnd();
  const click = r.click();
  assert.deepEqual(r.calls, ["send"]);
  assert.equal(click.defaultPrevented, true, "the spent press's click is cancelled so it cannot act on what Send became");
});

test("a tap whose pointerup never arrives is sent by its touchend", (t) => {
  const r = rig(t);
  r.down(); r.touchStart();
  r.wait(60);
  r.touchEnd();
  r.click();
  assert.deepEqual(r.calls, ["send"]);
});

test("a tap whose every release is lost is sent by its click", (t) => {
  const r = rig(t);
  r.down(); r.touchStart();
  r.wait(90);
  const click = r.click();
  assert.deepEqual(r.calls, ["send"]);
  assert.equal(click.defaultPrevented, false, "this click was the release, not a leftover");
});

test("a click with no press behind it sends: a tap heard only as a click, and the keyboard", (t) => {
  const r = rig(t);
  r.click();
  r.click({ detail: 0, clientX: 0, clientY: 0 });
  assert.deepEqual(r.calls, ["send", "send"]);
});

test("a press heard only through touch events sends", (t) => {
  const r = rig(t);
  r.touchStart();
  r.wait(70);
  r.touchEnd();
  assert.deepEqual(r.calls, ["send"]);
});

test("a hold shows its cue when the length is reached and keeps the draft on release", (t) => {
  const r = rig(t);
  r.down(); r.touchStart();
  r.wait(499);
  assert.deepEqual(r.calls, []);
  r.wait(1);
  assert.deepEqual(r.calls, ["cue"]);
  r.wait(100);
  r.up(); r.touchEnd();
  const click = r.click();
  assert.deepEqual(r.calls, ["cue", "draft"]);
  assert.equal(click.defaultPrevented, true);
});

test("a hold whose release never arrives still keeps the draft", (t) => {
  const r = rig(t);
  r.down(); r.touchStart();
  r.wait(500 + SEND_HOLD_GRACE_MS - 1);
  assert.deepEqual(r.calls, ["cue"]);
  r.wait(1);
  assert.deepEqual(r.calls, ["cue", "draft"]);
  // The finger lifts later, or its events turn up after all: nothing more.
  r.wait(900);
  r.up(); r.touchEnd(); r.click();
  assert.deepEqual(r.calls, ["cue", "draft"]);
});

test("a quick tap whose lift waited out a busy page sends, and its cue is taken back", (t) => {
  const r = rig(t);
  r.down();
  const lifted = r.now() + 60;
  r.stall(700);
  r.runTimers(500);
  assert.deepEqual(r.calls, ["cue"], "the timer ran first, as it can on a page that was busy");
  r.up({}, lifted);
  assert.deepEqual(r.calls, ["cue", "cue-dropped", "send"]);
});

test("a full hold on a busy page keeps the draft even before its cue ran", (t) => {
  const r = rig(t);
  r.down();
  const lifted = r.now() + 800;
  r.stall(900);
  r.up({}, lifted);
  assert.deepEqual(r.calls, ["draft"]);
});

test("a touch the system takes away still sends through its click", (t) => {
  const r = rig(t);
  r.down(); r.touchStart();
  r.wait(40);
  r.cancel(); r.touchCancel();
  assert.deepEqual(r.calls, [], "a cancelled touch is a lost lift, not an outcome");
  r.wait(30);
  r.click();
  assert.deepEqual(r.calls, ["send"]);
});

test("a touch the system takes away mid-hold still keeps its draft", (t) => {
  const r = rig(t);
  r.down(); r.touchStart();
  r.wait(300);
  r.cancel(); r.touchCancel();
  r.wait(200 + SEND_HOLD_GRACE_MS);
  assert.deepEqual(r.calls, ["cue", "draft"]);
});

test("a touch cancelled after the hold was reached keeps the draft at once", (t) => {
  const r = rig(t);
  r.down();
  const cancelled = r.now() + 620;
  r.stall(650);
  r.cancel(cancelled);
  assert.deepEqual(r.calls, ["draft"]);
});

test("a finger that slides off Send before lifting does nothing", (t) => {
  const r = rig(t);
  r.down();
  r.wait(80);
  r.move(OFF);
  r.up(OFF);
  r.wait(2_000);
  assert.deepEqual(r.calls, []);
});

test("a pointer that left Send is not holding it when the hold length passes", (t) => {
  const r = rig(t);
  r.down({ pointerType: "mouse" });
  r.wait(100);
  r.move(OFF);
  r.wait(2_000);
  assert.deepEqual(r.calls, []);
  assert.notEqual(r.control.dataset.sendHold, "full");
});

test("a finger that settles a few pixels past the disc still sends", (t) => {
  const r = rig(t);
  r.down({ clientX: 138, clientY: 118 });
  r.wait(60);
  r.up({ clientX: 141, clientY: 120 });
  assert.deepEqual(r.calls, ["send"]);
});

test("a new press elsewhere ends an open one without an outcome", (t) => {
  const r = rig(t);
  r.down();
  r.wait(100);
  r.fire("pointerdown", { pointerId: 2, pointerType: "touch", button: 0, target: r.elsewhere, ...OFF });
  r.wait(2_000);
  assert.deepEqual(r.calls, []);
});

test("a page that goes to the background ends an open press without an outcome", (t) => {
  const r = rig(t);
  r.down();
  r.wait(100);
  r.doc.visibilityState = "hidden";
  r.fire("visibilitychange");
  r.wait(2_000);
  assert.deepEqual(r.calls, []);
});

test("with the hold off, however long the press, it sends and draws no ring", (t) => {
  const r = rig(t, { holdMs: 0 });
  r.down();
  assert.equal(r.control.dataset.sendHold, undefined);
  r.wait(2_500);
  r.up();
  assert.deepEqual(r.calls, ["send"]);
});

test("a disabled Send and a secondary mouse button start nothing", (t) => {
  const r = rig(t);
  r.down({ pointerType: "mouse", button: 2 });
  r.up({ pointerType: "mouse" });
  r.control.disabled = true;
  r.down();
  r.wait(60);
  r.up();
  r.wait(2_000);
  assert.deepEqual(r.calls, []);
});

test("a mouse press sends on release, once", (t) => {
  const r = rig(t);
  r.down({ pointerType: "mouse" });
  r.wait(80);
  r.up({ pointerType: "mouse" });
  r.click();
  assert.deepEqual(r.calls, ["send"]);
});

test("a click long after a press ended is a new tap", (t) => {
  const r = rig(t);
  r.down();
  r.wait(60);
  r.up();
  r.wait(SEND_TRAILING_CLICK_MS + 1);
  const click = r.click();
  assert.deepEqual(r.calls, ["send", "send"]);
  assert.equal(click.defaultPrevented, false);
});

test("the ring winds from the press's real age, stands whole at the hold, and fades on release", (t) => {
  const r = rig(t);
  const pressed = r.now();
  r.stall(120);
  r.down({}, pressed);
  assert.equal(r.control.dataset.sendHold, "arming");
  assert.equal(r.style["--send-hold-age"], "-120ms");
  r.wait(380);
  assert.equal(r.control.dataset.sendHold, "full", "the cue comes when the press itself is 500 ms old");
  r.up();
  assert.equal(r.control.dataset.sendHold, "release");
  r.wait(SEND_HOLD_RELEASE_MS);
  assert.equal(r.control.dataset.sendHold, undefined);
  assert.equal(r.style["--send-hold-age"], undefined);
});

test("a Send that is replaced right after its press still swallows that press's click", (t) => {
  const r = rig(t);
  r.down();
  r.wait(60);
  r.up();
  r.detach();
  const leftover = r.click({ target: r.elsewhere });
  assert.equal(leftover.defaultPrevented, true, "the click lands where Send stood, on whatever stands there now");
  const next = r.click({ target: r.elsewhere });
  assert.equal(next.defaultPrevented, false);
  assert.deepEqual(r.calls, ["send"]);
});

test("a detached Send hears nothing", (t) => {
  const r = rig(t);
  r.detach();
  r.down(); r.wait(60); r.up(); r.click();
  assert.deepEqual(r.calls, []);
});

test("the trace names the events of a press and its outcome, and nothing else", (t) => {
  const r = rig(t);
  r.down(); r.touchStart();
  r.wait(60);
  r.touchEnd();
  const last = sendPressTrace().split("\n").at(-1) ?? "";
  assert.match(last, /touch hold=500 focus=textarea\.editor pointerdown@0 touchstart@0 touchend@60 > send \(touchend\)$/);
});

test("a press that lands beside Send on something else is traced as a near miss", (t) => {
  const r = rig(t);
  r.fire("pointerdown", { pointerId: 3, pointerType: "touch", button: 0, target: r.elsewhere, clientX: 118, clientY: 90 });
  assert.match(sendPressTrace().split("\n").at(-1) ?? "", /near .* > on textarea\.editor 0,-10$/);
  assert.deepEqual(r.calls, []);
});

test("the report a person copies names the build context and lists the presses, oldest first", (t) => {
  const r = rig(t);
  r.down();
  r.wait(60);
  r.up();
  const report = sendPressReport(new Date("2026-11-25T10:00:00.000Z")).split("\n");
  assert.equal(report[0], "Polyth Send diagnostics");
  assert.equal(report[1], "Time: 2026-11-25T10:00:00.000Z");
  assert.match(report.at(-1) ?? "", /^\d\d-\d\dT[\d:.]+ touch hold=500 .*pointerdown@0 pointerup@60 > send \(pointerup\)$/);
});
