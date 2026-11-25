import assert from "node:assert/strict";
import test from "node:test";
import { parseWebSearchSettingsSnapshot } from "../src/client.ts";
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  normalizeWebSearchQuery,
  parseWebSearchCount,
  parseWebSearchSettings,
} from "../src/settings.ts";

test("settings parser accepts bounded documented values", () => {
  assert.deepEqual(parseWebSearchSettings(DEFAULT_WEB_SEARCH_SETTINGS), DEFAULT_WEB_SEARCH_SETTINGS);
  assert.deepEqual(parseWebSearchSettings({
    enabled: true,
    provider: "tavily",
    region: "ua-uk",
    safeSearch: "strict",
    maxResults: 10,
    tavilyCredentialHandle: "TAVILY_KEY",
  }), {
    enabled: true,
    provider: "tavily",
    region: "ua-uk",
    safeSearch: "strict",
    maxResults: 10,
    tavilyCredentialHandle: "TAVILY_KEY",
  });
  // A choice saved while DuckDuckGo was the only free service becomes the free chain.
  assert.equal(parseWebSearchSettings({ ...DEFAULT_WEB_SEARCH_SETTINGS, provider: "duckduckgo" }).provider, "keyless");
  assert.throws(() => parseWebSearchSettings({ ...DEFAULT_WEB_SEARCH_SETTINGS, provider: "bing" }), /provider/);
  assert.equal(parseWebSearchCount(undefined, 8), 8);
  assert.equal(parseWebSearchCount(10, 8), 8);
  assert.equal(normalizeWebSearchQuery("  current   Polyth\nrelease  "), "current Polyth release");
});

test("settings and public snapshots reject malformed values", () => {
  assert.throws(() => parseWebSearchSettings({ ...DEFAULT_WEB_SEARCH_SETTINGS, maxResults: 11 }), /maxResults/);
  assert.throws(() => parseWebSearchSettings({ ...DEFAULT_WEB_SEARCH_SETTINGS, region: "unknown" }), /region/);
  assert.throws(() => parseWebSearchCount(0, 8), /count/);
  assert.throws(() => normalizeWebSearchQuery("x".repeat(2_049)), /2048/);
  assert.throws(() => parseWebSearchSettingsSnapshot({ version: 2 }), /unsupported/);
  assert.throws(() => parseWebSearchSettingsSnapshot({
    version: 1,
    revision: -1,
    settings: DEFAULT_WEB_SEARCH_SETTINGS,
    providers: [],
    credentialHandles: [],
    vaultAvailable: false,
  }), /revision/);
  // `keyed` is absent in a snapshot from an older server and reads as false.
  assert.deepEqual(parseWebSearchSettingsSnapshot({
    version: 1,
    revision: 3,
    settings: DEFAULT_WEB_SEARCH_SETTINGS,
    providers: [
      { id: "exa", name: "Exa", available: true, requiresCredential: false, configured: true },
      { id: "parallel", name: "Parallel", available: true, requiresCredential: false, configured: true },
      { id: "firecrawl", name: "Firecrawl", available: true, requiresCredential: false, configured: true },
      { id: "tavily", name: "Tavily", available: true, requiresCredential: false, configured: true, keyed: true },
      { id: "bing", name: "Bing", available: true, requiresCredential: false, configured: true },
    ],
    credentialHandles: [{ handle: "TAVILY_KEY", label: "Tavily", kind: "token" }],
    vaultAvailable: true,
  }).providers.map((provider) => provider.keyed), [false, false, false, true, false]);
  assert.throws(() => parseWebSearchSettingsSnapshot({
    version: 1,
    revision: 3,
    settings: DEFAULT_WEB_SEARCH_SETTINGS,
    providers: [{ id: "duckduckgo", name: "DuckDuckGo", available: true, requiresCredential: false, configured: true }],
    credentialHandles: [],
    vaultAvailable: true,
  }), /unsupported/);
});
