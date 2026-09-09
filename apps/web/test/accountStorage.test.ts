import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountStorageGet,
  accountStorageKey,
  accountStorageSet,
  activeBrowserAccountId,
  normalizeAccountId,
  setActiveBrowserAccount,
} from "../src/accountStorage.ts";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

test("browser preference keys are isolated by authenticated account", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  try {
    assert.equal(activeBrowserAccountId(), "usr_owner");
    storage.setItem("example.pref", "legacy-owner");
    assert.equal(accountStorageGet("example.pref"), "legacy-owner");
    assert.equal(storage.getItem("example.pref"), null, "legacy owner key is migrated once");
    assert.equal(storage.getItem(accountStorageKey("example.pref")), "legacy-owner");

    setActiveBrowserAccount("Alice Smith");
    assert.equal(activeBrowserAccountId(), "usr_alice-smith");
    assert.equal(normalizeAccountId("Alice Smith"), "usr_alice-smith");
    assert.equal(accountStorageGet("example.pref"), null, "new user never sees owner's legacy value");
    accountStorageSet("example.pref", "alice");
    assert.equal(accountStorageGet("example.pref"), "alice");

    setActiveBrowserAccount("usr_bob");
    assert.equal(accountStorageGet("example.pref"), null);
    accountStorageSet("example.pref", "bob");
    assert.equal(accountStorageGet("example.pref"), "bob");

    setActiveBrowserAccount("usr_alice-smith");
    assert.equal(accountStorageGet("example.pref"), "alice");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
