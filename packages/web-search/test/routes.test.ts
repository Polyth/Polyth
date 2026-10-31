import assert from "node:assert/strict";
import test from "node:test";
import type { RouteHandler } from "@polyth/contracts";
import type { WebSearchSettingsSnapshot } from "../src/client.ts";
import { webSearchError } from "../src/errors.ts";
import { webSearchRoutes } from "../src/routes.ts";
import { DEFAULT_WEB_SEARCH_SETTINGS, WEB_SEARCH_SETTINGS_VERSION } from "../src/settings.ts";

const space = {
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user-a",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/unused",
} as const;

const snapshot: WebSearchSettingsSnapshot = {
  version: WEB_SEARCH_SETTINGS_VERSION,
  revision: 2,
  settings: { ...DEFAULT_WEB_SEARCH_SETTINGS },
  providers: [
    { id: "duckduckgo", name: "DuckDuckGo", available: true, requiresCredential: false, configured: true },
    { id: "tavily", name: "Tavily", available: false, requiresCredential: true, configured: false },
  ],
  credentialHandles: [],
  vaultAvailable: false,
};

const request = (method: string, input?: unknown, role: string = space.role) => {
  const response: { status?: number; body?: unknown } = {};
  return {
    value: {
      path: "/api/web-search/settings",
      method,
      url: new URL("http://polyth.test/api/web-search/settings"),
      space: { ...space, role },
      body: async () => input ?? {},
      json: (status: number, body: unknown) => { response.status = status; response.body = body; },
    } as never,
    response,
  };
};

test("settings route uses only the validated Space and supports revisioned replacement", async () => {
  let saved: unknown;
  const routes: RouteHandler = webSearchRoutes({
    settingsSnapshot: () => snapshot,
    saveSettings: (_space, settings, expectedRevision) => {
      saved = { settings, expectedRevision };
      return snapshot;
    },
  });
  const get = request("GET");
  assert.equal(await routes(get.value), true);
  assert.equal(get.response.status, 200);
  assert.equal(get.response.body, snapshot);

  const put = request("PUT", { settings: DEFAULT_WEB_SEARCH_SETTINGS, expectedRevision: 2 });
  assert.equal(await routes(put.value), true);
  assert.equal(put.response.status, 200);
  assert.deepEqual(saved, { settings: DEFAULT_WEB_SEARCH_SETTINGS, expectedRevision: 2 });

  const wrongMethod = request("DELETE");
  assert.equal(await routes(wrongMethod.value), false);
});

test("settings route maps stale revisions without exposing storage internals", async () => {
  const routes = webSearchRoutes({
    settingsSnapshot: () => snapshot,
    saveSettings: () => { throw webSearchError("conflict", "changed elsewhere"); },
  });
  const put = request("PUT", { settings: DEFAULT_WEB_SEARCH_SETTINGS, expectedRevision: 1 });
  assert.equal(await routes(put.value), true);
  assert.equal(put.response.status, 409);
  assert.deepEqual(put.response.body, { error: "conflict", message: "changed elsewhere" });
});

test("only a Space admin saves web search settings; members still read them", async () => {
  let saves = 0;
  const routes = webSearchRoutes({
    settingsSnapshot: () => snapshot,
    saveSettings: () => { saves += 1; return snapshot; },
  });
  const body = { settings: DEFAULT_WEB_SEARCH_SETTINGS, expectedRevision: 2 };

  const refused = request("PUT", body, "member");
  assert.equal(await routes(refused.value), true);
  assert.equal(refused.response.status, 403);
  assert.equal((refused.response.body as { error: string }).error, "forbidden");
  assert.equal(saves, 0);

  const read = request("GET", undefined, "member");
  assert.equal(await routes(read.value), true);
  assert.equal(read.response.status, 200);

  const allowed = request("PUT", body, "admin");
  assert.equal(await routes(allowed.value), true);
  assert.equal(allowed.response.status, 200);
  assert.equal(saves, 1);
});
