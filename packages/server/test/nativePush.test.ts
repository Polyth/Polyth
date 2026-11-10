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

test("a send that never reached the push service is retried once; an uncertain one never; health changes are logged once", async () => {
  const ios: Destination = { subscriptionId, version: 1, platform: "ios", environment: "production", providerToken: apnsToken };
  const alert: DeliveryInput = { version: 1, subscriptionId, notificationId: "n-1", kind: "completed", tag: "t" };
  const lines: string[] = [];
  const replies: Array<() => Response> = [];
  let calls = 0;
  const unsent = (code: string) => () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }); };
  const ok = (result = "success") => () => new Response(JSON.stringify({ result }), { status: 200 });
  const sender = relaySender("http://127.0.0.1:8787", async () => { calls++; return replies.shift()!(); }, { log: (line) => lines.push(line), retryDelayMs: 0 })!;

  replies.push(unsent("ENOTFOUND"), ok());
  assert.equal(await sender.deliver(ios, alert), "success", "DNS failure: retried and delivered");
  assert.equal(calls, 2);
  assert.deepEqual(lines, [], "a recovered retry is not a health change");

  replies.push(unsent("ECONNREFUSED"), unsent("ECONNREFUSED"));
  assert.equal(await sender.deliver(ios, alert), "transient");
  assert.equal(calls, 4, "only one retry");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /not delivering: network ECONNREFUSED/);
  assert.doesNotMatch(lines[0]!, new RegExp(apnsToken), "never logs the token");

  replies.push(unsent("ECONNREFUSED"), unsent("ECONNREFUSED"));
  await sender.deliver(ios, alert);
  assert.equal(lines.length, 1, "the same trouble is reported once");

  for (const reply of [unsent("ECONNRESET"), unsent("UND_ERR_HEADERS_TIMEOUT"), () => new Response("{}", { status: 502 })]) {
    calls = 0;
    replies.push(reply);
    assert.equal(await sender.deliver(ios, alert), "transient");
    assert.equal(calls, 1, "a send the service may have accepted is never repeated");
  }

  calls = 0;
  replies.push(() => new Response("{}", { status: 503 }), ok());
  assert.equal(await sender.deliver(ios, alert), "success", "503 is a refusal before any provider call");
  assert.equal(calls, 2);
  assert.match(lines.at(-1)!, /delivers again/);

  replies.push(ok("config"));
  assert.equal(await sender.deliver(ios, alert), "config");
  assert.match(lines.at(-1)!, /no APNs credential/);
  replies.push(ok("permanent"));
  assert.equal(await sender.deliver(ios, alert), "permanent");
  assert.match(lines.at(-1)!, /delivers again/, "a dead token proves the service works");
});

test("send reaches every device at once: one slow phone does not hold the others", async () => {
  const persisted = file();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delivered: string[] = [];
  const slow = "b".repeat(64);
  const relay: PushSender = {
    async deliver(destination) {
      if (destination.providerToken === slow) await gate;
      delivered.push(destination.providerToken);
      return "success";
    },
    async deliverActivity() { return "success"; },
  };
  const authority = () => ({ hostEndpointId: async () => "host-endpoint", validate: async (input: typeof alice) => input.userId === alice.userId });
  const service = createNativePushService({ file: persisted, relay, authority });
  await service.register({ ...alice, deviceId: "slow-phone", deviceEndpointId: "slow-endpoint", subscriptionId: `sub_${"s".repeat(22)}`, providerToken: slow, environment: "production" });
  await service.register({ ...alice, subscriptionId, providerToken: apnsToken, environment: "production" });
  const sending = service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(delivered, [apnsToken], "the fast phone got it while the slow one is still pending");
  release();
  assert.deepEqual(await sending, { sent: 2 });
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
