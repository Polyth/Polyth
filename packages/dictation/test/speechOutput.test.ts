// The shared speech output: chunks play in order on the best voice, a
// failing server voice falls back to the browser voice instead of going
// silent, and a second owner claiming the speaker silences the first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window();
Object.assign(globalThis, { window: dom, CustomEvent: dom.CustomEvent });
Object.defineProperty(globalThis, "navigator", { value: { language: "en-US" }, configurable: true });

const spoken: Array<{ text: string; voice: string | null; lang: string }> = [];
class FakeUtterance {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: { name: string; lang: string } | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onboundary: (() => void) | null = null;
  constructor(text: string) { this.text = text; }
}
const voices = [
  { name: "Albert", lang: "en-US", localService: true },
  { name: "Samantha", lang: "en-US", localService: true, default: true },
  { name: "Ava (Premium)", lang: "en-US", localService: true },
];
let current: FakeUtterance | null = null;
const synth = {
  speaking: false,
  paused: false,
  getVoices: () => voices,
  speak(utterance: FakeUtterance) {
    current = utterance;
    this.speaking = true;
    spoken.push({ text: utterance.text, voice: utterance.voice?.name ?? null, lang: utterance.lang });
    queueMicrotask(() => utterance.onstart?.());
  },
  cancel() { this.speaking = false; current = null; },
  resume() {},
  addEventListener() {},
  removeEventListener() {},
};
Object.assign(dom, { speechSynthesis: synth });
Object.assign(globalThis, { SpeechSynthesisUtterance: FakeUtterance });

const { createSpeechOutput } = await import("../widgets/speechOutput.ts");

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const finishCurrent = async () => {
  const utterance = current;
  synth.speaking = false;
  utterance?.onend?.();
  await tick();
};

const settings = (engine: "browser" | "server" = "browser") => () => ({ engine, lang: "en-US", rate: 1, pitch: 1, volume: 1 });

test("chunks play in order on the best natural voice, then report done", async () => {
  spoken.length = 0;
  const log: string[] = [];
  const output = createSpeechOutput(settings(), {
    onSpeaking: (value) => log.push(`speaking:${value}`),
    onChunk: (text) => log.push(`chunk:${text}`),
    onIdle: () => log.push("idle"),
    onDone: () => log.push("done"),
  });
  output.enqueue("First sentence.");
  output.enqueue("Second sentence.");
  await tick();
  assert.deepEqual(spoken.map(({ text, voice }) => [text, voice]), [["First sentence.", "Ava (Premium)"]],
    "one utterance at a time, on the highest-ranked voice for the language");
  await finishCurrent();
  assert.deepEqual(spoken.map(({ text }) => text), ["First sentence.", "Second sentence."]);
  await finishCurrent();
  assert.ok(log.includes("idle"), "a drained queue that may still grow reports idle, not done");
  output.end();
  await tick();
  assert.deepEqual(log.filter((entry) => entry.startsWith("speaking") || entry === "done"),
    ["speaking:true", "speaking:false", "done"]);
  output.dispose();
});

test("a failing server voice falls back to the browser voice for the same chunk", async () => {
  spoken.length = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "no TTS server" }), { status: 503 });
  const errors: string[] = [];
  const output = createSpeechOutput(settings("server"), { onError: (error) => errors.push(error.message) });
  try {
    output.enqueue("Still audible.");
    await tick();
    await tick();
    assert.deepEqual(errors, ["no TTS server"]);
    assert.deepEqual(spoken.map(({ text }) => text), ["Still audible."]);
    await finishCurrent();
    output.enqueue("Next one.");
    await tick();
    assert.deepEqual(spoken.map(({ text }) => text), ["Still audible.", "Next one."],
      "after one failure the server is not retried for every chunk");
    assert.equal(errors.length, 1);
  } finally {
    output.dispose();
    globalThis.fetch = original;
  }
});

test("a new utterance group retries a server voice that failed before", async () => {
  spoken.length = 0;
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ message: "no TTS server" }), { status: 503 }); };
  const output = createSpeechOutput(settings("server"));
  try {
    output.enqueue("First reply.");
    await tick();
    await tick();
    assert.equal(calls, 1);
    output.cancel();
    output.enqueue("Second reply.");
    await tick();
    await tick();
    assert.equal(calls, 2, "an earlier failure does not pin later replies to the browser voice");
  } finally {
    output.dispose();
    globalThis.fetch = original;
  }
});

test("a preview without fallback reports the server failure instead of playing the browser voice", async () => {
  spoken.length = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "Audio could not be decoded" }), { status: 502 });
  const errors: string[] = [];
  let done = 0;
  const output = createSpeechOutput(
    () => ({ ...settings("server")(), fallback: false }),
    { onError: (error) => errors.push(error.message), onDone: () => { done++; } },
  );
  try {
    output.enqueue("Polyth voice check.");
    output.end();
    await tick();
    await tick();
    assert.deepEqual(errors, ["Audio could not be decoded"]);
    assert.deepEqual(spoken, [], "the browser voice never stands in for the chosen voice");
    assert.equal(done, 1);
    assert.equal(output.active, false);
  } finally {
    output.dispose();
    globalThis.fetch = original;
  }
});

test("a built-in voice is asked for by id, speaker and pace, and falls back to the browser voice", async () => {
  spoken.length = 0;
  const original = globalThis.fetch;
  const requests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ message: "Lada is not downloaded on this server" }), { status: 409 });
  };
  const errors: string[] = [];
  const output = createSpeechOutput(
    () => ({ engine: "local" as const, localVoice: "piper-uk_UA-lada-x_low", localSpeaker: 2, lang: "uk-UA", rate: 1.2, pitch: 1, volume: 1 }),
    { onError: (error) => errors.push(error.message) },
  );
  try {
    output.enqueue("Привіт.");
    await tick();
    await tick();
    assert.deepEqual(requests, [{
      url: "/api/tts/local",
      body: { text: "Привіт.", voice: "piper-uk_UA-lada-x_low", speaker: 2, lang: "uk-UA", speed: 1.2 },
    }]);
    assert.deepEqual(errors, ["Lada is not downloaded on this server"]);
    assert.deepEqual(spoken.map(({ text }) => text), ["Привіт."], "the chunk is still heard");
  } finally {
    output.dispose();
    globalThis.fetch = original;
  }
});

test("a second owner claiming the speaker silences the first", async () => {
  spoken.length = 0;
  let claimed = 0;
  const first = createSpeechOutput(settings(), { onClaimed: () => { claimed++; } });
  const second = createSpeechOutput(settings());
  first.enqueue("Reading a reply.");
  await tick();
  assert.equal(first.active, true);
  second.enqueue("Voice mode answer.");
  await tick();
  assert.equal(first.active, false, "the first output stopped");
  assert.equal(claimed, 1, "and was told why");
  assert.equal(spoken.at(-1)?.text, "Voice mode answer.");
  first.dispose();
  second.dispose();
});

test("asides can be dropped before they play, and one that waited too long is skipped", async () => {
  spoken.length = 0;
  const chunks: Array<[string, string]> = [];
  const output = createSpeechOutput(settings(), { onChunk: (text, kind) => chunks.push([text, kind]) });
  output.enqueue("Reading config.ts.", { kind: "aside", expiresAt: Date.now() + 60_000 });
  output.enqueue("Running the tests.", { kind: "aside", expiresAt: Date.now() + 60_000 });
  output.enqueue("Here is the fix.");
  await tick();
  output.dropAsides();
  await finishCurrent();
  assert.deepEqual(spoken.map(({ text }) => text), ["Reading config.ts.", "Here is the fix."],
    "the playing aside finishes; the waiting one is dropped, the reply is kept");
  assert.deepEqual(chunks, [["Reading config.ts.", "aside"], ["Here is the fix.", "reply"]]);
  await finishCurrent();

  spoken.length = 0;
  output.enqueue("Now.");
  output.enqueue("Old news.", { kind: "aside", expiresAt: Date.now() - 1 });
  output.enqueue("Still fresh.", { kind: "aside", expiresAt: Date.now() + 60_000 });
  await tick();
  await finishCurrent();
  assert.deepEqual(spoken.map(({ text }) => text), ["Now.", "Still fresh."], "an expired aside is skipped unheard");
  output.dispose();
});
