// A package window's close animation, mounted for real (happy-dom). The
// leaving window plays its exit beside the kept-alive panes, which stay
// mounted and hidden the whole time. Rendering the leaving surface alone used
// to unmount every kept pane as the exit began and mount it afresh as it
// ended: lost package state, and two main-thread spikes framing the motion.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

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
  getComputedStyle: dom.getComputedStyle.bind(dom),
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { fetch?: unknown }).fetch = async (input: string | URL | Request) => {
  const body = String(input).startsWith("/api/git/status")
    ? { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], clean: true, isRepo: false }
    : [];
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerSurface } = await import("../src/surfaces.ts");
const { activateProject, applyProjectUpsert, setRailPlugin } = await import("../src/store.ts");
const { default: ContextRail } = await import("../src/components/ContextRail.tsx");

// Nodes are compared by identity into booleans: a failing assert.equal on a
// happy-dom node inspects the whole Window graph and runs out of memory.
const PROJECT = "package-window-exit";
/** Past the host's exit hold (PANE_EXIT_FALLBACK_MS) with room to spare. */
const PAST_EXIT_MS = 520;
const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

const lifecycle: string[] = [];
const probe = (id: string) => function Probe({ active }: { active?: boolean } = {}) {
  useEffect(() => {
    lifecycle.push(`mount:${id}`);
    return () => { lifecycle.push(`unmount:${id}`); };
  }, []);
  return createElement("p", { "data-probe": id, "data-active": String(active) }, id);
};

test("closing a window keeps every kept-alive pane mounted through its exit", async () => {
  applyProjectUpsert({ id: PROJECT, path: "/work/package-window-exit", name: "Exit", createdAt: 1 });
  activateProject(PROJECT);
  const unregister = [
    registerSurface({
      id: "exit-kept",
      title: "Kept",
      order: 1,
      component: probe("exit-kept"),
      presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "close" },
    }),
    // A contextual panel: it docks without waiting for workspace geometry.
    registerSurface({ id: "exit-panel", title: "Panel", order: 2, component: probe("exit-panel") }),
  ];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const body = (id: string) => container.querySelector(`[data-probe="${id}"]`)?.closest<HTMLElement>(".rail-body") ?? null;
  try {
    await act(async () => { root.render(createElement(ContextRail)); });

    // Visit the keep-alive pane and close it: it stays mounted, hidden.
    await act(async () => { setRailPlugin("exit-kept"); });
    await act(async () => { setRailPlugin(null); });
    await sleep(PAST_EXIT_MS);
    const kept = body("exit-kept");
    assert.ok(kept !== null, "a visited keep-alive pane stays mounted after close");
    assert.equal(kept.hidden, true);

    await act(async () => { setRailPlugin("exit-panel"); });
    assert.equal(body("exit-panel")?.hidden, false, "the panel opens beside it");
    assert.ok(body("exit-kept") === kept);
    lifecycle.length = 0;

    // Close: the panel is held for its exit…
    await act(async () => { setRailPlugin(null); });
    const pane = container.querySelector<HTMLElement>(".railbar > .rail");
    assert.equal(pane?.classList.contains("rail-exiting"), true, "the leaving window is held for its exit");
    assert.equal(pane?.getAttribute("data-rail-motion"), "exiting");
    assert.equal(body("exit-panel")?.hidden, false, "the leaving window stays painted");
    assert.equal(body("exit-panel")?.hasAttribute("inert"), true, "…and inert");
    assert.deepEqual(lifecycle, [], "nothing unmounts or remounts as the exit begins");
    assert.ok(body("exit-kept") === kept, "the kept-alive pane is the same node during the exit");
    assert.equal(kept.hidden, true, "…and stays hidden");

    // …and released once it has played.
    await sleep(PAST_EXIT_MS);
    assert.ok(container.querySelector(".rail-exiting") === null, "the exit is released");
    assert.ok(body("exit-panel") === null, "the leaving panel unmounts after its exit");
    assert.deepEqual(lifecycle, ["unmount:exit-panel"], "only the leaving panel unmounts, once, after its exit");
    assert.ok(body("exit-kept") === kept, "the kept-alive pane is still the same node");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    for (const off of unregister) off();
    await act(async () => { setRailPlugin(null); });
  }
});
