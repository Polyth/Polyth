// The running clock of a working row is the only thing in a list that changes
// every second. It ticks in the label alone, on one shared timer, so the list
// around it is not rendered again each second.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, { window: dom, document: dom.document });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useNowTick, nowTickSubscriberCount } = await import("../src/nowTicker.ts");

test("labels tick on one shared timer without re-rendering their list", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  let listRenders = 0;
  let showSecond: (value: boolean) => void = () => {};
  const Label = ({ id, since }: { id: string; since: number }) =>
    createElement("span", { id }, String(Math.floor((useNowTick(true) - since) / 1000)));
  const Idle = () => createElement("i", { id: "idle" }, String(useNowTick(false)));
  const List = () => {
    listRenders++;
    const [second, setSecond] = useState(true);
    showSecond = setSecond;
    return createElement("div", null,
      createElement(Label, { id: "one", since: 1_000_000 - 30_000 }),
      second ? createElement(Label, { id: "two", since: 1_000_000 - 90_000 }) : null,
      createElement(Idle));
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const text = (id: string) => container.querySelector(`#${id}`)?.textContent;
  try {
    await act(async () => { root.render(createElement(List)); });
    assert.equal(text("one"), "30");
    assert.equal(text("two"), "90");
    assert.equal(nowTickSubscriberCount(), 2, "a label that is not running does not subscribe");
    const rendersAtRest = listRenders;
    const idleAtRest = text("idle");

    await act(async () => { t.mock.timers.tick(3_000); });
    assert.equal(text("one"), "33");
    assert.equal(text("two"), "93");
    assert.equal(listRenders, rendersAtRest, "three ticks moved two labels and never the list");
    assert.equal(text("idle"), idleAtRest);

    await act(async () => { showSecond(false); });
    assert.equal(nowTickSubscriberCount(), 1);
    await act(async () => { root.unmount(); });
    assert.equal(nowTickSubscriberCount(), 0, "the timer has nobody left to drive");
  } finally {
    container.remove();
  }
});

test("a hidden page leaves its labels alone and catches up when it is shown again", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 2_000_000 });
  let renders = 0;
  const Label = () => { renders++; return createElement("span", { id: "label" }, String((useNowTick(true) - 2_000_000) / 1000)); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const text = () => container.querySelector("#label")?.textContent;
  const setVisibility = (state: "hidden" | "visible") => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
  };
  try {
    await act(async () => { root.render(createElement(Label)); });
    await act(async () => { t.mock.timers.tick(1_000); });
    assert.equal(text(), "1");
    const rendersShown = renders;

    await act(async () => { setVisibility("hidden"); });
    await act(async () => { t.mock.timers.tick(30_000); });
    assert.equal(renders, rendersShown, "thirty hidden seconds rendered nothing");
    assert.equal(text(), "1");

    await act(async () => { setVisibility("visible"); });
    assert.equal(text(), "31", "shown again, the label is right at once");
    await act(async () => { t.mock.timers.tick(1_000); });
    assert.equal(text(), "32");
  } finally {
    setVisibility("visible");
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a label that mounts after the clock stood still starts from now", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 5_000_000 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const Label = () => createElement("span", null, String(useNowTick(true)));
  try {
    await act(async () => { root.render(createElement(Label)); });
    await act(async () => { root.unmount(); });
    // Nothing listened for ten minutes, so the shared reading is that old.
    t.mock.timers.setTime(5_600_000);
    const later = createRoot(container);
    const seen: string[] = [];
    const Probe = () => { const now = String(useNowTick(true)); seen.push(now); return createElement("span", null, now); };
    await act(async () => { later.render(createElement(Probe)); });
    assert.equal(seen[0], "5600000", "the first paint already shows the current time");
    await act(async () => { later.unmount(); });
  } finally {
    container.remove();
  }
});

test.after(async () => { await dom.happyDOM.close(); });
