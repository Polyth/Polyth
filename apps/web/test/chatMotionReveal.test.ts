// A session surface lands as one revealed surface (host: builtinSurfaces
// publishes `data-session-reveal="active"` on <html> for that beat). Rows the
// transcript mounts meanwhile get no per-row entrance; once the beat is over,
// live arrivals animate again. Own file: chatMotion installs global watchers.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  location: dom.location,
  history: dom.history,
  addEventListener: dom.addEventListener.bind(dom),
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
});

const animated: HTMLElement[] = [];
const proto = dom.HTMLElement.prototype as unknown as HTMLElement;
Object.defineProperty(proto, "getBoundingClientRect", {
  configurable: true,
  value(this: HTMLElement) {
    const top = this.classList.contains("timeline") ? 0 : 100;
    const height = this.classList.contains("timeline") ? 600 : 40;
    return { top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) };
  },
});
Object.defineProperty(proto, "animate", {
  configurable: true,
  value(this: HTMLElement) {
    animated.push(this);
    return { finished: Promise.resolve(), playState: "finished", cancel() {} } as unknown as Animation;
  },
});

await import("../src/chatMotion.ts");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("rows mounted while a session reveal is active get no entrance; later arrivals do", async () => {
  const timeline = dom.document.createElement("div");
  timeline.className = "timeline";
  dom.document.body.appendChild(timeline);
  await settle();

  dom.document.documentElement.dataset.sessionReveal = "active";
  const landed = dom.document.createElement("div");
  landed.className = "msg assistant";
  timeline.appendChild(landed);
  await settle();
  assert.deepEqual(animated, [], "history landing with the surface is not replayed row by row");

  delete dom.document.documentElement.dataset.sessionReveal;
  const arrival = dom.document.createElement("div");
  arrival.className = "msg assistant";
  timeline.appendChild(arrival);
  await settle();
  assert.equal(animated.length, 1, "a live arrival after the reveal still enters");
  assert.equal(animated[0], arrival as unknown as HTMLElement);
  dom.close();
});
