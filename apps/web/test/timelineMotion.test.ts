// Chat timeline motion contract, mounted for real: store → reduce → Timeline
// over happy-dom with a small layout model (a 600px scroller whose direct rows
// stack with a 16px gap). The model gives the follow engine real geometry to
// decide on and FLIP deltas to measure; WAAPI is recorded, never rendered.
//
// Pins (packet A/A2): a followed stage fold never lowers scrollTop; streamed
// prose fills down to the composer edge without moving the rows above; a turn
// end settles with one downward glide after its beat for an overflowing chat,
// while a short chat does not drop its whole transcript; a send inside the
// beat cancels it; a confirmed revert fades its rows in place (same DOM), then
// one commit removes them and the survivors glide, and only then do the
// marker and the restored draft appear. Opening a chat (A3): a saved reading
// position is the first painted position; a detached reader's row survives
// late layout and the earlier-history host leaving; a live session lands in
// the live layout, an idle one on the composer edge. A long session's sliding
// window and a tall live fold never lift the live tail out of the reading area.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { Window } from "happy-dom";
import { api } from "@polyth/session/web-api";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: dom.sessionStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Per spec, `toggle(token, force)` that changes nothing writes no attribute and
// queues no mutation; happy-dom queues one, which would loop the timeline's
// class observer through every refresh.
const tokenList = Object.getPrototypeOf(dom.document.createElement("div").classList) as DOMTokenList;
const toggleToken = tokenList.toggle;
tokenList.toggle = function toggle(this: DOMTokenList, token: string, force?: boolean) {
  if (force !== undefined && this.contains(token) === force) return force;
  return toggleToken.call(this, token, force);
};

// ---- layout model ------------------------------------------------------------

const VIEW_HEIGHT = 600;
const ROW_GAP = 16;
const PAD_TOP = 24;
const PAD_BOTTOM = 40;
const scrollTops = new WeakMap<object, number>();
// The status dock leaving at completion increases the real scrollport height.
const viewportHeight = (el: HTMLElement) => VIEW_HEIGHT + cssPx(el, "--test-viewport-growth")
  + cssPx(el.closest(".focus-conversation")?.querySelector<HTMLElement>(".conversation-composer-dock") ?? el, "--test-dock-growth");

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}
function cssPx(el: HTMLElement, name: string): number {
  return Number.parseFloat(el.style.getPropertyValue(name)) || 0;
}
function rowHeight(row: HTMLElement): number {
  if (row.classList.contains("sr-only") || row.hasAttribute("hidden")) return 0;
  // Late layout (an image or code block settling) in a row the test grows.
  if (row.classList.contains("test-late-growth")) return 40 + rowHeightBase(row);
  return rowHeightBase(row) + (row.classList.contains("test-fractional-tall") ? 0.7
    : row.classList.contains("test-fractional-short") ? 0.3 : 0);
}
function rowHeightBase(row: HTMLElement): number {
  if (row.matches(".timeline-earlier")) return 36;
  // A tall block (the reader opened it), when the test asks.
  if (row.matches(".activity-group")) return row.classList.contains("test-tall-row") ? 400 : 44;
  if (row.matches(".execution-row, .task-activity")) return 40;
  if (row.matches(".msg.user")) return 60;
  if (row.matches(".msg.assistant")) return 40 + 20 * Math.ceil((row.textContent ?? "").length / 60);
  if (row.matches(".rewind-marker")) return 32;
  if (row.matches(".test-approval-card")) return 180;
  return 0;
}
function layout(timeline: HTMLElement): { tops: Map<Element, number>; contentBottom: number; scrollHeight: number } {
  const tops = new Map<Element, number>();
  let cursor = PAD_TOP;
  let placed = false;
  for (const child of Array.from(timeline.children) as HTMLElement[]) {
    if (child.classList.contains("timeline-extent-floor")) continue;
    const height = rowHeight(child);
    if (height <= 0) continue;
    if (placed) cursor += ROW_GAP;
    tops.set(child, cursor);
    cursor += height;
    placed = true;
  }
  const scrollHeight = cursor + cssPx(timeline, "--timeline-extent-floor") + PAD_BOTTOM
    + cssPx(timeline, "--timeline-turn-sheet-space");
  return { tops, contentBottom: cursor, scrollHeight: Math.max(scrollHeight, viewportHeight(timeline)) };
}
/** Every scrollTop write on a timeline, to prove a first frame has no detour. */
const scrollWrites: number[] = [];
/** Chromium at scale 1 rounds CSSOM scroll pixels; shrinking extent clamps them. */
function scrollTopOf(el: HTMLElement): number {
  const raw = scrollTops.get(el) ?? 0;
  if (!el.classList.contains("timeline")) return raw;
  const clamped = Math.max(0, Math.min(raw, Math.round(layout(el).scrollHeight) - viewportHeight(el)));
  scrollTops.set(el, clamped);
  return clamped;
}
const proto = dom.HTMLElement.prototype as unknown as HTMLElement;
Object.defineProperty(proto, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) { return this.classList.contains("timeline") ? viewportHeight(this) : 0; },
});
Object.defineProperty(proto, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) { return this.classList.contains("timeline")
      ? Math.round(layout(this).scrollHeight) + (this.classList.contains("test-transform-overflow") ? 160 : 0) : 0; },
});
Object.defineProperty(proto, "scrollTop", {
  configurable: true,
  get(this: HTMLElement) { return scrollTopOf(this); },
  set(this: HTMLElement, value: number) {
    scrollTops.set(this, Math.round(value));
    const clamped = scrollTopOf(this);
    if (this.classList.contains("timeline")) scrollWrites.push(clamped);
  },
});
// Layout offsets inside the scroller: content coordinates, scroll-independent.
Object.defineProperty(proto, "offsetTop", {
  configurable: true,
  get(this: HTMLElement) {
    const timeline = this.parentElement;
    if (!timeline?.classList.contains("timeline")) return 0;
    // The floor's negative margin cancels its gap: it starts at the content end.
    const { tops, contentBottom } = layout(timeline);
    return this.classList.contains("timeline-extent-floor") ? contentBottom : tops.get(this) ?? 0;
  },
});
Object.defineProperty(proto, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.parentElement?.classList.contains("timeline") ? rowHeight(this) : 0;
  },
});
Object.defineProperty(proto, "getBoundingClientRect", {
  configurable: true,
  value(this: HTMLElement) {
    if (this.classList.contains("timeline")) return rect(0, viewportHeight(this));
    const timeline = this.parentElement;
    if (timeline?.classList.contains("timeline")) {
      const { tops, contentBottom } = layout(timeline);
      const scrollTop = scrollTopOf(timeline);
      if (this.classList.contains("timeline-extent-floor")) {
        return rect(contentBottom - scrollTop, cssPx(timeline, "--timeline-extent-floor"));
      }
      const top = tops.get(this);
      if (top !== undefined) return rect(top - scrollTop, rowHeight(this));
    }
    return rect(0, 0);
  },
});

interface RecordedAnimation {
  element: HTMLElement;
  frames: Keyframe[];
  duration: number;
  cancelled: boolean;
}
const recorded: RecordedAnimation[] = [];
Object.defineProperty(proto, "animate", {
  configurable: true,
  value(this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
    const record: RecordedAnimation = { element: this, frames, duration: Number(options.duration ?? 0), cancelled: false };
    recorded.push(record);
    let settle!: () => void;
    const finished = new Promise<void>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => {
      animation.playState = "finished";
      settle();
    }, record.duration);
    const animation = {
      id: options.id ?? "",
      playState: "running",
      finished,
      effect: null,
      cancel() {
        clearTimeout(timer);
        record.cancelled = true;
        animation.playState = "idle";
        settle();
      },
    };
    return animation as unknown as Animation;
  },
});
/** Vertical start offset of a FLIP (negative: the row travels down). */
const travel = (animation: RecordedAnimation) =>
  Number(/translate3d\(0, (-?[\d.]+)px/.exec(String(animation.frames[0]?.transform))?.[1] ?? Number.NaN);

// ---- app under test -----------------------------------------------------------

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Timeline } = await import("../src/components/Timeline.tsx");
const {
  activateProject,
  activateSession,
  applyEvent,
  beginPendingSend,
  getState,
  reduceSessionModel,
  setSessions,
  useStore,
} = await import("../src/store.ts");
const { drainComposerReplacement } = await import("../src/composerInsert.ts");
const { TIMELINE_SETTLE_DURATION_MS } = await import("../src/timelineLift.ts");
const { getUiSettings, setUiSettings } = await import("../src/uiPrefs.ts");
const { loadOlderEvents } = await import("../src/init.ts");
const { registerSlot } = await import("../src/slots.ts");

// As in styles.css, the surface publishes its tail clearance (the bottom
// runway without reserve) as the scroller's bottom scroll padding.
const clearanceRule = document.createElement("style");
clearanceRule.textContent = `.timeline { scroll-padding-bottom: ${PAD_BOTTOM}px; }`;
document.head.appendChild(clearanceRule);

const PROJECT = "timeline-motion";
const REWIND_EXIT_MS = 220;
const REWIND_GLIDE_MS = 280;
const TURN_END_SETTLE_WAIT_MS = 150;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const LONG = "A settled synthetic answer that wraps across several lines of the reading column. ".repeat(4);

api.queueList = async () => [];

interface SeedTools {
  event: (type: string, data: JsonObject) => SessionEvent;
  turn: (n: number, prompt: string, answer?: string) => SessionEvent[];
}
let sessionSeq = 0;
/** Mount a session. `seed` events are in the store before the first render,
 *  like a cached or hydrated session being opened; `anchor` is its saved
 *  reading position. */
async function mountTimeline(options: {
  seed?: (tools: SeedTools) => SessionEvent[];
  anchor?: (seeded: SessionEvent[]) => { id: string | null; offset: number; atBottom: boolean };
  live?: boolean;
} = {}) {
  const sessionId = `timeline-motion-${++sessionSeq}`;
  let seq = 0;
  const surface = document.createElement("div");
  surface.className = "focus-conversation";
  const host = document.createElement("div");
  const dock = document.createElement("div");
  dock.className = "conversation-composer-dock";
  surface.append(host, dock);
  document.body.appendChild(surface);
  const root = createRoot(host);
  const event = (type: string, data: JsonObject): SessionEvent => {
    seq += 1;
    return { id: `ev-${sessionId}-${seq}`, sessionId, seq, time: Date.now(), type, data, v: 1 } as SessionEvent;
  };
  const LiveTimeline = () => {
    const events = useStore((state) => state.events[sessionId]);
    return createElement(Timeline, { model: reduceSessionModel(sessionId, events ?? []) });
  };
  const render = () => options.live ? root.render(createElement(LiveTimeline)) : root.render(createElement(Timeline, {
    model: reduceSessionModel(sessionId, getState().events[sessionId] ?? []),
  }));
  const push = async (...events: SessionEvent[]) => {
    await act(async () => {
      for (const ev of events) applyEvent(ev);
      render();
    });
  };
  const turn = (n: number, prompt: string, answer = LONG) => {
    const user = event("user/message", { text: prompt });
    return [
      user,
      event("turn/started", { turnId: `${sessionId}-t${n}` }),
      event("assistant/message", { partId: `${sessionId}-p${n}`, text: answer }),
      event("turn/stopped", { turnId: `${sessionId}-t${n}`, reason: "completed" }),
    ];
  };
  const seeded = options.seed?.({ event, turn }) ?? [];
  const anchor = options.anchor?.(seeded);
  if (anchor) sessionStorage.setItem(`polyth.timelineAnchor.${sessionId}`, JSON.stringify(anchor));
  scrollWrites.length = 0;
  await act(async () => {
    activateProject(PROJECT);
    setSessions(PROJECT, [{ id: sessionId, projectId: PROJECT, title: "Motion", status: "idle", createdAt: 1, updatedAt: 1 }]);
    activateSession(sessionId);
    for (const ev of seeded) applyEvent(ev);
    render();
  });
  const timeline = () => host.querySelector<HTMLElement>(".timeline")!;
  return {
    sessionId,
    event,
    push,
    turn,
    timeline,
    reserve: () => cssPx(timeline(), "--timeline-turn-sheet-space"),
    floor: () => cssPx(timeline(), "--timeline-extent-floor"),
    maxScrollTop: () => timeline().scrollHeight - timeline().clientHeight,
    async wait(ms: number) {
      await act(async () => { await sleep(ms); });
    },
    async cleanup() {
      await act(async () => {
        activateSession(null);
        setSessions(PROJECT, []);
      });
      await act(async () => root.unmount());
      surface.remove();
    },
  };
}

test("while following, a live step swaps in its block's own line: the transcript never moves", async () => {
  const t = await mountTimeline();
  try {
    await t.push(...t.turn(1, "Seed prompt one."), ...t.turn(2, "Seed prompt two."));
    await t.push(t.event("user/message", { text: "Run the tools." }), t.event("turn/started", { turnId: "live" }));
    await t.push(t.event("tool/call", { callId: "c1", tool: "list", input: { path: "." } }));
    const block = () => [...t.timeline().querySelectorAll<HTMLElement>(":scope > .activity-group")].at(-1)!;
    const entry = () => block().querySelector<HTMLElement>(".activity-ticker")?.dataset.tickerEntry;
    const first = entry();
    assert.ok(first && first !== "summary", "the working block names its step in its own line");
    const scrollTop = t.timeline().scrollTop;
    const blockTop = block().getBoundingClientRect().top;
    const before = recorded.length;
    await t.push(t.event("tool/result", { callId: "c1", tool: "list", output: "README.md" }));
    await t.push(t.event("tool/call", { callId: "c2", tool: "read", input: { path: "README.md" } }));
    for (let elapsed = 0; elapsed < 1_200; elapsed += 150) {
      await t.wait(150);
      assert.equal(t.timeline().scrollTop, scrollTop, "no scroll while the line swaps");
      assert.equal(block().getBoundingClientRect().top, blockTop, "the block keeps its place");
    }
    assert.notEqual(entry(), first, "the newest step took the line");
    assert.equal(t.timeline().children.length > 0 && t.timeline().querySelector(".activity-live-stage") === null, true,
      "no live row exists beside the block");
    assert.equal(t.floor(), 0, "nothing folded, so no blank is held");
    assert.equal(recorded.slice(before).filter((animation) => Math.abs(travel(animation)) > 0).length, 0,
      "no row travels");
  } finally {
    await t.cleanup();
  }
});

test("an ungrouped tool on screen stays still while actions land below it, then glides with the transcript", async () => {
  const previous = getUiSettings();
  setUiSettings({ actionGrouping: "ungrouped", thinkingDisplayMode: "expanded" });
  const t = await mountTimeline({ seed: ({ turn }) => [...turn(1, "Seed one."), ...turn(2, "Seed two.")] });
  try {
    await t.push(t.event("user/message", { text: "Inspect files." }), t.event("turn/started", { turnId: "tools" }));
    await t.push(t.event("tool/call", { callId: "first", tool: "read", input: { path: "a.ts" } }));
    await t.wait(300);
    const row = t.timeline().querySelector<HTMLElement>(":scope > .execution-row")!;
    assert.ok(row);
    let glided = false;
    for (let call = 0; call < 12 && !glided; call += 1) {
      const top = row.getBoundingClientRect().top;
      const scrollTop = t.timeline().scrollTop;
      const before = recorded.length;
      await t.push(t.event("tool/call", { callId: `next-${call}`, tool: "read", input: { path: `b${call}.ts` } }));
      const moved = t.timeline().scrollTop - scrollTop;
      if (moved === 0) {
        assert.equal(row.getBoundingClientRect().top, top, "a row lands below without moving the rows above it");
        continue;
      }
      assert.ok(moved > 0, "the view only ever follows down the transcript");
      if (moved < 24) continue;
      const lift = recorded.slice(before).find((animation) => animation.element === row);
      assert.ok(lift, "an existing standalone tool is included in the shared lift");
      assert.equal(travel(lift), top - row.getBoundingClientRect().top, "the row starts at its previous pixels, not a snapped position");
      assert.ok(travel(lift) > 0);
      glided = true;
    }
    assert.ok(glided, "the tail reached the composer edge and the view followed it");
  } finally {
    await t.cleanup();
    setUiSettings(previous);
  }
});

test("streamed prose fills down: rows above stay still until the tail reaches the composer edge", async () => {
  const t = await mountTimeline();
  try {
    await t.push(...t.turn(1, "Seed prompt one."), ...t.turn(2, "Seed prompt two."));
    await t.push(t.event("user/message", { text: "Answer at length." }), t.event("turn/started", { turnId: "live" }));
    assert.ok(t.reserve() > 0, "a live turn reserves the space below the focus line");
    const first = t.event("assistant/chunk", { partId: "answer", text: "First words." });
    await t.push(first);
    const landed = t.timeline().scrollTop;
    const answer = t.timeline().querySelector<HTMLElement>(`:scope > .msg.assistant[data-message-seq="${first.seq}"]`)!;
    assert.ok(answer, "the streamed answer row is mounted");
    const prompt = [...t.timeline().querySelectorAll<HTMLElement>(":scope > .msg.user")].at(-1)!;
    assert.equal(prompt.getBoundingClientRect().bottom, VIEW_HEIGHT / 2, "the prompt rests on the focus line");
    assert.equal(answer.getBoundingClientRect().top, VIEW_HEIGHT / 2 + ROW_GAP, "the new answer lands right under it");
    // The composer edge: the visible bottom less the tail clearance.
    const restLine = VIEW_HEIGHT - PAD_BOTTOM;
    const tops: number[] = [];
    let text = "First words.";
    let grownAfterBottom = 0;
    for (let step = 0; step < 80 && grownAfterBottom < 4; step += 1) {
      const delta = " More streamed words for the growing answer.";
      text += delta;
      await t.push(t.event("assistant/chunk", { partId: "answer", text: delta }));
      const row = answer.getBoundingClientRect();
      const scrollTop = t.timeline().scrollTop;
      if (scrollTop === landed) {
        // Rows above have not moved: the prose is still growing into the reserve.
        assert.ok(row.bottom <= restLine + 0.5, `the prose grew past the edge without follow (${row.bottom})`);
      } else {
        // The view moves only to keep the reached tail on the composer edge.
        grownAfterBottom += 1;
        assert.ok(Math.abs(row.bottom - restLine) <= 0.5, `the growing tail stays on the composer edge (${row.bottom})`);
      }
      tops.push(scrollTop);
    }
    assert.ok(grownAfterBottom > 0, "the answer grew past the visible bottom");
    assert.ok(tops.every((top, index) => index === 0 || top >= tops[index - 1]!), `follow never moved down: ${tops.join(", ")}`);
    // The canonical final message re-stamps the row's event seq. It is still
    // the same row, so it moves nothing.
    const beforeFinal = t.timeline().scrollTop;
    await t.push(t.event("assistant/message", { partId: "answer", text }));
    assert.ok(answer.isConnected, "the final message keeps the streamed row");
    assert.equal(t.timeline().scrollTop, beforeFinal, "the final message moves nothing");
    // A long answer ends on the composer edge: the turn end has nothing to glide.
    const before = recorded.length;
    await t.push(t.event("turn/stopped", { turnId: "live", reason: "completed" }));
    await t.wait(TURN_END_SETTLE_WAIT_MS + TIMELINE_SETTLE_DURATION_MS + 60);
    assert.equal(t.reserve(), 0);
    assert.equal(recorded.slice(before).filter((animation) => animation.duration === TIMELINE_SETTLE_DURATION_MS).length, 0,
      "no extra motion after a long answer");
  } finally {
    await t.cleanup();
  }
});

test("an overflowing turn end moves nothing; a send inside the beat cancels the handover", async () => {
  const t = await mountTimeline();
  try {
    await t.push(...t.turn(1, "Seed prompt one."), ...t.turn(2, "Seed prompt two."));
    await t.push(t.event("user/message", { text: "Short answer please." }), t.event("turn/started", { turnId: "a" }));
    await t.push(t.event("assistant/message", { partId: "short-a", text: "Done." }));
    const resting = t.timeline().scrollTop;
    const rows = () => [...t.timeline().querySelectorAll<HTMLElement>(":scope > .msg")].map((row) => row.getBoundingClientRect().top);
    const restingRows = rows();
    assert.ok(t.reserve() > 0 && resting < t.maxScrollTop(), "a short answer sits under its prompt with the reserve below");
    let before = recorded.length;
    await t.push(t.event("turn/stopped", { turnId: "a", reason: "completed" }));
    await t.wait(TURN_END_SETTLE_WAIT_MS + 60);
    assert.equal(t.reserve(), 0, "the turn's reserve is handed over");
    assert.ok(t.floor() > 0, "the blank the reader sees under the answer is held");
    assert.equal(t.timeline().scrollTop, resting, "the reader's position is kept");
    assert.equal(t.timeline().scrollTop, t.maxScrollTop(), "and the extent ends exactly at it: nothing below to scroll into");
    assert.deepEqual(rows(), restingRows, "no row moved when the turn ended");
    assert.equal(recorded.slice(before).length, 0, "no glide, up or down");

    // Next turn: a send inside the beat cancels the pending handover outright.
    await t.push(t.event("user/message", { text: "Another short one." }), t.event("turn/started", { turnId: "b" }));
    assert.equal(t.floor(), 0, "a new turn drops the held blank");
    await t.push(t.event("assistant/message", { partId: "short-b", text: "Also done." }));
    await t.push(t.event("turn/stopped", { turnId: "b", reason: "completed" }));
    const endTop = t.timeline().scrollTop;
    before = recorded.length;
    await t.wait(TURN_END_SETTLE_WAIT_MS - 100);
    await act(async () => {
      beginPendingSend({ sessionId: t.sessionId, text: "Follow-up inside the beat.", attachments: [] });
    });
    await t.push();
    await t.wait(TURN_END_SETTLE_WAIT_MS + 120);
    assert.ok(recorded.slice(before).every((animation) => !(travel(animation) < 0)), "nothing glides down after the send");
    assert.ok(t.reserve() > 0, "the new turn owns the reserve");
    assert.ok(t.timeline().scrollTop >= endTop, "no down-then-up: the send only lifts");
  } finally {
    await t.cleanup();
  }
});

for (const previousTurn of [false, true]) for (const reducedMotion of [false, true]) for (const growingViewport of [false, true]) {
test(`a short transcript (${previousTurn ? "over" : "under"} half a viewport, motion ${reducedMotion ? "off" : "on"}${growingViewport ? ", viewport grows" : ""}) stays in place when the turn ends`, async () => {
  document.documentElement.dataset.reduceAnimations = String(reducedMotion);
  const t = await mountTimeline({ seed: previousTurn ? ({ turn }) => turn(1, "Earlier prompt.") : undefined });
  try {
    await t.push(t.event("user/message", { text: "Short prompt." }), t.event("turn/started", { turnId: "short" }));
    await t.push(t.event("assistant/message", { partId: "short-answer", text: "Done." }));
    const beforeEnd = t.timeline().scrollTop;
    const rowsBeforeEnd = [...t.timeline().querySelectorAll<HTMLElement>(":scope > .msg")]
      .map((row) => row.getBoundingClientRect().top);
    assert.ok(t.reserve() > 0, "the live turn still owns its focus-line reserve");
    const naturalHeight = layout(t.timeline()).contentBottom + PAD_BOTTOM;
    assert.ok(naturalHeight < VIEW_HEIGHT, "all messages fit without the artificial reserve");
    if (previousTurn) {
      assert.ok(naturalHeight > VIEW_HEIGHT / 2, "the transcript crosses the focus line");
      assert.ok(beforeEnd > 0, "the live reserve created a scroll offset that must survive completion");
    }

    const before = recorded.length;
    // In the real surface the working-status dock leaves in the same commit.
    if (growingViewport) t.timeline().style.setProperty("--test-viewport-growth", "52px");
    await t.push(t.event("turn/stopped", { turnId: "short", reason: "completed" }));
    await t.wait(TURN_END_SETTLE_WAIT_MS + TIMELINE_SETTLE_DURATION_MS + 60);

    assert.equal(t.reserve(), 0);
    assert.equal(t.timeline().scrollTop, beforeEnd, "ending a short turn does not scroll the transcript");
    assert.deepEqual(
      [...t.timeline().querySelectorAll<HTMLElement>(":scope > .msg")].map((row) => row.getBoundingClientRect().top),
      rowsBeforeEnd,
      "ending a short turn does not lower every message",
    );
    assert.equal(
      recorded.slice(before).filter((animation) => animation.duration === TIMELINE_SETTLE_DURATION_MS).length,
      0,
      "a short transcript needs no downward settle glide",
    );
    // A later observer refresh must not undo the held position.
    await act(async () => { t.timeline().classList.add("test-idle-refresh"); });
    assert.equal(t.timeline().scrollTop, beforeEnd);
  } finally {
    await t.cleanup();
    delete document.documentElement.dataset.reduceAnimations;
  }
});
}

for (const reset of ["new turn", "reader scroll", "overflow"] as const) {
test(`a short transcript's hold adapts to late layout and ${reset === "reader scroll" ? "survives" : "clears on"} ${reset}`, async () => {
  document.documentElement.dataset.reduceAnimations = "true";
  const t = await mountTimeline({ seed: ({ turn }) => turn(1, "Earlier prompt.") });
  try {
    await t.push(t.event("user/message", { text: "Short prompt." }), t.event("turn/started", { turnId: "short" }));
    await t.push(t.event("assistant/message", { partId: "short-answer", text: "Done." }));
    const beforeEnd = t.timeline().scrollTop;
    await t.push(t.event("turn/stopped", { turnId: "short", reason: "completed" }));
    assert.ok(t.floor() > 0);
    const held = t.floor();
    const answer = [...t.timeline().querySelectorAll<HTMLElement>(":scope > .msg.assistant")].at(-1)!;
    await act(async () => { answer.classList.add("test-late-growth"); });
    assert.equal(t.floor(), held - 40, "late answer growth consumes the held blank space");
    assert.equal(t.timeline().scrollTop, beforeEnd, "late growth below the reader does not lower the rows");

    if (reset === "reader scroll") {
      await act(async () => {
        const el = t.timeline();
        el.dispatchEvent(new dom.WheelEvent("wheel", { deltaY: -120, bubbles: true }) as unknown as Event);
        el.scrollTop = 0;
        el.dispatchEvent(new dom.Event("scroll") as unknown as Event);
      });
      // The whole transcript stays visible: a control there would only hide
      // itself on tap without moving anything.
      assert.equal(t.timeline().parentElement!.querySelector(".jump-latest") !== null, false,
        "nothing hidden below: no Jump to latest");
      await act(async () => {
        const el = t.timeline();
        el.dispatchEvent(new dom.WheelEvent("wheel", { deltaY: 120, bubbles: true }) as unknown as Event);
        el.scrollTop = t.maxScrollTop();
        el.dispatchEvent(new dom.Event("scroll") as unknown as Event);
      });
      await t.wait(260);
      assert.equal(t.floor(), held - 40, "the hold keeps the rows in place until a new turn or overflow");
      return;
    } else if (reset === "new turn") {
      await t.push(t.event("user/message", { text: "Continue." }), t.event("turn/started", { turnId: "continue" }));
      assert.ok(t.reserve() > 0, "the new turn owns the ordinary live reserve");
    } else {
      await t.push(t.event("assistant/message", { partId: "short-answer", text: LONG.repeat(4) }));
      assert.ok(layout(t.timeline()).contentBottom + PAD_BOTTOM > VIEW_HEIGHT);
      assert.equal(t.timeline().scrollTop, t.maxScrollTop(), "an overflowing chat follows its real tail");
    }
    assert.equal(t.floor(), 0, `${reset} clears the short-transcript hold`);
  } finally {
    await t.cleanup();
    delete document.documentElement.dataset.reduceAnimations;
  }
});
}

test("revert: in-place exit, then removal and one glide, then marker and draft", async () => {
  const t = await mountTimeline();
  const originalRewind = api.rewind;
  try {
    const seeded = [...t.turn(1, "First prompt."), ...t.turn(2, "Second prompt."), ...t.turn(3, "Third prompt to revert.")];
    await t.push(...seeded);
    const promptSeq = seeded[8]!.seq;
    const answerSeq = seeded[10]!.seq;
    const el = t.timeline();
    assert.equal(el.scrollTop, t.maxScrollTop(), "following at the tail");
    const prompt = el.querySelector<HTMLElement>(`:scope > .msg.user[data-message-seq="${promptSeq}"]`)!;
    const answer = el.querySelector<HTMLElement>(`:scope > .msg.assistant[data-message-seq="${answerSeq}"]`)!;
    assert.ok(prompt && answer);

    let respond!: (event: SessionEvent) => void;
    const requested: number[] = [];
    api.rewind = (_id: string, atSeq: number) => {
      requested.push(atSeq);
      return new Promise<SessionEvent>((resolve) => { respond = resolve; });
    };
    const before = recorded.length;
    await act(async () => {
      el.querySelector<HTMLButtonElement>(`[data-revert-seq="${promptSeq}"]`)!.click();
    });
    assert.deepEqual(requested, [promptSeq]);
    assert.equal(el.querySelector(".rewind-leaving"), null, "nothing fades before the server confirms");
    assert.equal(recorded.length, before, "nothing moves before the server confirms");

    // The WS confirmation lands first; the request resolves during the exit.
    const marker = t.event("session/rewound", { atSeq: promptSeq });
    await t.push(marker);
    assert.equal(el.querySelector(`:scope > .msg.user[data-message-seq="${promptSeq}"]`), prompt, "the prompt row kept its DOM node");
    assert.equal(el.querySelector(`:scope > .msg.assistant[data-message-seq="${answerSeq}"]`), answer, "the answer row kept its DOM node");
    assert.ok(prompt.classList.contains("rewind-leaving") && answer.classList.contains("rewind-leaving"), "the whole cut leaves together");
    assert.equal(el.querySelector(".rewind-marker"), null, "the marker waits for the exit");
    const exitTop = el.scrollTop;
    await act(async () => { respond(marker); });
    assert.equal(drainComposerReplacement(), undefined, "the draft waits for the glide");

    await t.wait(REWIND_EXIT_MS + 30);
    assert.ok(!prompt.isConnected && !answer.isConnected, "one commit removed the cut");
    assert.equal(el.querySelector(".rewind-marker"), null, "the marker waits for the glide");
    assert.ok(el.scrollTop < exitTop, "the canonical scroll moved to the new tail");
    const glide = recorded.slice(before).filter((animation) => animation.duration === REWIND_GLIDE_MS);
    assert.ok(glide.length > 0 && glide.every((animation) => travel(animation) < 0), "the survivors glide down together");
    assert.equal(drainComposerReplacement(), undefined, "the draft still waits for the glide");

    await t.wait(REWIND_GLIDE_MS + 60);
    assert.ok(el.querySelector(".rewind-marker"), "the marker appears after the glide");
    assert.equal(drainComposerReplacement(), "Third prompt to revert.", "the draft is restored after the glide");
  } finally {
    api.rewind = originalRewind;
    await t.cleanup();
  }
});

test("an answered question stays in the chat and its answer reverts like a prompt", async () => {
  const t = await mountTimeline();
  const originalRewind = api.rewind;
  try {
    const user = t.event("user/message", { text: "Set up the project." });
    const started = t.event("turn/started", { turnId: `${t.sessionId}-q` });
    const before = t.event("assistant/message", { partId: `${t.sessionId}-before`, text: "One question first." });
    const asked = t.event("question/asked", {
      requestId: "que-db",
      questions: [{ id: "db", prompt: "Which database?", options: [{ value: "pg", label: "Postgres" }, { value: "my", label: "MySQL" }] }],
    });
    await t.push(user, started, before, asked);
    const el = t.timeline();
    assert.equal(el.querySelector(".question-record"), null, "the open stepper owns a pending question");
    const open = el.querySelector<HTMLElement>(`:scope > .msg.question-open[data-message-seq="${asked.seq}"]`);
    assert.ok(open, "the open question is a row of the conversation, not a dock beside it");

    const answered = t.event("question/answered", { requestId: "que-db", answers: { db: "pg" } });
    const after = t.event("assistant/message", { partId: `${t.sessionId}-after`, text: "Using Postgres." });
    await t.push(answered, after, t.event("turn/stopped", { turnId: `${t.sessionId}-q`, reason: "completed" }));
    const record = el.querySelector<HTMLElement>(`:scope > .question-record[data-message-seq="${asked.seq}"]`)!;
    const reply = el.querySelector<HTMLElement>(`:scope > .msg.user.question-answer[data-message-seq="${answered.seq}"]`)!;
    assert.ok(record && reply, "question and answer stay in the conversation");
    assert.match(record.textContent ?? "", /Which database\?/);
    assert.match(reply.textContent ?? "", /Postgres/);
    const rows = [...el.children];
    assert.ok(rows.indexOf(record) < rows.indexOf(reply), "the answer follows its question");

    let respond!: (event: SessionEvent) => void;
    const requested: number[] = [];
    api.rewind = (_id: string, atSeq: number) => {
      requested.push(atSeq);
      return new Promise<SessionEvent>((resolve) => { respond = resolve; });
    };
    await act(async () => {
      el.querySelector<HTMLButtonElement>(`[data-revert-seq="${answered.seq}"]`)!.click();
    });
    assert.deepEqual(requested, [answered.seq], "the cut starts at the answer");

    const marker = t.event("session/rewound", { atSeq: answered.seq });
    await t.push(marker);
    assert.ok(reply.isConnected && reply.classList.contains("rewind-leaving"), "the answer plays the cut's exit");
    assert.equal(record.classList.contains("rewind-leaving"), false, "the question stays");
    await act(async () => { respond(marker); });

    await t.wait(REWIND_EXIT_MS + REWIND_GLIDE_MS + 90);
    assert.ok(!reply.isConnected, "the answer left");
    assert.ok(record.isConnected, "the question kept its row");
    assert.match(record.querySelector(".question-record-status")?.textContent ?? "", /Answer reverted/);
    assert.ok(el.querySelector(".rewind-marker"), "the cut marker appears");
    assert.equal(drainComposerReplacement(), "> Which database?\nPostgres", "the answer returns to the composer");
  } finally {
    api.rewind = originalRewind;
    await t.cleanup();
  }
});

test("an open question is answered in place and hands its row to the record", async () => {
  const t = await mountTimeline();
  const originalAnswer = api.answerQuestion;
  try {
    const asked = t.event("question/asked", {
      requestId: "que-stack",
      questions: [
        { id: "db", prompt: "Which database?", options: [{ value: "pg", label: "Postgres", description: "Relational" }, { value: "my", label: "MySQL" }] },
        { id: "extras", type: "multi", allowOther: true, prompt: "Which extras?", options: [{ value: "cache", label: "Cache" }] },
      ],
    });
    await t.push(t.event("user/message", { text: "Set it up." }), t.event("turn/started", { turnId: "q2" }), asked);
    const el = t.timeline();
    // The stepper hands its row to the record at the click and takes it back
    // after a failure, so it is found again each time.
    const open = () => el.querySelector<HTMLElement>(`:scope > .msg.question-open[data-message-seq="${asked.seq}"]`);
    const row = { querySelector: (s: string) => open()!.querySelector(s), querySelectorAll: (s: string) => open()!.querySelectorAll(s) } as HTMLElement;
    assert.ok(open(), "the stepper renders inside the timeline scrollport");
    assert.equal(document.querySelector(".question-cards"), null, "no separate question dock");
    assert.match(row.querySelector(".question-progress")?.textContent ?? "", /1.*2/);
    assert.match(row.querySelector(".question-prompt")?.textContent ?? "", /Which database\?/);
    assert.match(row.querySelector(".question-option-desc")?.textContent ?? "", /Relational/);

    const next = () => [...row.querySelectorAll<HTMLButtonElement>(".question-actions button")].at(-1)!;
    await act(async () => { row.querySelector<HTMLInputElement>('input[type="radio"]')!.click(); });
    assert.ok(row.querySelector(".question-option.selected"), "the chosen option is marked");
    await act(async () => { next().click(); });
    assert.match(row.querySelector(".question-prompt")?.textContent ?? "", /Which extras\?/);
    assert.equal(row.querySelectorAll(".question-tab.done").length, 1, "the answered step is marked done");

    // Ticking "Other" opens its field; an empty Other is not an answer.
    const boxes = () => [...row.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(async () => { boxes().at(-1)!.click(); });
    assert.ok(row.querySelector(".question-other-input"), "Other reveals its text field");
    assert.equal(next().disabled, true, "an empty Other cannot be submitted");
    await act(async () => { boxes()[0]!.click(); });
    assert.equal(next().disabled, false);

    const sent: JsonObject[] = [];
    let fail = true;
    api.answerQuestion = async (_id: string, _req: string, answers: JsonObject) => {
      sent.push(answers);
      if (fail) throw new Error("offline");
      return undefined as never;
    };
    await act(async () => { next().click(); });
    await t.wait(10);
    assert.deepEqual(sent.at(-1), { db: "pg", extras: ["cache"] }, "the blank Other entry is not sent");
    assert.ok(row.querySelector(".question-error[role=alert]"), "a failed send says so in the card");
    assert.equal(next().disabled, false, "the card is usable again after a failure");

    fail = false;
    await act(async () => { next().click(); });
    await t.wait(10);
    assert.equal(sent.length, 2);
    assert.equal(open(), null, "the stepper leaves at the click");
    assert.match(el.querySelector(`:scope > .question-record[data-message-seq="${asked.seq}"] + .question-answer`)?.textContent ?? "", /Postgres.*Cache/,
      "the answer shows before the server confirms it");

    await t.push(t.event("question/answered", { requestId: "que-stack", answers: { db: "pg", extras: ["cache"] } }));
    assert.equal(el.querySelector(".msg.question-open"), null, "the stepper leaves once the answer is canonical");
    assert.ok(el.querySelector(`:scope > .question-record[data-message-seq="${asked.seq}"]`), "the record takes the row");
  } finally {
    api.answerQuestion = originalAnswer;
    await t.cleanup();
  }
});

// ---- opening an existing chat (packet A3) ---------------------------------------

test("a saved reading position is the first painted position: no intermediate scrollTop", async () => {
  const t = await mountTimeline({
    seed: ({ turn }) => [
      ...turn(1, "Opening prompt one."), ...turn(2, "Opening prompt two."),
      ...turn(3, "Opening prompt three."), ...turn(4, "Opening prompt four."),
    ],
    // The reader had prompt two's row 12px below the top of the reading area.
    anchor: (seeded) => ({ id: seeded[4]!.id, offset: 12, atBottom: false }),
  });
  try {
    const anchored = t.timeline().querySelector<HTMLElement>(`[data-msg-id="ev-${t.sessionId}-5"]`)!;
    assert.ok(anchored, "the anchored row is in the first window");
    assert.equal(anchored.getBoundingClientRect().top, 12, "the row is exactly where the reader left it");
    const landed = t.timeline().scrollTop;
    assert.ok(scrollWrites.length > 0 && scrollWrites.every((top) => top === landed),
      `the first frame took no detour: ${scrollWrites.join(", ")}`);
  } finally {
    await t.cleanup();
  }
});

test("a detached reader's row stays put through late layout above it and the earlier-history host leaving", async () => {
  // History starts at seq 3: the server still advertises earlier events.
  const t = await mountTimeline({
    seed: ({ event, turn }) => {
      event("session/created", { title: "Motion" });
      event("session/renamed", { title: "Motion" });
      return [
        ...turn(1, "Reader prompt one."), ...turn(2, "Reader prompt two."),
        ...turn(3, "Reader prompt three."), ...turn(4, "Reader prompt four."),
      ];
    },
  });
  try {
    const el = t.timeline();
    assert.ok(el.querySelector(":scope > .timeline-earlier"), "the earlier-history host is mounted");
    // The reader scrolls up, deliberately, into the middle of the transcript.
    await act(async () => {
      el.dispatchEvent(new dom.WheelEvent("wheel", { deltaY: -120, bubbles: true }) as unknown as Event);
      el.scrollTop = 180;
      el.dispatchEvent(new dom.Event("scroll") as unknown as Event);
    });
    const rows = [...el.querySelectorAll<HTMLElement>(":scope > .msg")];
    const reading = rows.find((row) => row.getBoundingClientRect().bottom > 0)!;
    const top = reading.getBoundingClientRect().top;
    const above = rows[0]!;
    assert.notEqual(above, reading, "a row above the reader can still settle");

    // Late layout above the reader: a code block / image settles 40px taller.
    await act(async () => { above.classList.add("test-late-growth"); });
    assert.equal(reading.getBoundingClientRect().top, top, "late growth above did not move the reader's row");

    // The whole history is now cached: the host leaves above the reader.
    await t.push(
      { id: `ev-${t.sessionId}-1`, sessionId: t.sessionId, seq: 1, time: Date.now(), type: "session/created", data: { title: "Motion" }, v: 1 } as SessionEvent,
      { id: `ev-${t.sessionId}-2`, sessionId: t.sessionId, seq: 2, time: Date.now(), type: "session/renamed", data: { title: "Motion" }, v: 1 } as SessionEvent,
    );
    assert.equal(el.querySelector(":scope > .timeline-earlier"), null, "the host left once nothing earlier remains");
    assert.equal(reading.getBoundingClientRect().top, top, "the host leaving did not move the reader's row");
  } finally {
    await t.cleanup();
  }
});

test("a session opened mid-turn or idle lands with its tail on the composer edge", async () => {
  const live = await mountTimeline({
    seed: ({ event, turn }) => [
      ...turn(1, "Settled one."), ...turn(2, "Settled two."),
      event("user/message", { text: "Still working on this." }),
      event("turn/started", { turnId: "open-live" }),
      event("tool/call", { callId: "open-c1", tool: "list", input: { path: "." } }),
    ],
  });
  try {
    assert.ok(live.reserve() > 0, "the live turn owns its reserve from the first frame");
    const tail = [...live.timeline().children].filter((child) => (child as HTMLElement).getBoundingClientRect().height > 0).at(-1)!;
    assert.ok(live.timeline().scrollTop > 0, "the seeded transcript overflows");
    assert.equal(live.timeline().scrollTop, live.maxScrollTop() - live.reserve(), "the reserve stays below the view");
    assert.equal(tail.getBoundingClientRect().bottom, VIEW_HEIGHT - PAD_BOTTOM,
      "its tail rests on the composer edge, never mid-screen above blank");
  } finally {
    await live.cleanup();
  }
  const idle = await mountTimeline({ seed: ({ turn }) => [...turn(1, "Settled one."), ...turn(2, "Settled two."), ...turn(3, "Settled three.")] });
  try {
    assert.equal(idle.reserve(), 0, "an idle session holds no reserve");
    assert.equal(idle.timeline().scrollTop, idle.maxScrollTop(), "its tail rests on the composer edge");
  } finally {
    await idle.cleanup();
  }
});


test("activity owns waiting while reasoning and prose render without typewriter delay", async () => {
  const t = await mountTimeline();
  try {
    await t.push(t.event("user/message", { text: "Think then answer." }));
    assert.equal(t.timeline().querySelector('.msg[role="status"]'), null, "waiting does not add a second status row");
    await t.push(t.event("turn/started", { turnId: "stream" }));
    assert.equal(t.timeline().querySelector('.msg[role="status"]'), null, "waiting does not add a second status row");
    await t.push(t.event("assistant/reasoning-chunk", { partId: "stream", text: "Inspecting the request." }));
    assert.equal(t.timeline().querySelector('.msg[role="status"]'), null);
    assert.match(t.timeline().textContent ?? "", /Inspecting the request\./);
    await t.push(t.event("assistant/chunk", { partId: "stream", text: "The complete incoming chunk." }));
    assert.match(t.timeline().textContent ?? "", /The complete incoming chunk\./);
  } finally {
    await t.cleanup();
  }
});

for (const delivery of [undefined, "steer", "interrupt"] as const) {
  test(`canonical acknowledgement preserves manual reading (${delivery ?? "send"})`, async () => {
    const t = await mountTimeline({ seed: ({ turn }) => [...turn(1, "History one."), ...turn(2, "History two.")] });
    try {
      await act(async () => { beginPendingSend({ sessionId: t.sessionId, text: "Next prompt.", attachments: [], delivery }); });
      await t.push();
      await t.wait(240);
      const el = t.timeline();
      await act(async () => {
        el.dispatchEvent(new dom.WheelEvent("wheel", { deltaY: -120, bubbles: true }) as unknown as Event);
        el.scrollTop = 180;
        el.dispatchEvent(new dom.Event("scroll") as unknown as Event);
      });
      const reading = [...el.querySelectorAll<HTMLElement>(":scope > .msg")]
        .find((row) => row.getBoundingClientRect().bottom > 0)!;
      const top = reading.getBoundingClientRect().top;
      // Status can arrive before the user event retires the optimistic echo.
      await t.push(t.event("turn/started", { turnId: "next" }));
      assert.equal(reading.getBoundingClientRect().top, top, "status does not restart the same pending send");
      await t.push(t.event("user/message", { text: "Next prompt." }));
      await t.push(t.event("assistant/chunk", { partId: "next", text: LONG }));
      assert.equal(reading.getBoundingClientRect().top, top, "acknowledgement and chunks do not reclaim follow");
    } finally {
      await t.cleanup();
    }
  });
}


for (const reduced of [false, true]) {
  test(`prompt bookmark respects motion preferences (reduced=${reduced})`, async () => {
    const previous = getUiSettings();
    setUiSettings({ pinLatestPrompt: true });
    document.documentElement.dataset.reduceAnimations = String(reduced);
    const t = await mountTimeline({ seed: ({ turn }) => [...turn(1, "First."), ...turn(2, "Latest.", LONG.repeat(5))] });
    try {
      const prompt = [...t.timeline().querySelectorAll<HTMLElement>('.msg.user')].at(-1)!;
      let behavior: ScrollBehavior | undefined;
      prompt.scrollIntoView = (options) => { behavior = typeof options === "object" ? options.behavior : undefined; };
      const shell = t.timeline().closest('.timeline-shell')!;
      const toggle = shell.querySelector<HTMLButtonElement>('.prompt-bookmark-toggle');
      assert.ok(toggle, "the latest prompt is outside the viewport");
      await act(async () => toggle.click());
      await act(async () => document.querySelector<HTMLButtonElement>('.prompt-bookmark-peek-button')!.click());
      assert.equal(behavior, reduced ? "auto" : "smooth");
    } finally {
      await t.cleanup();
      delete document.documentElement.dataset.reduceAnimations;
      setUiSettings(previous);
    }
  });
}

test("bookmark hydrates a distant selected prompt beyond twelve chunks, then focuses it", async () => {
  const prefs = getUiSettings();
  setUiSettings({ pinLatestPrompt: true });
  const originalEvents = api.getEvents;
  const originalPrompts = api.sessionPrompts;
  const requests: Array<{ before: number; limit: number }> = [];
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  let jumped = "";
  HTMLElement.prototype.scrollIntoView = function () { jumped = this.dataset.msgId ?? ""; };
  const t = await mountTimeline({ live: true, seed: ({ turn }) => turn(1, "Latest prompt").map((event, i) => ({ ...event, seq: 26_002 + i })) });
  const latest = getState().events[t.sessionId]!.find((e) => e.type === "user/message")!;
  api.sessionPrompts = async () => ({ prompts: [{ id: latest.id, seq: latest.seq, preview: "Latest prompt" }, { id: "ancient", seq: 2, preview: "Ancient prompt" }], beforeSeq: null });
  api.getEvents = async (id, _after, page) => {
    const before = page!.beforeSeq!;
    const limit = page!.limit!;
    requests.push({ before, limit });
    return Array.from({ length: limit }, (_, i): SessionEvent => {
      const seq = before - limit + i;
      return { id: seq === 2 ? "ancient" : `gap-${seq}`, sessionId: id, seq, time: seq,
        type: seq === 2 ? "user/message" : "test/ignored", data: seq === 2 ? { text: "Ancient prompt" } : {}, v: 1 };
    });
  };
  try {
    await act(async () => document.querySelector<HTMLButtonElement>('.prompt-bookmark-toggle')!.click());
    const target = [...document.querySelectorAll<HTMLButtonElement>('.prompt-bookmark-peek-button')].find((p) => p.textContent === "Ancient prompt")!;
    assert.ok(target);
    await act(async () => target.click());
    for (let i = 0; i < 100 && jumped !== "ancient"; i++) await t.wait(50);
    assert.equal(requests.length, 13, "the old twelve-page limit must not strand navigation");
    assert.ok(requests.every((r) => r.limit <= 2000));
    assert.equal(getState().events[t.sessionId]![0]!.seq, 2, "loading stops at the selected sequence");
    assert.equal(jumped, "ancient");
    assert.equal((document.activeElement as HTMLElement).dataset.msgId, "ancient");
  } finally {
    await t.cleanup();
    api.getEvents = originalEvents;
    api.sessionPrompts = originalPrompts;
    HTMLElement.prototype.scrollIntoView = originalScroll;
    setUiSettings(prefs);
  }
});

test("concurrent history readers share one request and failed requests release the flight", async () => {
  const original = api.getEvents;
  const t = await mountTimeline({ live: true, seed: ({ turn }) => turn(1, "Latest").map((event, i) => ({ ...event, seq: 20 + i })) });
  let requests = 0;
  let finish: (events: SessionEvent[]) => void = () => {};
  api.getEvents = () => { requests++; return new Promise((resolve) => { finish = resolve; }); };
  const events = (from: number): SessionEvent[] => Array.from({ length: 5 }, (_, i) => ({ id: `old-${from + i}`, sessionId: t.sessionId,
    seq: from + i, time: 1, type: "test/ignored", data: {}, v: 1 }));
  try {
    const first = loadOlderEvents(t.sessionId, 5);
    const second = loadOlderEvents(t.sessionId, 5);
    assert.equal(requests, 1);
    await act(async () => {
      finish(events(15));
      assert.deepEqual(await Promise.all([first, second]), [true, true]);
    });
    assert.equal(getState().events[t.sessionId]!.length, 9, "joined reads do not duplicate events");
    api.getEvents = async () => { throw new Error("offline"); };
    await assert.rejects(() => loadOlderEvents(t.sessionId, 5), /offline/);
    api.getEvents = async () => events(10);
    await act(async () => assert.equal(await loadOlderEvents(t.sessionId, 5), true));
  } finally { await t.cleanup(); api.getEvents = original; }
});


test("temporary transform overflow cannot ratchet the followed extent", async () => {
  const t = await mountTimeline({ seed: ({ turn }) => [...turn(1, "History one."), ...turn(2, "History two.")] });
  try {
    await t.push(t.event("user/message", { text: "Stream." }), t.event("turn/started", { turnId: "live" }),
      t.event("assistant/chunk", { partId: "live", text: LONG.repeat(5) }));
    await t.wait(300);
    const el = t.timeline();
    const top = el.scrollTop;
    const floor = t.floor();
    // Real browsers include transformed descendants in scrollHeight, while
    // the in-flow tail and its layout height have not changed.
    await act(async () => el.classList.add("test-transform-overflow"));
    await act(async () => el.classList.remove("test-transform-overflow"));
    assert.equal(t.floor(), floor, "animated overflow does not become permanent blank space");
    assert.equal(el.scrollTop, top, "ending a transform does not move the reading position");
  } finally {
    await t.cleanup();
  }
});


test("fast admission preserves the prompt's painted origin for the first streamed row", async () => {
  const t = await mountTimeline({ seed: ({ turn }) => [...turn(1, "History one."), ...turn(2, "History two.")] });
  try {
    await act(async () => { beginPendingSend({ sessionId: t.sessionId, text: "Next prompt.", attachments: [] }); });
    await t.push();
    await t.push(t.event("user/message", { text: "Next prompt." }), t.event("turn/started", { turnId: "next" }));
    const prompt = [...t.timeline().querySelectorAll<HTMLElement>(":scope > .msg.user")].at(-1)!;
    const before = recorded.length;
    // Buffered output taller than the room below the prompt: the view must
    // follow it past the composer edge, from where the echo was painted.
    await t.push(t.event("assistant/chunk", { partId: "next", text: LONG.repeat(3) }));
    await t.wait(520);
    assert.ok(recorded.slice(before).some((animation) => animation.element === prompt && travel(animation) > 24),
      "the canonical prompt glides from the echo's painted position instead of snapping when buffered output lands");
  } finally {
    await t.cleanup();
  }
});


test("fractional live tail shrink keeps the followed position without rounding tremor", async () => {
  const t = await mountTimeline({ seed: ({ turn }) => [...turn(1, "History one."), ...turn(2, "History two.")] });
  try {
    await t.push(t.event("user/message", { text: "Run a tool." }), t.event("turn/started", { turnId: "live" }),
      t.event("tool/call", { callId: "fractional", tool: "list", input: { path: "." } }));
    await t.wait(520);
    const block = [...t.timeline().querySelectorAll<HTMLElement>(":scope > .activity-group")].at(-1)!;
    assert.ok(block);
    await act(async () => block.classList.add("test-fractional-tall"));
    const before = t.timeline().scrollTop;
    await act(async () => block.classList.replace("test-fractional-tall", "test-fractional-short"));
    assert.ok(Math.abs(t.timeline().scrollTop - before) < 0.001,
      `a 0.4px fold crossing the browser rounding boundary preserves the reading position (${before} -> ${t.timeline().scrollTop})`);
    assert.ok(t.floor() > 0, "the floor covers the fractional lost extent");
  } finally {
    await t.cleanup();
  }
});


test("dock geometry mutation restores live extent before a resize callback is needed", async () => {
  const t = await mountTimeline({ seed: ({ turn }) => [...turn(1, "History one."), ...turn(2, "History two.")] });
  try {
    await t.push(t.event("user/message", { text: "Run a tool." }), t.event("turn/started", { turnId: "live" }),
      t.event("tool/call", { callId: "dock", tool: "list", input: { path: "." } }));
    await t.wait(520);
    const el = t.timeline();
    const top = el.scrollTop;
    const dock = el.closest(".focus-conversation")!.querySelector<HTMLElement>(".conversation-composer-dock")!;
    await act(async () => dock.style.setProperty("--test-dock-growth", "4px"));
    assert.equal(el.scrollTop, top, "the dock mutation pays the native clamp before the next paint");
    assert.ok(t.floor() > 0, "the lost extent is reserved without waiting for ResizeObserver");
  } finally {
    await t.cleanup();
  }
});


test("a pending approval hangs below the live tail and leaves no blank when answered", async () => {
  const off = registerSlot("session.timeline.after", "test.approval", (context) =>
    Array.isArray(context.permissions) && context.permissions.length > 0
      ? createElement("div", { className: "test-approval-card" })
      : null);
  const t = await mountTimeline({ seed: ({ turn }) => [...turn(1, "History one."), ...turn(2, "History two.")] });
  try {
    await t.push(t.event("user/message", { text: "Run a tool." }), t.event("turn/started", { turnId: "live" }),
      t.event("tool/call", { callId: "guarded", tool: "bash", input: { command: "ls" } }));
    await t.wait(520);
    const el = t.timeline();
    const tail = () => [...el.querySelectorAll<HTMLElement>(":scope > .msg")]
      .filter((row) => row.offsetHeight > 0).at(-1)!;
    const tailBottom = () => tail().getBoundingClientRect().bottom;
    const resting = tailBottom();
    await t.push(t.event("permission/requested", { requestId: "r1", permission: "bash", patterns: ["ls"], tool: "bash" }));
    await t.wait(520);
    const card = el.querySelector<HTMLElement>(".test-approval-card");
    assert.ok(card, "the approval card renders after the transcript");
    assert.ok(Math.abs(tailBottom() - resting) < 1, "a card that fits below the tail moves no row");
    assert.ok(card.getBoundingClientRect().bottom <= el.clientHeight - PAD_BOTTOM + 1,
      "the card's actions are fully visible above the composer");
    await t.push(t.event("permission/resolved", { requestId: "r1", reply: "once" }));
    assert.equal(el.querySelector(".test-approval-card"), null);
    assert.equal(t.floor(), 0, "the answered card's height is not held as blank space");
    assert.ok(Math.abs(tailBottom() - resting) < 1, "answering moves no row either");
    const prompt = () => [...el.querySelectorAll<HTMLElement>(":scope > .msg.user")].at(-1)!.getBoundingClientRect().top;
    const promptTop = prompt();
    await t.wait(520);
    assert.equal(prompt(), promptTop, "no later sheet sync moves the rows");
  } finally {
    off();
    await t.cleanup();
  }
});

test("an approval in a keyboard-shortened viewport rests on the composer edge and glides back when answered", async () => {
  // Like the permissions package: a card after the transcript while a request is pending.
  const off = registerSlot("session.timeline.after", "test.approval", (context) =>
    Array.isArray(context.permissions) && context.permissions.length > 0
      ? createElement("div", { className: "test-approval-card" })
      : null);
  const t = await mountTimeline({ seed: ({ turn }) => [...turn(1, "History one."), ...turn(2, "History two.")] });
  try {
    await t.push(t.event("user/message", { text: "Run a tool." }), t.event("turn/started", { turnId: "live" }),
      t.event("tool/call", { callId: "guarded", tool: "bash", input: { command: "ls" } }));
    await t.wait(520);
    const el = t.timeline();
    // The keyboard opens: the scrollport keeps only the band above it.
    await act(async () => {
      el.style.setProperty("--test-viewport-growth", "-300px");
      el.classList.add("test-keyboard-open");
    });
    await t.wait(520);
    const tail = () => [...el.querySelectorAll<HTMLElement>(":scope > .msg")]
      .filter((row) => row.offsetHeight > 0).at(-1)!;
    const tailBottom = () => tail().getBoundingClientRect().bottom;
    const resting = tailBottom();
    await t.push(t.event("permission/requested", { requestId: "r1", permission: "bash", patterns: ["ls"], tool: "bash" }));
    await t.wait(520);
    const card = el.querySelector<HTMLElement>(".test-approval-card");
    assert.ok(card, "the approval card renders after the transcript");
    assert.ok(Math.abs(card.getBoundingClientRect().bottom - (el.clientHeight - PAD_BOTTOM)) < 1,
      `the card rests on the composer edge, its actions never mid-screen (${card.getBoundingClientRect().bottom})`);
    assert.ok(tailBottom() < resting - 24, "the transcript made room for the part that did not fit");
    const before = recorded.length;
    await t.push(t.event("permission/resolved", { requestId: "r1", reply: "once" }));
    assert.equal(el.querySelector(".test-approval-card"), null);
    assert.equal(t.floor(), 0, "the answered card's height is not held as blank space");
    assert.ok(Math.abs(tailBottom() - resting) < 1,
      `the tail returns to where it rested before the card (${resting} -> ${tailBottom()})`);
    assert.ok(recorded.slice(before).some((animation) => travel(animation) < -24),
      "the rows glide back down from where the reader saw them");
    const prompt = () => [...el.querySelectorAll<HTMLElement>(":scope > .msg.user")].at(-1)!.getBoundingClientRect().top;
    const promptTop = prompt();
    await t.wait(520);
    assert.equal(prompt(), promptTop, "no later sheet sync moves the rows a second time");
  } finally {
    off();
    await t.cleanup();
  }
});

const touch = (type: string, touches: Array<{ clientY: number }>) => {
  const event = new dom.Event(type, { bubbles: true, cancelable: true }) as unknown as Event;
  Object.defineProperty(event, "touches", { value: touches });
  return event;
};

test("a tap that answers a card under the finger moves no row", async () => {
  const off = registerSlot("session.timeline.after", "test.approval", (context) =>
    Array.isArray(context.permissions) && context.permissions.length > 0
      ? createElement("div", { className: "test-approval-card" })
      : null);
  const t = await mountTimeline({ seed: ({ turn }) => [...turn(1, "History one."), ...turn(2, "History two.")] });
  try {
    await t.push(t.event("user/message", { text: "Run a tool." }), t.event("turn/started", { turnId: "live" }),
      t.event("tool/call", { callId: "guarded", tool: "bash", input: { command: "ls" } }));
    await t.wait(520);
    const el = t.timeline();
    const tailBottom = () => [...el.querySelectorAll<HTMLElement>(":scope > .msg")]
      .filter((row) => row.offsetHeight > 0).at(-1)!.getBoundingClientRect().bottom;
    const resting = tailBottom();
    await t.push(t.event("permission/requested", { requestId: "r1", permission: "bash", patterns: ["ls"], tool: "bash" }));
    await t.wait(520);
    assert.equal(el.querySelector(".test-approval-card") !== null, true);
    // The reader taps Allow: a touch that scrolls nothing.
    await act(async () => {
      el.dispatchEvent(touch("touchstart", [{ clientY: 420 }]));
      el.dispatchEvent(touch("touchend", []));
    });
    await t.push(t.event("permission/resolved", { requestId: "r1", reply: "once" }));
    assert.ok(Math.abs(tailBottom() - resting) < 1, `a tap's own answer moved the rows (${resting} -> ${tailBottom()})`);
    await t.wait(300);
    assert.ok(Math.abs(tailBottom() - resting) < 1, `and nothing moves once the touch has rested (${resting} -> ${tailBottom()})`);
  } finally {
    off();
    await t.cleanup();
  }
});

for (const start of ["hidden resend", "bare turn"] as const) {
test(`a turn that starts without a visible prompt (${start}) inherits the held blank: no row drops`, async () => {
  const t = await mountTimeline();
  try {
    await t.push(...t.turn(1, "Seed prompt one."), ...t.turn(2, "Seed prompt two."), ...t.turn(3, "Seed prompt three."));
    await t.push(t.event("user/message", { text: "Short answer please." }), t.event("turn/started", { turnId: "a" }));
    await t.push(t.event("assistant/message", { partId: "short-a", text: "Done." }));
    await t.push(t.event("turn/stopped", { turnId: "a", reason: "completed" }));
    await t.wait(TURN_END_SETTLE_WAIT_MS + 60);
    assert.ok(t.floor() > 0, "the finished turn holds the blank under its short answer");
    const prompt = () => [...t.timeline().querySelectorAll<HTMLElement>(":scope > .msg.user")].at(-1)!.getBoundingClientRect().top;
    const top = prompt();
    const before = recorded.length;
    if (start === "hidden resend") {
      await t.push(t.event("user/message", { text: "Retry.", hiddenUserMessage: true }), t.event("turn/started", { turnId: "b" }));
    } else {
      await t.push(t.event("turn/started", { turnId: "b" }));
    }
    await t.push(t.event("assistant/chunk", { partId: "b-answer", text: "Picking up again." }));
    assert.equal(prompt(), top, "the rows the reader sees stay put");
    assert.equal(recorded.slice(before).filter((animation) => travel(animation) < 0).length, 0, "nothing glides down");
  } finally {
    await t.cleanup();
  }
});
}

// Reader position inside a live turn's runway (blank reserve below the tail).
async function mountLiveTools() {
  const previous = getUiSettings();
  setUiSettings({ actionGrouping: "ungrouped", thinkingDisplayMode: "expanded" });
  const t = await mountTimeline({ seed: ({ turn }) => [...turn(1, "Seed one."), ...turn(2, "Seed two.")] });
  await t.push(t.event("user/message", { text: "Inspect files." }), t.event("turn/started", { turnId: "tools" }));
  let calls = 0;
  const tool = () => t.push(t.event("tool/call", { callId: `call-${++calls}`, tool: "read", input: { path: `f${calls}.ts` } }));
  await tool();
  await t.wait(300);
  const el = t.timeline();
  const tailBottom = () => [...el.querySelectorAll<HTMLElement>(":scope > .execution-row")].at(-1)!.getBoundingClientRect().bottom;
  // Boolean, never the node: a failing assert would serialize the whole DOM.
  const jump = () => el.parentElement!.querySelector(".jump-latest") !== null;
  const scrollBy = async (deltaY: number) => {
    await act(async () => {
      el.dispatchEvent(new dom.WheelEvent("wheel", { deltaY, bubbles: true }) as unknown as Event);
      el.scrollTop += deltaY;
      el.dispatchEvent(new dom.Event("scroll") as unknown as Event);
    });
  };
  return {
    t, el, tool, tailBottom, jump, scrollBy,
    async cleanup() {
      await t.cleanup();
      setUiSettings(previous);
    },
  };
}

test("scrolled up a little in a live turn, the position soft-locks and rows keep filling down", async () => {
  const live = await mountLiveTools();
  const { t, el } = live;
  try {
    const restLine = VIEW_HEIGHT - PAD_BOTTOM;
    assert.equal(live.tailBottom(), VIEW_HEIGHT / 2 + ROW_GAP + 40, "the first action landed right under the prompt");
    assert.ok(t.maxScrollTop() - el.scrollTop > 40, "the live runway lies below the view");
    await live.scrollBy(-40);
    const locked = el.scrollTop;
    assert.equal(live.jump(), false, "the whole tail is visible: no Jump to latest");

    // New rows fill the runway below the reader instead of lifting the view.
    const tops = [locked];
    let followed = 0;
    for (let step = 0; step < 12 && followed < 2; step += 1) {
      await live.tool();
      await t.wait(60);
      const bottom = live.tailBottom();
      if (el.scrollTop === tops.at(-1)) {
        assert.ok(bottom <= restLine + 0.5, `a row grew past the composer edge without follow (${bottom})`);
      } else {
        followed += 1;
        assert.ok(Math.abs(bottom - restLine) <= 0.5, `the reached tail stays on the composer edge (${bottom})`);
      }
      assert.equal(live.jump(), false, "the soft lock never shows Jump to latest");
      tops.push(el.scrollTop);
    }
    assert.ok(followed > 0, "the rows reached the composer edge");
    assert.ok(tops.every((top, index) => index === 0 || top >= tops[index - 1]!), `the view never moved down: ${tops.join(", ")}`);
    assert.ok(t.reserve() > 0, "the live runway is still there to scroll into");

    // Scrolling on into the true tail: the next row still lands below and
    // the rows the reader sees stay put.
    await live.scrollBy(t.maxScrollTop() - el.scrollTop);
    assert.equal(el.scrollTop, t.maxScrollTop());
    const end = el.scrollTop;
    await live.tool();
    await t.wait(60);
    assert.equal(el.scrollTop, end, "a row landing in the runway moves nothing");
  } finally {
    await live.cleanup();
  }
});

test("a detached reader reconnects once the live tail is visible, without moving", async () => {
  const live = await mountLiveTools();
  const { t, el } = live;
  try {
    await live.scrollBy(-400);
    assert.ok(live.tailBottom() > VIEW_HEIGHT - PAD_BOTTOM, "the tail is hidden below the composer edge");
    assert.ok(live.jump(), "a hidden tail offers Jump to latest");
    // Back down until the tail shows, still well above the runway's end.
    await live.scrollBy(200);
    const top = el.scrollTop;
    assert.ok(t.maxScrollTop() - top > 100, "the reader stopped inside the runway");
    assert.equal(live.jump(), false, "Jump to latest left once the whole tail was visible");
    await live.tool();
    await t.wait(60);
    assert.equal(el.scrollTop, top, "the reconnected reader's position holds while runway remains");
  } finally {
    await live.cleanup();
  }
});

test("momentum that carries a detached reader into the tail reconnects after the input stops", async () => {
  const live = await mountLiveTools();
  const { t, el } = live;
  try {
    await live.scrollBy(-400);
    assert.ok(live.jump());
    // One downward flick, then inertia: scroll events with no further input.
    await act(async () => {
      el.dispatchEvent(new dom.WheelEvent("wheel", { deltaY: 40, bubbles: true }) as unknown as Event);
    });
    for (let step = 0; step < 4; step += 1) {
      await t.wait(400);
      await act(async () => {
        el.scrollTop += 100;
        el.dispatchEvent(new dom.Event("scroll") as unknown as Event);
      });
    }
    assert.equal(el.scrollTop, t.maxScrollTop(), "the flick reached the true end");
    assert.equal(live.jump(), false, "inertia past the input lease still reconnects");
  } finally {
    await live.cleanup();
  }
});

// A long session renders a sliding window of its newest rows (timelineWindow.ts):
// every row a live turn adds unmounts the oldest one, far above the reader.
// That history leaving is not a fold: it must neither be held as blank below
// the tail nor move the rows the reader sees.
const TALL = LONG.repeat(5);
const longSession = ({ turn }: SeedTools) =>
  Array.from({ length: 75 }, (_, index) => turn(index + 1, `Seed prompt ${index + 1}.`, TALL)).flat();
const oldestRow = (el: HTMLElement) => el.querySelector<HTMLElement>(":scope > .msg, :scope > .activity-group")!;

test("the sliding window of a long session moves no live row when a tall old row leaves", async () => {
  const t = await mountTimeline({ seed: longSession });
  try {
    const el = t.timeline();
    await t.push(t.event("user/message", { text: "Keep going." }), t.event("turn/started", { turnId: "live" }));
    await t.wait(520);
    const oldest = oldestRow(el);
    assert.ok(oldest.matches(".msg.assistant") && oldest.offsetHeight >= VIEW_HEIGHT,
      "the oldest rendered row is a tall answer that the window drops next");
    const prompt = [...el.querySelectorAll<HTMLElement>(":scope > .msg.user")].at(-1)!;
    assert.equal(prompt.getBoundingClientRect().bottom, VIEW_HEIGHT / 2, "the live prompt rests on the focus line");
    const promptTop = prompt.getBoundingClientRect().top;
    const before = recorded.length;
    const chunk = t.event("assistant/chunk", { partId: "interim", text: "Checking the next file." });
    await t.push(chunk);
    assert.equal(oldest.isConnected, false, "the window slid past the tall answer");
    const row = el.querySelector<HTMLElement>(`:scope > .msg.assistant[data-message-seq="${chunk.seq}"]`)!;
    assert.ok(row, "the interim answer row is mounted");
    assert.equal(row.getBoundingClientRect().top, VIEW_HEIGHT / 2 + ROW_GAP,
      `the new row lands right under the prompt, inside the reading area (${row.getBoundingClientRect().top})`);
    assert.equal(t.floor(), 0, "history leaving above the reader is not held as blank");
    assert.equal(prompt.getBoundingClientRect().top, promptTop, "the prompt did not move");
    assert.equal(recorded.slice(before).filter((animation) => animation.element === prompt).length, 0,
      "nothing glides: the window's slide is invisible");
  } finally {
    await t.cleanup();
  }
});

test("the sliding window of a long session never moves a soft-locked reader's rows", async () => {
  const previous = getUiSettings();
  setUiSettings({ actionGrouping: "ungrouped", thinkingDisplayMode: "expanded" });
  const t = await mountTimeline({ seed: longSession });
  try {
    const el = t.timeline();
    await t.push(t.event("user/message", { text: "Inspect files." }), t.event("turn/started", { turnId: "tools" }));
    await t.wait(520);
    // Scrolled up a little inside the live runway: new rows fill down below.
    await act(async () => {
      el.dispatchEvent(new dom.WheelEvent("wheel", { deltaY: -40, bubbles: true }) as unknown as Event);
      el.scrollTop -= 40;
      el.dispatchEvent(new dom.Event("scroll") as unknown as Event);
    });
    const oldest = oldestRow(el);
    assert.ok(oldest.matches(".msg.assistant") && oldest.offsetHeight >= VIEW_HEIGHT,
      "the oldest rendered row is a tall answer that the window drops next");
    const prompt = [...el.querySelectorAll<HTMLElement>(":scope > .msg.user")].at(-1)!;
    const promptTop = prompt.getBoundingClientRect().top;
    await t.push(t.event("tool/call", { callId: "read-1", tool: "read", input: { path: "a.ts" } }));
    await t.wait(60);
    assert.equal(oldest.isConnected, false, "the window slid past the tall answer");
    assert.equal(prompt.getBoundingClientRect().top, promptTop, "the rows the reader holds stay where they are");
    const row = [...el.querySelectorAll<HTMLElement>(":scope > .execution-row")].at(-1)!;
    assert.ok(row.getBoundingClientRect().bottom <= VIEW_HEIGHT - PAD_BOTTOM, "the new row fills the runway in view");
    assert.equal(t.floor(), 0, "history leaving above the reader is not held as blank");
  } finally {
    await t.cleanup();
    setUiSettings(previous);
  }
});

test("a live tail shrink taller than the room above it glides down instead of lifting the tail out of view", async () => {
  const t = await mountTimeline({ seed: ({ turn }) => [...turn(1, "History one."), ...turn(2, "History two.")] });
  try {
    await t.push(t.event("user/message", { text: "Think it through." }), t.event("turn/started", { turnId: "live" }),
      t.event("tool/call", { callId: "tall", tool: "list", input: { path: "." } }));
    await t.wait(520);
    const el = t.timeline();
    const block = [...el.querySelectorAll<HTMLElement>(":scope > .activity-group")].at(-1)!;
    // The reader opens the live block: it grows past the composer edge, and
    // the view follows its end there.
    await act(async () => block.classList.add("test-tall-row"));
    await t.wait(300);
    assert.equal(block.getBoundingClientRect().bottom, VIEW_HEIGHT - PAD_BOTTOM, "the tall block rests on the composer edge");
    // Then folds it again: 356px leave the tail at once.
    await act(async () => block.classList.remove("test-tall-row"));
    await t.wait(520);
    const bottom = block.getBoundingClientRect().bottom;
    assert.ok(bottom >= VIEW_HEIGHT / 4 - 0.5,
      `held blank never lifts the tail into the top quarter of the reading area (${bottom})`);
    assert.ok(bottom <= VIEW_HEIGHT - PAD_BOTTOM + 0.5, `the tail stays in view (${bottom})`);
  } finally {
    await t.cleanup();
  }
});

test("Jump to latest only shows while something is hidden below a detached reader", async () => {
  const t = await mountTimeline({ seed: ({ turn }) => [1, 2, 3, 4, 5, 6].flatMap((n) => turn(n, `Seed prompt ${n}.`)) });
  try {
    const el = t.timeline();
    const jump = () => el.parentElement!.querySelector(".jump-latest") !== null;
    const scrollBy = async (deltaY: number) => {
      await act(async () => {
        el.dispatchEvent(new dom.WheelEvent("wheel", { deltaY, bubbles: true }) as unknown as Event);
        el.scrollTop += deltaY;
        el.dispatchEvent(new dom.Event("scroll") as unknown as Event);
      });
    };
    assert.ok(t.maxScrollTop() > 0 && el.scrollTop === t.maxScrollTop(), "a finished overflowing chat rests at its end");
    // One slow tick up detaches, but the whole tail is still in view.
    await scrollBy(-1);
    assert.equal(jump(), false, "nothing hidden below: no Jump to latest");
    // A new row lands below the still reader: now there is something to jump to.
    const top = el.scrollTop;
    await t.push(t.event("assistant/message", { partId: "late", text: "A late note arrives." }));
    await t.wait(60);
    assert.equal(el.scrollTop, top, "the detached reader did not move");
    assert.equal(jump(), true, "a row below the composer edge brings the control back");
  } finally {
    await t.cleanup();
  }
});
