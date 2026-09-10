import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createPushRelay, type DeliveryInput, type Destination, type ProviderAdapter, type ProviderClass, RelayFault } from "../src/index.ts";

const MASTER_KEY = Buffer.alloc(32, 7);
const binding = (label = "device"): string => createHash("sha256").update(label).digest("base64url").toLowerCase();
const delivery = (subscriptionId: string): DeliveryInput => ({
  version: 1,
  subscriptionId,
  notificationId: "bbbeeeee-1111-4222-8333-444444444444",
  kind: "completed",
  tag: "opaque_tag_7",
});
const tempFile = (): string => join(mkdtempSync(join(tmpdir(), "polyth-relay-")), "relay.sqlite");

class FakeProvider implements ProviderAdapter {
  calls: Array<{ destination: Destination; input: DeliveryInput }> = [];
  result: ProviderClass = "success";
  pause?: Promise<void>;
  started?: () => void;

  async deliver(destination: Destination, input: DeliveryInput): Promise<ProviderClass> {
    this.calls.push({ destination, input });
    this.started?.();
    await this.pause;
    return this.result;
  }
}

function relay(file: string, android = new FakeProvider(), overrides: Record<string, unknown> = {}) {
  let now = 1_700_000_000_000;
  const instance = createPushRelay({
    file,
    masterKey: MASTER_KEY,
    providers: { android },
    now: () => now,
    ...overrides,
  });
  return { instance, android, tick: (ms: number) => { now += ms; } };
}

function androidRegistration(token = "fcm:opaque-token-abcdefghijklmnopqrstuvwxyz"): Record<string, string> {
  return { platform: "android", providerToken: token, binding: binding() };
}

test("registration persists encrypted data across restart and management rotation keeps the sender identity", async () => {
  const file = tempFile();
  const first = relay(file);
  const registration = first.instance.register(androidRegistration());
  assert.match(registration.subscriptionId, /^sub_[A-Za-z0-9_-]{22}$/);
  assert.match(registration.claimToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(registration.manageToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(registration.claimExpiresAt, 1_700_000_300_000);
  const claimed = first.instance.redeem({ claimToken: registration.claimToken, binding: binding() });
  first.instance.close();

  const afterRestart = relay(file);
  await afterRestart.instance.rotate(registration.subscriptionId, registration.manageToken, { providerToken: "fcm:rotated-token-abcdefghijklmnopqrstuvwxyz" });
  const sent = await afterRestart.instance.deliver(claimed.senderToken, delivery(registration.subscriptionId));
  assert.deepEqual(sent, { status: "accepted", classification: "success" });
  assert.equal(afterRestart.android.calls[0]!.destination.providerToken, "fcm:rotated-token-abcdefghijklmnopqrstuvwxyz");

  const disk = [file, `${file}-wal`].filter(existsSync).map((path) => readFileSync(path));
  for (const bytes of disk) {
    assert.doesNotMatch(bytes.toString("utf8"), /fcm:opaque-token|fcm:rotated-token|"claimToken"|"manageToken"/);
    assert.doesNotMatch(bytes.toString("utf8"), new RegExp(registration.claimToken));
    assert.doesNotMatch(bytes.toString("utf8"), new RegExp(registration.manageToken));
    assert.doesNotMatch(bytes.toString("utf8"), new RegExp(claimed.senderToken));
  }
  afterRestart.instance.close();
});

test("claims are binding-bound, single-use, race-safe, and expiry is opaque", async () => {
  const setup = relay(tempFile());
  const registration = setup.instance.register(androidRegistration());
  assert.throws(() => setup.instance.redeem({ claimToken: registration.claimToken, binding: binding("wrong") }), (error: unknown) => error instanceof RelayFault && error.code === "unauthorized");
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => Promise.resolve().then(() =>
    setup.instance.redeem({ claimToken: registration.claimToken, binding: binding() }),
  )));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of results.filter((result) => result.status === "rejected")) {
    assert.ok((result as PromiseRejectedResult).reason instanceof RelayFault);
    assert.equal((result as PromiseRejectedResult).reason.code, "unauthorized");
  }
  assert.throws(() => setup.instance.redeem({ claimToken: registration.claimToken, binding: binding() }), (error: unknown) => error instanceof RelayFault && error.code === "unauthorized");

  const expiring = setup.instance.register({ ...androidRegistration("fcm:second-abcdefghijklmnopqrstuvwxyz"), binding: binding("second") });
  setup.tick(5 * 60_000);
  assert.throws(() => setup.instance.redeem({ claimToken: expiring.claimToken, binding: binding("second") }), (error: unknown) => error instanceof RelayFault && error.code === "unauthorized");
  setup.instance.close();

  const claimLimited = relay(tempFile(), new FakeProvider(), { rateLimits: { claims: 1 } });
  const limitedRegistration = claimLimited.instance.register(androidRegistration());
  assert.throws(() => claimLimited.instance.redeem({ claimToken: limitedRegistration.claimToken, binding: binding("wrong") }, "first-ip"), (error: unknown) => error instanceof RelayFault && error.code === "unauthorized");
  assert.throws(() => claimLimited.instance.redeem({ claimToken: limitedRegistration.claimToken, binding: binding() }, "second-ip"), (error: unknown) => error instanceof RelayFault && error.code === "rate");
  claimLimited.instance.close();
});

test("sender caps cannot cross subscriptions, sender revoke leaves registration managed, and permanent cleanup is version-safe", async () => {
  const setup = relay(tempFile());
  const one = setup.instance.register(androidRegistration());
  const two = setup.instance.register({ ...androidRegistration("fcm:two-token-abcdefghijklmnopqrstuvwxyz"), binding: binding("two") });
  const sender = setup.instance.redeem({ claimToken: one.claimToken, binding: binding() });
  await assert.rejects(setup.instance.deliver(sender.senderToken, delivery(two.subscriptionId)), (error: unknown) => error instanceof RelayFault && error.code === "unauthorized");
  await setup.instance.revokeSender(one.subscriptionId, sender.senderToken);
  await assert.rejects(setup.instance.deliver(sender.senderToken, delivery(one.subscriptionId)), (error: unknown) => error instanceof RelayFault && error.code === "unauthorized");
  await setup.instance.rotate(one.subscriptionId, one.manageToken, { providerToken: "fcm:managed-after-sender-revoke-abcdefghijklmnopqrstuvwxyz" });

  const three = setup.instance.register({ ...androidRegistration("fcm:three-token-abcdefghijklmnopqrstuvwxyz"), binding: binding("three") });
  const thirdSender = setup.instance.redeem({ claimToken: three.claimToken, binding: binding("three") });
  setup.android.result = "permanent";
  assert.deepEqual(await setup.instance.deliver(thirdSender.senderToken, delivery(three.subscriptionId)), { status: "accepted", classification: "permanent" });
  await assert.rejects(setup.instance.deliver(thirdSender.senderToken, delivery(three.subscriptionId)), (error: unknown) => error instanceof RelayFault && error.code === "unauthorized");
  await setup.instance.rotate(three.subscriptionId, three.manageToken, { providerToken: "fcm:replacement-after-permanent-abcdefghijklmnopqrstuvwxyz" });
  setup.android.result = "success";
  assert.deepEqual(await setup.instance.deliver(thirdSender.senderToken, delivery(three.subscriptionId)), { status: "accepted", classification: "success" });
  setup.instance.close();

  const rateSetup = relay(tempFile(), new FakeProvider(), { rateLimits: { deliveries: 1 } });
  const rateFirst = rateSetup.instance.register(androidRegistration());
  const rateSecond = rateSetup.instance.register({ ...androidRegistration("fcm:rate-second-abcdefghijklmnopqrstuvwxyz"), binding: binding("rate-second") });
  const firstRateSender = rateSetup.instance.redeem({ claimToken: rateFirst.claimToken, binding: binding() });
  const secondRateSender = rateSetup.instance.redeem({ claimToken: rateSecond.claimToken, binding: binding("rate-second") });
  await rateSetup.instance.deliver(firstRateSender.senderToken, delivery(rateFirst.subscriptionId));
  await assert.rejects(rateSetup.instance.deliver(firstRateSender.senderToken, delivery(rateSecond.subscriptionId)), (error: unknown) => error instanceof RelayFault && error.code === "rate");
  await assert.rejects(rateSetup.instance.deliver(secondRateSender.senderToken, delivery(rateFirst.subscriptionId)), (error: unknown) => error instanceof RelayFault && error.code === "rate");
  rateSetup.instance.close();
});

test("delivery and revocation serialize deterministically", async () => {
  const provider = new FakeProvider();
  let release: (() => void) | undefined;
  provider.pause = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { provider.started = resolve; });
  const setup = relay(tempFile(), provider);
  const registration = setup.instance.register(androidRegistration());
  const sender = setup.instance.redeem({ claimToken: registration.claimToken, binding: binding() });
  const inFlight = setup.instance.deliver(sender.senderToken, delivery(registration.subscriptionId));
  await started;
  const revocation = setup.instance.revoke(registration.subscriptionId, registration.manageToken);
  let revoked = false;
  void revocation.then(() => { revoked = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(revoked, false, "revocation waits for a begun send in this relay process");
  release?.();
  assert.deepEqual(await inFlight, { status: "accepted", classification: "success" });
  await revocation;
  await assert.rejects(setup.instance.deliver(sender.senderToken, delivery(registration.subscriptionId)), (error: unknown) => error instanceof RelayFault && error.code === "unauthorized");
  setup.instance.close();
});

test("wrong-key, corrupt, and cross-row ciphertext fail closed without secret-bearing logs", async () => {
  const file = tempFile();
  const logs: unknown[] = [];
  const setup = relay(file, new FakeProvider(), { logger: (event: unknown) => logs.push(event) });
  const registration = setup.instance.register(androidRegistration("fcm:very-secret-destination-abcdefghijklmnopqrstuvwxyz"));
  const sender = setup.instance.redeem({ claimToken: registration.claimToken, binding: binding() });
  const other = setup.instance.register({
    ...androidRegistration("fcm:other-secret-destination-abcdefghijklmnopqrstuvwxyz"),
    binding: binding("other-cipher-row"),
  });
  const otherSender = setup.instance.redeem({ claimToken: other.claimToken, binding: binding("other-cipher-row") });
  setup.instance.close();
  const wrong = createPushRelay({ file, masterKey: Buffer.alloc(32, 9), logger: (event) => logs.push(event) });
  await assert.rejects(wrong.deliver(sender.senderToken, delivery(registration.subscriptionId)), (error: unknown) => error instanceof RelayFault && error.code === "storage");
  wrong.close();
  let raw = new DatabaseSync(file);
  const firstCipher = raw.prepare("SELECT token_nonce, token_cipher, token_tag FROM subscriptions WHERE id = ?")
    .get(registration.subscriptionId) as { token_nonce: Uint8Array; token_cipher: Uint8Array; token_tag: Uint8Array };
  raw.prepare("UPDATE subscriptions SET token_nonce = ?, token_cipher = ?, token_tag = ? WHERE id = ?")
    .run(firstCipher.token_nonce, firstCipher.token_cipher, firstCipher.token_tag, other.subscriptionId);
  raw.close();
  const swapped = relay(file, new FakeProvider(), { logger: (event: unknown) => logs.push(event) });
  await assert.rejects(swapped.instance.deliver(otherSender.senderToken, delivery(other.subscriptionId)), (error: unknown) => error instanceof RelayFault && error.code === "storage");
  swapped.instance.close();
  raw = new DatabaseSync(file);
  raw.prepare("UPDATE subscriptions SET token_tag = ? WHERE id = ?").run(Buffer.alloc(16), registration.subscriptionId);
  raw.close();
  const corrupted = relay(file, new FakeProvider(), { logger: (event: unknown) => logs.push(event) });
  await assert.rejects(corrupted.instance.deliver(sender.senderToken, delivery(registration.subscriptionId)), (error: unknown) => error instanceof RelayFault && error.code === "storage");
  corrupted.instance.close();
  const output = JSON.stringify(logs);
  assert.doesNotMatch(output, /very-secret|other-secret|claimToken|senderToken|manageToken/);
});
