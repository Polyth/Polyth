import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRuntime, ProviderAuthMethod } from "@polyth/contracts";
import { createHttpServer } from "../../server/src/http.ts";
import { testTenancy } from "../../server/test/support/spaces.ts";
import { createProviderAuthController } from "../src/providerAuth.ts";
import { providerAuthRoutes } from "../src/providerAuthRoutes.ts";
import {
  createPkcePair,
  isPkceFingerprint,
  pkceAuthMethod,
  pkceCallbackUrl,
  pkceProvider,
  PKCE_CALLBACK_PATH,
} from "../src/providerPkce.ts";
import { fakeSpaceContext } from "../../server/test/support/spaces.ts";

const SPACE = fakeSpaceContext();

const base64url = (buffer: Buffer): string =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const openRouterOnlyKeyMethod: Record<string, ProviderAuthMethod[]> = {
  openrouter: [{ type: "api", label: "API key", upstreamIndex: 210 }],
};

test("pkce pair is url-safe and matches the S256 challenge", () => {
  const pair = createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(base64url(createHash("sha256").update(pair.verifier).digest()), pair.challenge);
  const other = createPkcePair();
  assert.notEqual(other.verifier, pair.verifier);
});

test("openrouter authorize url carries the challenge, state and optional callback", () => {
  const provider = pkceProvider("openrouter");
  assert.ok(provider);
  const headless = new URL(provider.authorizeUrl({ challenge: "CH", state: "ST", keyLabel: "Polyth" }));
  assert.equal(headless.origin + headless.pathname, "https://openrouter.ai/auth");
  assert.equal(headless.searchParams.get("code_challenge"), "CH");
  assert.equal(headless.searchParams.get("code_challenge_method"), "S256");
  assert.equal(headless.searchParams.get("state"), "ST");
  assert.equal(headless.searchParams.get("key_label"), "Polyth");
  assert.equal(headless.searchParams.get("callback_url"), null);

  const redirect = new URL(provider.authorizeUrl({
    challenge: "CH",
    state: "ST",
    callbackUrl: "https://polyth.test/api/providers/auth/pkce/callback",
  }));
  assert.equal(redirect.searchParams.get("callback_url"), "https://polyth.test/api/providers/auth/pkce/callback");
});

test("callback url follows the declared public origin and ignores insecure or malformed ones", () => {
  assert.equal(pkceCallbackUrl({ POLYTH_PUBLIC_ORIGIN: "" }), undefined);
  assert.equal(pkceCallbackUrl({}), undefined);
  assert.equal(pkceCallbackUrl({ POLYTH_PUBLIC_ORIGIN: "http://polyth.test" }), undefined);
  assert.equal(pkceCallbackUrl({ POLYTH_PUBLIC_ORIGIN: "not a url" }), undefined);
  assert.equal(
    pkceCallbackUrl({ POLYTH_PUBLIC_ORIGIN: "https://polyth.test/" }),
    `https://polyth.test${PKCE_CALLBACK_PATH}`,
  );
});

test("exchange sends the verifier and rejects a response without a key", async () => {
  const provider = pkceProvider("openrouter");
  assert.ok(provider);
  let seen: { url: string; body: Record<string, unknown> } | undefined;
  const key = await provider.exchange({
    code: "the-code",
    verifier: "the-verifier",
    fetch: async (url, init) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ key: "sk-or-v1-abcdef" }), { status: 200 });
    },
  });
  assert.equal(key, "sk-or-v1-abcdef");
  assert.equal(seen?.url, "https://openrouter.ai/api/v1/auth/keys");
  assert.deepEqual(seen?.body, {
    code: "the-code",
    code_verifier: "the-verifier",
    code_challenge_method: "S256",
  });

  await assert.rejects(
    provider.exchange({
      code: "bad",
      verifier: "v",
      fetch: async () => new Response(JSON.stringify({ error: { message: "Invalid code" } }), { status: 400 }),
    }),
    /Invalid code/,
  );
  await assert.rejects(
    provider.exchange({ code: "bad", verifier: "v", fetch: async () => new Response("{}", { status: 200 }) }),
    /failed/,
  );
});

test("the PKCE method is offered next to a provider that only has an API key", async () => {
  const runtime = {
    providerAuthMethods: async () => openRouterOnlyKeyMethod,
    setProviderApiKey: async () => {},
  } as unknown as AgentRuntime;
  const auth = createProviderAuthController({
    runtime: async () => runtime,
    invalidateModels: () => {},
  });
  const view = await auth.view("openrouter", false, SPACE);
  const kinds = view.methods.map((method) => method.kind);
  assert.deepEqual(kinds, ["oauth", "api"]);
  const pkce = view.methods[0]!;
  assert.equal(pkce.provenance, "polyth");
  assert.equal(pkce.label, "Sign in with OpenRouter");
  assert.equal(isPkceFingerprint(pkce.fingerprint), true);
  assert.equal(pkce.upstreamIndex, -1);

  // Another provider keeps its own methods untouched.
  const openai = await auth.view("openai", false, SPACE);
  assert.equal(openai.methods.length, 0);
});

test("a provider with its own OAuth method keeps it and gains no synthetic one", async () => {
  const runtime = {
    providerAuthMethods: async () => ({
      openrouter: [{ type: "oauth", label: "Sign in", upstreamIndex: 0 }],
    }),
    providerAuthorize: async () => ({ url: "https://example.test/oauth", method: "auto", instructions: "Continue" }),
    providerAuthCallback: async () => true,
  } as unknown as AgentRuntime;
  const auth = createProviderAuthController({
    runtime: async () => runtime,
    invalidateModels: () => {},
  });
  const view = await auth.view("openrouter", false, SPACE);
  assert.deepEqual(view.methods.map((method) => method.kind), ["oauth"]);
  assert.equal(view.methods[0]!.provenance, "opencode-plugin");
});

test("sign-in mints a key through the exchange and stores it without leaking it", async () => {
  const stored: Array<{ providerId: string; key: string; metadata?: Record<string, string> }> = [];
  let invalidated = 0;
  const runtime = {
    providerAuthMethods: async () => openRouterOnlyKeyMethod,
    endpoint: async () => ({
      authorityId: "local-host",
      continuity: "generation-only" as const,
      generation: 1,
      url: "http://127.0.0.1:4096",
      location: { directory: "/tmp" },
      control: { kind: "owned" as const, instanceToken: "t" },
      config: { kind: "writable" as const, targetId: "local" },
      authentication: { kind: "none" as const },
    }),
    setProviderApiKey: async (providerId: string, key: string, metadata?: Record<string, string>) => {
      stored.push({ providerId, key, ...(metadata ? { metadata } : {}) });
    },
  } as unknown as AgentRuntime;
  const auth = createProviderAuthController({
    runtime: async () => runtime,
    invalidateModels: () => { invalidated += 1; },
    fetchImpl: (async () => new Response(JSON.stringify({ key: "sk-or-v1-minted" }), { status: 200 })) as typeof fetch,
    env: { POLYTH_PUBLIC_ORIGIN: "https://polyth.test" },
  });

  const method = pkceAuthMethod(pkceProvider("openrouter")!);
  const started = await auth.startAttempt({
    providerId: "openrouter",
    methodId: method.id,
    space: SPACE,
  });
  assert.equal(started.phase, "awaiting_code");
  assert.equal(started.urlKind, "authorization");
  const url = new URL(started.url!);
  assert.equal(url.searchParams.get("callback_url"), "https://polyth.test/api/providers/auth/pkce/callback");
  const state = url.searchParams.get("state");
  assert.ok(state);
  assert.equal(JSON.stringify(started).includes("sk-or-v1-minted"), false);

  const done = await auth.completeAttempt(
    started.id,
    `https://polyth.test${PKCE_CALLBACK_PATH}?code=good-code&state=${state}`,
    SPACE,
  );
  assert.equal(done.phase, "configured_unverified");
  assert.deepEqual(stored, [{ providerId: "openrouter", key: "sk-or-v1-minted", metadata: { method: "polyth-pkce" } }]);
  assert.equal(invalidated, 1);
  assert.equal(JSON.stringify(done).includes("sk-or-v1-minted"), false);
});

test("the redirect callback completes by state and refuses a bad or unknown one", async () => {
  const stored: string[] = [];
  const runtime = {
    providerAuthMethods: async () => openRouterOnlyKeyMethod,
    setProviderApiKey: async (_providerId: string, key: string) => { stored.push(key); },
  } as unknown as AgentRuntime;
  const auth = createProviderAuthController({
    runtime: async () => runtime,
    invalidateModels: () => {},
    fetchImpl: (async () => new Response(JSON.stringify({ key: "sk-or-v1-callback" }), { status: 200 })) as typeof fetch,
    env: {},
  });
  const method = pkceAuthMethod(pkceProvider("openrouter")!);
  const started = await auth.startAttempt({ providerId: "openrouter", methodId: method.id, space: SPACE });
  // No public origin: the vendor shows the code and no callback is requested.
  assert.equal(new URL(started.url!).searchParams.get("callback_url"), null);
  const state = new URL(started.url!).searchParams.get("state")!;

  await assert.rejects(auth.completePkceCallback("unknown-state", "code", SPACE), /no longer active|expired/i);
  const done = await auth.completePkceCallback(state, "code", SPACE);
  assert.equal(done.phase, "configured_unverified");
  assert.deepEqual(stored, ["sk-or-v1-callback"]);
  // Single use: the same state cannot mint a second key.
  const again = await auth.completePkceCallback(state, "code", SPACE);
  assert.equal(again.phase, "configured_unverified");
  assert.deepEqual(stored, ["sk-or-v1-callback"]);
});

test("the HTTP surface offers the method and the callback route finishes the sign-in", async () => {
  const stored: string[] = [];
  const runtime = {
    providerAuthMethods: async () => openRouterOnlyKeyMethod,
    setProviderApiKey: async (_providerId: string, key: string) => { stored.push(key); },
  } as unknown as AgentRuntime;
  const auth = createProviderAuthController({
    runtime: async () => runtime,
    invalidateModels: () => {},
    fetchImpl: (async () => new Response(JSON.stringify({ key: "sk-or-v1-http" }), { status: 200 })) as typeof fetch,
    env: { POLYTH_PUBLIC_ORIGIN: "https://polyth.test" },
  });
  const tenancy = await testTenancy();
  const server = createHttpServer({
    spaces: tenancy.gateway,
    runtimes: { forProject: async () => runtime },
    capabilities: () => [],
    webDist: mkdtempSync(join(tmpdir(), "polyth-provider-pkce-")),
    version: "test",
    routes: [providerAuthRoutes({ auth, runtime: async () => runtime })],
    visibility: {
      catalog: () => [],
      available: (_models: unknown, _live: unknown, ids: string[]) => ids.map((id) => ({ id, name: id })),
      filter: (models: unknown) => models,
      setProviderEnabled: async () => ({ disabledProviders: [], disabledModels: [], addedProviders: [] }),
      addProvider: async () => ({ disabledProviders: [], disabledModels: [], addedProviders: [] }),
      removeProvider: async () => ({ disabledProviders: [], disabledModels: [], addedProviders: [] }),
      setModelEnabled: async () => ({ disabledProviders: [], disabledModels: [], addedProviders: [] }),
    } as never,
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const caps = await fetch(`${base}/api/providers/auth-capabilities`);
    const body = await caps.json() as { providers: Record<string, { methods: Array<{ id: string; kind: string }> }> };
    const methods = body.providers["openrouter"]?.methods ?? [];
    assert.deepEqual(methods.map((method) => method.kind), ["oauth", "api"]);

    const pkceMethodId = methods[0]!.id;
    const started = await fetch(`${base}/api/providers/openrouter/auth/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ methodId: pkceMethodId }),
    });
    assert.equal(started.status, 200);
    const attempt = await started.json() as { url?: string; phase?: string };
    assert.equal(attempt.phase, "awaiting_code");
    const state = new URL(attempt.url!).searchParams.get("state")!;

    const callback = await fetch(`${base}${PKCE_CALLBACK_PATH}?code=http-code&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 200);
    assert.match(String(callback.headers.get("content-type")), /text\/html/);
    const html = await callback.text();
    assert.match(html, /Connected|Almost done/);
    assert.equal(html.includes("sk-or-v1-http"), false);
    assert.deepEqual(stored, ["sk-or-v1-http"]);

    const replay = await fetch(`${base}${PKCE_CALLBACK_PATH}?code=http-code&state=${encodeURIComponent(state)}`);
    assert.equal(replay.status, 200);
    assert.deepEqual(stored, ["sk-or-v1-http"]);
  } finally {
    server.close();
  }
});
