import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  ApnsProvider, type ApnsRequest, type ApnsTransport, FcmProvider, type FcmRequest, type FcmTransport,
  FetchFcmTransport, ProviderTransportError, ServiceAccountAccessTokenProvider,
} from "../src/index.ts";
import type { DeliveryInput, Destination, ProviderReply } from "../src/types.ts";

const message: DeliveryInput = { version: 1, subscriptionId: "sub_abcdefghijklmnopqrstuv", notificationId: "bbbeeeee-1111-4222-8333-444444444444", kind: "permission", tag: "tag_opaque" };
const ios: Destination = { subscriptionId: message.subscriptionId, version: 1, platform: "ios", environment: "sandbox", providerToken: "a".repeat(64) };
const android: Destination = { subscriptionId: message.subscriptionId, version: 1, platform: "android", providerToken: "fcm:opaque-token-abcdefghijklmnopqrstuvwxyz" };

class ApnsFake implements ApnsTransport {
  calls: ApnsRequest[] = [];
  replies: Array<ProviderReply | Error> = [];
  async send(request: ApnsRequest): Promise<ProviderReply> {
    this.calls.push(request);
    const next = this.replies.shift() ?? { status: 200 };
    if (next instanceof Error) throw next;
    return next;
  }
}

class FcmFake implements FcmTransport {
  calls: FcmRequest[] = [];
  reply: ProviderReply = { status: 200 };
  async send(request: FcmRequest): Promise<ProviderReply> { this.calls.push(request); return this.reply; }
}

test("APNs uses ES256 token auth, fixed sandbox origin, generic alert, permanent/auth/transient classes, and one GOAWAY retry", async () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const fake = new ApnsFake();
  let now = 1_700_000_000;
  const provider = new ApnsProvider({ teamId: "TEAM123", keyId: "KEY123", p8: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), topic: "com.polyth.app", transport: fake, nowSeconds: () => now });
  assert.equal(await provider.deliver(ios, message), "success");
  const first = fake.calls[0]!;
  assert.equal(first.origin, "https://api.sandbox.push.apple.com");
  assert.equal(first.headers["apns-topic"], "com.polyth.app");
  assert.equal(first.headers["apns-priority"], "10");
  assert.match(first.headers.authorization!, /^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(first.body), {
    aps: { alert: { title: "Polyth", body: "A task needs permission" }, sound: "default" },
    version: 1,
    subscriptionId: message.subscriptionId,
    notificationId: message.notificationId,
    kind: "permission",
    tag: message.tag,
  });
  const token = first.headers.authorization;
  await provider.deliver(ios, message);
  assert.equal(fake.calls[1]!.headers.authorization, token, "token is cached before one hour");
  now += 56 * 60;
  await provider.deliver(ios, message);
  assert.notEqual(fake.calls[2]!.headers.authorization, token, "token rotates before one hour");
  fake.replies.push({ status: 400, reason: "BadDeviceToken" });
  assert.equal(await provider.deliver(ios, message), "permanent");
  fake.replies.push({ status: 401 });
  assert.equal(await provider.deliver(ios, message), "auth");
  fake.replies.push({ status: 500 });
  assert.equal(await provider.deliver(ios, message), "transient");
  fake.replies.push(new ProviderTransportError("goaway"), { status: 200 });
  const before = fake.calls.length;
  assert.equal(await provider.deliver(ios, message), "success");
  assert.equal(fake.calls.length - before, 2);
});

test("FCM uses HTTP v1 only, caches access tokens, selects stable channels, and classifies provider responses", async () => {
  let tokens = 0;
  const fake = new FcmFake();
  const provider = new FcmProvider({
    project: "polyth-project",
    accessTokenProvider: { async getAccessToken() { tokens++; return { accessToken: "access-token", expiresAt: Date.now() + 3_600_000 }; } },
    transport: fake,
  });
  assert.equal(await provider.deliver(android, message), "success");
  assert.match(fake.calls[0]!.url, /^https:\/\/fcm\.googleapis\.com\/v1\/projects\/polyth-project\/messages:send$/);
  const payload = JSON.parse(fake.calls[0]!.body).message;
  assert.deepEqual(payload.android, {
    ttl: "300s",
    notification: { channel_id: "polyth_attention", tag: message.tag },
  });
  assert.deepEqual(payload.data, {
    version: "1",
    subscriptionId: message.subscriptionId,
    notificationId: message.notificationId,
    kind: "permission",
    tag: message.tag,
  });
  assert.equal(tokens, 1);
  fake.reply = { status: 404, reason: "UNREGISTERED" };
  assert.equal(await provider.deliver(android, message), "permanent");
  fake.reply = { status: 400, reason: "INVALID_ARGUMENT" };
  assert.equal(await provider.deliver(android, message), "permanent");
  fake.reply = { status: 401, reason: "UNAUTHENTICATED" };
  assert.equal(await provider.deliver(android, message), "auth");
  fake.reply = { status: 429, reason: "RESOURCE_EXHAUSTED" };
  assert.equal(await provider.deliver(android, message), "rate");
  fake.reply = { status: 503, reason: "UNAVAILABLE" };
  assert.equal(await provider.deliver(android, message), "transient");
  assert.equal(tokens, 1, "cached access token avoids repeated OAuth work");
});

test("FCM and OAuth retain an unconditional deadline when ingress supplies a live signal", async () => {
  const external = new AbortController();
  const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as typeof fetch;
  const fcmStarted = Date.now();
  await assert.rejects(
    new FetchFcmTransport(20, hangingFetch).send({ url: "https://fcm.googleapis.com/v1/projects/p/messages:send", bearer: "token", body: "{}", signal: external.signal }),
    (error: unknown) => error instanceof ProviderTransportError && error.code === "network",
  );
  assert.ok(Date.now() - fcmStarted < 500);

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const oauth = new ServiceAccountAccessTokenProvider({
    serviceAccountJson: JSON.stringify({
      client_email: "relay@example.invalid",
      private_key: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    fetchFn: hangingFetch,
    timeoutMs: 20,
  });
  const oauthStarted = Date.now();
  await assert.rejects(oauth.getAccessToken(external.signal));
  assert.ok(Date.now() - oauthStarted < 500);
  assert.equal(external.signal.aborted, false, "the independent deadline does not mutate the ingress signal");
});
