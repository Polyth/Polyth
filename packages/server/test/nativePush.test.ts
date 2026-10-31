import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNativePushService, nativePushBinding, nativePushTag } from "../src/nativePush.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "polyth-native-push-")), "native-push.json");
const alice = { userId: "usr_alice", spaceId: "sp_alice", deviceId: "dev_alice", deviceEndpointId: "end_alice" };
const bob = { userId: "usr_bob", spaceId: "sp_bob", deviceId: "dev_bob", deviceEndpointId: "end_bob" };

test("binding is stable over only pinned host/device/account identity", () => {
  assert.equal(nativePushBinding({ hostEndpointId: "host", deviceEndpointId: "device", userId: "user" }), nativePushBinding({ hostEndpointId: "host", deviceEndpointId: "device", userId: "user" }));
  assert.notEqual(nativePushBinding({ hostEndpointId: "host", deviceEndpointId: "device", userId: "user" }), nativePushBinding({ hostEndpointId: "host", deviceEndpointId: "other", userId: "user" }));
  assert.match(nativePushTag("session:turn:idle"), /^[A-Za-z0-9_-]{43}$/);
});

test("claim and delivery use durable account/device authority", async () => {
  let allowed = true;
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const persisted = file();
  const claimToken = "a".repeat(43);
  const senderToken = "b".repeat(43);
  const subscriptionId = `sub_${"c".repeat(22)}`;
  const authority = () => ({ hostEndpointId: async () => "host-endpoint", validate: async (input: typeof alice) => allowed && input.userId === alice.userId && input.spaceId === alice.spaceId && input.deviceId === alice.deviceId });
  const service = createNativePushService({
    file: persisted, relayOrigin: "http://127.0.0.1:8787", authority,
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
      if (String(url).endsWith("/v1/claims/redeem")) return new Response(JSON.stringify({ subscriptionId, senderToken }), { status: 200 });
      return new Response("{}", { status: 200 });
    },
  });
  await service.claim({ ...alice, claimToken });
  assert.equal(calls[0]?.body?.binding, nativePushBinding({ hostEndpointId: "host-endpoint", deviceEndpointId: alice.deviceEndpointId, userId: alice.userId }));
  await service.send({ userId: alice.userId, spaceId: alice.spaceId, notificationId: "n-1", kind: "completed", transitionKey: "s:turn:idle" });
  assert.equal(calls.filter((call) => call.url.endsWith("/v1/deliver")).length, 1);
  await service.send({ userId: bob.userId, spaceId: bob.spaceId, notificationId: "n-foreign", kind: "completed", transitionKey: "s:turn:idle" });
  assert.equal(calls.filter((call) => call.url.endsWith("/v1/deliver")).length, 1);
  allowed = false;
  const restarted = createNativePushService({ file: persisted, relayOrigin: "http://127.0.0.1:8787", authority, fetchFn: async () => { throw new Error("revoked subscription must not send"); } });
  await restarted.send({ userId: alice.userId, spaceId: alice.spaceId, notificationId: "n-after-revoke", kind: "completed", transitionKey: "s:turn:idle" });
  assert.equal(calls.filter((call) => call.url.endsWith("/v1/deliver")).length, 1);
});

test("relay redirects are rejected without a follow-up request", async () => {
  let calls = 0;
  let redirect: RequestRedirect | undefined;
  const service = createNativePushService({
    file: file(), relayOrigin: "http://127.0.0.1:8787",
    authority: () => ({ hostEndpointId: async () => "host-endpoint", validate: async () => true }),
    fetchFn: async (_url, init) => {
      calls++;
      redirect = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid" } });
    },
  });
  await assert.rejects(() => service.claim({ ...alice, claimToken: "a".repeat(43) }), { code: "invalid-input" });
  assert.equal(calls, 1);
  assert.equal(redirect, "error");
});

test("claims reject malformed capabilities before persistence", async () => {
  let calls = 0;
  const service = createNativePushService({
    file: file(), relayOrigin: "http://127.0.0.1:8787",
    authority: () => ({ hostEndpointId: async () => "host-endpoint", validate: async () => true }),
    fetchFn: async () => {
      calls++;
      return new Response(JSON.stringify({ subscriptionId: `sub_${"x".repeat(21)}`, senderToken: "y".repeat(43) }), { status: 200 });
    },
  });
  await assert.rejects(() => service.claim({ ...alice, claimToken: "not-a-capability" }), { code: "invalid-input" });
  assert.equal(calls, 0);
  await assert.rejects(() => service.claim({ ...alice, claimToken: "a".repeat(43) }), { code: "invalid-input" });
  assert.equal(calls, 1);
  assert.deepEqual(await service.status(alice), { enabled: true, subscribed: false });
});

test("account removal durably drops local sender authority before best-effort relay revoke", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const subscriptionId = `sub_${"d".repeat(22)}`;
  const service = createNativePushService({
    file: file(), relayOrigin: "http://127.0.0.1:8787",
    authority: () => ({ hostEndpointId: async () => "host-endpoint", validate: async () => true }),
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      if (String(url).endsWith("/v1/claims/redeem")) {
        return new Response(JSON.stringify({ subscriptionId, senderToken: "e".repeat(43) }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    },
  });
  await service.claim({ ...alice, claimToken: "f".repeat(43) });
  assert.equal(await service.removeAccount(alice.userId), 1);
  assert.deepEqual(await service.status(alice), { enabled: true, subscribed: false });
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url.endsWith(`/v1/senders/${subscriptionId}`)));
});
