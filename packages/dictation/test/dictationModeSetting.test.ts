// Settings → Voice → Dictation mode against the real settings service and
// routes: the row switches between live and record-first, explains each, and
// is locked to live while the server's engine is browser recognition.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { createVoiceSettings } = await import("../../server/src/voice.ts");
const { ProviderRegistry } = await import("../src/providers.ts");
const { voiceRoutes } = await import("../src/serverEntry.ts");
type RouteRequest = import("../../server/src/http.ts").RouteRequest;

test("the dictation mode row switches between live and record-first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-dictation-mode-"));
  const voice = createVoiceSettings({ file: join(dir, "voice.json"), env: {} });
  voice.put({ dictation: { provider: "openai-compatible" } });
  const routes = voiceRoutes({ voice, providers: new ProviderRegistry() });

  const dom = new Window({ url: "http://polyth.test/" });
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    localStorage: dom.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://polyth.test");
    if (url.pathname === "/api/dictation/models") return new Response(JSON.stringify({ models: [] }));
    if (url.pathname === "/api/dictation/capability") return new Response(JSON.stringify({ available: true }));
    const raw = typeof init?.body === "string" ? init.body : "";
    let status = 404;
    let payload: unknown = { error: "not-found" };
    await routes({
      req: {}, res: {}, url, space: { userId: "usr_test" }, path: url.pathname, method: init?.method ?? "GET",
      body: async () => (raw ? JSON.parse(raw) : {}),
      json: (code: number, body: unknown) => { status = code; payload = body; },
    } as unknown as RouteRequest);
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: VoicePage } = await import("../widgets/VoicePage.tsx");
  const { getVoicePrefs, setVoicePrefs } = await import("../widgets/voice.tsx");
  const { tr } = await import("../../../apps/web/src/i18n/index.ts");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  let root = createRoot(container as unknown as HTMLElement);
  const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
  const row = () => container.querySelector('[data-settings-item="voice.dictation-mode"]')!;
  const hint = () => row().querySelector(".set-row-hint")?.textContent ?? "";
  const option = (label: string) => [...row().querySelectorAll("button")]
    .find((button) => button.textContent === label) as unknown as HTMLButtonElement;
  try {
    setVoicePrefs({ dictationMode: "live" });
    await act(async () => { root.render(createElement(VoicePage)); });
    await settle();

    assert.ok(row(), "the dictation section has a mode row");
    assert.equal(row().querySelector(".set-row-label")?.textContent, tr("settings.voicepage.dictationMode"));
    assert.equal(option(tr("settings.voicepage.dictationModeLive")).getAttribute("aria-pressed"), "true");
    assert.equal(hint(), tr("settings.voicepage.dictationModeLiveHint"));

    await act(async () => { option(tr("settings.voicepage.dictationModeRecord")).click(); });
    assert.equal(getVoicePrefs().dictationMode, "record");
    assert.equal(option(tr("settings.voicepage.dictationModeRecord")).getAttribute("aria-pressed"), "true");
    assert.equal(hint(), tr("settings.voicepage.dictationModeRecordHint"));
    assert.equal(JSON.parse(dom.localStorage.getItem("polyth.voice") ?? "{}").dictationMode, "record",
      "the choice is stored with the other voice prefs, which sync per person");

    // Browser recognition cannot record: the row says so, and with live
    // selected it is locked; a stored "record" can still be switched back.
    await act(async () => { root.unmount(); });
    voice.put({ dictation: { provider: "web-speech" } });
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => { root.render(createElement(VoicePage)); });
    await settle();
    assert.equal(hint(), tr("settings.voicepage.dictationModeBrowserOnly"));
    assert.equal(option(tr("settings.voicepage.dictationModeLive")).disabled, false);
    await act(async () => { option(tr("settings.voicepage.dictationModeLive")).click(); });
    assert.equal(getVoicePrefs().dictationMode, "live");
    assert.equal(option(tr("settings.voicepage.dictationModeRecord")).disabled, true);
    assert.equal(row().classList.contains("is-disabled"), true);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
