import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProviderHttpClient,
  parseProviderAuthMethods,
  parseProviderAuthorization,
  parseProviderCatalogue,
} from "../src/providerHttp.ts";

test("legacy catalogue keeps nameless ids; v2 drops them", () => {
  const body = { all: [{ id: "cursor", name: "Cursor" }, { id: "bad", name: "" }, { id: "ok" }] };
  assert.deepEqual(parseProviderCatalogue(body), [
    { id: "cursor", name: "Cursor" },
    { id: "bad", name: "bad" },
    { id: "ok", name: "ok" },
  ]);
  assert.deepEqual(parseProviderCatalogue(body, { requireName: true }), [
    { id: "cursor", name: "Cursor" },
  ]);
});

test("catalogue parser does not treat a raw array as providers", () => {
  assert.deepEqual(parseProviderCatalogue([{ id: "nope", name: "Nope" }]), []);
});

test("auth method and authorization parsers match the generation-1 wire", () => {
  assert.deepEqual(parseProviderAuthMethods({ cursor: [{ type: "oauth", label: "Sign in" }] }), {
    cursor: [{ type: "oauth", label: "Sign in", upstreamIndex: 0 }],
  });
  assert.deepEqual(
    parseProviderAuthorization({ url: "https://x", method: "code", instructions: "go" }),
    { url: "https://x", method: "code", instructions: "go" },
  );
  assert.equal(parseProviderAuthorization({ url: "https://x" }), undefined);
});

test("shared client preserves optional auth-methods and required catalogue paths", async () => {
  const calls: string[] = [];
  const client = createProviderHttpClient({
    locate: (path) => path,
    deadlineMs: 1_000,
    authMethodsOptional: true,
    transport: {
      queryRequired: async (path) => {
        calls.push(`required:${path}`);
        return { all: [{ id: "openai", name: "OpenAI" }] };
      },
      queryOptional: async (path) => {
        calls.push(`optional:${path}`);
        return { ok: false as const };
      },
      mutate: async () => ({ status: 200, body: true }),
    },
  });
  assert.deepEqual(await client.listAllProviders(), [{ id: "openai", name: "OpenAI" }]);
  assert.deepEqual(await client.providerAuthMethods(), {});
  assert.deepEqual(calls, ["required:/provider", "optional:/provider/auth"]);
});

const mutationClient = (mutate: (method: string, path: string) => Promise<unknown>) =>
  createProviderHttpClient({
    locate: (path) => path,
    deadlineMs: 1_000,
    transport: {
      queryRequired: async () => ({ all: [] }),
      mutate: async (method, path) => mutate(method, path),
    },
  });

test("provider auth mutations require a confirmed 2xx and never treat unknown as success", async () => {
  const ok = mutationClient(async () => ({ status: 200, body: true }));
  assert.equal(await ok.setProviderApiKey("openai", "sk"), true);
  assert.equal(await ok.removeProviderAuth("openai"), true);
  assert.equal(await ok.providerAuthCallback("openai", 0, "code"), true);

  for (const status of [401, 403, 404, 500]) {
    const client = mutationClient(async () => ({ status, body: { error: "nope" } }));
    await assert.rejects(() => client.setProviderApiKey("openai", "sk"));
    await assert.rejects(() => client.providerAuthCallback("openai", 0));
  }

  const unknown = mutationClient(async () => ({ kind: "unknown", operationId: "op-1", message: "lost" }));
  await assert.rejects(
    () => unknown.setProviderApiKey("openai", "sk"),
    (e: Error & { code?: string }) => e.code === "unavailable" && /lost|unknown/i.test(e.message),
  );
  await assert.rejects(
    () => unknown.removeProviderAuth("openai"),
    (e: Error & { code?: string }) => e.code === "unavailable",
  );
  await assert.rejects(
    () => unknown.providerAuthCallback("openai", 0, "code"),
    (e: Error & { code?: string }) => e.code === "unavailable",
  );
});
