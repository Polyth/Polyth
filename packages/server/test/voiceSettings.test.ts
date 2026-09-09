import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LOCAL_MODEL_ID } from "@polyth/dictation";
import { createVoiceSettings } from "../src/voice.ts";

const withSettings = async (
  run: (settings: ReturnType<typeof createVoiceSettings>) => void | Promise<void>,
  env: Record<string, string | undefined> = {},
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "polyth-voice-settings-"));
  try {
    await run(createVoiceSettings({ file: join(root, "voice.json"), env }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("new voice settings use balanced local model and no implicit secondary provider", async () => {
  await withSettings((settings) => {
    const current = settings.get();
    assert.equal(current.dictation.localModel, DEFAULT_LOCAL_MODEL_ID);
    assert.equal(current.dictation.localModel, "nemotron-3.5-streaming-0.6b-560ms");
    assert.equal(current.dictation.contextInjection, false);
    assert.equal(current.dictation.processingPolicy, "prefer-cloud");
    assert.equal(current.dictation.fallbackProvider, undefined);
    assert.equal(current.dictation.fallbackApiKeyEnv, "");
    assert.equal(current.dictation.cloudFallback, false);
  });
});

test("legacy local cloudFallback preserves the previous ElevenLabs opt-in explicitly", async () => {
  await withSettings((settings) => {
    const saved = settings.put({
      dictation: {
        provider: "local-nemotron",
        transport: "local-worker",
        localModel: "nemotron-3.5-streaming-0.6b-80ms",
        cloudFallback: true,
      },
    });
    assert.equal(saved.dictation.processingPolicy, "prefer-local");
    assert.equal(saved.dictation.fallbackProvider, "elevenlabs");
    assert.equal(saved.dictation.fallbackApiKeyEnv, "ELEVENLABS_API_KEY");
    assert.equal(saved.dictation.cloudFallback, true);
    // Explicit old model choices remain untouched; only new profiles default to 560 ms.
    assert.equal(saved.dictation.localModel, "nemotron-3.5-streaming-0.6b-80ms");
  });
});

test("primary and fallback credentials resolve only through their own env references", async () => {
  await withSettings((settings) => {
    const saved = settings.put({
      dictation: {
        provider: "local-nemotron",
        transport: "local-worker",
        processingPolicy: "prefer-local",
        fallbackProvider: "deepgram",
        fallbackApiKeyEnv: "POLYTH_DEEPGRAM_KEY",
      },
    });
    assert.equal(saved.dictation.apiKeyEnv, "");
    assert.equal(saved.dictation.fallbackProvider, "deepgram");
    assert.equal(saved.dictation.fallbackApiKeyEnv, "POLYTH_DEEPGRAM_KEY");
    assert.equal(settings.resolveDictationProviderKey("local-nemotron"), undefined);
    assert.equal(settings.resolveDictationProviderKey("deepgram"), "deepgram-secret-value");
    assert.equal(JSON.stringify(settings.get()).includes("deepgram-secret-value"), false);
  }, { POLYTH_DEEPGRAM_KEY: "deepgram-secret-value" });
});

test("new local-only settings never infer a cloud provider even when cloud secrets exist", async () => {
  await withSettings((settings) => {
    const saved = settings.put({
      dictation: {
        provider: "local-nemotron",
        transport: "local-worker",
        processingPolicy: "local-only",
      },
    });
    assert.equal(saved.dictation.fallbackProvider, undefined);
    assert.equal(saved.dictation.fallbackApiKeyEnv, "");
    assert.equal(saved.dictation.cloudFallback, false);
    assert.equal(settings.resolveDictationProviderKey("elevenlabs"), undefined);
  }, { ELEVENLABS_API_KEY: "must-not-be-consulted" });
});

test("auto-fallback canonicalizes direct browser to server-owned auto transport", async () => {
  await withSettings((settings) => {
    const eleven = settings.put({
      dictation: {
        provider: "elevenlabs",
        transport: "direct-browser",
        processingPolicy: "auto-fallback",
      },
    });
    assert.equal(eleven.dictation.transport, "auto");

    const wispr = settings.put({
      dictation: {
        provider: "wispr",
        transport: "direct-browser",
        processingPolicy: "auto-fallback",
      },
    });
    assert.equal(wispr.dictation.transport, "auto");
  });
});

test("unsupported provider transports normalize to auto while supported direct routes survive", async () => {
  await withSettings((settings) => {
    assert.equal(settings.put({
      dictation: { provider: "deepgram", transport: "direct-browser", processingPolicy: "prefer-cloud" },
    }).dictation.transport, "auto");
    assert.equal(settings.put({
      dictation: { provider: "local-nemotron", transport: "server-proxy", processingPolicy: "local-only" },
    }).dictation.transport, "auto");
    assert.equal(settings.put({
      dictation: { provider: "wispr", transport: "direct-browser", processingPolicy: "prefer-cloud" },
    }).dictation.transport, "direct-browser");
  });
});
