import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActivityInput, DeliveryInput, Destination } from "@polyth/push-relay";
import { createNativePushService, nativePushRoutes, nativePushTag, PUSH_SERVICE_ORIGIN, relaySender, type PushProbe, type PushSender, type SendResult } from "../src/nativePush.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "polyth-native-push-")), "native-push.json");
const alice = { userId: "usr_alice", spaceId: "sp_alice", deviceId: "dev_alice", deviceEndpointId: "end_alice" };
const bob = { userId: "usr_bob", spaceId: "sp_bob", deviceId: "dev_bob", deviceEndpointId: "end_bob" };
const subscriptionId = `sub_${"c".repeat(22)}`;
const apnsToken = "ab".repeat(32);
const fcmToken = "fcm:opaque-token-abcdefghijklmnopqrstuvwxyz";
const send = { notificationId: "n-1", kind: "completed" as const, transitionKey: "s:turn:idle" };

class FakeSender implements PushSender {
  alerts: Array<{ destination: Destination; input: DeliveryInput }> = [];
  result: SendResult = "success";
  probe?: () => Promise<PushProbe>;
  async deliver(destination: Destination, input: DeliveryInput): Promise<SendResult> { this.alerts.push({ destination, input }); return this.result; }
  async deliverActivity(_destination: Destination, _input: ActivityInput): Promise<SendResult> { return this.result; }
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

test("a send that never reached the push service is retried once, then reported unsent; an uncertain one never; health changes are logged once", async () => {
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
  assert.equal(await sender.deliver(ios, alert), "unsent", "the caller may queue it: it never arrived");
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

test("an alert the push service never received or refused before delivery goes again until its lifetime ends; an uncertain one never", async () => {
  let clock = 1_000_000;
  const relay = new FakeSender();
  const service = createNativePushService({
    file: file(), relay, now: () => clock, retryDelaysMs: [1_000, 10_000],
    authority: () => ({ hostEndpointId: async () => "host", validate: async () => true }),
  });
  try {
    await service.register({ ...alice, subscriptionId, providerToken: apnsToken, environment: "production" });
    relay.result = "unsent";
    assert.deepEqual(await service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send }), { sent: 0 });
    assert.equal((await service.delivery(alice)).pending, 1);
    await service.flushRetries();
    assert.equal(relay.alerts.length, 1, "nothing is due before its delay");
    clock += 1_000;
    await service.flushRetries();
    assert.equal(relay.alerts.length, 2);
    assert.deepEqual(relay.alerts[1]!.input, relay.alerts[0]!.input, "the same alert, same tag");
    // A limit or a missing/rejected credential also proves nothing was shown.
    for (const refusal of ["rate", "config", "auth"] as const) {
      relay.result = refusal;
      clock += 10_000;
      await service.flushRetries();
    }
    assert.equal(relay.alerts.length, 5);
    relay.result = "success";
    clock += 10_000;
    await service.flushRetries();
    assert.equal(relay.alerts.length, 6);
    assert.equal((await service.delivery(alice)).pending, 0, "delivered: no longer waiting");
    clock += 10_000;
    await service.flushRetries();
    assert.equal(relay.alerts.length, 6, "never sent twice");

    // An uncertain failure may already be on the phone: never repeated.
    relay.result = "transient";
    await service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send, notificationId: "n-2", transitionKey: "s:turn:failed" });
    assert.equal((await service.delivery(alice)).pending, 0);

    // A completed-task alert lives an hour: past it, it is dropped unsent.
    relay.result = "unsent";
    await service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send, notificationId: "n-3", transitionKey: "s:turn:idle:2" });
    const before = relay.alerts.length;
    clock += 3_600_000;
    await service.flushRetries();
    assert.equal(relay.alerts.length, before, "too old to show");
    assert.equal((await service.delivery(alice)).pending, 0);

    // A new registration drops what was sealed for the old one.
    await service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send, notificationId: "n-4", transitionKey: "s:turn:idle:3" });
    await service.register({ ...alice, subscriptionId, providerToken: "cd".repeat(32), environment: "production" });
    const sentBefore = relay.alerts.length;
    clock += 1_000;
    await service.flushRetries();
    assert.equal(relay.alerts.length, sentBefore);
  } finally { service.close(); }
});

test("a delivered send wakes what waits for the same route at once", async () => {
  let clock = 1_000_000;
  const relay = new FakeSender();
  const service = createNativePushService({
    file: file(), relay, now: () => clock, retryDelaysMs: [60_000],
    authority: () => ({ hostEndpointId: async () => "host", validate: async () => true }),
  });
  try {
    await service.register({ ...alice, subscriptionId, providerToken: apnsToken, environment: "production" });
    relay.result = "unsent";
    await service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send });
    relay.result = "success";
    await service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send, notificationId: "n-2", transitionKey: "other" });
    await service.flushRetries();
    assert.equal(relay.alerts.length, 3, "the waiting one went with no backoff left");
    assert.equal((await service.delivery(alice)).pending, 0);
  } finally { service.close(); }
});

test("delivery reports the route, the push service's reachability and credentials, and what a send saw", async () => {
  let clock = 1_000_000;
  let probe: PushProbe = { reach: "unsent" };
  let probes = 0;
  const relay = new FakeSender();
  relay.probe = async () => { probes++; return probe; };
  const lines: string[] = [];
  let apns: FakeSender | undefined;
  const service = createNativePushService({
    file: file(), relay, apns: () => apns, now: () => clock, log: (line) => lines.push(line),
    authority: () => ({ hostEndpointId: async () => "host", validate: async (input) => input.userId === alice.userId }),
  });
  try {
    assert.deepEqual(await service.delivery(alice), { phones: 0, route: "service", state: "failing", problem: "unreachable", checkedAt: clock, pending: 0 });
    await service.register({ ...alice, subscriptionId, providerToken: apnsToken, environment: "production" });
    probe = { reach: "ok", credentials: { ios: false, android: true } };
    clock += 61_000;
    assert.deepEqual(await service.delivery(alice), { phones: 1, route: "service", state: "failing", problem: "no-credential", checkedAt: clock, pending: 0 });
    assert.equal(probes, 2);
    await service.delivery(alice);
    assert.equal(probes, 2, "a fresh check is reused");
    // Answering says nothing about a rejected key a send saw.
    relay.result = "auth";
    await service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send });
    probe = { reach: "ok", credentials: { ios: true, android: true } };
    clock += 61_000;
    assert.equal((await service.delivery(alice)).problem, "credential-rejected");
    relay.result = "success";
    await service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send, transitionKey: "next" });
    await service.flushRetries();
    assert.equal((await service.delivery(alice)).state, "ok");
    // An older push service only says it answers.
    probe = { reach: "ok" };
    clock += 61_000;
    assert.equal((await service.delivery(alice)).state, "ok");

    // This server's own APNs key takes iOS over; its health is logged here.
    apns = new FakeSender();
    assert.equal((await service.delivery(alice)).state, "unknown", "no send through it yet");
    apns.result = "config";
    await service.send({ userId: alice.userId, spaceId: alice.spaceId, ...send, transitionKey: "direct" });
    assert.deepEqual(await service.delivery(alice), { phones: 1, route: "direct", state: "failing", problem: "no-credential", checkedAt: clock, pending: 1 });
    assert.match(lines.at(-1)!, /own APNs key is not delivering: no-credential/);
    assert.equal((await service.delivery(bob)).phones, 0, "another person's phones are not counted");

    const off = createNativePushService({ file: file(), authority: () => ({ hostEndpointId: async () => "host", validate: async () => true }) });
    assert.deepEqual(await off.delivery(alice), { phones: 0, route: "none", state: "failing", pending: 0 });
  } finally { service.close(); }
});

test("the relay's reachability check reads /v1/health without following a redirect", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let reply: () => Response = () => new Response(JSON.stringify({ ok: true, ios: true, android: false }), { status: 200 });
  const sender = relaySender("http://127.0.0.1:8787", async (url, init) => { calls.push({ url: String(url), init: init! }); return reply(); }, { log: () => {} })!;
  assert.deepEqual(await sender.probe!(), { reach: "ok", credentials: { ios: true, android: false } });
  assert.equal(calls[0]!.url, "http://127.0.0.1:8787/v1/health");
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.redirect, "error");
  reply = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  assert.deepEqual(await sender.probe!(), { reach: "ok", credentials: {} });
  reply = () => new Response("{}", { status: 503 });
  assert.deepEqual(await sender.probe!(), { reach: "unsent" });
  reply = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }) }); };
  assert.deepEqual(await sender.probe!(), { reach: "unsent" });
  reply = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }) }); };
  assert.deepEqual(await sender.probe!(), { reach: "transient" });
});

test("GET /api/native-push/delivery answers any signed-in principal for its own account; the rest stays paired-device only", async () => {
  const asked: Array<{ userId: string; spaceId: string }> = [];
  const service = { delivery: async (account: { userId: string; spaceId: string }) => { asked.push(account); return { phones: 2, route: "service", state: "ok", pending: 0 }; } };
  const routes = nativePushRoutes(service as never);
  const answers: unknown[] = [];
  const rc = (path: string, method = "GET") => ({
    path, method, principal: { kind: "session" }, space: { userId: alice.userId, spaceId: alice.spaceId },
    json: (_status: number, body: unknown) => { answers.push(body); },
  });
  assert.equal(await routes(rc("/api/native-push/delivery") as never), true);
  assert.deepEqual(asked, [{ userId: alice.userId, spaceId: alice.spaceId }]);
  assert.equal((answers[0] as { phones: number }).phones, 2);
  await assert.rejects(routes(rc("/api/native-push") as never), { code: "forbidden" });
});
