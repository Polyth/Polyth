import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { act, isValidElement } from "react";
import { Window } from "happy-dom";
import type { SlotRegistration, WebPackageHost, WidgetPlugin } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { installVoice } = await import("../widgets/voice.tsx");

test("voice installs per-reply read-aloud and a renderable microphone control", async () => {
  const slots: SlotRegistration[] = [];
  const widgets: WidgetPlugin[] = [];
  const disposed: string[] = [];
  const host = {
    slots: {
      register(definition: SlotRegistration) {
        slots.push(definition);
        return () => { disposed.push(`slot:${definition.id}`); };
      },
    },
    widgets: {
      registerPlugin(plugin: WidgetPlugin) {
        widgets.push(plugin);
        return () => { disposed.push(`widgets:${plugin.id}`); };
      },
    },
  } as unknown as WebPackageHost;

  const dispose = installVoice(host);
  assert.deepEqual(widgets.map((plugin) => plugin.id), ["voice"]);
  assert.deepEqual(slots.map(({ slot, id }) => [slot, id]), [
    ["session.message.actions", "dictation.read-reply"],
  ]);
  assert.ok(isValidElement(slots[0]!.render({
    sessionId: "session-1",
    kind: "assistant",
    messageId: "message-1",
    eventSeq: 7,
  })));

  const dom = new Window();
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    CustomEvent: dom.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  class FakeRecognition {
    static latest: FakeRecognition | null = null;
    static throwOnStart = false;
    started = 0;
    aborted = 0;
    lang = "";
    continuous = false;
    interimResults = false;
    onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() { FakeRecognition.latest = this; }
    start() {
      if (FakeRecognition.throwOnStart) throw new Error("recognition start failed");
      this.started++;
    }
    stop() { this.onend?.(); }
    abort() { this.aborted++; this.onend?.(); }
  }
  Object.defineProperty(dom, "SpeechRecognition", { value: FakeRecognition, configurable: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ available: false }), { status: 200 });
  const { createRoot } = await import("react-dom/client");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  try {
    const widget = widgets[0]!.widgets?.[0];
    assert.ok(widget, "the voice plugin declares a renderable widget");
    await act(async () => { root.render(widget.render({} as never)); });
    assert.ok(container.querySelector(".mic-btn"), "the microphone mounts instead of failing its slot boundary");
    const mic = container.querySelector<HTMLButtonElement>(".mic-btn");
    assert.ok(mic && !mic.disabled, "browser recognition keeps mobile mic usable while the provider is unavailable");
    const inserted: string[] = [];
    const consume = (event: Event) => {
      inserted.push(String((event as CustomEvent).detail));
      event.preventDefault();
    };
    dom.addEventListener("polyth:composer-insert", consume);
    await act(async () => { mic.click(); });
    const recognition = FakeRecognition.latest;
    assert.equal(recognition?.started, 1, "the browser recognition fallback starts from the mic intent");
    await act(async () => {
    recognition?.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "mobile dictation" } }] });
    });
    await act(async () => { recognition?.onend?.(); });
    assert.deepEqual(inserted, ["mobile dictation"], "the final browser transcript inserts exactly once");
    await act(async () => {
      recognition?.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "late stale result" } }] });
    });
    assert.deepEqual(inserted, ["mobile dictation"], "a result queued after onend cannot mutate the idle composer");
    await act(async () => { mic.click(); });
    const errored = FakeRecognition.latest;
    await act(async () => { errored?.onerror?.({ error: "not-allowed" }); });
    assert.equal(errored?.aborted, 1, "recognition errors abort and release the active recognizer");
    assert.deepEqual(inserted, ["mobile dictation"], "an error abort cannot commit a partial browser transcript");
    FakeRecognition.throwOnStart = true;
    await act(async () => { mic.click(); });
    assert.equal(FakeRecognition.latest?.aborted, 1, "a synchronous browser start failure releases the recognition object");
    dom.removeEventListener("polyth:composer-insert", consume);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
  }

  dispose();
  assert.deepEqual(disposed, ["slot:dictation.read-reply", "widgets:voice"]);
});
