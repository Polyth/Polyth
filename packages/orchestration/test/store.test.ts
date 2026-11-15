import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_POLICY } from "../src/contracts.ts";
import { personFile, readPolicyFile, resetPolicy, savePolicy } from "../src/store.ts";

const dir = (t: { after(fn: () => void): void }) => {
  const root = mkdtempSync(join(tmpdir(), "orchestration-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const draft = { ...DEFAULT_POLICY, mode: "roles" as const, maxChildren: 2 };

test("missing file reads as the unsaved default", (t) => {
  const file = personFile(dir(t), "alice");
  const { policy, corrupt } = readPolicyFile(file);
  assert.equal(policy.revision, "default");
  assert.equal(corrupt, false);
});

test("save → read round-trips, file is private, revision moves", async (t) => {
  const root = dir(t);
  const file = personFile(root, "alice");
  const saved = await savePolicy(file, draft, "default", 123);
  assert.notEqual(saved.revision, "default");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const read = readPolicyFile(file).policy;
  assert.equal(read.revision, saved.revision);
  assert.equal(read.maxChildren, 2);
  assert.equal(read.updatedAt, 123);
});

test("a stale expectedRevision is a conflict; concurrent writers serialize", async (t) => {
  const file = personFile(dir(t), "alice");
  const [one, two] = await Promise.allSettled([
    savePolicy(file, draft, "default"),
    savePolicy(file, { ...draft, maxChildren: 4 }, "default"),
  ]);
  assert.equal(one.status, "fulfilled");
  assert.equal(two.status, "rejected");
  assert.equal((two as PromiseRejectedResult).reason.code, "conflict");
  assert.equal(readPolicyFile(file).policy.maxChildren, 2);
});

test("invalid input is rejected before touching the file", async (t) => {
  const file = personFile(dir(t), "alice");
  assert.throws(() => savePolicy(file, { ...draft, mode: "x" }, "default"), /mode/);
  assert.equal(existsSync(file), false);
});

test("each person has their own file; one cannot read another's", async (t) => {
  const root = dir(t);
  await savePolicy(personFile(root, "alice"), draft, "default");
  assert.equal(readPolicyFile(personFile(root, "bob")).policy.revision, "default");
  assert.notEqual(personFile(root, "alice"), personFile(root, "bob"));
  assert.equal(readdirSync(join(root, "people")).length, 1);
  assert.doesNotMatch(personFile(root, "alice"), /alice/);
});

test("reset deletes the file; a corrupt file reads as default and flags it", async (t) => {
  const root = dir(t);
  const file = personFile(root, "alice");
  await savePolicy(file, draft, "default");
  const reset = await resetPolicy(file);
  assert.equal(reset.revision, "default");
  assert.equal(existsSync(file), false);
  await savePolicy(file, draft, "default");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, "{nope");
  const corrupt = readPolicyFile(file);
  assert.equal(corrupt.corrupt, true);
  assert.equal(corrupt.policy.revision, "default");
  assert.match(readFileSync(file, "utf8"), /nope/);
});
