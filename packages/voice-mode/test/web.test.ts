// The real voice mode web entry, mounted in happy-dom with a fake browser
// recognizer: the launcher starts a conversation, the dock shows the turn,
// spoken words stream into the composer and a tap sends them through it.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Fragment, act, createElement, type ReactNode } from "react";
import { Window } from "happy-dom";
import type { SlotRegistration, WebPackageHost, WidgetPlugin } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

test("voice mode installs, runs a spoken turn through the composer, and cleans up", async () => {
  const dom = new Window({ width: 1280, height: 800 });
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    localStorage: dom.localStorage,
    CustomEvent: dom.CustomEvent,
    Event: dom.Event,
    HTMLElement: dom.HTMLElement,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // Node 22 defines a getter-only global navigator; replace it for the DOM's.
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

  class FakeRecognition {
    static latest: FakeRecognition | null = null;
    lang = "";
    continuous = false;
    interimResults = false;
    processLocally?: boolean;
    started = 0;
    onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() { FakeRecognition.latest = this; }
    start() { this.started++; }
    stop() { queueMicrotask(() => this.onend?.()); }
    abort() { this.onend?.(); }
  }
  Object.defineProperty(dom, "SpeechRecognition", { value: FakeRecognition, configurable: true });
  const originalFetch = globalThis.fetch;
  // An unreachable settings endpoint: routing falls back to local prefs and
  // the browser recognizer, like a paired phone without server access.
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "local-only" }), { status: 403 });

  const slots: SlotRegistration[] = [];
  const plugins: WidgetPlugin[] = [];
  const capabilities: Array<{ id: string; open(): void }> = [];
  const pages: string[] = [];
  const prefs: string[] = [];
  const disposed: string[] = [];
  const dictated: Array<{ text: string; final: boolean }> = [];
  let submits = 0;
  const host = {
    ui: { locale: { get: () => "en" } },
    store: { getSnapshot: () => ({ activeSessionId: "s1", activeProjectId: "p1" }) },
    sessions: { get: () => ({ title: "Fix flaky test" }), subscribeEvents: () => () => { disposed.push("events"); } },
    conversation: {
      dictate: (update: { text: string; final: boolean }) => { dictated.push(update); return true; },
      submitDraft: () => { submits++; return true; },
    },
    navigation: { setActiveView() {}, openSettingsPage() {} },
    preferences: { register: (id: string) => { prefs.push(id); return () => disposed.push(`pref:${id}`); } },
    settings: { registerPage: (page: { id: string }) => { pages.push(page.id); return () => disposed.push(`page:${page.id}`); } },
    slots: { register: (slot: SlotRegistration) => { slots.push(slot); return () => disposed.push(`slot:${slot.id}`); } },
    widgets: { registerPlugin: (plugin: WidgetPlugin) => { plugins.push(plugin); return () => disposed.push(`widgets:${plugin.id}`); } },
    capabilities: { register: (capability: { id: string; open(): void }) => { capabilities.push(capability); return () => disposed.push(`capability:${capability.id}`); } },
  } as unknown as WebPackageHost;

  const { default: entry } = await import("../widgets/index.tsx");
  const uninstall = entry(host)();
  assert.deepEqual(prefs, ["package.voice-mode"]);
  assert.deepEqual(pages, ["voice-mode"]);
  assert.deepEqual(slots.map(({ slot, id }) => [slot, id]), [
    ["session.composer.before", "voice-mode.layer"],
    ["composer.pending", "voice-mode.layer-fallback"],
  ]);
  assert.deepEqual(capabilities.map(({ id }) => id), ["voice-mode"]);
  const widget = plugins[0]!.widgets![0]!;
  assert.equal(widget.defaultSlot, "composer.trailing", "the launcher sits beside Send, like other voice assistants");

  const { createRoot } = await import("react-dom/client");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  const render = (node: ReactNode) => act(async () => { root.render(node); });
  try {
    // Inside-composer fallback mounted first: the area above still wins.
    await render(createElement(Fragment, null,
      createElement("div", { id: "inside" }, slots[1]!.render({})),
      createElement("div", { id: "above" }, slots[0]!.render({})),
      widget.render({} as never)));
    const launcher = container.querySelector(".voice-mode-btn") as unknown as HTMLButtonElement;
    assert.ok(launcher, "the launcher renders");
    assert.equal(container.querySelector(".voice-dock"), null, "nothing is drawn while voice mode is off");

    await act(async () => { launcher.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const recognition = FakeRecognition.latest;
    assert.equal(recognition?.started, 1, "the browser recognizer starts listening");
    const dock = container.querySelector(".voice-dock");
    assert.ok(dock, "a wide window gets the compact dock above the composer");
    assert.equal(container.querySelectorAll(".voice-dock").length, 1, "one host draws voice mode");
    assert.ok(container.querySelector("#above .voice-dock"), "the area above the composer is preferred");
    assert.equal(container.querySelector(".voice-phase")?.textContent, "Listening");
    assert.equal(launcher.getAttribute("aria-pressed"), "true");

    // Replies are switched in the voice window, not in Settings, and the
    // choice is the synced preference the next conversation starts with.
    const replies = container.querySelector(".voice-dock .voice-replies");
    assert.equal(replies?.getAttribute("aria-label"), "Replies");
    const option = (label: string) => replies!.querySelector(`button[aria-label="${label}"]`) as unknown as HTMLButtonElement;
    assert.equal(option("Spoken").getAttribute("aria-pressed"), "true");
    await act(async () => { option("Silent").click(); });
    assert.equal(option("Silent").getAttribute("aria-pressed"), "true");
    assert.equal(replies!.getAttribute("data-value"), "silent");
    assert.equal(JSON.parse(dom.localStorage.getItem("polyth.voice-mode") ?? "{}").feedback, "silent");
    await act(async () => { option("Spoken").click(); });
    assert.equal(replies!.getAttribute("data-value"), "voice");

    await act(async () => {
      recognition!.onresult!({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "run the tests comma please" } }] });
    });
    assert.deepEqual(dictated.at(-1), { runId: (dictated.at(-1) as { runId?: string }).runId, text: "run the tests, please", final: false },
      "spoken words (with spoken punctuation) stream into the composer");
    assert.match(container.querySelector(".voice-caption")?.textContent ?? "", /run the tests, please/);

    const orb = container.querySelector(".voice-orb") as unknown as HTMLButtonElement;
    assert.equal(orb.getAttribute("aria-label"), "Send now", "the orb names what a tap does");
    await act(async () => { orb.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(submits, 1, "a tap sends the draft through the composer");
    assert.equal(dictated.at(-1)?.final, true);
    assert.equal(container.querySelector(".voice-phase")?.textContent, "Listening",
      "the microphone reopens at once, so the user can keep talking while the agent works");
    assert.notEqual(FakeRecognition.latest, recognition, "a fresh recognizer listens for the next turn");

    const end = [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "End voice mode") as unknown as HTMLButtonElement;
    await act(async () => { end.click(); });
    assert.equal(container.querySelector(".voice-dock"), null, "ending removes the dock");
    assert.equal(launcher.getAttribute("aria-pressed"), "false");

    // New chat has no area above the composer: voice mode must still show.
    await render(createElement(Fragment, null,
      createElement("div", { id: "inside" }, slots[1]!.render({})),
      widget.render({} as never)));
    await act(async () => { (container.querySelector(".voice-mode-btn") as unknown as HTMLButtonElement).click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(container.querySelector("#inside .voice-dock"), "the composer fallback draws voice mode");
    await act(async () => { (container.querySelector(".voice-mode-btn") as unknown as HTMLButtonElement).click(); });
  } finally {
    await act(async () => { root.unmount(); });
    uninstall();
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    await dom.happyDOM.close();
  }
  assert.ok(disposed.includes("slot:voice-mode.layer") && disposed.includes("slot:voice-mode.layer-fallback") && disposed.includes("widgets:voice-mode")
    && disposed.includes("capability:voice-mode") && disposed.includes("page:voice-mode"));
});
