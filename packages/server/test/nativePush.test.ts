import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivityInput, DeliveryInput, Destination, ProviderClass } from "@polyth/push-relay";
import { createNativePushService, nativePushTag, PUSH_SERVICE_ORIGIN, relaySender, type PushSender } from "../src/nativePush.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "polyth-native-push-")), "native-push.json");
const alice = { userId: "usr_alice", spaceId: "sp_alice", deviceId: "dev_alice", deviceEndpointId: "end_alice" };
const bob = { userId: "usr_bob", spaceId: "sp_bob", deviceId: "dev_bob", deviceEndpointId: "end_bob" };
const subscriptionId = `sub_${"c".repeat(22)}`;
const apnsToken = "ab".repeat(32);
const fcmToken = "fcm:opaque-token-abcdefghijklmnopqrstuvwxyz";
const send = { notificationId: "n-1", kind: "completed" as const, transitionKey: "s:turn:idle" };

class FakeSender implements PushSender {
  alerts: Array<{ destination: Destination; input: DeliveryInput }> = [];
  result: ProviderClass = "success";
  async deliver(destination: Destination, input: DeliveryInput): Promise<ProviderClass> { this.alerts.push({ destination, input }); return this.result; }
  async deliverActivity(_destination: Destination, _input: ActivityInput): Promise<ProviderClass> { return this.result; }
}

test("the transition tag is a bounded opaque fingerprint", () => {
  assert.match(nativePushTag("session:turn:idle"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(nativePushTag("a"), nativePushTag("a"));
  assert.notEqual(nativePushTag("a"), nativePushTag("b"));
});

test("registration and delivery use durable account/device authority", async () => {
  let allowed = true;
  const persisted = file();
  const relay = new FakeSender();
  const authority = () => ({ hostEndpointId: async () => "host-endpoint", validate: async (input: typeof alice) => allowed && input.userId === alice.userId && input.spaceId === alice.spaceId && input.deviceId === alice.deviceId });
  const service = createNativePushService({ file: persisted, relay, authority });
  await assert.rejects(service.register({ ...bob, subscriptionId, providerToken: apnsToken, environment: "production" }), { code: "unavailable" });
  await service.register({ ...alice, subscriptionId, providerToken: apnsToken, environment: "production" });
  assert.deepEqual(await service.status(alice), { enabled: true, subscribed: true, subscriptionId });
  assert.deepEqual(await service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send }), { sent: 1 });
  assert.deepEqual(relay.alerts[0]!.destination, { subscriptionId, version: 1, platform: "ios", environment: "production", providerToken: apnsToken });
  await service.send({ userId: bob.userId, spaceId: bob.spaceId, ...send });
  assert.equal(relay.alerts.length, 1);
  allowed = false;
  const restarted = createNativePushService({ file: persisted, relay, authority });
  assert.deepEqual(await restarted.send({ userId: alice.userId, spaceId: alice.spaceId, ...send }), { sent: 0 });
  assert.equal(relay.alerts.length, 1, "a revoked device is not sent to");
});

test("Android registers its FCM token the same way and always goes through the push service", async () => {
  const relay = new FakeSender();
  const apns = new FakeSender();
  const service = createNativePushService({ file: file(), relay, apns: () => apns, authority: () => ({ hostEndpointId: async () => "host", validate: async () => true }) });
  await assert.rejects(service.register({ ...alice, subscriptionId, providerToken: fcmToken, environment: "production", platform: "android" }), { code: "invalid-input" });
  await assert.rejects(service.register({ ...alice, subscriptionId, providerToken: fcmToken, environment: undefined, platform: "windows" }), { code: "invalid-input" });
  await assert.rejects(service.register({ ...alice, subscriptionId, providerToken: fcmToken, environment: "production" }), { code: "invalid-input" }, "an iOS token is hex");
  await service.register({ ...alice, subscriptionId, providerToken: fcmToken, environment: undefined, platform: "android" });
  await service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send });
  assert.deepEqual(relay.alerts[0]!.destination, { subscriptionId, version: 1, platform: "android", providerToken: fcmToken });
  // iOS uses the server's own APNs key when its owner placed one.
  await service.register({ ...bob, userId: alice.userId, spaceId: alice.spaceId, subscriptionId, providerToken: apnsToken, environment: "sandbox" });
  await service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send });
  assert.equal(apns.alerts.length, 1);
  assert.equal(relay.alerts.length, 2);
});

test("the push service gets only the token and a payload without words, never follows a redirect, and its answer is classified", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let reply: () => Response = () => new Response(JSON.stringify({ result: "permanent" }), { status: 200 });
  const sender = relaySender("http://127.0.0.1:8787", async (url, init) => { calls.push({ url: String(url), init: init! }); return reply(); })!;
  const ios: Destination = { subscriptionId, version: 1, platform: "ios", environment: "production", providerToken: apnsToken };
  const alert: DeliveryInput = { version: 1, subscriptionId, notificationId: "n-1", kind: "completed", tag: "t" };
  assert.equal(await sender.deliver(ios, alert), "permanent");
  assert.equal(calls[0]!.url, "http://127.0.0.1:8787/v1/send");
  assert.equal(calls[0]!.init.redirect, "error");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { to: { platform: "ios", token: apnsToken, environment: "production" }, alert });
  const activity: ActivityInput = { event: "update", state: "working", waiting: 0, working: 1, staleAt: 2, urgent: true };
  await sender.deliverActivity({ ...ios, channel: "liveactivity" }, activity);
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { to: { platform: "ios", token: apnsToken, environment: "production" }, activity });
  await sender.deliver({ subscriptionId, version: 1, platform: "android", providerToken: fcmToken }, alert);
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)).to, { platform: "android", token: fcmToken });

  reply = () => new Response("{}", { status: 429 });
  assert.equal(await sender.deliver(ios, alert), "rate");
  reply = () => new Response("{}", { status: 400 });
  assert.equal(await sender.deliver(ios, alert), "invalid");
  reply = () => new Response(JSON.stringify({ result: "owned" }), { status: 200 });
  assert.equal(await sender.deliver(ios, alert), "transient");
  reply = () => { throw new TypeError("redirect"); };
  assert.equal(await sender.deliver(ios, alert), "transient");

  assert.equal(PUSH_SERVICE_ORIGIN, "https://push.polyth.app");
  assert.ok(relaySender(undefined), "unset means Polyth's service");
  assert.ok(relaySender(""), "empty means Polyth's service");
  assert.equal(relaySender("off"), undefined);
  assert.equal(relaySender("http://push.example.com"), undefined, "plain http only on loopback");
  assert.equal(relaySender("https://push.example.com/path"), undefined);
});

test("account removal drops its devices; relay-claim entries from older servers are dropped on load", async () => {
  const persisted = file();
  const relay = new FakeSender();
  const authority = () => ({ hostEndpointId: async () => "host-endpoint", validate: async () => true });
  const service = createNativePushService({ file: persisted, relay, authority });
  await service.register({ ...alice, subscriptionId, providerToken: apnsToken, environment: "production" });
  assert.equal(await service.removeAccount(alice.userId), 1);
  assert.deepEqual(await service.status(alice), { enabled: true, subscribed: false });

  const stored = JSON.parse(readFileSync(persisted, "utf8"));
  stored.subscriptions = [{ ...alice, hostEndpointId: "host-endpoint", subscriptionId, relayId: "https://relay.example", senderToken: "b".repeat(43), createdAt: 1, updatedAt: 1 }];
  writeFileSync(persisted, JSON.stringify(stored));
  const loaded = createNativePushService({ file: persisted, relay, authority });
  assert.deepEqual(await loaded.status(alice), { enabled: true, subscribed: false });
  assert.deepEqual(await loaded.send({ userId: alice.userId, spaceId: alice.spaceId, ...send }), { sent: 0 });
});
