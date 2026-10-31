import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  matchMedia: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
for (const name of ["Element", "HTMLElement", "MutationObserver"] as const) {
  Object.defineProperty(globalThis, name, {
    value: dom[name],
    configurable: true,
  });
}

interface RecordedAnimation {
  element: HTMLElement;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  cancelled: boolean;
}

const recorded: RecordedAnimation[] = [];
Object.defineProperty(dom.HTMLElement.prototype, "animate", {
  configurable: true,
  value(this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
    const record: RecordedAnimation = { element: this, frames, options, cancelled: false };
    recorded.push(record);
    let finish!: () => void;
    let finishedOnce = false;
    const finished = new Promise<void>((resolve) => {
      finish = () => {
        if (finishedOnce) return;
        finishedOnce = true;
        resolve();
      };
    });
    const timer = setTimeout(finish, 0);
    const animation = {
      playState: "running",
      finished,
      cancel() {
        record.cancelled = true;
        this.playState = "idle";
        clearTimeout(timer);
        finish();
      },
    };
    void finished.then(() => {
      if (animation.playState === "running") animation.playState = "finished";
    });
    return animation as unknown as Animation;
  },
});

const rewindMotion = await import("../src/rewindMotion.ts");
const {
  beginRegenerateMotion,
  beginRestoreMotion,
  pendingRewindMotion,
  settleRewindMotion,
} = rewindMotion;

function rect(top: number, height: number): DOMRect {
  return {
    top,
    right: 600,
    bottom: top + height,
    left: 40,
    width: 560,
    height,
    x: 40,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function timeline(): HTMLElement {
  const node = dom.document.createElement("div");
  const el = node as unknown as HTMLElement;
  el.className = "timeline";
  el.getBoundingClientRect = () => rect(0, 500);
  dom.document.body.appendChild(node);
  return el;
}

function row(className: string, top: number, height = 40): HTMLElement {
  const el = dom.document.createElement("div") as unknown as HTMLElement;
  el.className = className;
  el.getBoundingClientRect = () => rect(top, height);
  return el;
}

test("revert has no click-time choreography here: the timeline owns its exit", () => {
  recorded.length = 0;
  const el = timeline();
  const marker = row("rewind-marker", 100, 32);
  el.append(marker);

  // Clicking Revert fades and captures nothing. The confirmed cut leaves in
  // place and the survivors glide in Timeline (timelineMotion.test.ts pins
  // exit → removal → glide → marker), so a confirmed marker settles nothing
  // in this module.
  assert.equal("beginRevertMotion" in rewindMotion, false);
  assert.equal(pendingRewindMotion(), null);
  assert.equal(settleRewindMotion(el, { sessionId: "s", rewindAtSeq: 2, echoIds: [] }), null);
  assert.equal(recorded.length, 0);
});

test("regenerate moves its optimistic prompt from the source pixels without a second entrance", async () => {
  recorded.length = 0;
  const el = timeline();
  const prompt = row("msg user", 100);
  prompt.dataset.messageSeq = "2";
  const answer = row("msg assistant", 160, 80);
  el.append(prompt, answer);

  assert.equal(beginRegenerateMotion("s", 2, el), true);
  prompt.remove();
  answer.remove();
  const echo = row("msg user msg-pending", 84);
  echo.dataset.pendingSend = "pending-1";
  el.append(echo);

  const settled = settleRewindMotion(el, { sessionId: "s", rewindAtSeq: 2, echoIds: ["pending-1"] });
  assert.ok(settled);
  await settled;
  const echoAnimations = recorded.filter(({ element }) => element === echo);
  assert.equal(echoAnimations.length, 1);
  assert.equal(echoAnimations[0]?.options.fill, "both");
  assert.match(String(echoAnimations[0]?.frames[0]?.transform), /16px/);
});

test("restore reveals the original tail with the same bounded entrance", async () => {
  recorded.length = 0;
  const el = timeline();
  const marker = row("rewind-marker", 100, 32);
  el.append(marker);
  assert.equal(beginRestoreMotion("s", 2, el), true);
  marker.remove();
  const restoredPrompt = row("msg user", 100);
  restoredPrompt.dataset.messageSeq = "2";
  const restoredAnswer = row("msg assistant", 160, 80);
  el.append(restoredPrompt, restoredAnswer);

  const settled = settleRewindMotion(el, { sessionId: "s", rewindAtSeq: null, echoIds: [] });
  assert.ok(settled);
  await settled;
  assert.equal(recorded.filter(({ element }) => element === restoredPrompt || element === restoredAnswer).length, 2);
  assert.ok(recorded.every(({ options }) => options.duration === 180));
});
