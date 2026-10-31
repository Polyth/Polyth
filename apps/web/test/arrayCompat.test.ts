import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const METHODS = ["at", "toSorted", "toReversed", "toSpliced", "findLast", "findLastIndex"] as const;

test("installs ES2023 array methods an older WebView lacks", async () => {
  const saved = new Map(METHODS.map((name) => [name, Object.getOwnPropertyDescriptor(Array.prototype, name)]));
  for (const name of METHODS) delete (Array.prototype as unknown as Record<string, unknown>)[name];
  try {
    const { installArrayCompat } = await import("../src/arrayCompat.ts");
    installArrayCompat();
    const source = [3, 1, 2];
    assert.deepEqual(source.toSorted(), [1, 2, 3]);
    assert.deepEqual(source.toSorted((a, b) => b - a), [3, 2, 1]);
    assert.deepEqual(source.toReversed(), [2, 1, 3]);
    assert.deepEqual(source.toSpliced(1), [3]);
    assert.deepEqual(source.toSpliced(1, 1, 9, 8), [3, 9, 8, 2]);
    assert.deepEqual((source.toSpliced as (...args: number[]) => number[]).call(source), [3, 1, 2]);
    assert.equal(source.findLast((value) => value > 1), 2);
    assert.equal(source.findLastIndex((value) => value > 2), 0);
    assert.equal(source.findLast((value) => value > 5), undefined);
    assert.equal(source.findLastIndex((value) => value > 5), -1);
    assert.equal(source.at(-1), 2);
    assert.equal(source.at(0), 3);
    assert.equal(source.at(3), undefined);
    assert.equal(source.at(-4), undefined);
    assert.equal("abc".at(-1), "c");
    assert.deepEqual(source, [3, 1, 2], "change-by-copy methods never mutate");
    assert.equal(Object.keys(Array.prototype).length, 0, "installed methods are non-enumerable");
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(Array.prototype, name, descriptor);
    }
  }
});

test("keeps a native implementation and loads before the app graph", async () => {
  const native = Array.prototype.toSorted;
  const { installArrayCompat } = await import("../src/arrayCompat.ts");
  installArrayCompat();
  assert.equal(Array.prototype.toSorted, native);
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const firstImport = main.match(/^import .*$/m)?.[0];
  assert.equal(firstImport, 'import "./arrayCompat.ts";');
});

test("installs the WebKit 15.4 globals shell and package code use unguarded", async () => {
  const { installObjectCompat, installStructuredClone, installCryptoCompat } = await import("../src/arrayCompat.ts");

  const savedHasOwn = Object.getOwnPropertyDescriptor(Object, "hasOwn");
  delete (Object as unknown as Record<string, unknown>).hasOwn;
  try {
    installObjectCompat();
    assert.equal(Object.hasOwn({ a: 1 }, "a"), true);
    assert.equal(Object.hasOwn({ a: 1 }, "b"), false);
    assert.throws(() => (Object.hasOwn as unknown as (t: unknown, k: string) => boolean)(null, "a"), TypeError);
    assert.equal(Object.keys(Object).includes("hasOwn"), false, "installed shim is non-enumerable");
  } finally {
    if (savedHasOwn) Object.defineProperty(Object, "hasOwn", savedHasOwn);
  }

  const savedClone = Object.getOwnPropertyDescriptor(globalThis, "structuredClone");
  delete (globalThis as unknown as Record<string, unknown>).structuredClone;
  try {
    installStructuredClone();
    const date = new Date(1_700_000_000_000);
    const source: Record<string, unknown> = { a: 1, date, map: new Map([["k", 1]]), set: new Set([1, 2]), list: [1, 2] };
    source.self = source;
    const copy = structuredClone(source) as typeof source;
    assert.notEqual(copy, source);
    assert.equal(copy.self, copy, "circular references are preserved");
    assert.equal((copy.date as Date).getTime(), date.getTime());
    assert.notEqual(copy.date, date);
    assert.deepEqual([...copy.set as Set<number>], [1, 2]);
    assert.equal((copy.map as Map<string, number>).get("k"), 1);
    assert.notEqual(copy.list, source.list);
    assert.throws(() => structuredClone(() => undefined), TypeError);
  } finally {
    if (savedClone) Object.defineProperty(globalThis, "structuredClone", savedClone);
  }

  const savedUUID = Object.getOwnPropertyDescriptor(Crypto.prototype, "randomUUID");
  delete (Crypto.prototype as unknown as Record<string, unknown>).randomUUID;
  try {
    installCryptoCompat();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(first, second);
  } finally {
    if (savedUUID) Object.defineProperty(Crypto.prototype, "randomUUID", savedUUID);
  }
});
