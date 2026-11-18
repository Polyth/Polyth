import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let visibility = "visible";
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });

const events = [
  { id: "e1", sessionId: "child", seq: 1, time: 1, v: 1, type: "assistant/message", data: { partId: "p1", text: "working" } },
];
const urls: string[] = [];
(globalThis as { fetch?: unknown }).fetch = async (input: string | URL | Request) => {
  urls.push(String(input));
  const body = events;
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SubagentWork } = await import("../src/components/ExecutionRow.tsx");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a hidden tab issues no subagent reads and one on becoming visible; reads are a bounded passive tail", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const timers: Array<() => void> = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void) => { timers.push(fn); return timers.length; }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  try {
    await act(async () => root.render(createElement(SubagentWork, { sessionId: "child", status: "running" })));
    await act(async () => { await wait(5); });
    assert.equal(urls.length, 1, "one read on mount");
    assert.match(urls[0]!, /limit=\d+/);
    assert.match(urls[0]!, /prefetch=1/);
    await act(async () => { for (const tick of timers) tick(); await wait(5); });
    assert.equal(urls.length, 2, "a visible tick reads");
    assert.match(urls[0]!, /afterSeq=0\b/, "the first read takes the tail");
    assert.match(urls[1]!, /afterSeq=1\b/, "a later read asks only for events after the newest one held");
    assert.match(urls[1]!, /limit=\d+/);
    visibility = "hidden";
    await act(async () => { for (let i = 0; i < 5; i++) for (const tick of timers) tick(); await wait(5); });
    assert.equal(urls.length, 2, "hidden ticks read nothing");
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await wait(5); });
    assert.equal(urls.length, 3, "one read when the tab shows again");
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    await act(async () => root.unmount());
  }
});
