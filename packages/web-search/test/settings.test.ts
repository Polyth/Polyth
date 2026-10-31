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
  assert.deepEqual(parseWebSearchSettingsSnapshot({
    version: 1,
    revision: 3,
    settings: DEFAULT_WEB_SEARCH_SETTINGS,
    providers: [
      { id: "duckduckgo", name: "DuckDuckGo", available: true, requiresCredential: false, configured: true },
      { id: "tavily", name: "Tavily", available: false, requiresCredential: true, configured: false },
    ],
    credentialHandles: [{ handle: "TAVILY_KEY", label: "Tavily", kind: "token" }],
    vaultAvailable: true,
  }).revision, 3);
});
