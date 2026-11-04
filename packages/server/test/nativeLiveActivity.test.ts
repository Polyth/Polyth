import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ActivityInput, DeliveryInput, Destination, ProviderClass } from "@polyth/push-relay";
import {
  apnsFromDir, apnsKeyPem, createNativePushService, LIVE_ACTIVITY_HEARTBEAT_MS, liveActivityState, nativePushRoutes,
  type LiveActivityView, type PushSender,
} from "../src/nativePush.ts";

const alice = { userId: "usr_alice", spaceId: "sp_alice", deviceId: "dev_alice", deviceEndpointId: "end_alice" };
const token = "ab".repeat(32);
const activityToken = "cd".repeat(80);
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-native-la-"));
  dirs.push(dir);
  return dir;
};

class FakeApns implements PushSender {
  alerts: Array<{ destination: Destination; input: DeliveryInput }> = [];
  activity: Array<{ destination: Destination; input: ActivityInput }> = [];
  result: ProviderClass | (() => Promise<ProviderClass>) = "success";
  async deliver(destination: Destination, input: DeliveryInput): Promise<ProviderClass> {
    this.alerts.push({ destination, input });
    return typeof this.result === "function" ? this.result() : this.result;
  }
  async deliverActivity(destination: Destination, input: ActivityInput): Promise<ProviderClass> {
    this.activity.push({ destination, input });
    return typeof this.result === "function" ? this.result() : this.result;
  }
}

function setup(views: Map<string, LiveActivityView>, file = join(tempDir(), "native-push.json")) {
  let now = 1_800_000_000_000;
  const apns = new FakeApns();
  let configured = true;
  const service = createNativePushService({
    file, now: () => now,
    apns: () => configured ? apns : undefined,
    authority: () => ({ hostEndpointId: async () => "host-endpoint", validate: async (input) => input.userId === alice.userId }),
    // Only chats this person can read are returned at all.
    activityViews: async (account, ids) => new Map(account.userId === alice.userId ? ids.flatMap((id) => views.has(id) ? [[id, views.get(id)!] as const] : []) : []),
  });
  return {
    service, apns, file, tick: (ms: number) => { now += ms; }, at: () => now,
    unconfigure: () => { configured = false; },
    pushed: () => apns.activity.map((call) => call.input),
  };
}

const working = (at: number): LiveActivityView => ({ status: "working", lastTurnAt: at, updatedAt: at });
const register = (t: ReturnType<typeof setup>) => t.service.registerActivity({ ...alice, providerToken: activityToken, environment: "production" });

test("the island state mirrors the navigator's: approval, reply, working, then failed or done", () => {
  assert.equal(liveActivityState({ status: "working", updatedAt: 1, attention: { questions: 1, permissions: 1 } }), "needs-approval");
  assert.equal(liveActivityState({ status: "working", updatedAt: 1, attention: { questions: 1, permissions: 0 } }), "needs-reply");
  assert.equal(liveActivityState({ status: "waiting", updatedAt: 1 }), "needs-reply");
  assert.equal(liveActivityState({ status: "idle", updatedAt: 1, backgroundWork: { workflow: 1 } }), "working");
  assert.equal(liveActivityState({ status: "failed", updatedAt: 1 }), "failed");
  // A limit pause resends by itself: not a failure.
  assert.equal(liveActivityState({ status: "failed", updatedAt: 1, resume: { resumeAt: 2, scope: "account" } as LiveActivityView["resume"] }), "done");
  assert.equal(liveActivityState({ status: "archived", updatedAt: 1 }), "done");
  assert.equal(liveActivityState(undefined), "done");
});

test("a tracked island is pushed its state changes, heartbeats while live, and ends when nothing is live", async () => {
  const views = new Map<string, LiveActivityView>();
  const t = setup(views);
  const start = t.at() - 30_000;
  views.set("chat-a", working(start));
  views.set("chat-b", working(start));
  assert.deepEqual(await t.service.activityStatus(alice), { enabled: true, subscribed: false });
  await register(t);
  assert.deepEqual(await t.service.activityStatus(alice), { enabled: true, subscribed: true });
  const shown = { state: "working", startedAt: start, waiting: 0, working: 1 };
  assert.deepEqual(await t.service.trackActivity({ ...alice, track: { sessionId: "chat-a", others: ["chat-b"], shown } }), { tracked: true });
  // What the device shows is current: nothing to push.
  await t.service.flushActivities();
  assert.equal(t.pushed().length, 0);

  // A question arrives while the phone sleeps.
  views.set("chat-a", { ...working(start), attention: { questions: 1, permissions: 0 } });
  await t.service.flushActivities();
  assert.deepEqual(t.apns.activity[0]!.destination, {
    subscriptionId: "live-activity", version: 1, platform: "ios", environment: "production", channel: "liveactivity", providerToken: activityToken,
  });
  // No words ever reach APNs.
  assert.deepEqual(t.pushed()[0], { event: "update", state: "needs-reply", waiting: 0, working: 1, staleAt: Math.floor(t.at() / 1000) + 600, urgent: true });

  // Unchanged: only a low-priority heartbeat once it is due.
  t.tick(LIVE_ACTIVITY_HEARTBEAT_MS - 1_000);
  await t.service.flushActivities();
  assert.equal(t.pushed().length, 1);
  t.tick(2_000);
  await t.service.flushActivities();
  assert.equal(t.pushed()[1]?.urgent, false);
  assert.equal(t.pushed()[1]?.state, "needs-reply");

  // Answered from the PC: working again, with the timer start in seconds.
  views.set("chat-a", working(start));
  await t.service.flushActivities();
  assert.equal(t.pushed()[2]?.state, "working");
  assert.equal(t.pushed()[2]?.startedAt, Math.floor(start / 1000));

  // The focus finishes while another chat still works: an update, not an end.
  views.set("chat-a", { status: "idle", updatedAt: t.at() });
  await t.service.flushActivities();
  assert.equal(t.pushed()[3]?.event, "update");
  assert.equal(t.pushed()[3]?.state, "done");
  // Then the other one: the activity ends and stays briefly.
  views.set("chat-b", { status: "idle", updatedAt: t.at() });
  await t.service.flushActivities();
  assert.equal(t.pushed()[4]?.event, "end");
  assert.equal(t.pushed()[4]?.dismissAt, Math.floor(t.at() / 1000) + 600);
  // Nothing tracked any more.
  t.tick(LIVE_ACTIVITY_HEARTBEAT_MS * 2);
  await t.service.flushActivities();
  assert.equal(t.pushed().length, 5);
  t.service.close();
});

test("only a readable chat is tracked, a chat that becomes unreadable ends at once, and a dead token is dropped", async () => {
  const views = new Map<string, LiveActivityView>();
  const t = setup(views);
  views.set("chat-a", working(t.at()));
  await register(t);
  const shown = { state: "working", startedAt: t.at(), waiting: 0, working: 0 };
  assert.deepEqual(await t.service.trackActivity({ ...alice, track: { sessionId: "foreign", others: [], shown } }), { tracked: false });
  await assert.rejects(t.service.trackActivity({ ...alice, track: { sessionId: "chat-a", others: ["chat-a"], shown } }), { code: "invalid-input" });
  await assert.rejects(t.service.trackActivity({ ...alice, track: { sessionId: "chat-a", others: [], shown: { ...shown, state: "Reply needed" } } }), { code: "invalid-input" });
  await assert.rejects(t.service.registerActivity({ ...alice, providerToken: "not hex", environment: "production" }), { code: "invalid-input" });
  assert.deepEqual(await t.service.trackActivity({ ...alice, track: { sessionId: "chat-a", others: [], shown } }), { tracked: true });
  views.delete("chat-a");
  await t.service.flushActivities();
  assert.equal(t.pushed()[0]?.event, "end");
  assert.equal(t.pushed()[0]?.dismissAt, Math.floor(t.at() / 1000), "a chat that is gone leaves at once");

  // APNs retired the token: that activity is over.
  views.set("chat-a", working(t.at()));
  await register(t);
  await t.service.trackActivity({ ...alice, track: { sessionId: "chat-a", others: [], shown } });
  views.set("chat-a", { status: "idle", updatedAt: t.at() });
  t.apns.result = "permanent";
  await t.service.flushActivities();
  assert.deepEqual(await t.service.activityStatus(alice), { enabled: true, subscribed: false });
  assert.deepEqual(await t.service.trackActivity({ ...alice, track: { sessionId: "chat-a", others: [], shown } }), { tracked: false });
  t.service.close();
});

test("without this server's APNs key nothing registers or sends", async () => {
  const t = setup(new Map([["chat-a", working(1_800_000_000_000)]]));
  t.unconfigure();
  assert.deepEqual(await t.service.activityStatus(alice), { enabled: false, subscribed: false });
  await assert.rejects(register(t), { code: "unavailable" });
  t.service.close();
});

test("tracking survives a restart and the device's end stops further pushes", async () => {
  const views = new Map<string, LiveActivityView>([["chat-a", working(1_800_000_000_000)]]);
  const first = setup(views);
  await register(first);
  await first.service.trackActivity({ ...alice, track: { sessionId: "chat-a", others: [], shown: { state: "working", startedAt: 1_800_000_000_000, waiting: 0, working: 0 } } });
  first.service.close();
  const second = setup(views, first.file);
  views.set("chat-a", { status: "failed", updatedAt: second.at() });
  await second.service.flushActivities();
  assert.equal(second.pushed()[0]?.event, "end");
  assert.equal(second.pushed()[0]?.state, "failed");

  views.set("chat-a", working(second.at()));
  await second.service.trackActivity({ ...alice, track: { sessionId: "chat-a", others: [], shown: { state: "working", startedAt: second.at(), waiting: 0, working: 0 } } });
  assert.equal(await second.service.untrackActivity(alice), true);
  views.set("chat-a", { status: "idle", updatedAt: second.at() });
  await second.service.flushActivities();
  assert.equal(second.pushed().length, 1);
  second.service.close();
});

test("a push answered after the device named another chat leaves the new track untouched", async () => {
  const views = new Map<string, LiveActivityView>([["chat-a", working(1_800_000_000_000)], ["chat-b", working(1_800_000_000_000)]]);
  const t = setup(views);
  await register(t);
  await t.service.trackActivity({ ...alice, track: { sessionId: "chat-a", others: [], shown: { state: "working", startedAt: 1_800_000_000_000, waiting: 0, working: 0 } } });
  views.set("chat-a", { ...working(1_800_000_000_000), attention: { questions: 1, permissions: 0 } });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.apns.result = () => gate.then(() => "success" as const);
  const inFlight = t.service.flushActivities();
  await new Promise((resolve) => setImmediate(resolve));
  // Meanwhile the page moved the island to another chat.
  await t.service.trackActivity({ ...alice, track: { sessionId: "chat-b", others: [], shown: { state: "working", startedAt: 1_800_000_000_000, waiting: 0, working: 0 } } });
  release();
  await inFlight;
  t.apns.result = "success";
  // chat-b's track still holds what the page showed: nothing to push for it.
  await t.service.flushActivities();
  assert.deepEqual(t.pushed().map((input) => input.state), ["needs-reply"]);
  t.service.close();
});

test("with the app's own APNs key, a phone registered over Link gets alerts straight from this server, and a retired token is dropped", async () => {
  const t = setup(new Map());
  assert.deepEqual(await t.service.status(alice), { enabled: true, subscribed: false });
  const subscriptionId = `sub_${"d".repeat(22)}`;
  await assert.rejects(t.service.register({ ...alice, subscriptionId, providerToken: token, environment: "staging" }), { code: "invalid-input" });
  assert.deepEqual(await t.service.register({ ...alice, subscriptionId, providerToken: token, environment: "sandbox" }), { subscriptionId });
  assert.deepEqual(await t.service.status(alice), { enabled: true, subscribed: true, subscriptionId });
  assert.deepEqual(await t.service.send({ ...alice, notificationId: "n-1", kind: "completed", transitionKey: "s:turn:idle", title: "Docs", body: "Done" }), { sent: 1 });
  assert.deepEqual(t.apns.alerts[0]!.destination, { subscriptionId, version: 1, platform: "ios", environment: "sandbox", providerToken: token });
  assert.equal(t.apns.alerts[0]!.input.subscriptionId, subscriptionId);
  t.apns.result = "permanent";
  assert.deepEqual(await t.service.send({ ...alice, notificationId: "n-2", kind: "completed", transitionKey: "s:turn:idle" }), { sent: 0 });
  assert.deepEqual(await t.service.status(alice), { enabled: true, subscribed: false });
  t.service.close();
});

test("the APNs key is read from the data dir, accepted flattened onto one line, and re-read when it changes", () => {
  const dir = tempDir();
  const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.equal(apnsKeyPem(pem.replace(/\n/g, "")), pem);
  assert.equal(apnsKeyPem(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "")), pem);
  assert.equal(apnsKeyPem("not a key"), undefined);
  const made: unknown[] = [];
  const load = apnsFromDir(dir, (options) => { made.push(options); return new FakeApns(); });
  assert.equal(load(), undefined, "no files, no direct push");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "apns.json"), JSON.stringify({ teamId: "ABCDE12345", keyId: "KEY1234567" }));
  writeFileSync(join(dir, "apns.p8"), pem.replace(/\n/g, " "));
  const sender = load();
  assert.ok(sender);
  assert.equal(load(), sender, "unchanged files keep the sender");
  assert.deepEqual(made, [{ teamId: "ABCDE12345", keyId: "KEY1234567", p8: pem, topic: "com.polyth.mobile" }]);
  writeFileSync(join(dir, "apns.json"), JSON.stringify({ teamId: "bad", keyId: "KEY1234567" }));
  utimesSync(join(dir, "apns.json"), new Date(), new Date(Date.now() + 5_000));
  assert.equal(load(), undefined, "an unusable config turns direct push off");
});

test("the Live Activity routes are paired-device only and scoped to the caller's account", async () => {
  const t = setup(new Map([["chat-a", working(1_800_000_000_000)]]));
  const routes = nativePushRoutes(t.service);
  const call = async (method: string, principal: Record<string, unknown>, body: Record<string, unknown> = {}, path = "/api/native-push/live-activity") => {
    let out: { status: number; body: unknown } | undefined;
    await routes({
      path, method, principal, space: { userId: alice.userId, spaceId: alice.spaceId },
      body: async () => body, json: (status: number, value: unknown) => { out = { status, body: value }; },
    } as never);
    return out;
  };
  await assert.rejects(call("GET", { kind: "browser" }), { code: "forbidden" });
  const device = { kind: "paired-device", deviceId: alice.deviceId, deviceEndpointId: alice.deviceEndpointId };
  assert.deepEqual((await call("POST", device, { providerToken: activityToken, environment: "production" }))?.body, { ok: true });
  assert.deepEqual((await call("GET", device))?.body, { enabled: true, subscribed: true });
  assert.deepEqual((await call("PUT", device, { sessionId: "chat-a", others: [], shown: { state: "working", waiting: 0, working: 0 } }))?.body, { tracked: true });
  assert.deepEqual((await call("DELETE", device))?.body, { ok: true });
  const subscriptionId = `sub_${"e".repeat(22)}`;
  assert.deepEqual((await call("POST", device, { subscriptionId, providerToken: token, environment: "production" }, "/api/native-push"))?.body, { subscriptionId });
  t.service.close();
});
