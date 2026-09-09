import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  accountStorageGet,
  accountStorageSet,
  activeBrowserAccountId,
  setActiveBrowserAccount,
} from "../src/accountStorage.ts";
import { consumeAuthPrefetch, prefetchAuthStatus } from "../src/authPrefetch.ts";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  get length(): number { return this.values.size; }
}

const installStorage = () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  };
};

test("browser-local state is isolated by active account", () => {
  const restore = installStorage();
  try {
    setActiveBrowserAccount("usr_alice");
    accountStorageSet("polyth.test", "alice");
    setActiveBrowserAccount("usr_bob");
    accountStorageSet("polyth.test", "bob");

    assert.equal(activeBrowserAccountId(), "usr_bob");
    assert.equal(accountStorageGet("polyth.test"), "bob");
    setActiveBrowserAccount("usr_alice");
    assert.equal(accountStorageGet("polyth.test"), "alice");
  } finally {
    restore();
  }
});

test("remembered authentication aligns browser account scope before bootstrap", async () => {
  const restoreStorage = installStorage();
  const previousFetch = globalThis.fetch;
  try {
    setActiveBrowserAccount("usr_owner");
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/api/auth/status") {
        return new Response(JSON.stringify({
          required: true,
          authorized: true,
          scope: "ui-session",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/api/auth/accounts") {
        return new Response(JSON.stringify({
          currentAccountId: "usr_alice",
          canManage: false,
          accounts: [{ id: "usr_alice", name: "Alice", current: true }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${path}`);
    };

    const status = await prefetchAuthStatus();
    assert.equal(status.authorized, true);
    assert.equal(activeBrowserAccountId(), "usr_alice");
    assert.equal(await consumeAuthPrefetch(), status);
  } finally {
    globalThis.fetch = previousFetch;
    restoreStorage();
  }
});

test("agent presets stay separate from the harness/model picker", () => {
  const harnessPicker = readFileSync(
    new URL("../../../packages/harness-runtime/widgets/index.tsx", import.meta.url),
    "utf8",
  );
  const miniWidgets = readFileSync(new URL("../src/widgets/builtinMiniWidgets.tsx", import.meta.url), "utf8");
  const sessionPackage = readFileSync(new URL("../../../packages/session/package.json", import.meta.url), "utf8");

  assert.doesNotMatch(harnessPicker, /executionProfileControl/);
  assert.match(miniWidgets, /id: "composer\.preset"/);
  assert.match(miniWidgets, /context\.executionProfileControl/);
  assert.match(sessionPackage, /webApiAccountScoped\.ts/);
});
