import assert from "node:assert/strict";
import test from "node:test";
import { clearAuthCsrf } from "../src/authClient.ts";
import { completePendingProviderCallback } from "../src/identityProviders.ts";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  get length(): number { return this.values.size; }
}

const installBrowser = (search: string) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { pathname: "/auth/provider/callback", search } },
  });
  return {
    storage,
    restore() {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage);
      else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    },
  };
};

test("provider callback requires the exact browser-stored state and posts no account identity itself", async () => {
  const browser = installBrowser("?state=state-123&code=provider-code");
  const previousFetch = globalThis.fetch;
  clearAuthCsrf();
  try {
    browser.storage.setItem("polyth.provider-flow.v1", JSON.stringify({
      providerId: "github",
      purpose: "login",
      state: "state-123",
      returnTo: "/",
    }));
    const calls: string[] = [];
    const csrfToken = "a".repeat(64);
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      calls.push(path);
      if (path === "/api/auth/status") {
        return new Response(JSON.stringify({
          required: true,
          authorized: false,
          scope: "anonymous",
          state: "ready",
          csrfToken,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.equal(path, "/api/auth/providers/login/complete");
      assert.equal((init?.headers as Record<string, string>)["x-polyth-csrf"], csrfToken);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        providerId: "github",
        state: "state-123",
        code: "provider-code",
      });
      return new Response(JSON.stringify({ ok: true, returnTo: "/settings/access" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    assert.deepEqual(await completePendingProviderCallback(), {
      returnTo: "/settings/access",
      purpose: "login",
    });
    assert.deepEqual(calls, ["/api/auth/status", "/api/auth/providers/login/complete"]);
    assert.equal(browser.storage.getItem("polyth.provider-flow.v1"), null);
  } finally {
    clearAuthCsrf();
    globalThis.fetch = previousFetch;
    browser.restore();
  }
});

test("provider callback state mismatch fails before any network completion", async () => {
  const browser = installBrowser("?state=attacker-state&code=provider-code");
  const previousFetch = globalThis.fetch;
  clearAuthCsrf();
  try {
    browser.storage.setItem("polyth.provider-flow.v1", JSON.stringify({
      providerId: "github",
      purpose: "login",
      state: "expected-state",
      returnTo: "/",
    }));
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; throw new Error("must not fetch"); };
    await assert.rejects(completePendingProviderCallback(), { code: "invalid-provider-transaction" });
    assert.equal(fetched, false);
    assert.equal(browser.storage.getItem("polyth.provider-flow.v1"), null);
  } finally {
    clearAuthCsrf();
    globalThis.fetch = previousFetch;
    browser.restore();
  }
});
