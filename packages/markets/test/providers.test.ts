import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistry, type MarketProvider } from "../src/providers.ts";

const quote = (source: string) => ({
  symbol: "NVDA",
  currency: "USD",
  price: 100,
  asOf: "2026-09-09T00:00:00.000Z",
  source,
  freshness: "delayed" as const,
});

const notFound = (message: string): Error => Object.assign(new Error(message), { code: "not-found" });

test("provider registry falls back and records health", async () => {
  const registry = new ProviderRegistry();
  registry.register({ id: "primary", quote: async () => { throw new Error("down"); } });
  registry.register({ id: "fallback", quote: async () => quote("fallback") });

  const result = await registry.run("quote", (provider) => provider.quote!("NVDA", new AbortController().signal));

  assert.equal(result.providerId, "fallback");
  assert.equal(result.value.price, 100);
  const health = registry.healthSnapshot();
  assert.equal(health[0]?.failures, 1);
  assert.equal(health[0]?.capabilities[0]?.failures, 1);
  assert.equal(health[1]?.successes, 1);
});

test("provider data misses fall through without poisoning health", async () => {
  const registry = new ProviderRegistry();
  registry.register({ id: "primary", quote: async () => { throw notFound("unsupported symbol"); } });
  registry.register({ id: "fallback", quote: async () => quote("fallback") });

  const result = await registry.run("quote", (provider) => provider.quote!("^VIX", new AbortController().signal));
  assert.equal(result.providerId, "fallback");
  const primary = registry.healthSnapshot()[0];
  assert.equal(primary?.failures, 0);
  assert.equal(primary?.capabilities[0]?.failures, 0);
  assert.equal(primary?.circuitOpenUntil, undefined);
});

test("all provider data misses preserve not-found semantics", async () => {
  const registry = new ProviderRegistry();
  registry.register({ id: "a", quote: async () => { throw notFound("unsupported"); } });
  registry.register({ id: "b", quote: async () => { throw notFound("unknown symbol"); } });

  await assert.rejects(
    registry.run("quote", (provider) => provider.quote!("^VIX", new AbortController().signal)),
    (cause: unknown) => (cause as { code?: string }).code === "not-found",
  );
  assert.deepEqual(registry.healthSnapshot().map((item) => item.failures), [0, 0]);
});

test("provider registry runs aggregate capabilities concurrently and keeps partial success", async () => {
  const registry = new ProviderRegistry();
  registry.register({ id: "a", news: async () => [{ title: "A", url: "https://a.example", publisher: "A", symbol: "NVDA", source: "a" }] });
  registry.register({ id: "b", news: async () => { throw new Error("down"); } });
  const result = await registry.runAll("news", (provider) => provider.news!("NVDA", new AbortController().signal));
  assert.deepEqual(result.map((item) => item.providerId), ["a"]);
  assert.equal(registry.healthSnapshot()[1]?.failures, 1);
});

test("provider registry opens a circuit after repeated failures", async () => {
  let now = 1_000;
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const registry = new ProviderRegistry({ failureThreshold: 2, circuitMs: 30_000, now: () => now });
  const primary: MarketProvider = {
    id: "primary",
    quote: async () => {
      primaryCalls += 1;
      throw new Error("rate limited");
    },
  };
  const fallback: MarketProvider = {
    id: "fallback",
    quote: async () => {
      fallbackCalls += 1;
      return quote("fallback");
    },
  };
  registry.register(primary);
  registry.register(fallback);

  for (let index = 0; index < 3; index += 1) {
    await registry.run("quote", (provider) => provider.quote!("NVDA", new AbortController().signal));
    now += 10;
  }

  assert.equal(primaryCalls, 2);
  assert.equal(fallbackCalls, 3);
  const primaryHealth = registry.healthSnapshot()[0];
  assert.equal(primaryHealth?.consecutiveFailures, 2);
  assert.ok((primaryHealth?.circuitOpenUntil ?? 0) > now);
  const quoteHealth = primaryHealth?.capabilities.find((item) => item.capability === "quote");
  assert.equal(quoteHealth?.consecutiveFailures, 2);
  assert.ok((quoteHealth?.circuitOpenUntil ?? 0) > now);
});

test("circuit failures are isolated by provider capability", async () => {
  let now = 1_000;
  let quoteCalls = 0;
  const registry = new ProviderRegistry({ failureThreshold: 2, circuitMs: 30_000, now: () => now });
  registry.register({
    id: "multi",
    quote: async () => {
      quoteCalls += 1;
      return quote("multi");
    },
    earnings: async () => {
      throw new Error("earnings endpoint down");
    },
  });

  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(
      registry.run("earnings", (provider) => provider.earnings!("NVDA", new AbortController().signal)),
      /earnings endpoint down/,
    );
    now += 10;
  }

  const result = await registry.run("quote", (provider) => provider.quote!("NVDA", new AbortController().signal));
  assert.equal(result.providerId, "multi");
  assert.equal(quoteCalls, 1);

  const health = registry.healthSnapshot()[0];
  const earnings = health?.capabilities.find((item) => item.capability === "earnings");
  const quotes = health?.capabilities.find((item) => item.capability === "quote");
  assert.ok((earnings?.circuitOpenUntil ?? 0) > now);
  assert.equal(quotes?.circuitOpenUntil, undefined);
  assert.equal(quotes?.successes, 1);
});

test("provider ids reject duplicates", () => {
  const registry = new ProviderRegistry();
  registry.register({ id: "same" });
  assert.throws(() => registry.register({ id: "same" }), /already registered/);
});
