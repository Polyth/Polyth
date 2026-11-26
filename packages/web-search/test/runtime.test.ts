import assert from "node:assert/strict";
import test from "node:test";
import type {
  SecureSafeService,
  SpaceContext,
  ToolExecutionContext,
} from "@polyth/contracts";
import { webSearchError } from "../src/errors.ts";
import { WebSearchRuntime } from "../src/runtime.ts";
import { DEFAULT_WEB_SEARCH_SETTINGS, type WebSearchSettings } from "../src/settings.ts";
import type { WebSearchSettingsState, WebSearchSettingsStore } from "../src/settingsStore.ts";
import type { SearchProvider, WebSearchResult } from "../src/types.ts";

const space: SpaceContext = {
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user-a",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/unused",
};

const context = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  sessionId: "session-a",
  projectId: "project-a",
  cwd: "/workspace/project-a",
  spaceId: space.spaceId,
  ...overrides,
});

const store = (settings: WebSearchSettings): WebSearchSettingsStore => {
  let state: WebSearchSettingsState = { revision: 0, settings };
  return {
    read: () => ({ revision: state.revision, settings: { ...state.settings } }),
    save(_space, next, expectedRevision) {
      assert.equal(expectedRevision, state.revision);
      state = { revision: state.revision + 1, settings: { ...next } };
      return { revision: state.revision, settings: { ...state.settings } };
    },
  };
};

const vault = (): SecureSafeService => ({
  list: () => [
    { id: "global", handle: "TAVILY_KEY", label: "Tavily", purpose: "Web search", kind: "token", scope: "global" },
    { id: "project", handle: "PROJECT_KEY", label: "Project key", kind: "token", scope: "project", projectId: "project-a" },
    { id: "password", handle: "PRIVATE_KEY", label: "Private key", kind: "password", scope: "global" },
  ],
  hasHandle: (handle: string) => ["TAVILY_KEY", "PROJECT_KEY"].includes(handle),
  useCredential: async (input: { projectId: string; handle: string }, use: (value: string) => Promise<void>) => {
    assert.equal(input.projectId, "project-a");
    await use("fixture-tavily-value");
  },
}) as unknown as SecureSafeService;

const result = (suffix: string): { title: string; url: string; snippet: string } => ({
  title: `Result ${suffix}`,
  url: `https://example.com/${suffix}`,
  snippet: `Snippet ${suffix}`,
});

const free = (id: "exa" | "parallel" | "firecrawl" | "bing", search: SearchProvider["search"]): SearchProvider => ({
  id,
  name: id,
  requiresCredential: false,
  search,
});

const runtime = (input: {
  settings?: WebSearchSettings;
  /** The free services, in registration order; one answering Exa by default. */
  keyless?: SearchProvider[];
  tavily?: SearchProvider;
  projectExists?: (space: SpaceContext, projectId: string) => Promise<boolean>;
  secure?: SecureSafeService;
}) => {
  const keyless = input.keyless ?? [free("exa", async () => [result("exa-1"), result("exa-2")])];
  const tavily = input.tavily ?? {
    id: "tavily",
    name: "Tavily",
    requiresCredential: false,
    acceptsCredential: true,
    search: async (_request, credential) => {
      assert.equal(credential, "fixture-tavily-value");
      return [result("tavily")];
    },
  } satisfies SearchProvider;
  const value = new WebSearchRuntime({
    settings: store(input.settings ?? DEFAULT_WEB_SEARCH_SETTINGS),
    providers: [...keyless, tavily],
    spaceForId: () => space,
    secureSafeForSpace: () => input.secure ?? vault(),
    projectExists: input.projectExists ?? (async () => true),
  });
  value.start();
  return value;
};

test("auto mode uses configured Tavily without exposing its credential", async () => {
  let tavilyCalls = 0;
  const service = runtime({
    settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, provider: "auto", tavilyCredentialHandle: "TAVILY_KEY" },
    tavily: {
      id: "tavily",
      name: "Tavily",
      requiresCredential: true,
      search: async (_request, credential) => {
        tavilyCalls += 1;
        assert.equal(credential, "fixture-tavily-value");
        return [result("tavily")];
      },
    },
  });
  const response = await service.search(context(), { query: "  current   Polyth release  " });
  assert.equal(tavilyCalls, 1);
  assert.equal(response.provider, "tavily");
  assert.equal(response.query, "current Polyth release");
  assert.equal(response.fallbackFrom, undefined);
  assert.equal(JSON.stringify(response).includes("fixture-tavily-value"), false);
});

test("auto mode falls back from a rate-limited Tavily to bounded free results", async () => {
  let freeCalls = 0;
  const service = runtime({
    settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, provider: "auto", maxResults: 2, tavilyCredentialHandle: "TAVILY_KEY" },
    tavily: {
      id: "tavily",
      name: "Tavily",
      requiresCredential: true,
      search: async () => { throw webSearchError("rate-limited", "limited"); },
    },
    keyless: [free("exa", async () => {
      freeCalls += 1;
      return [result("one"), result("two"), result("three")];
    })],
  });
  const response = await service.search(context(), { query: "release" });
  assert.equal(freeCalls, 1);
  assert.equal(response.provider, "exa");
  assert.equal(response.fallbackFrom, "tavily");
  assert.equal(response.results.length, 2);
  assert.equal(response.truncated, true);
  assert.deepEqual(response.results.map((item: WebSearchResult) => item.rank), [1, 2]);
});

test("unexpected credential-provider errors are redacted at the vault boundary", async () => {
  const service = runtime({
    settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, provider: "tavily", tavilyCredentialHandle: "TAVILY_KEY" },
    tavily: {
      id: "tavily",
      name: "Tavily",
      requiresCredential: true,
      search: async () => { throw new Error("fixture-tavily-value"); },
    },
  });
  await assert.rejects(service.search(context(), { query: "release" }), (cause: unknown) => {
    assert.equal((cause as { code?: string }).code, "auth-required");
    assert.equal((cause as Error).message.includes("fixture-tavily-value"), false);
    return true;
  });
});

test("explicit Tavily does not silently switch providers", async () => {
  let freeCalls = 0;
  const service = runtime({
    settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, provider: "tavily", tavilyCredentialHandle: "TAVILY_KEY" },
    tavily: {
      id: "tavily",
      name: "Tavily",
      requiresCredential: true,
      search: async () => { throw webSearchError("rate-limited", "limited"); },
    },
    keyless: [free("exa", async () => { freeCalls += 1; return []; })],
  });
  await assert.rejects(service.search(context(), { query: "release" }), (cause: unknown) => {
    assert.equal((cause as { code?: string }).code, "rate-limited");
    return true;
  });
  assert.equal(freeCalls, 0);
});

test("the free chain hands over to the next service and names the first one that failed", async () => {
  const calls: string[] = [];
  const service = runtime({
    settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, provider: "keyless" },
    keyless: [
      free("exa", async () => { calls.push("exa"); throw webSearchError("rate-limited", "Exa free rate limit reached"); }),
      free("parallel", async () => { calls.push("parallel"); return [result("parallel")]; }),
      free("bing", async () => { calls.push("bing"); return [result("bing")]; }),
    ],
  });
  const response = await service.search(context(), { query: "release" });
  assert.deepEqual(calls, ["exa", "parallel"]);
  assert.equal(response.provider, "parallel");
  assert.equal(response.fallbackFrom, "exa");
});

test("Bing answers only after every other free service failed, in chain order whatever the registration order", async () => {
  const calls: string[] = [];
  const service = runtime({
    keyless: [
      free("bing", async () => { calls.push("bing"); return [result("bing")]; }),
      free("firecrawl", async () => { calls.push("firecrawl"); throw webSearchError("rate-limited", "capped"); }),
      free("parallel", async () => { calls.push("parallel"); throw webSearchError("provider-invalid-response", "unreadable"); }),
      free("exa", async () => { calls.push("exa"); throw webSearchError("provider-unavailable", "down"); }),
    ],
    tavily: {
      id: "tavily",
      name: "Tavily",
      requiresCredential: false,
      acceptsCredential: true,
      search: async (_request, credential) => {
        // No key is configured here, so the chain reaches Tavily in keyless mode.
        assert.equal(credential, undefined);
        calls.push("tavily");
        throw webSearchError("rate-limited", "Tavily keyless limit reached");
      },
    },
  });
  const response = await service.search(context(), { query: "release" });
  assert.deepEqual(calls, ["exa", "parallel", "firecrawl", "tavily", "bing"]);
  assert.equal(response.provider, "bing");
  assert.equal(response.fallbackFrom, "exa");
});

test("after a failed keyed Tavily the chain does not ask Tavily again without the key", async () => {
  const credentials: Array<string | undefined> = [];
  const service = runtime({
    settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, provider: "auto", tavilyCredentialHandle: "TAVILY_KEY" },
    tavily: {
      id: "tavily",
      name: "Tavily",
      requiresCredential: false,
      acceptsCredential: true,
      search: async (_request, credential) => {
        credentials.push(credential);
        throw webSearchError("tavily-plan-exhausted", "exhausted");
      },
    },
    keyless: [free("exa", async () => { throw webSearchError("rate-limited", "exa limited"); })],
  });
  await assert.rejects(service.search(context(), { query: "release" }), /no free search service answered \(exa limited\)/);
  assert.deepEqual(credentials, ["fixture-tavily-value"]);
});

test("an exhausted free chain reports every reason, as a rate limit only when all were", async () => {
  const limited = (id: "exa" | "parallel" | "bing") => free(id, async () => { throw webSearchError("rate-limited", `${id} limited`); });
  const tavily: SearchProvider = { id: "tavily", name: "Tavily", requiresCredential: false, acceptsCredential: true, search: async () => { throw webSearchError("rate-limited", "tavily limited"); } };
  await assert.rejects(runtime({ keyless: [limited("exa"), limited("parallel"), limited("bing")], tavily })
    .search(context(), { query: "release" }), (cause: unknown) => {
    assert.equal((cause as { code?: string }).code, "rate-limited");
    assert.match((cause as Error).message, /exa limited; parallel limited; tavily limited; bing limited/);
    return true;
  });
  await assert.rejects(runtime({
    keyless: [limited("exa"), free("parallel", async () => { throw webSearchError("provider-unavailable", "parallel down"); })],
    tavily,
  }).search(context(), { query: "release" }), (cause: unknown) => {
    assert.equal((cause as { code?: string }).code, "provider-unavailable");
    return true;
  });
});

test("a cancelled search stops the free chain instead of trying the next service", async () => {
  let parallelCalls = 0;
  const service = runtime({
    keyless: [
      free("exa", async () => { throw webSearchError("aborted", "web search was cancelled"); }),
      free("parallel", async () => { parallelCalls += 1; return []; }),
    ],
  });
  await assert.rejects(service.search(context(), { query: "release" }), (cause: unknown) => {
    assert.equal((cause as { code?: string }).code, "aborted");
    return true;
  });
  assert.equal(parallelCalls, 0);
});

test("search revalidates the current project and disabled settings make no provider call", async () => {
  let calls = 0;
  const provider = free("exa", async () => { calls += 1; return []; });
  const revoked = runtime({ settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, provider: "keyless" }, keyless: [provider], projectExists: async () => false });
  await assert.rejects(revoked.search(context(), { query: "release" }), (cause: unknown) => {
    assert.equal((cause as { code?: string }).code, "forbidden");
    return true;
  });
  const disabled = runtime({ settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, enabled: false, provider: "keyless" }, keyless: [provider] });
  await assert.rejects(disabled.search(context(), { query: "release" }), /disabled/);
  assert.equal(calls, 0);
});

test("disable aborts active work and prevents future provider calls", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const service = runtime({
    settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, provider: "keyless" },
    keyless: [free("exa", async ({ signal }) => {
      entered();
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(webSearchError("aborted", "cancelled")), { once: true });
      });
    })],
  });
  const pending = service.search(context(), { query: "release" });
  await started;
  service.stop();
  await assert.rejects(pending, (cause: unknown) => {
    assert.equal((cause as { code?: string }).code, "aborted");
    return true;
  });
  await assert.rejects(service.search(context(), { query: "again" }), /not enabled/);
});

test("settings snapshot exposes only global handle metadata and rejects project handles", () => {
  const service = runtime({ settings: { ...DEFAULT_WEB_SEARCH_SETTINGS, provider: "auto", tavilyCredentialHandle: "TAVILY_KEY" } });
  const snapshot = service.settingsSnapshot(space);
  assert.deepEqual(snapshot.credentialHandles.map((item) => item.handle), ["TAVILY_KEY"]);
  assert.equal(snapshot.providers.find((provider) => provider.id === "tavily")?.configured, true);
  assert.deepEqual(snapshot.providers.map((provider) => [provider.id, provider.available, provider.keyed]), [["exa", true, false], ["tavily", true, true]]);
  const keyless = runtime({}).settingsSnapshot(space).providers.find((provider) => provider.id === "tavily");
  assert.deepEqual([keyless?.available, keyless?.requiresCredential, keyless?.keyed], [true, false, false]);
  assert.throws(() => service.saveSettings(space, {
    ...DEFAULT_WEB_SEARCH_SETTINGS,
    provider: "auto",
    tavilyCredentialHandle: "PRIVATE_KEY",
  }, 0), /global/);
  assert.throws(() => service.saveSettings(space, {
    ...DEFAULT_WEB_SEARCH_SETTINGS,
    provider: "auto",
    tavilyCredentialHandle: "PROJECT_KEY",
  }, 0), /global/);
});
