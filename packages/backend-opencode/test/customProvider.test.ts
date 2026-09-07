import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addManualModelIntoProvider,
  applyHeaderPatch,
  applyProviderOps,
  mergeCustomProvider,
  mergeDiscoveredIntoProvider,
  protocolFromNpm,
  reconcileDiscoveredModels,
} from "../src/customProvider.ts";

test("reconcile is merge-only and keeps models discovery did not return", () => {
  const merged = reconcileDiscoveredModels(
    { "keep-me": { name: "Manual" }, stale: { name: "Still here" } },
    [{ id: "found", name: "Found" }, { id: "keep-me" }],
  );
  assert.deepEqual(Object.keys(merged).sort(), ["found", "keep-me", "stale"]);
  assert.equal((merged["keep-me"] as { name: string }).name, "Manual");
});

test("mergeCustomProvider preserves unknown sibling providers and fields", () => {
  const next = mergeCustomProvider({
    external: { npm: "future-provider", keep: { nested: true } },
  }, {
    id: "local-lmstudio",
    name: "LM Studio",
    protocol: "openai-compatible",
    baseURL: "http://127.0.0.1:1234/v1",
    authMode: "none",
  });
  assert.deepEqual((next.external as { keep: unknown }).keep, { nested: true });
  const created = next["local-lmstudio"] as Record<string, unknown>;
  assert.equal(created.npm, "@ai-sdk/openai-compatible");
  assert.equal("polyth" in created, false);
  assert.equal(protocolFromNpm(created.npm), "openai-compatible");
});

test("omitted header patch preserves existing headers; unset is precise", () => {
  let provider = mergeCustomProvider({}, {
    id: "lab",
    name: "Lab",
    protocol: "openai-compatible",
    baseURL: "http://127.0.0.1:9/v1",
    headerPatch: { set: { Authorization: "Bearer secret", "X-Org": "acme" } },
  });
  provider = mergeCustomProvider(provider, {
    id: "lab",
    name: "Lab 2",
    protocol: "openai-compatible",
    baseURL: "http://127.0.0.1:10/v1",
  });
  const options = (provider.lab as { options: { headers: Record<string, string>; baseURL: string } }).options;
  assert.equal(options.baseURL, "http://127.0.0.1:10/v1");
  assert.deepEqual(options.headers, { Authorization: "Bearer secret", "X-Org": "acme" });
  provider = mergeCustomProvider(provider, {
    id: "lab",
    name: "Lab 2",
    protocol: "openai-compatible",
    baseURL: "http://127.0.0.1:10/v1",
    headerPatch: { unset: ["X-Org"] },
  });
  assert.deepEqual(
    (provider.lab as { options: { headers: Record<string, string> } }).options.headers,
    { Authorization: "Bearer secret" },
  );
});

test("discovery merge does not drop manuals or unknown model fields", () => {
  let provider = mergeCustomProvider({}, {
    id: "lab",
    name: "Lab",
    protocol: "openai-compatible",
    baseURL: "http://127.0.0.1:9/v1",
  });
  provider = addManualModelIntoProvider(provider, "lab", { id: "hand-rolled", name: "Hand" });
  const withExtra = provider.lab as { models: Record<string, Record<string, unknown>> };
  withExtra.models["hand-rolled"]!.keep = true;
  provider = mergeDiscoveredIntoProvider(provider, "lab", [{ id: "auto" }, { id: "hand-rolled" }]);
  const models = (provider.lab as { models: Record<string, { name?: string; keep?: boolean }> }).models;
  assert.ok("hand-rolled" in models);
  assert.ok("auto" in models);
  assert.equal(models["hand-rolled"]!.keep, true);
  assert.equal("polyth" in (provider.lab as object), false);
});

test("applyHeaderPatch clear then set replaces the map", () => {
  assert.deepEqual(
    applyHeaderPatch({ A: "1", B: "2" }, { clear: true, set: { C: "3" } }),
    { C: "3" },
  );
});

test("staged header ops keep latest user intent", () => {
  const base = {
    id: "lab",
    name: "Lab",
    protocol: "openai-compatible" as const,
    baseURL: "http://127.0.0.1:1/v1",
  };
  const headersOf = (ops: Parameters<typeof applyProviderOps>[1]) =>
    (applyProviderOps({ lab: { options: { headers: { Authorization: "seed" } } } }, ops)
      ?.lab as { options?: { headers?: Record<string, string> } })?.options?.headers;

  assert.equal(headersOf([
    { kind: "upsert", input: { ...base, headerPatch: { set: { Authorization: "foo" } } } },
    { kind: "upsert", input: { ...base, headerPatch: { unset: ["Authorization"] } } },
  ])?.Authorization, undefined);

  assert.equal(headersOf([
    { kind: "upsert", input: { ...base, headerPatch: { unset: ["Authorization"] } } },
    { kind: "upsert", input: { ...base, headerPatch: { set: { Authorization: "bar" } } } },
  ])?.Authorization, "bar");

  assert.equal(headersOf([
    { kind: "upsert", input: { ...base, headerPatch: { set: { Authorization: "foo" } } } },
    { kind: "upsert", input: { ...base, headerPatch: { set: { Authorization: "bar" } } } },
  ])?.Authorization, "bar");

  assert.deepEqual(headersOf([
    { kind: "upsert", input: { ...base, headerPatch: { set: { A: "1", B: "2" } } } },
    { kind: "upsert", input: { ...base, headerPatch: { clear: true } } },
  ]), undefined);

  assert.deepEqual(headersOf([
    { kind: "upsert", input: { ...base, headerPatch: { clear: true } } },
    { kind: "upsert", input: { ...base, headerPatch: { set: { C: "3" } } } },
  ]), { C: "3" });

  assert.deepEqual(headersOf([
    { kind: "upsert", input: { ...base, headerPatch: { set: { A: "1" } } } },
    { kind: "upsert", input: { ...base, headerPatch: { clear: true } } },
  ]), undefined);

  assert.deepEqual(headersOf([
    { kind: "upsert", input: { ...base, headerPatch: { clear: true } } },
    { kind: "upsert", input: { ...base, headerPatch: { set: { A: "2" } } } },
    { kind: "upsert", input: { ...base, headerPatch: { unset: ["A"] } } },
  ]), undefined);

  assert.equal(headersOf([
    { kind: "upsert", input: { ...base, headerPatch: { set: { "X-API-Key": "k" } } } },
    { kind: "upsert", input: { ...base, headerPatch: { unset: ["x-api-key"] } } },
  ])?.["X-API-Key"], undefined);
});

test("dropModel removes only the named configured model", () => {
  const provider = applyProviderOps({}, [
    { kind: "upsert", input: { id: "lab", name: "Lab", protocol: "openai-compatible", baseURL: "http://127.0.0.1:1/v1" } },
    { kind: "addManual", id: "lab", model: { id: "keep-me", name: "Keep" } },
    { kind: "addManual", id: "lab", model: { id: "wrong-model" } },
    { kind: "dropModel", id: "lab", modelId: "wrong-model" },
  ]);
  const models = (provider?.lab as { models: Record<string, unknown> }).models;
  assert.deepEqual(Object.keys(models), ["keep-me"]);
  assert.equal((models["keep-me"] as { name: string }).name, "Keep");
});

test("remove supersedes earlier staged create; later create wins", () => {
  const afterRemove = applyProviderOps({}, [
    { kind: "upsert", input: { id: "lab", name: "Lab", protocol: "openai-compatible", baseURL: "http://127.0.0.1:1/v1" } },
    { kind: "remove", id: "lab" },
  ]);
  assert.equal(afterRemove, undefined);
  const recreated = applyProviderOps({ keep: { npm: "x" } }, [
    { kind: "upsert", input: { id: "lab", name: "Lab", protocol: "openai-compatible", baseURL: "http://127.0.0.1:1/v1" } },
    { kind: "remove", id: "lab" },
    { kind: "upsert", input: { id: "lab", name: "Lab 2", protocol: "openai-compatible", baseURL: "http://127.0.0.1:2/v1" } },
  ]);
  assert.equal((recreated?.lab as { name: string }).name, "Lab 2");
  assert.deepEqual(recreated?.keep, { npm: "x" });
});
