// F18 web push: the aes128gcm body decrypts on a simulated browser receiver
// (RFC 8291), the VAPID JWT verifies against the advertised public key
// (RFC 8292), payloads stay bounded and control-stripped, subscriptions
// persist and validate, dead endpoints (410) drop on send, and the notifier
// attributes subagent completions to the parent while aborts stay silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes,
  verify as cryptoVerify,
} from "node:crypto";

import type { SessionProjection } from "@polyth/contracts";
import {
  b64u, b64uDecode, buildPushPayload, createPushNotifier, createPushService,
  encryptWebPush, generateVapidKeys, vapidAuthorization, type PushPayload,
} from "../src/push.ts";

// A fake browser subscription: real P-256 keypair + 16-byte auth secret.
function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    ecdh,
    p256dh: b64u(ecdh.getPublicKey()),
    authSecret: randomBytes(16),
  };
}

/** RFC 8291 receiver side — what the push service in the browser does. */
function decryptWebPush(ecdh: ReturnType<typeof createECDH>, authSecret: Buffer, body: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);

  const shared = ecdh.computeSecret(asPublic);
  const prkInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, prkInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const de = createDecipheriv("aes-128-gcm", cek, nonce);
  de.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([de.update(sealed.subarray(0, sealed.length - 16)), de.final()]);
  // Strip the record delimiter: trailing zeros then the 0x02 marker.
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  assert.equal(padded[end - 1], 2, "record must end with the 0x02 delimiter");
  return padded.subarray(0, end - 1);
}

test("encryptWebPush round-trips through an RFC 8291 receiver", () => {
  const { ecdh, p256dh, authSecret } = browserKeys();
  const msg = Buffer.from(JSON.stringify({ hello: "push", n: 42 }));
  const body = encryptWebPush(p256dh, b64u(authSecret), msg);

  // Header sanity: salt(16) ‖ rs(4)=4096 ‖ idlen(1)=65 ‖ point(65).
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(body[20], 65);
  assert.equal(body[21], 0x04);

  assert.deepEqual(decryptWebPush(ecdh, authSecret, body), msg);

  // Ephemeral sender key + random salt: two encryptions never match.
  assert.notDeepEqual(encryptWebPush(p256dh, b64u(authSecret), msg), body);
});

test("encryptWebPush rejects malformed subscription keys", () => {
  const { p256dh, authSecret } = browserKeys();
  assert.throws(() => encryptWebPush(b64u(randomBytes(64)), b64u(authSecret), Buffer.from("x")), /uncompressed/);
  assert.throws(() => encryptWebPush(p256dh, b64u(randomBytes(15)), Buffer.from("x")), /16 bytes/);
});

test("vapidAuthorization emits a verifiable ES256 JWT bound to the push origin", () => {
  const keys = generateVapidKeys();
  const now = () => 1_700_000_000_000;
  const header = vapidAuthorization("https://push.example.net/send/abc123", keys, "mailto:me@example.com", now);

  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, "header shape: vapid t=<jwt>, k=<key>");
  assert.equal(m![2], keys.publicKey);

  const [h, p, sig] = m![1]!.split(".");
  assert.deepEqual(JSON.parse(b64uDecode(h!).toString()), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(b64uDecode(p!).toString()), {
    aud: "https://push.example.net",
    exp: Math.floor(now() / 1000) + 12 * 3600,
    sub: "mailto:me@example.com",
  });

  // Signature verifies against the *advertised* public key — the point in k=.
  const point = b64uDecode(keys.publicKey);
  const pub = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) },
    format: "jwk",
  });
  const ok = cryptoVerify(
    "sha256", Buffer.from(`${h}.${p}`),
    { key: pub, dsaEncoding: "ieee-p1363" }, b64uDecode(sig!),
  );
  assert.equal(ok, true);
});

test("buildPushPayload bounds output, strips control chars, tags per session+kind", () => {
  const p = buildPushPayload("question", { sessionId: "ses_1", sessionTitle: "Fix\x07 the\nbug" });
  assert.equal(p.title, "Polyth — Fix  the bug");
  assert.equal(p.body, "Fix  the bug — has a question for you");
  assert.equal(p.tag, "polyth-ses_1-question");
  assert.equal(p.sessionId, "ses_1");

  const long = buildPushPayload("completed", { sessionId: "s", sessionTitle: "x".repeat(500) });
  assert.ok(long.title.length <= 91); // 80-char var cap + prefix + ellipsis
  assert.ok(long.body.length <= 201);

  const custom = buildPushPayload("subagent", { sessionId: "s", sessionTitle: "Parent", statusText: "delegated agent failed" });
  assert.equal(custom.body, "Parent — delegated agent failed");
});

test("subscriptions validate, persist across reload, and unsubscribe", () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-push-")), "push.json");
  const svc = createPushService({ file });

  const key1 = svc.publicKey();
  assert.equal(b64uDecode(key1).length, 65); // uncompressed P-256 point

  const { p256dh, authSecret } = browserKeys();
  const good = { endpoint: "https://push.example.net/send/1", keys: { p256dh, auth: b64u(authSecret) } };
  svc.subscribe(good);
  svc.subscribe(good); // same endpoint replaces, never duplicates
  assert.equal(svc.count(), 1);

  // http endpoints only pass for loopback hosts.
  assert.throws(() => svc.subscribe({ ...good, endpoint: "http://evil.example.com/x" }), /https/);
  svc.subscribe({ ...good, endpoint: "http://localhost:9999/dev" });
  assert.equal(svc.count(), 2);

  // Malformed keys are rejected with a typed code.
  assert.throws(
    () => svc.subscribe({ endpoint: "https://p.example/x", keys: { p256dh: b64u(randomBytes(10)), auth: b64u(authSecret) } }),
    (e: Error & { code?: string }) => e.code === "invalid-input",
  );

  // Reload: same VAPID key (rotation would orphan subscriptions), same subs.
  const svc2 = createPushService({ file });
  assert.equal(svc2.publicKey(), key1);
  assert.equal(svc2.count(), 2);
  assert.equal(svc2.unsubscribe("http://localhost:9999/dev"), true);
  assert.equal(svc2.unsubscribe("http://localhost:9999/dev"), false);
  assert.equal(createPushService({ file }).count(), 1);
});

test("send encrypts per subscription, sets VAPID headers, drops 410 endpoints", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-push-")), "push.json");
  const calls: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
  const statusFor = new Map<string, number>();
  const fetchFn = (async (url: unknown, init?: { headers?: Record<string, string>; body?: Uint8Array }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, body: Buffer.from(init?.body ?? []) });
    const status = statusFor.get(String(url)) ?? 201;
    return { ok: status < 300, status } as Response;
  }) as typeof fetch;

  const svc = createPushService({ file, fetchFn, contact: "mailto:ops@example.com" });
  const alive = browserKeys();
  const dead = browserKeys();
  svc.subscribe({ endpoint: "https://push.example.net/alive", keys: { p256dh: alive.p256dh, auth: b64u(alive.authSecret) } });
  svc.subscribe({ endpoint: "https://push.example.net/dead", keys: { p256dh: dead.p256dh, auth: b64u(dead.authSecret) } });
  statusFor.set("https://push.example.net/dead", 410);

  const payload = buildPushPayload("permission", { sessionId: "ses_9", sessionTitle: "Deploy" });
  assert.deepEqual(await svc.send(payload), { sent: 1, dropped: 1 });

  const aliveCall = calls.find((c) => c.url.endsWith("/alive"))!;
  assert.match(aliveCall.headers.authorization!, /^vapid t=.+, k=.+$/);
  assert.equal(aliveCall.headers["content-encoding"], "aes128gcm");
  assert.equal(aliveCall.headers.ttl, "300");
  assert.deepEqual(
    JSON.parse(decryptWebPush(alive.ecdh, alive.authSecret, aliveCall.body).toString()),
    payload,
  );

  // The 410 endpoint is gone from memory and from disk.
  assert.equal(svc.count(), 1);
  assert.doesNotMatch(readFileSync(file, "utf8"), /dead/);
  assert.deepEqual(await svc.send(payload), { sent: 1, dropped: 0 });
});

test("notifier: attention pushes, aborts stay silent, subagents attribute to parent", async () => {
  const sent: PushPayload[] = [];
  const projections = new Map<string, SessionProjection>([
    ["root", { id: "root", projectId: "p", title: "Root task", status: "working", createdAt: 1, updatedAt: 1 } as SessionProjection],
    ["child", { id: "child", projectId: "p", parentId: "root", title: "Child task", status: "working", createdAt: 1, updatedAt: 1 } as SessionProjection],
  ]);
  const notifier = createPushNotifier({
    send: async (p) => { sent.push(p); },
    projection: async (id) => projections.get(id),
  });
  const settle = () => new Promise((r) => setTimeout(r, 10));

  notifier.attention("root", "permission");
  notifier.turnStopped("root", "aborted"); // silent
  notifier.turnStopped("root", "completed");
  notifier.turnStopped("child", "error"); // attributes to the parent
  notifier.attention("ghost", "question"); // unknown session: no payload
  await settle();

  assert.deepEqual(sent.map((p) => [p.kind, p.sessionId]), [
    ["permission", "root"],
    ["completed", "root"],
    ["subagent", "root"],
  ]);
  assert.equal(sent[2]!.body, "Root task — delegated agent failed");
});
