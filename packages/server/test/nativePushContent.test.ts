import assert from "node:assert/strict";
import { createECDH, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNativePushService, parseContentKey, sealNativeContent } from "../src/nativePush.ts";

// Receiver-side reference opener: steps 1-11 of docs/mobile/native-push-content.md,
// written independently of encryptWebPush (HMAC/ECDH/AES-GCM from node:crypto only).
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
function open(message: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): Buffer {
  const salt = message.subarray(0, 16);
  const rs = message.readUInt32BE(16);
  const idlen = message[20]!;
  assert.ok(rs >= 18);
  assert.equal(idlen, 65);
  const asPublic = message.subarray(21, 86);
  assert.equal(asPublic[0], 0x04);
  const record = message.subarray(86);
  assert.ok(record.length >= 17 && record.length <= rs);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const prkKey = hmac(auth, secret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  let padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  assert.equal(padded[end - 1], 0x02);
  return padded.subarray(0, end - 1);
}
const b = (value: string) => Buffer.from(value, "base64url");

const newKey = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    priv: ecdh.getPrivateKey(), pub: ecdh.getPublicKey(), auth,
    key: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
  };
};

test("reference opener opens the RFC 8291 Appendix A message", () => {
  const plain = open(
    b("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"),
    b("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
    b("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
    b("BTBZMqHH6r4Tts7J_aSIgg"),
  );
  assert.equal(plain.toString(), "When I grow up, I want to be a watermelon");
});

test("host sealing opens to the exact {v,title,body}", () => {
  const device = newKey();
  const sealed = sealNativeContent(device.key, "Build finished", "All 12 checks passed — ünïcode ✓");
  assert.match(sealed, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(open(b(sealed), device.priv, device.pub, device.auth).toString()), { v: 1, title: "Build finished", body: "All 12 checks passed — ünïcode ✓" });
});

test("a long body is shortened on a word boundary to fit 3072 characters, never dropped", () => {
  const device = newKey();
  const words = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(" ");
  const sealed = sealNativeContent(device.key, "T", words);
  assert.ok(sealed.length <= 3072);
  const opened = JSON.parse(open(b(sealed), device.priv, device.pub, device.auth).toString()) as { body: string };
  assert.ok(opened.body.length > 1000);
  assert.ok(words.startsWith(opened.body));
  assert.match(opened.body, /word\d+$/, "ends on a whole word");
  assert.ok(words[opened.body.length] === " ");
  // No spaces at all still shortens rather than drops.
  const solid = sealNativeContent(device.key, "T", "x".repeat(5000));
  assert.ok(solid.length <= 3072);
  assert.ok((JSON.parse(open(b(solid), device.priv, device.pub, device.auth).toString()) as { body: string }).body.length > 1000);
});

test("parseContentKey validates strictly", () => {
  const { key } = newKey();
  assert.deepEqual(parseContentKey(key), key);
  assert.equal(parseContentKey(undefined), undefined);
  assert.equal(parseContentKey("x"), undefined);
  assert.equal(parseContentKey({ p256dh: key.p256dh }), undefined);
  assert.equal(parseContentKey({ ...key, auth: key.auth.slice(1) }), undefined, "auth too short");
  assert.equal(parseContentKey({ ...key, auth: `${key.auth}A` }), undefined, "auth too long");
  assert.equal(parseContentKey({ ...key, p256dh: key.p256dh.slice(1) }), undefined, "p256dh too short");
  assert.equal(parseContentKey({ ...key, p256dh: `${key.p256dh}A` }), undefined, "p256dh too long");
  assert.equal(parseContentKey({ ...key, p256dh: `${key.p256dh.slice(0, 86)}+` }), undefined, "not base64url");
  assert.equal(parseContentKey({ ...key, auth: `${key.auth.slice(0, 21)}=` }), undefined, "padding");
  const compressed = Buffer.from(b(key.p256dh)); compressed[0] = 0x02;
  assert.equal(parseContentKey({ ...key, p256dh: compressed.toString("base64url") }), undefined, "not 0x04");
  const offCurve = Buffer.from(b(key.p256dh)); offCurve[64] ^= 1; offCurve[63] ^= 1;
  assert.equal(parseContentKey({ ...key, p256dh: offCurve.toString("base64url") }), undefined, "not a P-256 point");
  assert.equal(parseContentKey({ ...key, p256dh: Buffer.alloc(65, 0).fill(4, 0, 1).toString("base64url") }), undefined, "zero point");
});

const alice = { userId: "usr_alice", spaceId: "sp_alice", deviceId: "dev_alice", deviceEndpointId: "end_alice" };
const subscriptionId = `sub_${"c".repeat(22)}`;
const authority = () => ({ hostEndpointId: async () => "host-endpoint", validate: async () => true });

function harness(deliver: (body: Record<string, unknown>, n: number) => number = () => 200, persisted = join(mkdtempSync(join(tmpdir(), "polyth-native-content-")), "native-push.json")) {
  const delivered: Array<Record<string, unknown>> = [];
  const service = createNativePushService({
    file: persisted, relayOrigin: "http://127.0.0.1:8787", authority,
    fetchFn: async (url, init) => {
      if (String(url).endsWith("/v1/claims/redeem")) return new Response(JSON.stringify({ subscriptionId, senderToken: "b".repeat(43) }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      delivered.push(body);
      return new Response("{}", { status: deliver(body, delivered.length) });
    },
  });
  return { service, delivered, persisted };
}
const sendInput = { userId: alice.userId, spaceId: alice.spaceId, notificationId: "n-1", kind: "completed" as const, transitionKey: "s:turn:idle", title: "Done", body: "It worked" };

test("claim rejects an invalid content key and stores nothing", async () => {
  const { service, delivered } = harness();
  const { key } = newKey();
  for (const bad of [{ ...key, auth: "short" }, { p256dh: "!".repeat(87), auth: key.auth }, "nope", 7, {}]) {
    await assert.rejects(service.claim({ ...alice, claimToken: "a".repeat(43), contentKey: bad }), { code: "invalid-input" });
  }
  assert.equal((await service.send(sendInput)).sent, 0);
  assert.equal(delivered.length, 0);
});

test("send seals for an entry with a key and omits sealed without one", async () => {
  const device = newKey();
  const keyed = harness();
  await keyed.service.claim({ ...alice, claimToken: "a".repeat(43), contentKey: device.key });
  assert.equal((await keyed.service.send(sendInput)).sent, 1);
  const body = keyed.delivered[0]!;
  assert.deepEqual(Object.keys(body).sort(), ["kind", "notificationId", "sealed", "subscriptionId", "tag", "version"]);
  assert.deepEqual(JSON.parse(open(b(body.sealed as string), device.priv, device.pub, device.auth).toString()), { v: 1, title: "Done", body: "It worked" });

  const plain = harness();
  await plain.service.claim({ ...alice, claimToken: "a".repeat(43) });
  await plain.service.send(sendInput);
  assert.deepEqual(Object.keys(plain.delivered[0]!).sort(), ["kind", "notificationId", "subscriptionId", "tag", "version"]);
});

test("a key persists (0600, survives restart) and a re-claim without one clears it", async () => {
  const device = newKey();
  const first = harness();
  await first.service.claim({ ...alice, claimToken: "a".repeat(43), contentKey: device.key });
  assert.equal(statSync(first.persisted).mode & 0o777, 0o600);
  const restarted = harness(() => 200, first.persisted);
  await restarted.service.send(sendInput);
  assert.ok(typeof restarted.delivered[0]!.sealed === "string");
  await restarted.service.claim({ ...alice, claimToken: "a".repeat(43) });
  await restarted.service.send(sendInput);
  assert.equal("sealed" in restarted.delivered[1]!, false);
  assert.equal("contentKey" in (JSON.parse(readFileSync(first.persisted, "utf8")).subscriptions[0] as object), false);
});

test("old files without a content key, and files with a malformed one, still load", async () => {
  const first = harness();
  await first.service.claim({ ...alice, claimToken: "a".repeat(43) });
  const file = JSON.parse(readFileSync(first.persisted, "utf8"));
  file.subscriptions[0].contentKey = { p256dh: "bad", auth: "bad" };
  writeFileSync(first.persisted, JSON.stringify(file));
  const loaded = harness(() => 200, first.persisted);
  assert.equal((await loaded.service.send(sendInput)).sent, 1);
  assert.equal("sealed" in loaded.delivered[0]!, false);
});

test("a 400 on a sealed delivery is retried exactly once without sealed", async () => {
  const { service, delivered } = harness((body) => ("sealed" in body ? 400 : 200));
  await service.claim({ ...alice, claimToken: "a".repeat(43), contentKey: newKey().key });
  assert.equal((await service.send(sendInput)).sent, 1);
  assert.equal(delivered.length, 2);
  assert.ok("sealed" in delivered[0]!);
  assert.equal("sealed" in delivered[1]!, false);
  const failing = harness(() => 400);
  await failing.service.claim({ ...alice, claimToken: "a".repeat(43), contentKey: newKey().key });
  assert.equal((await failing.service.send(sendInput)).sent, 0);
  assert.equal(failing.delivered.length, 2, "one retry only");
  const server = harness(() => 503);
  await server.service.claim({ ...alice, claimToken: "a".repeat(43), contentKey: newKey().key });
  await server.service.send(sendInput);
  assert.equal(server.delivered.length, 1, "other failures are not retried");
});

test("an oversized body is shortened, not dropped, in send", async () => {
  const device = newKey();
  const { service, delivered } = harness();
  await service.claim({ ...alice, claimToken: "a".repeat(43), contentKey: device.key });
  await service.send({ ...sendInput, body: "lorem ".repeat(2000) });
  const sealed = delivered[0]!.sealed as string;
  assert.ok(sealed.length <= 3072);
  assert.ok((JSON.parse(open(b(sealed), device.priv, device.pub, device.auth).toString()) as { body: string }).body.startsWith("lorem lorem"));
});
