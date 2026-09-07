import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  createApiTransport,
  defineWebPackage,
  friendlyError,
} from "../src/index.ts";

test("API transport encodes JSON and returns typed responses", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const transport = createApiTransport({
    baseUrl: "https://polyth.test",
    fetch: (async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(await transport.patch<{ ok: boolean }>("/api/feature", { enabled: true }), {
    ok: true,
  });
  assert.equal(calls[0]?.input, "https://polyth.test/api/feature");
  assert.equal(calls[0]?.init?.method, "PATCH");
  assert.equal(calls[0]?.init?.body, JSON.stringify({ enabled: true }));
  assert.equal(new Headers(calls[0]?.init?.headers).get("content-type"), "application/json");
});

test("API transport preserves structured errors and unauthorized callback", async () => {
  let unauthorized = 0;
  const transport = createApiTransport({
    fetch: async () => new Response(
      JSON.stringify({ error: "session-expired", message: "Sign in again" }),
      { status: 401 },
    ),
    onUnauthorized: () => { unauthorized++; },
  });

  await assert.rejects(
    () => transport.get("/api/private"),
    (cause: unknown) => {
      assert.ok(cause instanceof ApiError);
      assert.equal(cause.status, 401);
      assert.equal(cause.code, "session-expired");
      assert.equal(cause.message, "Sign in again");
      return true;
    },
  );
  assert.equal(unauthorized, 1);
});

test("defineWebPackage returns the entry unchanged", () => {
  const entry = () => () => () => undefined;
  assert.equal(defineWebPackage(entry), entry);
});

test("friendlyError is a public host-agnostic helper", () => {
  assert.equal(friendlyError("Could not load", new Error("offline")), "Could not load: offline");
  assert.equal(friendlyError("Could not load", "  "), "Could not load");
});
