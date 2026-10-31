// Settings → Voice against the real settings service and routes: a key typed
// for the read-aloud service is saved write-only, the page then says the
// service is ready (not "until it is saved"), and the key can be removed.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { createVoiceSettings } = await import("../../server/src/voice.ts");
const { ProviderRegistry } = await import("../src/providers.ts");
const { voiceRoutes } = await import("../src/serverEntry.ts");
type RouteRequest = import("../../server/src/http.ts").RouteRequest;

test("a read-aloud key typed in Settings is saved write-only and makes the service ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-voice-page-"));
  const file = join(dir, "voice.json");
  const voice = createVoiceSettings({ file, env: {} });
  voice.put({ tts: { provider: "elevenlabs", apiKeyEnv: "ELEVENLABS_API_KEY", voice: "JBFqnCBsd6RMkjVDRZzb" } });
  const routes = voiceRoutes({ voice, providers: new ProviderRegistry() });
  const bodies: string[] = [];

  const dom = new Window({ url: "http://polyth.test/" });
  dom.localStorage.setItem("polyth.voice", JSON.stringify({ ttsEngine: "server" }));
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
    if (url.pathname === "/api/dictation/capability") return new Response(JSON.stringify({ available: false }));
    const method = init?.method ?? "GET";
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw) bodies.push(raw);
    let status = 404;
    let payload: unknown = { error: "not-found" };
    await routes({
      req: {}, res: {}, url, space: { userId: "usr_test" }, path: url.pathname, method,
      body: async () => (raw ? JSON.parse(raw) : {}),
      json: (code: number, body: unknown) => { status = code; payload = body; },
    } as unknown as RouteRequest);
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: VoicePage } = await import("../widgets/VoicePage.tsx");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
  try {
    await act(async () => { root.render(createElement(VoicePage)); });
    await settle();

    const engineHint = () => container.querySelector('[data-settings-item="voice.ttsEngine"] .set-row-hint')?.textContent ?? "";
    const keyInput = () => container.querySelector(".voice-server-grid input[type=password]") as unknown as HTMLInputElement | null;
    const ttsForm = () => keyInput()!.closest(".voice-server-group")!.parentElement!;
    const ttsButton = (label: RegExp) => [...ttsForm().querySelectorAll(".voice-server-group ~ .settings-save-bar button, .voice-key button")]
      .find((button) => label.test(button.textContent ?? "")) as unknown as HTMLButtonElement | undefined;
    const click = (button: HTMLButtonElement | undefined) => act(async () => {
      assert.ok(button, "expected the button");
      assert.equal(button.disabled, false);
      button.click();
    });

    // Saved hosted service without a key: says the key is missing, not "unsaved".
    assert.match(engineHint(), /ttsKeyMissing|has no API key/);
    assert.doesNotMatch(engineHint(), /ttsServerSetup|Until it is saved/);
    assert.ok(keyInput(), "the read-aloud service offers an API key field");

    const key = "sk_00112233445566778899aabbccddeeff00112233";
    await act(async () => {
      const input = keyInput()!;
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, key);
      input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    await click(ttsButton(/save/i));
    await settle();

    assert.equal(voice.resolveKey("tts"), key);
    assert.deepEqual(JSON.parse(bodies.at(-1)!).keys, { "tts:elevenlabs": key });
    assert.doesNotMatch(readFileSync(file, "utf8"), new RegExp(key));
    assert.equal(keyInput()!.value, "", "the key is never shown back");
    assert.match(keyInput()!.placeholder, /apiKeySavedPlaceholder|Saved/);
    assert.doesNotMatch(engineHint(), /ttsKeyMissing|has no API key/);
    assert.doesNotMatch(container.innerHTML, new RegExp(key));

    await click(ttsButton(/apiKeyRemove|^Remove$/));
    await click(ttsButton(/save/i));
    await settle();
    assert.equal(voice.resolveKey("tts"), undefined);
    assert.deepEqual(voice.storedKeys(), []);
    assert.match(engineHint(), /ttsKeyMissing|has no API key/);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
