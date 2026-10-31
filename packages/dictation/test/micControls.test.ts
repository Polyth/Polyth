// Dictation mic refinements on the real widget: the command/shortcut toggles
// the composer's mic, spoken punctuation lands in the draft, the on-device
// recognizer is preferred when the browser has it, and voice mode taking the
// microphone ends dictation without losing the words already spoken.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { act } from "react";
import { Window } from "happy-dom";
import type { SlotRegistration, WebPackageHost, WidgetPlugin } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { installVoice, toggleDictation, dictationControlsMounted } = await import("../widgets/voice.tsx");
const { MICROPHONE_CLAIM_EVENT } = await import("../src/browser.ts");

test("mic command, spoken punctuation, on-device preference and microphone claims", async () => {
  const widgets: WidgetPlugin[] = [];
  const host = {
    slots: { register: (_definition: SlotRegistration) => () => {} },
    widgets: { registerPlugin: (plugin: WidgetPlugin) => { widgets.push(plugin); return () => {}; } },
  } as unknown as WebPackageHost;
  const dispose = installVoice(host);

  const dom = new Window();
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    CustomEvent: dom.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  class FakeRecognition {
    static latest: FakeRecognition | null = null;
    static availability = "available";
    static async available() { return FakeRecognition.availability; }
    started = 0;
    stopped = 0;
    lang = "";
    continuous = false;
    interimResults = false;
    processLocally?: boolean;
    onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() { FakeRecognition.latest = this; }
    start() { this.started++; }
    stop() { this.stopped++; this.onend?.(); }
    abort() { this.onend?.(); }
  }
  Object.defineProperty(dom, "SpeechRecognition", { value: FakeRecognition, configurable: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ available: false }), { status: 200 });
  const { createRoot } = await import("react-dom/client");
  const container = dom.document.createElement("div");
  container.className = "composer-rail";
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  const updates: Array<{ text: string; final: boolean }> = [];
  const consume = (event: Event) => {
    updates.push((event as CustomEvent).detail as { text: string; final: boolean });
    event.preventDefault();
  };
  dom.addEventListener("polyth:composer-dictation", consume as unknown as Parameters<typeof dom.addEventListener>[1]);
  try {
    assert.equal(dictationControlsMounted(), false);
    await act(async () => { root.render(widgets[0]!.widgets![0]!.render({} as never)); });
    // Let the on-device probe and capability checks settle.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.equal(dictationControlsMounted(), true, "a mounted mic is reachable from the command");

    await act(async () => { assert.equal(toggleDictation(), true); });
    const recognition = FakeRecognition.latest!;
    assert.equal(recognition.started, 1, "the command starts dictation in the composer's mic");
    assert.equal(recognition.processLocally, true, "the on-device recognizer is preferred when available");

    await act(async () => {
      recognition.onresult!({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "hello comma world question mark" } }] });
    });
    assert.deepEqual(updates.at(-1), { ...updates.at(-1), text: "hello, world?", final: false },
      "spoken punctuation is applied to the live transcript");

    await act(async () => {
      recognition.onresult!({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "hello comma world question mark" } }] });
      dom.dispatchEvent(new dom.CustomEvent(MICROPHONE_CLAIM_EVENT, { detail: { owner: "voice-mode" } }));
    });
    assert.equal(recognition.stopped, 1, "voice mode taking the microphone stops dictation");
    assert.deepEqual(updates.at(-1), { ...updates.at(-1), text: "hello, world?", final: true },
      "the words already spoken are committed, not discarded");

    FakeRecognition.availability = "unavailable";
    await act(async () => { toggleDictation(); });
    await act(async () => { toggleDictation(); });
    assert.equal(FakeRecognition.latest!.started, 1, "toggling again starts and then stops a new run");
    assert.equal(FakeRecognition.latest!.stopped, 1);
  } finally {
    dom.removeEventListener("polyth:composer-dictation", consume as unknown as Parameters<typeof dom.removeEventListener>[1]);
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
  }
  assert.equal(dictationControlsMounted(), false, "an unmounted mic is no longer a command target");
  dispose();
});
