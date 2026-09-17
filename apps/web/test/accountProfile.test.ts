import assert from "node:assert/strict";
import test from "node:test";
import { clearAuthCsrf } from "../src/authClient.ts";
import { renameCurrentAccount } from "../src/accounts.ts";

test("profile rename sends canonical CSRF/CAS payload and returns the server revision", async () => {
  const previousFetch = globalThis.fetch;
  clearAuthCsrf();
  const csrf = "c".repeat(64);
  const calls: string[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      calls.push(path);
      if (path === "/api/auth/status") {
        return new Response(JSON.stringify({
          required: true,
          authorized: true,
          scope: "ui-session",
          state: "ready",
          csrfToken: csrf,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.equal(path, "/api/auth/me");
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>)["x-polyth-csrf"], csrf);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        name: "Max",
        expectedRevision: 4,
      });
      return new Response(JSON.stringify({
        id: "usr_11111111-1111-1111-1111-111111111111",
        displayName: "Max",
        status: "active",
        revision: 5,
        managed: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    assert.deepEqual(
      await renameCurrentAccount({ id: "usr_11111111-1111-1111-1111-111111111111", revision: 4 }, "  Max  "),
      {
        id: "usr_11111111-1111-1111-1111-111111111111",
        name: "Max",
        current: true,
        status: "active",
        revision: 5,
        managed: false,
      },
    );
    assert.deepEqual(calls, ["/api/auth/status", "/api/auth/me"]);
  } finally {
    clearAuthCsrf();
    globalThis.fetch = previousFetch;
  }
});

test("profile rename refuses a missing revision before any mutation request", async () => {
  const previousFetch = globalThis.fetch;
  let called = false;
  try {
    globalThis.fetch = async () => {
      called = true;
      throw new Error("unexpected fetch");
    };
    await assert.rejects(
      renameCurrentAccount({ id: "usr_owner" }, "Max"),
      { code: "conflict" },
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
