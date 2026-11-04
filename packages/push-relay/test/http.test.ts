import assert from "node:assert/strict";
import test from "node:test";

import { createPushRelay, startRelayHttpServer, type ProviderAdapter, type ProviderClass, type RelayOptions } from "../src/index.ts";
import type { ActivityInput, DeliveryInput, Destination } from "../src/types.ts";

const IOS = "ab".repeat(32);
const FCM = "fcm:opaque-token-abcdefghijklmnopqrstuvwxyz";
const alert = { version: 1, subscriptionId: `sub_${"a".repeat(22)}`, notificationId: "bbbeeeee-1111-4222-8333-444444444444", kind: "completed", tag: "opaque" };
const now = () => Math.floor(Date.now() / 1_000);
const activity = () => ({ event: "update", state: "working", waiting: 1, working: 0, staleAt: now() + 600, urgent: true, startedAt: now() - 30 });

class Provider implements ProviderAdapter {
  sent: Array<{ to: Destination; alert?: DeliveryInput; activity?: ActivityInput }> = [];
  result: ProviderClass = "success";
  async deliver(to: Destination, input: DeliveryInput): Promise<ProviderClass> { this.sent.push({ to, alert: input }); return this.result; }
  async deliverActivity(to: Destination, input: ActivityInput): Promise<ProviderClass> { this.sent.push({ to, activity: input }); return this.result; }
}

async function serverFor(options: Omit<RelayOptions, "providers"> = {}, trustedProxy?: string) {
  const ios = new Provider();
  const android = new Provider();
  const relay = createPushRelay({ ...options, providers: { ios: () => ios, android: () => android } });
  const server = await startRelayHttpServer(relay, { host: "127.0.0.1", port: 0, testMode: true, ...(trustedProxy ? { trustedProxy } : {}) });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    ios, android, url,
    send: (body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/v1/send`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    }),
    close: () => new Promise<void>((resolve) => server.close(() => { relay.close(); resolve(); })),
  };
}

test("only exact alert and Live Activity shapes reach a provider", async () => {
  const setup = await serverFor();
  try {
    assert.equal((await fetch(`${setup.url}/v1/send`, { method: "POST", body: "{}" })).status, 400, "content type");
    const refused = [
      { to: { platform: "ios", token: IOS }, alert },
      { to: { platform: "ios", environment: "production", token: "not-hex" }, alert },
      { to: { platform: "android", environment: "production", token: FCM }, alert },
      { to: { platform: "android", token: FCM }, activity: activity() },
      { to: { platform: "ios", environment: "production", token: IOS }, alert: { ...alert, title: "leak me" } },
      { to: { platform: "ios", environment: "production", token: IOS }, alert: { ...alert, kind: "nonsense" } },
      { to: { platform: "ios", environment: "production", token: IOS }, alert, activity: activity() },
      { to: { platform: "ios", environment: "production", token: IOS } },
      { to: { platform: "ios", environment: "production", token: IOS }, activity: { ...activity(), title: "words" } },
      { to: { platform: "ios", environment: "production", token: IOS }, activity: { ...activity(), waiting: 100 } },
      { to: { platform: "ios", environment: "production", token: IOS }, activity: { ...activity(), staleAt: now() + 3 * 86_400 } },
      { to: { platform: "ios", environment: "production", token: IOS }, extra: 1, alert },
    ];
    for (const body of refused) assert.equal((await setup.send(body)).status, 400, JSON.stringify(body));
    assert.equal(setup.ios.sent.length + setup.android.sent.length, 0);

    const ok = await setup.send({ to: { platform: "ios", environment: "sandbox", token: IOS }, alert: { ...alert, kind: "message", sealed: "abc_-" } });
    assert.deepEqual(await ok.json(), { result: "success" });
    assert.deepEqual(setup.ios.sent[0], {
      to: { subscriptionId: "relay", version: 1, platform: "ios", environment: "sandbox", providerToken: IOS },
      alert: { ...alert, kind: "message", sealed: "abc_-" },
    });
    await setup.send({ to: { platform: "ios", environment: "production", token: IOS }, activity: activity() });
    assert.equal(setup.ios.sent[1]!.to.channel, "liveactivity");
    assert.equal(setup.ios.sent[1]!.activity?.state, "working");
    await setup.send({ to: { platform: "android", token: FCM }, alert });
    assert.equal(setup.android.sent[0]!.to.providerToken, FCM);

    setup.ios.result = "permanent";
    assert.deepEqual(await (await setup.send({ to: { platform: "ios", environment: "production", token: IOS }, alert })).json(), { result: "permanent" });
    assert.deepEqual(await (await fetch(`${setup.url}/v1/health`)).json(), { ok: true });
    assert.equal((await fetch(`${setup.url}/v1/registrations`, { method: "POST" })).status, 404);
  } finally { await setup.close(); }
});

test("a device token and a sender are each rate limited; behind the trusted proxy the forwarded address counts", async () => {
  const perToken = await serverFor({ limits: { perToken: 1 } });
  try {
    const body = { to: { platform: "ios", environment: "production", token: IOS }, alert };
    assert.equal((await perToken.send(body)).status, 200);
    assert.equal((await perToken.send(body)).status, 429);
    assert.equal((await perToken.send({ ...body, to: { ...body.to, token: "cd".repeat(32) } })).status, 200, "another device is unaffected");
  } finally { await perToken.close(); }

  const proxied = await serverFor({ limits: { perSource: 1 } }, "127.0.0.1");
  try {
    const body = (token: string) => ({ to: { platform: "ios", environment: "production", token }, alert });
    assert.equal((await proxied.send(body("01".repeat(32)), { "x-forwarded-for": "198.51.100.7" })).status, 200);
    assert.equal((await proxied.send(body("02".repeat(32)), { "x-forwarded-for": "198.51.100.7" })).status, 429);
    // A spoofed first entry does not dodge the limit: the proxy appends the real peer last.
    assert.equal((await proxied.send(body("03".repeat(32)), { "x-forwarded-for": "203.0.113.9, 198.51.100.7" })).status, 429);
    assert.equal((await proxied.send(body("04".repeat(32)), { "x-forwarded-for": "198.51.100.8" })).status, 200);
  } finally { await proxied.close(); }
});

test("no provider configured is a config result, and the log carries no token or address", async () => {
  const logs: unknown[] = [];
  const relay = createPushRelay({ logger: (event) => logs.push(event) });
  await assert.rejects(startRelayHttpServer(relay, { host: "0.0.0.0", port: 0 }), /TLS/);
  const server = await startRelayHttpServer(relay, { host: "127.0.0.1", port: 0, testMode: true });
  const { port } = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}/v1/send`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: { platform: "android", token: "fcm:raw-secret-destination-abcdefghijklmnopqrstuvwxyz" }, alert }),
  });
  assert.deepEqual(await response.json(), { result: "config" });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  relay.close();
  assert.deepEqual(logs, [{ provider: "android", status: 400, code: "alert", latencyMs: (logs[0] as { latencyMs: number }).latencyMs }]);
  assert.doesNotMatch(JSON.stringify(logs), /raw-secret|127\.0\.0\.1|sub_/);
});
