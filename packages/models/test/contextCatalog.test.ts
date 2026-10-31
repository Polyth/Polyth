import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModelContextIndex,
  createModelContextCatalog,
  enrichModelsWithContext,
} from "../src/contextCatalog.ts";

const payload = {
  openai: { models: { "gpt-5.6-sol": { limit: { context: 1_050_000 } } } },
  anthropic: { models: { "claude-sonnet-5": { limit: { context: 1_000_000 } } } },
  google: { models: { "gemini-3.8-flash": { limit: { context: 1_048_576 } } } },
  xai: { models: { "grok-4.7": { limit: { context: 500_000 } } } },
  deepseek: { models: { "deepseek-v4-flash": { limit: { context: 1_000_000 } } } },
  vercel: { models: { "laguna-s-2.1-free": { limit: { context: 256_000 } } } },
  ambiguousA: { models: { "same-window": { limit: { context: 100_000 } } } },
  ambiguousB: { models: { "same-window": { limit: { context: 200_000 } } } },
};

test("model context enrichment respects native values and resolves portable model identities", () => {
  const index = buildModelContextIndex(payload);
  const models = enrichModelsWithContext([
    { providerID: "openai", modelID: "gpt-5.6-sol", name: "GPT" },
    { providerID: "claude", modelID: "claude-sonnet-5", name: "Claude", context: 200_000 },
    { providerID: "antigravity", modelID: "gemini-3.8-flash-high", name: "Gemini" },
    { providerID: "cursor", modelID: "grok-4.7[context=256k,reasoning_effort=high]", name: "Grok" },
    { providerID: "deepseek", modelID: "deepseek/deepseek-v4-flash", name: "DeepSeek" },
    { providerID: "anthropic", modelID: "sonnet", name: "Sonnet" },
    { providerID: "poolside", modelID: "poolside/laguna-s-2.1-free", name: "Laguna" },
    { providerID: "fx", modelID: "same-window", name: "Ambiguous" },
  ], index);

  assert.deepEqual(models.map((model) => model.context), [
    1_050_000,
    200_000,
    1_048_576,
    256_000,
    1_000_000,
    1_000_000,
    256_000,
    undefined,
  ]);
  assert.equal(enrichModelsWithContext([
    { providerID: "openai", modelID: "gpt-5.6-sol[context=128k,context=256k]", name: "Ambiguous control" },
  ], index)[0]?.context, undefined);
});

test("model context enrichment refuses conflicting duplicate catalog rows", () => {
  const index = buildModelContextIndex({
    alternateA: {
      models: {
        "same-window": { limit: { context: 1_000_000 } },
      },
    },
    alternateB: {
      models: {
        "same-window": { limit: { context: 2_000_000 } },
      },
    },
  });
  assert.equal(enrichModelsWithContext([
    { providerID: "fx", modelID: "same-window", name: "Conflicted" },
  ], index)[0]?.context, undefined);
});

test("opaque runtime-local ids cannot borrow an unrelated provider's unanimous limit", () => {
  const index = buildModelContextIndex({ unrelated: { models: {
    auto: { limit: { context: 999_000 } },
    default: { limit: { context: 999_000 } },
    "private-model": { limit: { context: 999_000 } },
  } } });
  const models = enrichModelsWithContext([
    { providerID: "cursor", modelID: "auto", name: "Auto" },
    { providerID: "acp", modelID: "default", name: "Default" },
    { providerID: "fx", modelID: "private-model", name: "Private" },
    { providerID: "cursor", modelID: "auto", name: "Native auto", context: 128_000 },
  ], index);
  assert.deepEqual(models.map((model) => model.context), [undefined, undefined, undefined, 128_000]);
});

test("conflict markers clear malformed native values and bypass fallback fetch", async () => {
  let calls = 0;
  const catalog = createModelContextCatalog({
    async fetchImpl() {
      calls += 1;
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  const conflicted = {
    providerID: "openai",
    modelID: "gpt-5.6-sol",
    name: "Conflicted GPT",
    context: 88_000,
    contextStatus: "conflict" as const,
  };
  const first = await catalog.enrich([conflicted]);
  const second = await catalog.enrich(first);
  assert.equal(first[0]?.context, undefined);
  assert.equal(first[0]?.contextStatus, "conflict");
  assert.deepEqual(second, first, "conflict metadata must survive repeated enrichment");
  assert.equal(calls, 0, "a conflict is not missing metadata and must not trigger fallback I/O");
});

test("model context catalog single-flights and refreshes one bounded public request", async () => {
  let calls = 0;
  let now = 100;
  const catalog = createModelContextCatalog({
    now: () => now,
    ttlMs: 50,
    async fetchImpl() {
      calls += 1;
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });

  const [first, second] = await Promise.all([
    catalog.enrich([{ providerID: "openai", modelID: "gpt-5.6-sol", name: "GPT" }]),
    catalog.enrich([{ providerID: "xai", modelID: "grok-4.7", name: "Grok" }]),
  ]);
  assert.equal(calls, 1);
  assert.equal(first[0]?.context, 1_050_000);
  assert.equal(second[0]?.context, 500_000);

  now = 151;
  assert.equal((await catalog.enrich([{ providerID: "openai", modelID: "gpt-5.6-sol", name: "GPT" }]))[0]?.context, 1_050_000);
  assert.equal(calls, 2);
});

test("model context catalog refuses an oversized response without replacing native rows", async () => {
  let calls = 0;
  const catalog = createModelContextCatalog({
    maxBytes: 32,
    async fetchImpl() {
      calls += 1;
      return new Response("x".repeat(64), { status: 200 });
    },
  });
  const models = await catalog.enrich([
    { providerID: "openai", modelID: "gpt-test", name: "GPT", context: 42 },
    { providerID: "openai", modelID: "gpt-test-2", name: "GPT 2" },
  ]);
  assert.equal(models[0]?.context, 42);
  assert.equal(models[1]?.context, undefined);
  assert.equal(calls, 1);
});

test("model context catalog enforces its request timeout when fetch ignores abort", async () => {
  let calls = 0;
  const catalog = createModelContextCatalog({
    timeoutMs: 5,
    retryMs: 1_000,
    async fetchImpl() {
      calls += 1;
      return new Promise<Response>(() => {});
    },
  });
  const started = Date.now();
  const models = await catalog.enrich([{ providerID: "openai", modelID: "gpt-test", name: "GPT" }]);
  assert.equal(models[0]?.context, undefined);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 500, "the bounded request must not wait for a non-conforming fetch");
});

test("model context catalog failure degrades to native metadata without repeated request storms", async () => {
  let calls = 0;
  let now = 100;
  const catalog = createModelContextCatalog({
    now: () => now,
    retryMs: 50,
    async fetchImpl() {
      calls += 1;
      throw new Error("offline");
    },
  });

  const models = await Promise.all([
    catalog.enrich([{ providerID: "openai", modelID: "gpt-5.6-sol", name: "GPT", context: 42 }]),
    catalog.enrich([{ providerID: "openai", modelID: "gpt-5.6-sol", name: "GPT" }]),
  ]);
  assert.equal(models[0]?.[0]?.context, 42);
  assert.equal(models[1]?.[0]?.context, undefined);
  assert.equal(calls, 1);

  now = 120;
  await catalog.enrich([{ providerID: "openai", modelID: "gpt-5.6-sol", name: "GPT" }]);
  assert.equal(calls, 1);
  now = 151;
  await catalog.enrich([{ providerID: "openai", modelID: "gpt-5.6-sol", name: "GPT" }]);
  assert.equal(calls, 2);
});


test("invalid and conflicting explicit context controls never become guessed catalog limits", () => {
  const index = buildModelContextIndex(payload);
  for (const control of ["auto", "", "128kjunk", "128k,context=256k"]) {
    const [model] = enrichModelsWithContext([
      { providerID: "openai", modelID: `gpt-5.6-sol[context=${control}]`, name: "GPT" },
    ], index);
    assert.equal(model?.context, undefined, control);
    assert.equal(model?.contextStatus, "conflict", control);
    assert.deepEqual(enrichModelsWithContext(JSON.parse(JSON.stringify([model])), index), [model]);
  }
});

test("expired public metadata is not presented as current through fetch failures and backoff", async () => {
  let now = 0;
  let calls = 0;
  const model = { providerID: "openai", modelID: "gpt-5.6-sol", name: "GPT" };
  const catalog = createModelContextCatalog({
    now: () => now, ttlMs: 50, retryMs: 50,
    async fetchImpl() {
      calls += 1;
      if (calls === 2) throw new Error("offline");
      return new Response(JSON.stringify({ openai: { models: {
        "gpt-5.6-sol": { limit: { context: calls === 1 ? 1_050_000 : 128_000 } },
      } } }));
    },
  });
  assert.equal((await catalog.enrich([model]))[0]?.context, 1_050_000);
  now = 51;
  assert.equal((await catalog.enrich([model]))[0]?.context, undefined);
  now = 60;
  assert.equal((await catalog.enrich([model]))[0]?.context, undefined);
  assert.equal(calls, 2, "backoff does not retry or revive an expired limit");
  assert.equal((await catalog.enrich([{ ...model, context: 42_000 }]))[0]?.context, 42_000);
  now = 102;
  assert.equal((await catalog.enrich([model]))[0]?.context, 128_000);
  assert.equal(calls, 3);
});

test("a stalled response body times out and its late completion cannot replace newer metadata", async () => {
  let now = 0;
  let calls = 0;
  let finishBody!: () => void;
  const model = { providerID: "openai", modelID: "gpt", name: "GPT" };
  const encode = (context: number) => new TextEncoder().encode(JSON.stringify({
    openai: { models: { gpt: { limit: { context } } } },
  }));
  const catalog = createModelContextCatalog({
    now: () => now, retryMs: 50, timeoutMs: 10,
    async fetchImpl() {
      calls += 1;
      if (calls > 1) return new Response(encode(128_000));
      return new Response(new ReadableStream({
        start(controller) {
          finishBody = () => { controller.enqueue(encode(900_000)); controller.close(); };
        },
      }));
    },
  });
  assert.equal((await catalog.enrich([model]))[0]?.context, undefined);
  now = 51;
  assert.equal((await catalog.enrich([model]))[0]?.context, 128_000);
  finishBody();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await catalog.enrich([model]))[0]?.context, 128_000);
  assert.equal(calls, 2);
});

test("an account harness's catalog resolves like its family's", () => {
  const index = buildModelContextIndex({ ...payload, unrelated: { models: { auto: { limit: { context: 999_000 } } } } });
  const models = enrichModelsWithContext([
    // ACP account catalogs use the account harness id as provider id.
    { providerID: "grok-work", modelID: "grok-4.7", name: "Grok" },
    { providerID: "cursor-team", modelID: "grok-4.7[context=256k]", name: "Grok" },
    // Still runtime-local: an opaque id cannot borrow another provider's limit.
    { providerID: "cursor-team", modelID: "auto", name: "Auto" },
  ], index);
  assert.deepEqual(models.map((model) => model.context), [500_000, 256_000, undefined]);
});

test("Antigravity's Claude thinking ids resolve to the vendor window; GPT-OSS disagreement stays unknown", () => {
  const index = buildModelContextIndex({
    anthropic: { models: { "claude-opus-4-6": { limit: { context: 1_000_000 } } } },
    moonshotai: { models: { "kimi-k2": { limit: { context: 128_000 } }, "kimi-k2-thinking": { limit: { context: 262_144 } } } },
    hostA: { models: { "gpt-oss-120b": { limit: { context: 131_072 } } } },
    hostB: { models: { "gpt-oss-120b": { limit: { context: 128_000 } } } },
  });
  const models = enrichModelsWithContext([
    { providerID: "antigravity", modelID: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    // Another family's thinking id is its own model with its own window.
    { providerID: "fx", modelID: "kimi-k2-thinking", name: "Kimi" },
    { providerID: "antigravity", modelID: "gpt-oss-120b", name: "GPT-OSS 120B" },
  ], index);
  assert.deepEqual(models.map((model) => model.context), [1_000_000, 262_144, undefined]);
});
