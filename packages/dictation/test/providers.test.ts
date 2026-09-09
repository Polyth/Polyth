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

test("cloud default is ElevenLabs with automatic transport and no secondary provider", () => {
  assert.equal(DEFAULT_DICTATION_PREFERENCES.provider, "elevenlabs");
  assert.equal(DEFAULT_DICTATION_PREFERENCES.transport, "auto");
  assert.equal(DEFAULT_DICTATION_PREFERENCES.processingPolicy, "prefer-cloud");
  assert.equal(DEFAULT_DICTATION_PREFERENCES.fallbackProvider, undefined);
  assert.equal(DEFAULT_DICTATION_PREFERENCES.cloudFallback, false);
  assert.equal(providerCapabilities("elevenlabs")?.ephemeralClientAuth, true);
});

test("catalog keeps Ukrainian on the primary local Nemotron path", () => {
  const local = providerCapabilities("local-nemotron");
  assert.ok(local?.languages.includes("uk-UA"));
  assert.ok(local?.transports.includes("local-worker"));
  assert.equal(providerCapabilities("local-parakeet")?.languages.includes("uk-UA"), false);
  assert.equal(providerCapabilities("local-parakeet")?.publicApi, false);
});

test("Wispr is represented without inventing a public API contract", () => {
  const wispr = providerCapabilities("wispr");
  assert.equal(wispr?.publicApi, false);
  assert.equal(wispr?.streaming, true);
});

test("legacy voice engines migrate without opting into cloud fallback", () => {
  assert.deepEqual(
    migrateDictationPreferences({ sttEngine: "browser", lang: "uk-UA" }),
    {
      provider: "web-speech", transport: "direct-browser", language: "uk-UA",
      contextInjection: true, processingPolicy: "browser-fallback", cloudFallback: false,
      latencyPreference: "lowest",
    },
  );
  const modern = migrateDictationPreferences({
    provider: "deepgram", transport: "server-proxy", model: "nova-3", language: "uk",
    contextInjection: false, cloudFallback: true, latencyPreference: "balanced",
  });
  assert.equal(modern.provider, "deepgram");
  assert.equal(modern.transport, "server-proxy");
  assert.equal(modern.model, "nova-3");
  assert.equal(modern.contextInjection, false);
  // The old boolean never meant "pick a mystery provider" for cloud primary.
  assert.equal(modern.processingPolicy, "prefer-cloud");
  assert.equal(modern.fallbackProvider, undefined);
  assert.equal(modern.cloudFallback, false);
});

test("legacy local cloudFallback preserves its previous explicit ElevenLabs opt-in", () => {
  const migrated = migrateDictationPreferences({
    provider: "local-nemotron",
    transport: "local-worker",
    cloudFallback: true,
  });
  assert.equal(migrated.processingPolicy, "prefer-local");
  assert.equal(migrated.fallbackProvider, "elevenlabs");
  assert.equal(migrated.cloudFallback, true);
});

test("new processing policy never invents a fallback provider", () => {
  const localOnly = migrateDictationPreferences({
    provider: "local-nemotron",
    processingPolicy: "local-only",
  });
  assert.equal(localOnly.processingPolicy, "local-only");
  assert.equal(localOnly.fallbackProvider, undefined);
  assert.equal(localOnly.cloudFallback, false);

  const explicit = migrateDictationPreferences({
    provider: "local-nemotron",
    processingPolicy: "prefer-local",
    fallbackProvider: "deepgram",
  });
  assert.equal(explicit.fallbackProvider, "deepgram");
  assert.equal(explicit.cloudFallback, true);

  const unsafe = migrateDictationPreferences({
    provider: "local-nemotron",
    processingPolicy: "prefer-local",
    fallbackProvider: "web-speech",
  });
  assert.equal(unsafe.fallbackProvider, undefined);
  assert.equal(unsafe.cloudFallback, false);
});

test("stale or hand-edited unsupported transports normalize to a provider-supported choice", () => {
  assert.equal(
    migrateDictationPreferences({ provider: "deepgram", transport: "direct-browser" }).transport,
    "auto",
  );
  assert.equal(
    migrateDictationPreferences({ provider: "local-nemotron", transport: "server-proxy" }).transport,
    "auto",
  );
  assert.equal(
    migrateDictationPreferences({ provider: "web-speech", transport: "local-worker" }).transport,
    "auto",
  );
  // A supported explicit choice survives migration unchanged.
  assert.equal(
    migrateDictationPreferences({ provider: "elevenlabs", transport: "direct-browser" }).transport,
    "direct-browser",
  );
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

test("provider registry replaces and unregisters deterministically by id", () => {
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
  assert.equal(registry.unregister("elevenlabs"), true);
  assert.equal(registry.get("elevenlabs"), undefined);
});
