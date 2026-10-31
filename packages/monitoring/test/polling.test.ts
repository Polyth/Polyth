import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { Window } from "happy-dom";
import { usePolling } from "../widgets/usePolling.ts";

test("polling isolates instances, drops old host results, bounds concurrency and cleans up", async (t) => {
  const window = new Window({ url: "http://monitoring.test" });
  const keys = ["window", "document", "navigator", "HTMLElement", "MutationObserver"] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  keys.forEach((key) => Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true }));
  const timers: Array<() => void> = [];
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay === 5_000) { timers.push(callback); return callback as unknown as ReturnType<typeof setTimeout>; }
    return nativeSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    const index = timers.indexOf(id as unknown as () => void);
    if (index >= 0) timers.splice(index, 1); else nativeClearTimeout(id);
  }) as typeof clearTimeout;
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  t.after(async () => {
    root.unmount(); await window.happyDOM.close();
    globalThis.setTimeout = nativeSetTimeout; globalThis.clearTimeout = nativeClearTimeout;
    keys.forEach((key, index) => { if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!); else Reflect.deleteProperty(globalThis, key); });
  });
  const requests: Array<{ key: string; signal: AbortSignal; resolve: (value: string) => void }> = [];
  const loadA = (signal: AbortSignal) => new Promise<string>((resolve) => requests.push({ key: "A", signal, resolve }));
  const loadB = (signal: AbortSignal) => new Promise<string>((resolve) => requests.push({ key: "B", signal, resolve }));
  const loadOther = (signal: AbortSignal) => new Promise<string>((resolve) => requests.push({ key: "other", signal, resolve }));
  function Probe({ name, loader, live = false, active = true }: { name: string; loader: typeof loadA; live?: boolean; active?: boolean }) {
    const state = usePolling(name, loader, active, live);
    return createElement("output", { "data-probe": name }, state.value ?? (state.busy ? "loading" : "empty"));
  }
  const settle = async (condition: () => boolean) => {
    const deadline = Date.now() + 2_000;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => nativeSetTimeout(resolve, 5));
    assert.ok(condition());
  };
  root.render(createElement(Probe, { name: "A", loader: loadA }));
  await settle(() => requests.length === 1);
  root.render(createElement(Probe, { name: "B", loader: loadB }));
  await settle(() => requests.length === 2);
  assert.equal(requests[0]!.signal.aborted, true);
  requests[1]!.resolve("current host"); await settle(() => container.textContent === "current host");
  requests[0]!.resolve("stale host");
  await new Promise((resolve) => nativeSetTimeout(resolve, 20));
  assert.equal(container.textContent, "current host");
  root.render(createElement("div", {}, createElement(Probe, { key: "main", name: "B", loader: loadB, live: true }), createElement(Probe, { key: "other", name: "other", loader: loadOther })));
  await settle(() => requests.length === 4);
  assert.equal(timers.length, 0, "no poll timer while the first request is running");
  requests[2]!.resolve("live host"); requests[3]!.resolve("independent host");
  await settle(() => timers.length === 1 && container.textContent === "live hostindependent host");
  timers.shift()!(); await settle(() => requests.length === 5);
  assert.equal(timers.length, 0, "the next request must finish before another timer is scheduled");
  root.render(createElement(Probe, { name: "B", loader: loadB, active: false }));
  await settle(() => requests[4]!.signal.aborted);
  requests[4]!.resolve("late result");
  await new Promise((resolve) => nativeSetTimeout(resolve, 20));
  assert.equal(requests.length, 5); assert.equal(timers.length, 0);

  // Hide/resume before the aborted request settles must restart even when
  // live mode is off, and the aborted result must never become visible.
  root.render(createElement(Probe, { name: "A", loader: loadA }));
  await settle(() => requests.length === 6);
  Object.defineProperty(window.document, "visibilityState", { value: "hidden", configurable: true });
  Object.defineProperty(window.document, "hidden", { value: true, configurable: true });
  window.document.dispatchEvent(new window.Event("visibilitychange"));
  assert.equal(requests[5]!.signal.aborted, true);
  Object.defineProperty(window.document, "visibilityState", { value: "visible", configurable: true });
  Object.defineProperty(window.document, "hidden", { value: false, configurable: true });
  window.document.dispatchEvent(new window.Event("visibilitychange"));
  requests[5]!.resolve("hidden stale result");
  await settle(() => requests.length === 7);
  assert.equal(container.textContent?.includes("hidden stale result"), false);
  requests[6]!.resolve("resumed host"); await settle(() => container.textContent === "resumed host");
});
