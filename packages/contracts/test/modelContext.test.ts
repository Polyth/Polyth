import assert from "node:assert/strict";
import test from "node:test";
import { dedupeModelDescriptors, resolveModelContextLimit } from "../src/modelContext.ts";

const model = { harnessId: "cursor", providerID: "openai", modelID: "gpt", name: "GPT" };

test("native context wins over absent duplicates in either order", () => {
  const native = { ...model, context: 128_000 };
  for (const rows of [[model, native], [native, model]]) {
    assert.equal(dedupeModelDescriptors(rows)[0]?.context, 128_000);
  }
});

test("context conflicts survive serialization and subsequent merges", () => {
  const rows = dedupeModelDescriptors([{ ...model, context: 128_000 }, { ...model, context: 256_000 }]);
  const serialized = JSON.parse(JSON.stringify(rows));
  for (const values of [[...serialized, { ...model, context: 128_000 }], [{ ...model, context: 128_000 }, ...serialized]]) {
    const merged = dedupeModelDescriptors(values);
    assert.equal(merged[0]?.context, undefined);
    assert.equal(merged[0]?.contextStatus, "conflict");
  }
  assert.equal(dedupeModelDescriptors([{ ...model, context: 128_000, contextStatus: "conflict" }])[0]?.context, undefined);
});

test("context merging keeps harness and provider identities separate", () => {
  const rows = dedupeModelDescriptors([
    { ...model, context: 128_000 },
    { ...model, harnessId: "codex", context: 256_000 },
    { ...model, providerID: "proxy", context: 512_000 },
  ]);
  assert.deepEqual(rows.map(row => row.context), [128_000, 256_000, 512_000]);
});

test("context lookup never borrows another harness or provider's limit", () => {
  const selected = { providerID: "shared", modelID: "same" };
  const foreign = { ...selected, harnessId: "other", name: "Other", context: 256_000 };
  assert.equal(resolveModelContextLimit(selected, [foreign], "active"), undefined);
  assert.equal(resolveModelContextLimit(selected, [foreign]), undefined);
  assert.equal(resolveModelContextLimit(selected, [
    { ...foreign, providerID: "different", harnessId: "active" },
  ], "active"), undefined);
  const native = { ...foreign, harnessId: "active", context: 128_000 };
  const generic = { ...foreign, harnessId: undefined, context: 64_000 };
  assert.equal(resolveModelContextLimit(selected, [foreign, native, generic], "active"), 128_000);
  assert.equal(resolveModelContextLimit(selected, [foreign, generic], "active"), 64_000);
});

test("context lookup refuses duplicate conflicts even before catalog merging", () => {
  const native = { ...model, context: 128_000 };
  assert.equal(resolveModelContextLimit(model, [model, native], "cursor"), 128_000);
  assert.equal(resolveModelContextLimit(model, [native, { ...native, context: 256_000 }], "cursor"), undefined);
  assert.equal(resolveModelContextLimit(model, [native, { ...model, contextStatus: "conflict" }], "cursor"), undefined);
});
