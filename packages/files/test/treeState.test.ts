import test from "node:test";
import assert from "node:assert/strict";
import {
  ancestorPaths,
  beginTreeRequest,
  isCurrentTreeRequest,
  readTreePrefs,
  treeScopeKey,
  writeTreePrefs,
} from "../widgets/editor/treeState.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test("ancestorPaths returns fetch order for a nested file", () => {
  assert.deepEqual(ancestorPaths("src/components/Button.tsx"), ["", "src", "src/components"]);
  assert.deepEqual(ancestorPaths("README.md"), [""]);
  assert.deepEqual(ancestorPaths("/src/index.ts"), ["", "src"]);
});

test("tree preferences are scoped and tolerate malformed storage", () => {
  const storage = new MemoryStorage();
  const first = { projectId: "p", sessionId: "s1" };
  const second = { projectId: "p", sessionId: "s2" };
  writeTreePrefs(first, { open: ["src", "src", ""], selected: "src/index.ts", scrollTop: 41.7 }, storage);

  assert.notEqual(treeScopeKey(first), treeScopeKey(second));
  assert.notEqual(treeScopeKey({ ...first, repositoryId: "first" }), treeScopeKey({ ...first, repositoryId: "second" }));
  assert.deepEqual(readTreePrefs(first, storage), { open: ["src"], selected: "src/index.ts", scrollTop: 42 });
  assert.deepEqual(readTreePrefs(second, storage), { open: [], selected: "", scrollTop: 0 });

  storage.setItem(treeScopeKey(first), "not-json");
  assert.deepEqual(readTreePrefs(first, storage), { open: [], selected: "", scrollTop: 0 });
});

test("tree preferences stay isolated across account/Space storage namespaces", () => {
  const storage = new MemoryStorage();
  const first = { projectId: "p", sessionId: "s", repositoryId: "repo", storageNamespace: "polyth.workspace.[\"conn\",\"account-a\",\"space-a\",\"p\",\"s\",\"files.tree\"]" };
  const second = { ...first, storageNamespace: "polyth.workspace.[\"conn\",\"account-b\",\"space-b\",\"p\",\"s\",\"files.tree\"]" };
  writeTreePrefs(first, { open: ["src"], selected: "src/a.ts", scrollTop: 9 }, storage);
  assert.deepEqual(readTreePrefs(first, storage), { open: ["src"], selected: "src/a.ts", scrollTop: 9 });
  assert.deepEqual(readTreePrefs(second, storage), { open: [], selected: "", scrollTop: 0 });
});

test("tree request tokens reject responses from an earlier scope generation", () => {
  const first = { projectId: "p", sessionId: "s1" };
  const second = { projectId: "p", sessionId: "s2" };
  const token = beginTreeRequest(first, 3);

  assert.equal(isCurrentTreeRequest(token, first, 3), true);
  assert.equal(isCurrentTreeRequest(token, second, 3), false);
  assert.equal(isCurrentTreeRequest(token, first, 4), false);
});
