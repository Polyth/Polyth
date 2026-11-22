import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  NATIVE_AUDIO_CAPTURE_GLOBAL,
  createNativeAudioCapture,
  decodeBase64Pcm,
} from "../src/nativeAudioCapture.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

type Listener = (event: Record<string, unknown>) => void;

const fakePlugin = (startError?: unknown) => {
  const calls: string[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const plugin = {
    async start(options: { sampleRate: number; chunkMs: number }) {
      calls.push(`start:${options.sampleRate}:${options.chunkMs}`);
      if (startError) throw startError;
      return { sampleRate: options.sampleRate, channels: 1 };
    },
    async stop() { calls.push("stop"); },
    async pause() { calls.push("pause"); },
    async resume() { calls.push("resume"); },
    async addListener(name: string, listener: Listener) {
      const set = listeners.get(name) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(name, set);
      return { remove: async () => { set.delete(listener); } };
    },
  };
  const emit = (name: string, event: Record<string, unknown>) => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(event);
  };
  const count = (name: string) => listeners.get(name)?.size ?? 0;
  return { plugin, calls, emit, count };
};

test("the capture is published under its documented host global", () => {
  // Packages look it up structurally by this name; they never import the host.
  assert.equal(NATIVE_AUDIO_CAPTURE_GLOBAL, "__polythNativeAudioCapture");
});

test("native PCM chunks arrive decoded and stop removes every listener", async () => {
  const fake = fakePlugin();
  const capture = createNativeAudioCapture(fake.plugin as never);
  const chunks: Uint8Array[] = [];
  const handle = await capture.start({ sampleRate: 16_000, chunkMs: 40 }, { onChunk: (pcm) => chunks.push(pcm), onEnded() {} });
  assert.equal(handle.sampleRate, 16_000);
  fake.emit("audioChunk", { data: Buffer.from([1, 2, 3, 4]).toString("base64") });
  fake.emit("audioChunk", { data: 42 });
  assert.deepEqual(chunks.map((chunk) => [...chunk]), [[1, 2, 3, 4]]);
  await handle.pause();
  await handle.resume();
  await handle.stop();
  fake.emit("audioChunk", { data: Buffer.from([9]).toString("base64") });
  assert.equal(chunks.length, 1);
  assert.equal(fake.count("audioChunk") + fake.count("audioEnded"), 0);
  assert.deepEqual(fake.calls, ["start:16000:40", "pause", "resume", "stop"]);
});

test("a new capture retires the previous one, whose events are then ignored", async () => {
  const fake = fakePlugin();
  const capture = createNativeAudioCapture(fake.plugin as never);
  const first: Uint8Array[] = [];
  const second: Uint8Array[] = [];
  await capture.start({ sampleRate: 16_000, chunkMs: 40 }, { onChunk: (pcm) => first.push(pcm), onEnded() {} });
  await capture.start({ sampleRate: 16_000, chunkMs: 40 }, { onChunk: (pcm) => second.push(pcm), onEnded() {} });
  fake.emit("audioChunk", { data: Buffer.from([5, 6]).toString("base64") });
  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
  assert.deepEqual(fake.calls, ["start:16000:40", "stop", "start:16000:40"]);
});

test("a lost microphone is reported once and releases the capture", async () => {
  const fake = fakePlugin();
  const capture = createNativeAudioCapture(fake.plugin as never);
  let ended = 0;
  await capture.start({ sampleRate: 16_000, chunkMs: 40 }, { onChunk() {}, onEnded: () => { ended++; } });
  fake.emit("audioEnded", { reason: "interrupted" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, 1);
  assert.equal(fake.count("audioChunk") + fake.count("audioEnded"), 0);
});

test("a refused start keeps the plugin's code and leaves no listener behind", async () => {
  const fake = fakePlugin(Object.assign(new Error("Microphone permission was denied"), { code: "mic_denied" }));
  const capture = createNativeAudioCapture(fake.plugin as never);
  await assert.rejects(
    () => capture.start({ sampleRate: 16_000, chunkMs: 40 }, { onChunk() {}, onEnded() {} }),
    (error: unknown) => (error as { code?: string }).code === "mic_denied",
  );
  assert.equal(fake.count("audioChunk") + fake.count("audioEnded"), 0);
});

test("base64 PCM decodes without Uint8Array.fromBase64", () => {
  assert.deepEqual([...decodeBase64Pcm(Buffer.from([0, 255, 128]).toString("base64"))], [0, 255, 128]);
});

test("iOS registers the native capture plugin, builds its source and trusts only Polyth pages", async () => {
  const [scene, project, plugin, bridge] = await Promise.all([
    read("../ios/App/App/SceneDelegate.swift"),
    read("../ios/App/App.xcodeproj/project.pbxproj"),
    read("../ios/App/App/PolythAudioCapturePlugin.swift"),
    read("../src/nativeBridge.ts"),
  ]);
  assert.match(scene, /registerPluginInstance\(PolythAudioCapturePlugin\(\)\)/);
  assert.match(project, /PolythAudioCapturePlugin\.swift in Sources \*\/ = \{isa = PBXBuildFile/);
  assert.match(project, /files = \([\s\S]*?PolythAudioCapturePlugin\.swift in Sources \*\/,[\s\S]*?\);/);
  assert.match(plugin, /let jsName = "PolythAudioCapture"/);
  assert.match(plugin, /guard bundled \|\| PolythLinkPlugin\.ownsCurrentProxy\(url\)/);
  // 16-bit little-endian mono, the dictation wire format.
  assert.match(plugin, /AVAudioFormat\(commonFormat: \.pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true\)/);
  // A page that navigated away never keeps the microphone open.
  assert.match(plugin, /guard hasListeners\("audioChunk"\) else \{\s*end\(\)/);
  assert.match(bridge, /disposers\.push\(installNativeAudioCapture\(\)\)/);
});
