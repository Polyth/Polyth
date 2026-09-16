import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdempotentMutationClient } from "../src/idempotentMutation.ts";

const response = (status = 200, body: unknown = { ok: true }) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const keyOf = (init?: RequestInit): string => new Headers(init?.headers).get("Idempotency-Key") ?? "";

test("network uncertainty retains the operation id until a confirmed response", async () => {
  const keys: string[] = [];
  let attempt = 0;
  let next = 0;
  const client = createIdempotentMutationClient({
    operationId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(keyOf(init));
      if (attempt++ === 0) throw new TypeError("connection reset");
      return response();
    }) as typeof fetch,
  });

  await assert.rejects(() => client.request("/api/spaces", "POST", { name: "Work" }), { uncertain: true });
  await client.request("/api/spaces", "POST", { name: "Work" });
  await client.request("/api/spaces", "POST", { name: "Work" });
  assert.equal(keys[1], keys[0]);
  assert.notEqual(keys[2], keys[1]);
});

test("5xx and unreadable 2xx remain uncertain; a confirmed 4xx releases the key", async () => {
  const keys: string[] = [];
  let next = 0;
  const replies = [response(503, { error: "unavailable" }), new Response("broken", { status: 200 }), response(400, { error: "invalid-input" }), response()];
  const client = createIdempotentMutationClient({
    operationId: () => `10000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(keyOf(init));
      return replies.shift()!;
    }) as typeof fetch,
  });

  const invoke = () => client.request("/api/spaces/spc_work", "PATCH", { name: "Research" });
  await assert.rejects(invoke, { status: 503, uncertain: true });
  await assert.rejects(invoke, { uncertain: true });
  await assert.rejects(invoke, { status: 400, uncertain: false });
  await invoke();
  assert.equal(keys[1], keys[0]);
  assert.equal(keys[2], keys[1]);
  assert.notEqual(keys[3], keys[2]);
});

test("different request bodies never share an operation id", async () => {
  const keys: string[] = [];
  let next = 0;
  const client = createIdempotentMutationClient({
    operationId: () => `20000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(keyOf(init));
      throw new TypeError("offline");
    }) as typeof fetch,
  });
  await assert.rejects(() => client.request("/api/spaces", "POST", { name: "A" }));
  await assert.rejects(() => client.request("/api/spaces", "POST", { name: "B" }));
  assert.notEqual(keys[0], keys[1]);
});
