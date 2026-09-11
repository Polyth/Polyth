import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPushRelay, startRelayHttpServer, type ProviderAdapter, type ProviderClass } from "../src/index.ts";
import type { DeliveryInput, Destination } from "../src/types.ts";

const binding = createHash("sha256").update("http-binding").digest("base64url").toLowerCase();
const db = () => join(mkdtempSync(join(tmpdir(), "polyth-relay-http-")), "relay.sqlite");

class Provider implements ProviderAdapter {
  calls = 0;
  async deliver(_destination: Destination, _input: DeliveryInput): Promise<ProviderClass> { this.calls++; return "success"; }
}

async function serverFor(limits?: { registrations?: number; claims?: number; deliveries?: number }) {
  const provider = new Provider();
  const relay = createPushRelay({ file: db(), masterKey: Buffer.alloc(32, 4), providers: { android: provider }, rateLimits: limits });
  const server = await startRelayHttpServer(relay, { host: "127.0.0.1", port: 0, testMode: true });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    relay,
    provider,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      relay.close();
    },
  };
}

const post = (url: string, path: string, body: unknown, token?: string) => fetch(`${url}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

test("HTTP API enforces exact JSON, content type, bounded delivery fields, sender authority, and rate limits", async () => {
  const setup = await serverFor({ deliveries: 1, claims: 3 });
  try {
    const noContentType = await fetch(`${setup.url}/v1/registrations`, { method: "POST", body: "{}" });
    assert.equal(noContentType.status, 400);
    const invalid = await post(setup.url, "/v1/registrations", { platform: "android", providerToken: "fcm:opaque-token-abcdefghijklmnopqrstuvwxyz", binding, environment: "production" });
    assert.equal(invalid.status, 400, "android rejects iOS environment");
    const missingIosEnvironment = await post(setup.url, "/v1/registrations", { platform: "ios", providerToken: "a".repeat(64), binding });
    assert.equal(missingIosEnvironment.status, 400, "iOS requires an APNs environment");
    const created = await post(setup.url, "/v1/registrations", { platform: "android", providerToken: "fcm:opaque-token-abcdefghijklmnopqrstuvwxyz", binding });
    assert.equal(created.status, 201);
    const registration = await created.json() as { subscriptionId: string; claimToken: string; manageToken: string };
    const claim = await post(setup.url, "/v1/claims/redeem", { claimToken: registration.claimToken, binding });
    const sender = await claim.json() as { senderToken: string };
    const badContent = await post(setup.url, "/v1/deliver", {
      version: 1, subscriptionId: registration.subscriptionId, notificationId: "bbbeeeee-1111-4222-8333-444444444444", kind: "completed", tag: "opaque", title: "leak me",
    }, sender.senderToken);
    assert.equal(badContent.status, 400);
    assert.equal(setup.provider.calls, 0);
    const message = { version: 1, subscriptionId: registration.subscriptionId, notificationId: "bbbeeeee-1111-4222-8333-444444444444", kind: "completed", tag: "opaque" };
    assert.equal((await post(setup.url, "/v1/deliver", message, sender.senderToken)).status, 202);
    assert.equal((await post(setup.url, "/v1/deliver", message, sender.senderToken)).status, 429);
    const replay = await post(setup.url, "/v1/claims/redeem", { claimToken: registration.claimToken, binding });
    assert.equal(replay.status, 401);
    const senderDelete = await fetch(`${setup.url}/v1/senders/${registration.subscriptionId}`, { method: "DELETE", headers: { authorization: `Bearer ${sender.senderToken}` } });
    assert.equal(senderDelete.status, 204);
    const rotate = await fetch(`${setup.url}/v1/registrations/${registration.subscriptionId}`, {
      method: "PUT", headers: { authorization: `Bearer ${registration.manageToken}`, "content-type": "application/json" }, body: JSON.stringify({ providerToken: "fcm:rotated-token-abcdefghijklmnopqrstuvwxyz" }),
    });
    assert.equal(rotate.status, 204, "sender revocation did not revoke device management");
    const claimLimited = await post(setup.url, "/v1/registrations", { platform: "android", providerToken: "fcm:claim-limit-token-abcdefghijklmnopqrstuvwxyz", binding });
    const next = await claimLimited.json() as { claimToken: string };
    const wrong = await post(setup.url, "/v1/claims/redeem", { claimToken: "a".repeat(43), binding });
    assert.equal(wrong.status, 401);
    const validAfterDifferentToken = await post(setup.url, "/v1/claims/redeem", { claimToken: next.claimToken, binding });
    assert.equal(validAfterDifferentToken.status, 429, "a random claim token cannot bypass the per-IP ceiling");
  } finally { await setup.close(); }
});

test("production listener requires explicit TLS termination and logger input excludes every request secret", async () => {
  const logs: unknown[] = [];
  const relay = createPushRelay({ file: db(), masterKey: Buffer.alloc(32, 3), providers: { android: new Provider() }, logger: (event) => logs.push(event) });
  await assert.rejects(startRelayHttpServer(relay, { host: "0.0.0.0", port: 0 }), /TLS/);
  const server = await startRelayHttpServer(relay, { host: "127.0.0.1", port: 0, testMode: true });
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const providerToken = "fcm:raw-secret-destination-abcdefghijklmnopqrstuvwxyz";
  const created = await post(url, "/v1/registrations", { platform: "android", providerToken, binding });
  const registration = await created.json() as { subscriptionId: string; claimToken: string; manageToken: string };
  const claimed = await post(url, "/v1/claims/redeem", { claimToken: registration.claimToken, binding });
  const sender = await claimed.json() as { senderToken: string };
  await post(url, "/v1/deliver", { version: 1, subscriptionId: registration.subscriptionId, notificationId: "bbbeeeee-1111-4222-8333-444444444444", kind: "completed", tag: "opaque" }, sender.senderToken);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  relay.close();
  const text = JSON.stringify(logs);
  assert.doesNotMatch(text, /raw-secret|claimToken|manageToken|senderToken/);
});
