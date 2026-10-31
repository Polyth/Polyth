import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useComposerMorph, COMPOSER_MORPH_ATTRIBUTE } = await import("../src/composerMorph.ts");

type Call = { keyframes: Keyframe[]; options: KeyframeAnimationOptions; animation: EventTarget & { cancel(): void; finish(): void; cancelled: boolean } };

function Probe({ engaged }: { engaged: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useComposerMorph(ref, engaged, true);
  return createElement("div", { ref, className: "composer composer-mobile" },
    createElement("div", { className: "composer-card" }));
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let height = 56;
  // The height the running morph's keyframes impose, if the test set one.
  let animatedHeight: number | null = null;
  let running = 0;
  const calls: Call[] = [];
  // Installed before the first render: the hook learns the resting height on mount.
  const proto = dom.HTMLElement.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
    animate: unknown;
    classList: DOMTokenList;
  };
  const originalRect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: { classList: DOMTokenList }) {
    if (!this.classList.contains("composer-card")) return originalRect.call(this);
    const shown = running > 0 && animatedHeight !== null ? animatedHeight : height;
    return { height: shown, width: 360, top: 0, left: 0, right: 360, bottom: shown, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  proto.animate = (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    running += 1;
    let active = true;
    const stop = () => { if (active) { active = false; running -= 1; } };
    const animation = Object.assign(new dom.EventTarget() as unknown as EventTarget, {
      cancelled: false,
      cancel() { stop(); this.cancelled = true; (this as unknown as EventTarget).dispatchEvent(new dom.Event("cancel") as unknown as Event); },
      finish() { stop(); (this as unknown as EventTarget).dispatchEvent(new dom.Event("finish") as unknown as Event); },
    });
    calls.push({ keyframes, options, animation });
    return animation;
  };
  await act(async () => { root.render(createElement(Probe, { engaged: false })); });
  const composer = container.querySelector<HTMLElement>(".composer")!;
  return {
    composer,
    calls,
    setHeight: (next: number) => { height = next; },
    setAnimatedHeight: (next: number | null) => { animatedHeight = next; },
    render: (engaged: boolean) => act(async () => { root.render(createElement(Probe, { engaged })); }),
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
      proto.getBoundingClientRect = originalRect;
      delete (proto as { animate?: unknown }).animate;
    },
  };
}

test("engaging eases the card from its resting height on the keyboard's slide", async () => {
  const probe = await mount();
  try {
    // The resting height is learnt before the switch (ResizeObserver or mount).
    await probe.render(false);
    probe.setHeight(140);
    await probe.render(true);
    assert.equal(probe.calls.length, 1);
    assert.deepEqual(probe.calls[0]!.keyframes, [{ height: "56px" }, { height: "140px" }]);
    assert.equal(probe.calls[0]!.options.duration, 250);
    assert.equal(probe.calls[0]!.options.easing, "cubic-bezier(0.38, 0.7, 0.125, 1)");
    // Tagged so a native keyboard report can retime it (keyboardMotion.ts).
    assert.equal(probe.calls[0]!.options.id, "keyboard-ride");
    assert.equal(probe.composer.getAttribute(COMPOSER_MORPH_ATTRIBUTE), "engage",
      "CSS holds the content at the bottom edge while the top edge rises");
    probe.calls[0]!.animation.finish();
    assert.equal(probe.composer.getAttribute(COMPOSER_MORPH_ATTRIBUTE), null);

    probe.setHeight(56);
    await probe.render(false);
    assert.deepEqual(probe.calls[1]!.keyframes, [{ height: "140px" }, { height: "56px" }]);
    assert.equal(probe.composer.getAttribute(COMPOSER_MORPH_ATTRIBUTE), "rest");
  } finally {
    await probe.unmount();
  }
});

test("a switch mid-morph continues from where the card is, not from either end", async () => {
  const probe = await mount();
  try {
    await probe.render(false);
    probe.setHeight(140);
    await probe.render(true);
    // Partway up when the editor loses focus again.
    probe.setAnimatedHeight(98);
    probe.setHeight(56);
    const first = probe.calls[0]!.animation;
    await probe.render(false);
    assert.equal(first.cancelled, true);
    assert.deepEqual(probe.calls[1]!.keyframes, [{ height: "98px" }, { height: "56px" }]);
    // The cancelled morph's late event must not clear the new one's marker.
    assert.equal(probe.composer.getAttribute(COMPOSER_MORPH_ATTRIBUTE), "rest");
  } finally {
    await probe.unmount();
  }
});

test("an engaging card whose rows settle elsewhere mid-morph is re-aimed there instead of snapping at the end", async () => {
  // Rows stack from the card's top; the editor still has the resting row's
  // height when the morph measures, and shrinks once it sizes itself.
  const rows = [44, 46, 52];
  const observers = new Set<{ callback: () => void; targets: Element[] }>();
  // Rows report a resize; the morph re-aims on the next frame.
  const resize = async () => {
    for (const observer of [...observers]) if (observer.targets.length) observer.callback();
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  const observed = () => [...observers].flatMap((observer) => observer.targets);
  const globals = globalThis as unknown as { ResizeObserver?: unknown; getComputedStyle?: unknown };
  const saved = { ResizeObserver: globals.ResizeObserver, getComputedStyle: globals.getComputedStyle };
  globals.ResizeObserver = class {
    private readonly entry: { callback: () => void; targets: Element[] };
    constructor(callback: () => void) { this.entry = { callback, targets: [] }; observers.add(this.entry); }
    observe(target: Element) { this.entry.targets.push(target); }
    unobserve() {}
    disconnect() { this.entry.targets = []; }
  };
  globals.getComputedStyle = dom.getComputedStyle.bind(dom);
  const proto = dom.HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect; animate: unknown };
  const originalRect = proto.getBoundingClientRect;
  let engaged = false;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const index = Number(this.dataset.row ?? -1);
    if (index >= 0) {
      const top = rows.slice(0, index).reduce((sum, height) => sum + height, 0);
      return { top, bottom: top + rows[index]!, height: rows[index]!, width: 360, left: 0, right: 360, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    }
    if (!this.classList.contains("composer-card")) return originalRect.call(this);
    const height = engaged ? rows.reduce((sum, value) => sum + value, 0) : 56;
    return { top: 0, bottom: height, height, width: 360, left: 0, right: 360, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  const morphs: Array<{ keyframes: Keyframe[]; retargets: Keyframe[][]; animation: EventTarget }> = [];
  proto.animate = (keyframes: Keyframe[]) => {
    const retargets: Keyframe[][] = [];
    const animation = Object.assign(new dom.EventTarget() as unknown as EventTarget, {
      cancel() {}, finish() {},
      effect: { setKeyframes(next: Keyframe[]) { retargets.push(next); } },
    });
    morphs.push({ keyframes, retargets, animation });
    return animation;
  };
  function RowsProbe({ engaged: on }: { engaged: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useComposerMorph(ref, on, true);
    return createElement("div", { ref, className: "composer composer-mobile" },
      createElement("div", { className: "composer-card" },
        // Frozen while the card morphs, as styles.css holds them.
        ...rows.map((_, index) => createElement("div", { key: index, "data-row": String(index), style: { flexGrow: 0, flexShrink: 0 } }))));
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(RowsProbe, { engaged: false })); });
    engaged = true;
    await act(async () => { root.render(createElement(RowsProbe, { engaged: true })); });
    assert.deepEqual(morphs[0]!.keyframes, [{ height: "56px" }, { height: "142px" }]);
    assert.ok(observed().some((target) => (target as HTMLElement).dataset?.row === "1"), "the editor row is watched");
    // The editor sizes itself for the engaged card after the morph measured.
    rows[1] = 36;
    await resize();
    assert.deepEqual(morphs[0]!.retargets, [[{ height: "56px" }, { height: "132px" }]],
      "the running morph now ends where the card settles");
    await resize();
    assert.equal(morphs[0]!.retargets.length, 1, "an unchanged settled height is not re-aimed again");
    // A row that can still flex reports its squeezed box, not its settled size.
    const editorRow = container.querySelector<HTMLElement>('[data-row="1"]')!;
    editorRow.style.flexShrink = "1";
    rows[1] = 20;
    await resize();
    assert.equal(morphs[0]!.retargets.length, 1, "a flexing row never re-aims the morph");
    editorRow.style.flexShrink = "0";
    rows[1] = 36;
    morphs[0]!.animation.dispatchEvent(new dom.Event("finish") as unknown as Event);
    assert.ok(!observed().some((target) => (target as HTMLElement).dataset?.row), "a settled morph stops watching the rows");

    // A resting row is a fixed height: its morph never follows the rows.
    engaged = false;
    await act(async () => { root.render(createElement(RowsProbe, { engaged: false })); });
    assert.deepEqual(morphs[1]!.keyframes, [{ height: "132px" }, { height: "56px" }]);
    rows[1] = 60;
    await resize();
    assert.deepEqual(morphs[1]!.retargets, []);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    proto.getBoundingClientRect = originalRect;
    delete (proto as { animate?: unknown }).animate;
    globals.ResizeObserver = saved.ResizeObserver;
    globals.getComputedStyle = saved.getComputedStyle;
  }
});

test("no morph without a height change, on first mount, or under reduced motion", async () => {
  const probe = await mount();
  try {
    assert.equal(probe.calls.length, 0, "mounting never animates");
    await probe.render(true);
    assert.equal(probe.calls.length, 0, "an unchanged height is not a morph");
    document.documentElement.dataset.reduceAnimations = "true";
    probe.setHeight(56);
    await probe.render(false);
    assert.equal(probe.calls.length, 0);
    assert.equal(probe.composer.getAttribute(COMPOSER_MORPH_ATTRIBUTE), null);
  } finally {
    delete document.documentElement.dataset.reduceAnimations;
    await probe.unmount();
  }
});
