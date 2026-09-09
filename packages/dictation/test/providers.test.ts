import { test } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_DICTATION_PREFERENCES,
  ProviderRegistry,
  migrateDictationPreferences,
  normalizeDictationContext,
  providerCapabilities,
  providerCatalog,
  type DictationProvider,
} from "@polyth/dictation";

test("cloud default is ElevenLabs with automatic transport", () => {
  assert.equal(DEFAULT_DICTATION_PREFERENCES.provider, "elevenlabs");
  assert.equal(DEFAULT_DICTATION_PREFERENCES.transport, "auto");
  assert.equal(providerCapabilities("elevenlabs")?.ephemeralClientAuth, true);
});

test("catalog keeps Ukrainian on the primary local Nemotron path", () => {
  const local = providerCapabilities("local-nemotron");
  assert.ok(local?.languages.includes("uk-UA"));
  assert.ok(local?.transports.includes("local-worker"));
  assert.equal(providerCapabilities("local-parakeet")?.languages.includes("uk-UA"), false);
});

test("Wispr is represented without inventing a public API contract", () => {
  const wispr = providerCapabilities("wispr");
  assert.equal(wispr?.publicApi, false);
  assert.equal(wispr?.streaming, true);
});

test("legacy voice engines migrate without losing explicit new preferences", () => {
  assert.deepEqual(
    migrateDictationPreferences({ sttEngine: "browser", lang: "uk-UA" }),
    {
      provider: "web-speech", transport: "direct-browser", language: "uk-UA",
      contextInjection: true, cloudFallback: true, latencyPreference: "lowest",
    },
  );
  const modern = migrateDictationPreferences({
    provider: "deepgram", transport: "server-proxy", model: "nova-3", language: "uk",
    contextInjection: false, cloudFallback: false, latencyPreference: "balanced",
  });
  assert.equal(modern.provider, "deepgram");
  assert.equal(modern.transport, "server-proxy");
  assert.equal(modern.model, "nova-3");
  assert.equal(modern.contextInjection, false);
  assert.equal(modern.cloudFallback, false);
});

test("dictation context is deduped and bounded before provider use", () => {
  const context = normalizeDictationContext({
    language: "uk-UA",
    localeHints: ["uk-UA", " uk-UA ", "en-US"],
    keywords: ["Polyth", " polyth ", "a".repeat(200)],
    glossary: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`key-${i}`, `value-${i}`])),
    lexicalContext: "x".repeat(10_000),
  });
  assert.deepEqual(context.localeHints, ["uk-UA", "en-US"]);
  assert.equal(context.keywords?.length, 2);
  assert.ok((context.keywords?.[1]?.length ?? 0) <= 96);
  assert.equal(Object.keys(context.glossary ?? {}).length, 64);
  assert.equal(context.lexicalContext?.length, 8_000);
});

test("provider registry replaces a provider deterministically by id", () => {
  const capabilities = providerCatalog()[0]!;
  const provider = (reason: string): DictationProvider => ({
    id: "elevenlabs",
    capabilities,
    available: () => ({ available: false, reason }),
    createSession: () => { throw new Error("unused"); },
  });
  const registry = new ProviderRegistry().register(provider("one")).register(provider("two"));
  assert.equal(registry.get("elevenlabs")?.available().reason, "two");
  assert.equal(registry.list().length, 1);
});
