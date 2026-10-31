import test from "node:test";
import assert from "node:assert/strict";
import type { SessionCreateOperationStatusDto } from "@polyth/session/web-api";
import { createSessionWithRecovery, SESSION_CREATE_RESOLVE_DELAYS_MS } from "../src/sessionCreateRecovery.ts";

// iOS/WKWebView rejects a fetch whose Link transport dropped with this TypeError.
const loadFailed = () => new TypeError("Load failed");
const httpError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(code), { status, code, ...extra });

function script(steps: {
  create: Array<() => Promise<{ id: string }>>;
  status?: Array<() => Promise<SessionCreateOperationStatusDto>>;
}) {
  const keys: string[] = [];
  const calls: string[] = [];
  const deps = {
    newOperationId: () => "8d1c2a52-6d2f-4a51-9f3e-2b9a8d4c1e70",
    wait: async () => {},
    create: (key: string) => {
      keys.push(key);
      calls.push("create");
      const next = steps.create.shift();
      assert.ok(next, "unexpected create");
      return next();
    },
    status: (key: string) => {
      keys.push(key);
      calls.push("status");
      const next = steps.status?.shift();
      assert.ok(next, "unexpected status probe");
      return next();
    },
  };
  return { deps, keys, calls };
}

test("a confirmed create is one keyed request", async () => {
  const s = script({ create: [async () => ({ id: "s1" })] });
  assert.deepEqual(await createSessionWithRecovery(s.deps), { id: "s1" });
  assert.deepEqual(s.calls, ["create"]);
});

test("a lost response resolves to the session the server already created, without resending", async () => {
  const s = script({
    create: [async () => { throw loadFailed(); }],
    status: [async () => ({ state: "created", sessionId: "s1" })],
  });
  assert.deepEqual(await createSessionWithRecovery(s.deps), { id: "s1" });
  assert.deepEqual(s.calls, ["create", "status"]);
});

test("a request that never arrived is resent with the SAME key after the server proves it dedupes", async () => {
  const s = script({
    create: [async () => { throw loadFailed(); }, async () => ({ id: "s1" })],
    status: [async () => { throw loadFailed(); }, async () => ({ state: "absent" })],
  });
  assert.deepEqual(await createSessionWithRecovery(s.deps), { id: "s1" });
  assert.deepEqual(s.calls, ["create", "status", "status", "create"]);
  assert.equal(new Set(s.keys).size, 1, "every attempt carries one idempotency key");
});

test("a server without keyed create (404 probe) is never resent: the outcome stays unknown", async () => {
  const s = script({
    create: [async () => { throw loadFailed(); }],
    status: [async () => { throw httpError(404, "not-found"); }],
  });
  await assert.rejects(createSessionWithRecovery(s.deps), (error: { code?: string; mutationOutcome?: string }) =>
    error.code === "outcome-unknown" && error.mutationOutcome === "unknown");
  assert.deepEqual(s.calls, ["create", "status"]);
});

test("typed rejections pass through untouched, including a resent settled failure", async () => {
  const refused = httpError(503, "runtime-unavailable", { mutationOutcome: "rejected" });
  const first = script({ create: [async () => { throw refused; }] });
  await assert.rejects(createSessionWithRecovery(first.deps), (error) => error === refused);

  const settled = httpError(409, "session-create-failed", { mutationOutcome: "rejected", sessionId: "s1" });
  const second = script({
    create: [async () => { throw loadFailed(); }, async () => { throw settled; }],
    status: [async () => ({ state: "failed", sessionId: "s1" })],
  });
  await assert.rejects(createSessionWithRecovery(second.deps), (error) => error === settled);
});

test("a link that stays down ends as outcome unknown after the bounded backoff", async () => {
  const waits: number[] = [];
  const s = script({
    create: [async () => { throw loadFailed(); }],
    status: SESSION_CREATE_RESOLVE_DELAYS_MS.map(() => async () => { throw loadFailed(); }),
  });
  await assert.rejects(
    createSessionWithRecovery({ ...s.deps, wait: async (ms) => { waits.push(ms); } }),
    (error: { mutationOutcome?: string }) => error.mutationOutcome === "unknown",
  );
  assert.deepEqual(waits, [...SESSION_CREATE_RESOLVE_DELAYS_MS]);
  assert.equal(s.calls.filter((call) => call === "create").length, 1, "no resend without a dedupe-capable answer");
});
