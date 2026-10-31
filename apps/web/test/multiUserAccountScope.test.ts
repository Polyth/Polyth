import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  accountStorageGet,
  accountStorageSet,
  activeBrowserAccountId,
  setActiveBrowserAccount,
} from "../src/accountStorage.ts";
import { consumeAuthPrefetch, isBrowserAccountScopeResolved, prefetchAuthStatus } from "../src/authPrefetch.ts";
import { clearAuthCsrf } from "../src/authClient.ts";
import { loginAccount, recoverAccount } from "../src/accounts.ts";

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

test("a successful first login establishes the authenticated persistence namespace", async () => {
  const restoreStorage = installStorage();
  const previousFetch = globalThis.fetch;
  clearAuthCsrf();
  try {
    const csrfToken = "f".repeat(64);
    const seen: string[] = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      seen.push(path);
      if (path === "/api/auth/status") {
        return new Response(JSON.stringify({
          required: true,
          authorized: false,
          scope: "anonymous",
          state: "ready",
          csrfToken,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/api/auth/login") {
        assert.equal((init?.headers as Record<string, string>)["x-polyth-csrf"], csrfToken);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path === "/api/auth/me") {
        return new Response(JSON.stringify({ id: "usr_alice", displayName: "Alice" }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${path}`);
    };
    assert.deepEqual(await loginAccount("Alice", "secret"), { ok: true });
    assert.deepEqual(seen, ["/api/auth/status", "/api/auth/login", "/api/auth/me"]);
    assert.equal(activeBrowserAccountId(), "usr_alice");
    assert.equal(isBrowserAccountScopeResolved(), true);
  } finally {
    clearAuthCsrf();
    globalThis.fetch = previousFetch;
    restoreStorage();
  }
});

test("recovery replaces credentials without changing the browser account namespace", async () => {
  const restoreStorage = installStorage();
  const previousFetch = globalThis.fetch;
  clearAuthCsrf();
  const scopeResolvedBeforeRecovery = isBrowserAccountScopeResolved();
  try {
    const csrfToken = "a".repeat(64);
    const seen: string[] = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      seen.push(path);
      if (path === "/api/auth/status") {
        return new Response(JSON.stringify({
          required: true,
          authorized: false,
          scope: "anonymous",
          state: "ready",
          csrfToken,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.equal(path, "/api/auth/recover");
      assert.equal((init?.headers as Record<string, string>)["x-polyth-csrf"], csrfToken);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        login: "alice",
        code: "recovery-code",
        password: "replacement passphrase",
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    assert.deepEqual(
      await recoverAccount(" Alice ", " recovery-code ", "replacement passphrase"),
      { ok: true },
    );
    assert.deepEqual(seen, ["/api/auth/status", "/api/auth/recover"]);
    assert.equal(activeBrowserAccountId(), "usr_owner");
    assert.equal(isBrowserAccountScopeResolved(), scopeResolvedBeforeRecovery);
  } finally {
    clearAuthCsrf();
    globalThis.fetch = previousFetch;
    restoreStorage();
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

test("a status that names the UI session's account needs no second boot round trip", async () => {
  const restoreStorage = installStorage();
  const previousFetch = globalThis.fetch;
  try {
    consumeAuthPrefetch();
    setActiveBrowserAccount("usr_owner");
    const seen: string[] = [];
    globalThis.fetch = async (input) => {
      const path = String(input);
      seen.push(path);
      if (path === "/api/auth/status") {
        return new Response(JSON.stringify({
          required: true,
          authorized: true,
          scope: "ui-session",
          accountId: "usr_alice",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${path}`);
    };

    await prefetchAuthStatus();
    assert.deepEqual(seen, ["/api/auth/status"]);
    assert.equal(activeBrowserAccountId(), "usr_alice");
    assert.equal(isBrowserAccountScopeResolved(), true);
  } finally {
    globalThis.fetch = previousFetch;
    consumeAuthPrefetch();
    restoreStorage();
  }
});

test("a status inlined in the HTML shell boots without any auth request, once", async () => {
  const restoreStorage = installStorage();
  const previousFetch = globalThis.fetch;
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    consumeAuthPrefetch();
    let removed = false;
    const element = {
      textContent: JSON.stringify({ required: true, authorized: true, scope: "ui-session", accountId: "usr_inline" }),
      remove: () => { removed = true; },
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: (id: string) => (id === "polyth-auth-status" && !removed ? element : null) },
    });
    globalThis.fetch = async (input) => { throw new Error(`unexpected fetch ${String(input)}`); };
    const status = await prefetchAuthStatus();
    assert.equal(status.scope, "ui-session");
    assert.equal(activeBrowserAccountId(), "usr_inline");
    assert.equal(removed, true, "a later status check must ask the server");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete (globalThis as { document?: unknown }).document;
    consumeAuthPrefetch();
    restoreStorage();
  }
});

test("a loopback shell asks the Space gateway alongside the auth status", async () => {
  const restoreStorage = installStorage();
  const previousFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  try {
    consumeAuthPrefetch();
    Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", hostname: "127.0.0.1" } });
    const seen: string[] = [];
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    globalThis.fetch = async (input) => {
      const path = String(input);
      seen.push(path);
      if (path === "/api/auth/status") {
        await statusGate;
        return new Response(JSON.stringify({ required: false, authorized: true, scope: "paired-device" }), { status: 200 });
      }
      assert.equal(path, "/api/spaces");
      return new Response(JSON.stringify({ user: { id: "usr_phone" } }), { status: 200 });
    };

    const pending = prefetchAuthStatus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(seen.sort(), ["/api/auth/status", "/api/spaces"], "both requests are in flight before the status answers");
    releaseStatus();
    await pending;
    assert.equal(seen.length, 2, "the early gateway answer is reused");
    assert.equal(activeBrowserAccountId(), "usr_phone");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else delete (globalThis as { location?: unknown }).location;
    consumeAuthPrefetch();
    restoreStorage();
  }
});

test("authorized local-user bootstrap scopes browser state from the current Space user", async () => {
  const restoreStorage = installStorage();
  const previousFetch = globalThis.fetch;
  try {
    consumeAuthPrefetch();
    setActiveBrowserAccount("usr_owner");
    const seen: string[] = [];
    globalThis.fetch = async (input) => {
      const path = String(input);
      seen.push(path);
      if (path === "/api/auth/status") {
        return new Response(JSON.stringify({
          required: true,
          authorized: true,
          scope: "local-user",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.equal(path, "/api/spaces");
      return new Response(JSON.stringify({ user: { id: "usr_local" }, activeSpaceId: "spc_local" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const status = await prefetchAuthStatus();
    assert.equal(status.scope, "local-user");
    assert.deepEqual(seen, ["/api/auth/status", "/api/spaces"]);
    assert.equal(activeBrowserAccountId(), "usr_local");
    assert.equal(isBrowserAccountScopeResolved(), true);
    consumeAuthPrefetch();
  } finally {
    globalThis.fetch = previousFetch;
    consumeAuthPrefetch();
    restoreStorage();
  }
});

test("agent presets stay separate from the harness/model picker", () => {
  const harness = readFileSync(
    new URL("../../../packages/harness-runtime/widgets/runtime.tsx", import.meta.url),
    "utf8",
  );
  const sessionPackage = readFileSync(new URL("../../../packages/session/package.json", import.meta.url), "utf8");

  const modelHeader = harness.split("\n").find((line) => line.includes('slot: "modelPicker.header"')) ?? "";
  const preset = harness.split("\n").find((line) => line.includes('id: "harnesses.agent-preset"')) ?? "";
  assert.ok(modelHeader);
  assert.equal(modelHeader.includes("executionProfileControl"), false);
  assert.equal(preset, "", "profile selection has been removed from execution controls");
  assert.match(sessionPackage, /webApiAccountScoped\.ts/);
});
