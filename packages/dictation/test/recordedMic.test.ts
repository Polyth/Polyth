// Record-first dictation on the real mic widget: the mic records without
// sending audio, shows how long it has recorded, uploads the recording in
// chunks after it stops, inserts the transcript once, keeps a recording whose
// send failed for the next press, and drops it on Esc.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { act } from "react";
import { Window } from "happy-dom";
import type { SlotRegistration, WebPackageHost, WidgetPlugin } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { installVoice, toggleDictation, setVoicePrefs } = await import("../widgets/voice.tsx");
const { tr } = await import("../../../apps/web/src/i18n/index.ts");

class FakeTrack {
  onended: (() => void) | null = null;
  stop() {}
}
class FakeStream {
  readonly track = new FakeTrack();
  getAudioTracks() { return [this.track]; }
  getTracks() { return [this.track]; }
}
class FakeContext {
  state = "running";
  audioWorklet = { addModule: async () => {} };
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  async resume() { this.state = "running"; }
  async suspend() { this.state = "suspended"; }
  async close() { this.state = "closed"; }
}
class FakeWorkletNode {
  static latest: FakeWorkletNode | null = null;
  port = { onmessage: null as ((event: { data: ArrayBuffer }) => void) | null };
  constructor() { FakeWorkletNode.latest = this; }
  connect() {}
  disconnect() {}
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });

test("record mode records, sends after stop, and keeps a failed recording for a retry", async () => {
  const widgets: WidgetPlugin[] = [];
  const host = {
    slots: { register: (_definition: SlotRegistration) => () => {} },
    widgets: { registerPlugin: (plugin: WidgetPlugin) => { widgets.push(plugin); return () => {}; } },
  } as unknown as WebPackageHost;
  const dispose = installVoice(host);

  const dom = new Window();
  let microphones = 0;
  const saved = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    fetch: globalThis.fetch,
  };
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    CustomEvent: dom.CustomEvent,
    KeyboardEvent: dom.KeyboardEvent,
    AudioContext: FakeContext,
    AudioWorkletNode: FakeWorkletNode,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      language: "en-US",
      userAgent: "happy-dom",
      mediaDevices: { async getUserMedia() { microphones++; return new FakeStream(); } },
    },
  });

  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  let failFinalize = 0;
  let sessions = 0;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ method, path, ...(body ? { body } : {}) });
    const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/api/settings/voice") {
      return ok({ dictation: { provider: "openai-compatible", transport: "auto", model: "", language: "en-US", contextInjection: false, processingPolicy: "prefer-cloud" } });
    }
    if (path.startsWith("/api/dictation/capability")) return ok({ available: true, engine: "whisper" });
    if (path === "/api/dictation/sessions" && method === "POST") return ok({ id: `rec-${++sessions}`, mode: "batch", acknowledgedSeq: 0 });
    if (path.endsWith("/audio")) return ok({ ack: Number(body?.seq), duplicate: false });
    if (path.endsWith("/finalize")) {
      if (failFinalize > 0) {
        failFinalize--;
        return new Response(JSON.stringify({ error: "provider_unavailable", message: "engine is busy" }), { status: 503 });
      }
      return ok({ transcript: ` recorded words ${sessions} ` });
    }
    if (method === "DELETE") return ok({ ok: true });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

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
  const control = () => container.querySelector(".mic-control")!;
  const button = () => container.querySelector(".mic-btn") as unknown as HTMLButtonElement;
  const speak = (bytes: number) => {
    FakeWorkletNode.latest!.port.onmessage!({ data: new ArrayBuffer(bytes) });
  };

  try {
    setVoicePrefs({ dictationMode: "record" });
    await act(async () => { root.render(widgets[0]!.widgets![0]!.render({} as never)); });
    await settle();
    assert.ok(requests.some((r) => r.path === "/api/dictation/capability?mode=batch"),
      "record mode asks the server whether it can transcribe recordings");

    // Record: nothing is sent while the person speaks.
    await act(async () => { assert.equal(toggleDictation(), true); });
    await settle();
    assert.equal(control().classList.contains("mic-recording"), true);
    assert.equal(button().getAttribute("aria-label"), tr("voice.stopRecording"));
    assert.equal(container.querySelector(".mic-take .mic-timer")?.textContent, "0:00");
    assert.equal(container.querySelector(".mic-take")?.getAttribute("aria-hidden"), "true",
      "the take is decoration; the button's name says it records");
    assert.ok(container.querySelector(".mic-take canvas.mic-wave"), "a recording draws the waveform of what it hears");
    assert.equal(container.querySelector(".mic-take-dot"), null);

    // Low resource mode stills the take: a dot instead of the moving wave.
    await act(async () => {
      dom.document.body.dataset.desktopLowResource = "true";
      dom.dispatchEvent(new dom.CustomEvent("polyth:desktop-performance-changed"));
    });
    assert.equal(container.querySelector(".mic-wave"), null, "Low resource mode draws no waveform");
    assert.ok(container.querySelector(".mic-take .mic-take-dot"));
    await act(async () => {
      delete dom.document.body.dataset.desktopLowResource;
      dom.document.documentElement.dataset.reduceAnimations = "true";
      dom.dispatchEvent(new dom.CustomEvent("polyth:desktop-performance-changed"));
    });
    assert.equal(container.querySelector(".mic-wave"), null, "Reduce animations draws no waveform");
    await act(async () => {
      delete dom.document.documentElement.dataset.reduceAnimations;
      dom.dispatchEvent(new dom.CustomEvent("polyth:desktop-performance-changed"));
    });
    assert.ok(container.querySelector(".mic-wave"), "the waveform returns with motion");
    const before = requests.length;
    await act(async () => { speak(3_200); speak(3_200); });
    assert.equal(requests.length, before, "no audio leaves the device while recording");
    assert.equal(updates.length, 0, "no words appear while recording");

    // Stop: one session, the audio as base64 chunks, then one transcript.
    await act(async () => { toggleDictation(); });
    await settle();
    const created = requests.find((r) => r.path === "/api/dictation/sessions");
    assert.equal(created?.body?.mode, "batch");
    const uploads = requests.filter((r) => r.path === "/api/dictation/sessions/rec-1/audio");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]!.body?.seq, 1);
    assert.equal(Buffer.from(String(uploads[0]!.body?.audio), "base64").byteLength, 6_400);
    assert.deepEqual(updates.map(({ text, final }) => ({ text, final })), [{ text: "recorded words 1", final: true }]);
    assert.equal(control().classList.contains("mic-idle"), true);
    assert.equal(container.querySelector(".mic-take"), null);

    // A failed send keeps the recording; the next press resends it.
    failFinalize = 1;
    await act(async () => { toggleDictation(); });
    await settle();
    await act(async () => { speak(1_600); });
    await act(async () => { toggleDictation(); });
    await settle();
    assert.equal(control().classList.contains("has-recording"), true);
    assert.equal(button().getAttribute("aria-label"), tr("voice.sendRecordingAgain"));
    assert.match(button().title, /engine is busy/);
    assert.equal(updates.length, 1, "a failed send inserts nothing");
    assert.ok(requests.some((r) => r.method === "DELETE" && r.path === "/api/dictation/sessions/rec-2"),
      "the failed server session is abandoned");

    const microphonesBeforeRetry = microphones;
    await act(async () => { toggleDictation(); });
    await settle();
    assert.equal(microphones, microphonesBeforeRetry, "a retry resends the recording without the microphone");
    const retried = requests.filter((r) => r.path === "/api/dictation/sessions/rec-3/audio");
    assert.equal(Buffer.from(String(retried[0]!.body?.audio), "base64").byteLength, 1_600);
    assert.equal(updates.at(-1)?.text, "recorded words 3");
    assert.equal(control().classList.contains("has-recording"), false);

    // Esc on the mic drops a recording that is waiting to be resent.
    failFinalize = 1;
    await act(async () => { toggleDictation(); });
    await settle();
    await act(async () => { speak(1_600); });
    await act(async () => { toggleDictation(); });
    await settle();
    assert.equal(control().classList.contains("has-recording"), true);
    await act(async () => {
      button().dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    });
    assert.equal(control().classList.contains("has-recording"), false);
    assert.equal(button().getAttribute("aria-label"), tr("voice.dictate"));
    const sessionsBefore = sessions;
    await act(async () => { toggleDictation(); });
    await settle();
    assert.equal(sessions, sessionsBefore, "after Esc the next press records anew instead of resending");
    assert.equal(control().classList.contains("mic-recording"), true);
    await act(async () => { toggleDictation(); });
    await settle();
  } finally {
    dom.removeEventListener("polyth:composer-dictation", consume as unknown as Parameters<typeof dom.removeEventListener>[1]);
    await act(async () => { root.unmount(); });
    setVoicePrefs({ dictationMode: "live" });
    globalThis.fetch = saved.fetch;
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
    await dom.happyDOM.close();
    dispose();
  }
});
