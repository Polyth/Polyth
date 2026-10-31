// Mounted Replay Theater: the real component in happy-dom with a manual
// timer queue, fed synthetic session events through the host store.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { JsonObject, SessionEvent } from "@polyth/contracts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (cb: FrameRequestCallback) => { cb(0); return 1; } });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: class { observe(): void {} unobserve(): void {} disconnect(): void {} },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = (async () => new Response(JSON.stringify({ steps: [] }), { status: 200 })) as typeof fetch;

// Manual timer queue on the window the component schedules against.
type Timer = { id: number; at: number; fn: () => void };
let now = 0;
let nextId = 1;
const timers = new Map<number, Timer>();
Object.assign(dom, {
  setTimeout: (fn: () => void, ms = 0) => { const id = nextId++; timers.set(id, { id, at: now + ms, fn }); return id; },
  clearTimeout: (id: number) => { timers.delete(id); },
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ReplayTheater } = await import("../widgets/ReplayTheater.tsx");
const { default: WalkthroughView } = await import("../widgets/WalkthroughView.tsx");
const { activateSession, applyEvents, getState, setPaneFullscreen } = await import("../../../apps/web/src/store.ts");
const { replayIntervalMs } = await import("../src/replay.ts");

async function advance(ms: number) {
  const target = now + ms;
  for (;;) {
    const due = [...timers.values()].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers.delete(due.id);
    now = due.at;
    await act(async () => { due.fn(); });
  }
  now = target;
}

let seq = 0;
const ev = (sessionId: string, type: string, data: JsonObject): SessionEvent =>
  ({ id: `${sessionId}-${++seq}`, sessionId, seq, time: 1000 + seq, type, data, v: 1 });

function seed(sessionId: string, fileCount: number, opts: { chatOnlyTurn?: boolean } = {}) {
  const out: SessionEvent[] = [ev(sessionId, "user/message", { text: "go" })];
  for (let i = 0; i < fileCount; i++) {
    out.push(ev(sessionId, "tool/result", { callId: `c${i}`, tool: "write", output: "ok", input: { filePath: `src/f${i % 3}.ts`, content: `v${i}\n` } }));
  }
  if (opts.chatOnlyTurn) out.push(ev(sessionId, "user/message", { text: "question only" }));
  activateSession(sessionId);
  applyEvents(out);
}

async function mount(component: Parameters<typeof createElement>[0], props: Record<string, unknown> | null = null, frameClass?: string) {
  const outer = document.createElement("div");
  if (frameClass) outer.className = frameClass;
  const container = document.createElement("div");
  outer.appendChild(container);
  document.body.appendChild(outer);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(component, props)); });
  await act(async () => { await Promise.resolve(); });
  return {
    container,
    unmount: async () => { await act(async () => { root.unmount(); }); outer.remove(); },
  };
}

const q = <T extends Element = HTMLElement>(c: Element, sel: string) => c.querySelector(sel) as unknown as T;
const count = (c: Element) => q(c, ".wt-replay-count")?.textContent;
async function key(target: Element, k: string) {
  await act(async () => { target.dispatchEvent(new dom.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }) as unknown as Event); });
}
async function click(target: Element) {
  await act(async () => { (target as unknown as HTMLElement).click(); });
}

test("empty session renders the shared empty state, no player", async () => {
  seed("empty", 0);
  const { container, unmount } = await mount(ReplayTheater);
  try {
    assert.ok(q(container, ".wt-replay .empty-state"), "empty state inside the replay surface");
    assert.ok(!q(container, ".wt-replay-scrub"), "no player");
  } finally { await unmount(); }
});

test("playback steps on the interval, stops at the end, and announces only at rest", async () => {
  seed("play", 4);
  const { container, unmount } = await mount(ReplayTheater);
  try {
    const live = q(container, "[aria-live]");
    assert.equal(count(container), "1/4");
    assert.match(live.textContent ?? "", /Step 1 of 4/);
    await click(q(container, ".wt-replay-play"));
    assert.equal(q(container, ".wt-replay-play").getAttribute("aria-label"), "Pause");
    assert.equal(live.textContent, "", "no announcements while playing");
    await advance(replayIntervalMs(1));
    assert.equal(count(container), "2/4");
    assert.equal(live.textContent, "");
    await advance(replayIntervalMs(1) * 5);
    assert.equal(count(container), "4/4");
    assert.equal(q(container, ".wt-replay-play").getAttribute("aria-label"), "Play", "playback stops at the end");
    assert.match(live.textContent ?? "", /Step 4 of 4/);
    assert.equal(timers.size, 0, "no timer left after the end");
    // Play at the end restarts from the first step.
    await click(q(container, ".wt-replay-play"));
    assert.equal(count(container), "1/4");
  } finally { await unmount(); }
  assert.equal(timers.size, 0, "unmount clears the pending step timer");
});

test("scrubber is an accessible slider and jumps to the chosen step", async () => {
  seed("scrub", 6);
  const { container, unmount } = await mount(ReplayTheater);
  try {
    const slider = q<HTMLInputElement>(container, "input.wt-replay-scrub");
    assert.equal(slider.type, "range");
    assert.equal(slider.getAttribute("aria-label"), "Step position");
    assert.equal(slider.max, "5");
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(slider, "3");
      slider.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    assert.equal(count(container), "4/6");
    assert.equal(q(container, "input.wt-replay-scrub").getAttribute("aria-valuetext"), "Step 4 of 6: f0.ts");
  } finally { await unmount(); }
});

test("file filter narrows the steps; the strip is one roving Tab stop", async () => {
  seed("filter", 6);
  const { container, unmount } = await mount(ReplayTheater);
  try {
    const chips = [...container.querySelectorAll(".wt-replay-chip")];
    assert.equal(chips.length, 3);
    assert.deepEqual(chips.map((c) => c.getAttribute("tabindex")), ["0", "-1", "-1"]);
    await click(chips[1]!);
    assert.equal(chips[1]!.getAttribute("aria-pressed"), "true");
    assert.equal(count(container), "1/2");
    assert.ok(q(container, ".wt-replay-clear"), "clear appears while filtering");
    await click(q(container, ".wt-replay-clear"));
    assert.equal(count(container), "1/6");
    await key(chips[0]!, "End");
    assert.equal(container.querySelectorAll(".wt-replay-chip")[2]!.getAttribute("tabindex"), "0");
    assert.equal(count(container), "1/6", "arrow/Home/End inside the strip do not move playback");
  } finally { await unmount(); }
});

test("a turn range without file changes shows the scoped empty state", async () => {
  seed("chat", 2, { chatOnlyTurn: true });
  const { container, unmount } = await mount(ReplayTheater);
  try {
    assert.equal(count(container), "1/2", "defaults to the last turn that changed files");
    const [from, to] = [...container.querySelectorAll(".wt-replay-scope .picker-chip")];
    for (const trigger of [to!, from!]) {
      await click(trigger);
      const options = [...document.querySelectorAll("[role=option]")];
      await click(options[options.length - 1]!);
    }
    assert.ok(q(container, ".wt-replay .empty-state"), "scoped empty state");
    assert.ok(!q(container, ".wt-replay-scrub"));
  } finally { await unmount(); }
});

test("keyboard shortcuts drive the player but never fire from inputs", async () => {
  seed("keys", 5);
  const { container, unmount } = await mount(ReplayTheater);
  try {
    const root = q(container, ".wt-replay");
    await key(root, "l");
    assert.equal(count(container), "2/5");
    await key(root, "End");
    assert.equal(count(container), "5/5");
    await key(root, "Home");
    assert.equal(count(container), "1/5");
    await key(root, "+");
    assert.equal(q(container, ".wt-replay-speed").textContent, "2×");
    await key(root, "l");
    assert.equal(count(container), "2/5");
    // modifier combos belong to the browser/host
    await act(async () => { root.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "l", ctrlKey: true, bubbles: true }) as unknown as Event); });
    assert.equal(count(container), "2/5");
    // typing in an input inside the surface is untouched
    const input = document.createElement("input");
    root.appendChild(input);
    await key(input, "l");
    await key(input, "k");
    assert.equal(count(container), "2/5");
    assert.equal(q(container, ".wt-replay-play").getAttribute("aria-label"), "Play");
    input.remove();
    // an open popup trigger keeps its keys
    const trigger = q(container, ".wt-replay-scope .picker-chip");
    trigger.setAttribute("aria-expanded", "true");
    await key(trigger, "l");
    assert.equal(count(container), "2/5");
    await key(root, "k");
    assert.equal(q(container, ".wt-replay-play").getAttribute("aria-label"), "Pause");
    assert.equal(timers.size, 1);
    await key(root, "k");
    assert.equal(timers.size, 0, "pause clears the step timer");
  } finally { await unmount(); }
});

test("leaving the Replay tab unmounts the player and clears its timer", async () => {
  seed("tabs", 4);
  const { container, unmount } = await mount(WalkthroughView);
  try {
    const tabs = [...container.querySelectorAll("[role=tab]")];
    await click(tabs[1]!);
    await click(q(container, ".wt-replay-play"));
    assert.equal(timers.size, 1);
    await click(tabs[0]!);
    assert.ok(!q(container, ".wt-replay"));
    assert.equal(timers.size, 0);
    await advance(10_000);
  } finally { await unmount(); }
});

type RevealCall = { sessionId: string; seq: number; focus: boolean | undefined; fullscreenDuring: boolean };
function stubHost(result: boolean | "absent") {
  const calls: RevealCall[] = [];
  const nav: string[] = [];
  const host = {
    conversation: result === "absent" ? {} : {
      revealEvent: async (sessionId: string, seq: number, options?: { focus?: boolean }) => {
        calls.push({ sessionId, seq, focus: options?.focus, fullscreenDuring: getState().paneFullscreen });
        return result;
      },
    },
    navigation: {
      closeWorkspacePane: () => { nav.push("close"); },
      openWorkspacePane: (id: string) => { nav.push(`open:${id}`); return true; },
    },
  };
  return { host, calls, nav };
}

test("jump to message reveals the turn's prompt through the host seam", async () => {
  seed("jump-ok", 3);
  const { host, calls } = stubHost(true);
  const { container, unmount } = await mount(ReplayTheater, { host });
  try {
    await click(q(container, ".wt-replay-play"));
    await click(q(container, ".wt-replay-jump"));
    await act(async () => { await Promise.resolve(); });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.sessionId, "jump-ok");
    assert.equal(calls[0]!.focus, true);
    const prompt = getState().events["jump-ok"]!.find((e) => e.type === "user/message")!;
    assert.equal(calls[0]!.seq, prompt.seq, "reveals the user/message that started the turn");
    assert.equal(q(container, ".wt-replay-play").getAttribute("aria-label"), "Play", "jumping pauses playback");
    assert.ok(!q(container, ".wt-replay-notice"), "no notice on success");
    await key(q(container, ".wt-replay"), "m");
    await act(async () => { await Promise.resolve(); });
    assert.equal(calls.length, 2, "M shortcut uses the same seam");
  } finally { await unmount(); }
});

test("a failed reveal shows a dismissible status notice", async () => {
  seed("jump-fail", 2);
  const { host, calls } = stubHost(false);
  const { container, unmount } = await mount(ReplayTheater, { host });
  try {
    await click(q(container, ".wt-replay-jump"));
    await act(async () => { await Promise.resolve(); });
    assert.equal(calls.length, 1);
    const notice = q(container, ".wt-replay-notice");
    assert.ok(notice, "notice shown");
    assert.equal(notice.getAttribute("role"), "status");
    assert.match(notice.textContent ?? "", /Couldn't show that message/);
    await advance(6000);
    assert.ok(!q(container, ".wt-replay-notice"), "the notice clears itself");
  } finally { await unmount(); }
});

test("without the reveal seam the jump explains itself instead of failing silently", async () => {
  seed("jump-absent", 2);
  for (const props of [{ host: stubHost("absent").host }, null]) {
    const { container, unmount } = await mount(ReplayTheater, props);
    try {
      await click(q(container, ".wt-replay-jump"));
      assert.match(q(container, ".wt-replay-notice")?.textContent ?? "", /isn't available/);
    } finally { await unmount(); }
  }
});

test("a fullscreen pane yields to Chat for the reveal and returns when it fails", async () => {
  seed("jump-fs", 2);
  for (const result of [true, false] as const) {
    setPaneFullscreen(true);
    const { host, calls, nav } = stubHost(result);
    const { container, unmount } = await mount(ReplayTheater, { host }, "module-view module-view--main");
    try {
      await click(q(container, ".wt-replay-jump"));
      await act(async () => { await Promise.resolve(); });
      assert.equal(calls[0]!.fullscreenDuring, false, "Chat is not inert while revealing");
      assert.equal(getState().paneFullscreen, !result, result ? "stays yielded on success" : "restored after a failure");
      assert.deepEqual(nav, [], "desktop never closes the pane");
      assert.equal(!!q(container, ".wt-replay-notice"), !result);
    } finally { await unmount(); setPaneFullscreen(false); }
  }
});

test("first/last transport buttons have names and jump to the ends", async () => {
  seed("ends", 5);
  const { container, unmount } = await mount(ReplayTheater);
  try {
    const first = q(container, ".wt-replay-first");
    const last = q(container, ".wt-replay-last");
    assert.equal(first.getAttribute("aria-label"), "First step");
    assert.equal(last.getAttribute("aria-label"), "Last step");
    assert.equal(first.hasAttribute("disabled"), true);
    await click(last);
    assert.equal(count(container), "5/5");
    assert.equal(q(container, ".wt-replay-last").hasAttribute("disabled"), true);
    await click(q(container, ".wt-replay-first"));
    assert.equal(count(container), "1/5");
  } finally { await unmount(); }
});

test("every mode tab controls a tab panel labelled by that tab", async () => {
  seed("panels", 2);
  const { container, unmount } = await mount(WalkthroughView, { host: stubHost(true).host });
  try {
    for (let i = 0; i < 3; i++) {
      const tab = container.querySelectorAll("[role=tab]")[i]!;
      await click(tab);
      await act(async () => { await Promise.resolve(); });
      const current = container.querySelectorAll("[role=tab]")[i]!;
      const panel = document.getElementById(current.getAttribute("aria-controls")!);
      assert.ok(panel, `panel for tab ${i}`);
      assert.equal(panel.getAttribute("role"), "tabpanel");
      assert.equal(panel.getAttribute("aria-labelledby"), current.id);
      assert.equal(container.querySelectorAll("[role=tabpanel]").length, 1, "only the active panel renders");
    }
    // Replay: the panel is the shortcut surface itself — one Tab stop.
    await click(container.querySelectorAll("[role=tab]")[1]!);
    const panel = q(container, "[role=tabpanel]");
    assert.ok(panel.classList.contains("wt-replay"));
    assert.equal(panel.getAttribute("tabindex"), "0");
  } finally { await unmount(); }
});

test("pointer focus suppresses the panel ring until focus leaves; ticks share the slider's rail", async () => {
  seed("ring", 4);
  const { container, unmount } = await mount(ReplayTheater);
  try {
    const root = q(container, ".wt-replay");
    assert.equal(q(container, ".wt-replay-rail > .wt-replay-scrub + .wt-replay-ticks")?.getAttribute("aria-hidden"), "true");
    assert.equal(q(container, ".wt-replay-speed").classList.contains("ui-icon-btn--md"), true, "speed shares the icon-button chrome");
    await act(async () => { q(container, ".wt-replay-count").dispatchEvent(new dom.Event("pointerdown", { bubbles: true }) as unknown as Event); });
    assert.equal(root.hasAttribute("data-pointer-focus"), true);
    const blur = (relatedTarget: Element | null) => act(async () => {
      root.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true, relatedTarget: relatedTarget as never }) as unknown as Event);
    });
    await blur(q(container, ".wt-replay-scrub"));
    assert.equal(root.hasAttribute("data-pointer-focus"), true, "moving focus inside keeps the pointer origin");
    await blur(document.body);
    assert.equal(root.hasAttribute("data-pointer-focus"), false, "leaving the panel resets it for the next keyboard visit");
  } finally { await unmount(); }
});

test("an unknown After state never claims the content *before* the step was unseen", async () => {
  const sid = "after-unknown";
  activateSession(sid);
  applyEvents([
    ev(sid, "user/message", { text: "go" }),
    ev(sid, "tool/result", { callId: "p1", tool: "patch", output: "ok", input: { filePath: "src/p.ts", diff: "--- a/src/p.ts\n+++ b/src/p.ts\n@@ -0,0 +1 @@\n+x" } }),
    ev(sid, "tool/result", { callId: "e1", tool: "edit", output: "ok", input: { filePath: "src/e.ts", oldString: "gone", newString: "" } }),
  ]);
  const { container, unmount } = await mount(ReplayTheater);
  try {
    for (const position of ["1/2", "2/2"]) {
      if (count(container) !== position) await click(q(container, ".wt-replay-last"));
      assert.equal(count(container), position);
      const before = q(container, '.wt-replay-pane[aria-label="Before"]').textContent ?? "";
      const after = q(container, '.wt-replay-pane[aria-label="After"]').textContent ?? "";
      assert.doesNotMatch(after, /before this step/i, `${position}: After pane uses its own wording`);
      assert.match(after, /full file after this step isn't known/);
      if (position === "1/2") assert.match(before, /before this step was never seen/);
    }
  } finally { await unmount(); }
});

test("a single step shows its position without an empty, disabled scrubber", async () => {
  seed("single", 1);
  const { container, unmount } = await mount(ReplayTheater);
  try {
    assert.ok(!q(container, ".wt-replay-scrub"), "nothing to scrub between");
    assert.ok(!q(container, ".wt-replay-rail"));
    assert.equal(count(container), "1/1");
    assert.equal(q(container, ".wt-replay-last").hasAttribute("disabled"), true);
  } finally { await unmount(); }
});
