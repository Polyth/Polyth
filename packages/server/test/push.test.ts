// Web push: the aes128gcm body decrypts on a simulated browser receiver
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

import type { JsonObject, SessionEvent, SessionProjection } from "@polyth/contracts";
import {
  b64u, b64uDecode, buildPushPayload, createPushNotifier, createPushService,
  encryptWebPush, generateVapidKeys, plainTextExcerpt, vapidAuthorization, type PushPayload,
} from "../src/push.ts";
import { pushRoutes } from "../src/routes/push.ts";

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

  const question = buildPushPayload("question", {
    sessionId: "s",
    sessionTitle: "Choose",
    requestId: "que_1",
    questions: [{
      id: "choice",
      prompt: "Continue?",
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
    }],
  });
  assert.equal(question.requestId, "que_1");
  assert.deepEqual(question.quickAnswers, [
    { title: "Yes", answers: { choice: "yes" } },
    { title: "No", answers: { choice: "no" } },
  ]);
  assert.equal(buildPushPayload("question", {
    sessionId: "s",
    sessionTitle: "Explain",
    requestId: "que_2",
    questions: [{ id: "detail", prompt: "Why?" }],
  }).quickAnswers, undefined);
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

  const svc = createPushService({ file, fetchFn, contact: "mailto:ops@example.com", log: () => {} });
  const alive = browserKeys();
  const dead = browserKeys();
  svc.subscribe({ endpoint: "https://push.example.net/alive", keys: { p256dh: alive.p256dh, auth: b64u(alive.authSecret) } });
  svc.subscribe({ endpoint: "https://push.example.net/dead", keys: { p256dh: dead.p256dh, auth: b64u(dead.authSecret) } });
  statusFor.set("https://push.example.net/dead", 410);

  const payload = buildPushPayload("permission", { sessionId: "ses_9", sessionTitle: "Deploy" });
  assert.deepEqual(await svc.send(payload), { sent: 1, dropped: 1, failed: 0, droppedEndpoints: ["https://push.example.net/dead"] });

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
  assert.deepEqual(await svc.send(payload), { sent: 1, dropped: 0, failed: 0, droppedEndpoints: [] });
});

test("send logs rejections by host only, counts failures, and keeps those subscriptions", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-push-")), "push.json");
  const lines: string[] = [];
  const fetchFn = (async (url: unknown) => {
    const u = String(url);
    if (u.endsWith("/offline")) throw new Error("getaddrinfo ENOTFOUND push.example.net");
    if (u.endsWith("/gone")) return { ok: false, status: 410, text: async () => "push subscription has unsubscribed or expired." } as Response;
    return {
      ok: false,
      status: 403,
      text: async () => `the key in the authorization header does not match\n${"x".repeat(400)} token=abc123secret`,
    } as Response;
  }) as typeof fetch;
  const svc = createPushService({ file, fetchFn, log: (line) => lines.push(line) });
  const keys = (k: ReturnType<typeof browserKeys>) => ({ p256dh: k.p256dh, auth: b64u(k.authSecret) });
  svc.subscribe({ endpoint: "https://fcm.example.net/send/SECRET-TOKEN-1", keys: keys(browserKeys()) });
  svc.subscribe({ endpoint: "https://push.example.net/offline", keys: keys(browserKeys()) });
  svc.subscribe({ endpoint: "https://push.example.net/gone", keys: keys(browserKeys()) });

  const result = await svc.send(buildPushPayload("completed", { sessionId: "s", sessionTitle: "t" }));
  assert.deepEqual({ ...result, droppedEndpoints: undefined }, { sent: 0, dropped: 1, failed: 2, droppedEndpoints: undefined });
  assert.deepEqual(result.droppedEndpoints, ["https://push.example.net/gone"]);
  assert.equal(svc.count(), 2, "rejected and unreachable subscriptions are kept; only 410 drops");

  assert.equal(lines.length, 3);
  const joined = lines.join("\n");
  assert.match(joined, /fcm\.example\.net rejected \(403\): the key in the authorization header does not match/);
  assert.match(joined, /push\.example\.net failed: getaddrinfo ENOTFOUND/);
  assert.match(joined, /push\.example\.net expired \(410\); subscription dropped/);
  assert.doesNotMatch(joined, /SECRET-TOKEN|\/send\/|\/offline|\/gone/, "endpoint paths are bearer capabilities");
  assert.doesNotMatch(joined, /abc123secret/);
  for (const line of lines) assert.ok(line.length < 320, "response detail is bounded");
});

test("the test route reports whether the caller's own subscription expired", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-push-")), "push.json");
  const fetchFn = (async (url: unknown) =>
    String(url).endsWith("/mine") ? { ok: false, status: 410 } as Response : { ok: true, status: 201 } as Response) as typeof fetch;
  const push = createPushService({ file, fetchFn, log: () => {} });
  const account = { userId: "usr_a", spaceId: "sp_a" };
  const keys = (k: ReturnType<typeof browserKeys>) => ({ p256dh: k.p256dh, auth: b64u(k.authSecret) });
  push.subscribe(account, { endpoint: "https://push.example.net/mine", keys: keys(browserKeys()) });
  push.subscribe(account, { endpoint: "https://push.example.net/other", keys: keys(browserKeys()) });
  const route = pushRoutes(push);
  const call = async (body: JsonObject) => {
    let out: unknown;
    const handled = await route({
      path: "/api/push/test",
      method: "POST",
      space: account,
      body: async () => body,
      json: (_status: number, value: unknown) => { out = value; },
    } as unknown as Parameters<typeof route>[0]);
    assert.equal(handled, true);
    return out;
  };
  assert.deepEqual(await call({ endpoint: "https://push.example.net/mine" }), { sent: 1, dropped: 1, failed: 0, ownDropped: true });
  // Other devices' endpoints never leave the server; a non-caller stays false.
  assert.deepEqual(await call({ endpoint: "https://push.example.net/mine" }), { sent: 1, dropped: 0, failed: 0, ownDropped: false });
  assert.deepEqual(await call({}), { sent: 1, dropped: 0, failed: 0, ownDropped: false });
});

test("buildPushPayload redacts secret-shaped text before it can persist or transmit", () => {
  const p = buildPushPayload("completed", {
    sessionId: "s1",
    sessionTitle: "Deploy with token: ghp_abcdefghijklmnop123456",
    key: "s1:turn:idle",
    projectId: "p1",
  });
  assert.doesNotMatch(p.title, /ghp_/);
  assert.doesNotMatch(p.body, /ghp_/);
  assert.match(p.body, /\[redacted\]/);

  const bearer = buildPushPayload("failed", { sessionId: "s1", sessionTitle: "authorization: Bearer abc.def.ghi-jkl" });
  assert.doesNotMatch(bearer.body, /abc\.def/);
});

test("buildPushPayload carries the stable key + projectId and derives the tag from the key", () => {
  const keyed = buildPushPayload("completed", {
    sessionId: "ses_1", sessionTitle: "Build", key: "ses_1:turn:idle", projectId: "p1",
  });
  assert.equal(keyed.key, "ses_1:turn:idle");
  assert.equal(keyed.projectId, "p1");
  assert.equal(keyed.tag, "polyth-ses_1:turn:idle");

  // The keyless test path (/api/push/test) keeps the legacy tag; its empty
  // key/projectId can never pass the recording sink's validation.
  const keyless = buildPushPayload("completed", { sessionId: "ses_1", sessionTitle: "Build" });
  assert.equal(keyless.key, "");
  assert.equal(keyless.projectId, "");
  assert.equal(keyless.tag, "polyth-ses_1-completed");
  const testPayload = buildPushPayload("completed", { sessionId: "", sessionTitle: "Test notification", test: true });
  assert.equal(testPayload.test, true);
});

test("notifier supplies stable keys, durable attention counts, and the trusted projectId", async () => {
  const sent: PushPayload[] = [];
  const projections = new Map<string, SessionProjection>([
    ["root", { id: "root", projectId: "p", title: "Root task", status: "working", createdAt: 1, updatedAt: 1 } as SessionProjection],
    ["child", { id: "child", projectId: "p", parentId: "root", title: "Child task", status: "working", createdAt: 1, updatedAt: 1 } as SessionProjection],
    ["stray", { id: "stray", projectId: "other", parentId: "root", title: "Stray", status: "working", createdAt: 1, updatedAt: 1 } as SessionProjection],
    ["orphan", { id: "orphan", projectId: "p", parentId: "gone", title: "Orphan", status: "working", createdAt: 1, updatedAt: 1 } as SessionProjection],
  ]);
  const notifier = createPushNotifier({
    send: async (p) => { sent.push(p); },
    projection: async (id) => projections.get(id),
    attention: async (id) => (id === "root" ? { questions: 2, permissions: 1 } : { questions: 0, permissions: 0 }),
  });
  // Each call is fire-and-forget; settle between them so arrival order is
  // deterministic (cross-transition ordering is not part of the contract).
  const settle = () => new Promise((r) => setTimeout(r, 10));

  notifier.attention("root", "question");     // durable count 2 → :question:2
  await settle();
  notifier.attention("root", "permission");   // durable count 1 → :permission:1
  await settle();
  notifier.turnStopped("root", "completed");  // :turn:idle
  await settle();
  notifier.turnStopped("root", "error");      // :turn:failed
  await settle();
  notifier.turnStopped("child", "completed"); // child key, parent target, shared project
  await settle();
  notifier.turnStopped("stray", "completed"); // parent in another project → silent
  await settle();
  notifier.turnStopped("orphan", "completed"); // missing parent cannot verify project → silent
  await settle();

  assert.deepEqual(sent.map((p) => [p.kind, p.sessionId, p.key, p.projectId]), [
    ["question", "root", "root:question:2", "p"],
    ["permission", "root", "root:permission:1", "p"],
    ["completed", "root", "root:turn:idle", "p"],
    ["failed", "root", "root:turn:failed", "p"],
    ["subagent", "root", "child:subagent:idle", "p"],
  ]);
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
  // Settle between fire-and-forget calls: arrival order across distinct
  // transitions is not a contract, only per-transition delivery is.
  const settle = () => new Promise((r) => setTimeout(r, 10));

  notifier.attention("root", "permission");
  await settle();
  notifier.turnStopped("root", "aborted"); // silent
  await settle();
  notifier.turnStopped("root", "completed");
  await settle();
  notifier.turnStopped("child", "error"); // attributes to the parent
  await settle();
  notifier.attention("ghost", "question"); // unknown session: no payload
  await settle();

  assert.deepEqual(sent.map((p) => [p.kind, p.sessionId]), [
    ["permission", "root"],
    ["completed", "root"],
    ["subagent", "root"],
  ]);
  assert.equal(sent[2]!.body, "Root task — delegated agent failed");
});

test("notifier: a package that claims a session's turns reports them itself", async () => {
  const sent: PushPayload[] = [];
  const projections = new Map<string, SessionProjection>([
    ["agent", { id: "agent", projectId: "p", title: "Morning digest", status: "working", createdAt: 1, updatedAt: 1 } as SessionProjection],
    ["chat", { id: "chat", projectId: "p", title: "Ordinary chat", status: "working", createdAt: 1, updatedAt: 1 } as SessionProjection],
  ]);
  const notifier = createPushNotifier({
    send: async (p) => { sent.push(p); },
    projection: async (id) => projections.get(id),
    claimed: (id) => id === "agent",
  });
  const settle = () => new Promise((r) => setTimeout(r, 10));

  notifier.turnStopped("agent", "completed"); // claimed: silent
  await settle();
  notifier.turnStopped("agent", "error"); // claimed: silent
  await settle();
  notifier.attention("agent", "permission"); // approvals still reach the person
  await settle();
  notifier.turnStopped("chat", "completed");
  await settle();
  notifier.report("agent", "completed", "needs you: build broken", "run-1");
  await settle();

  assert.deepEqual(sent.map((p) => [p.kind, p.sessionId, p.key]), [
    ["permission", "agent", "agent:permission:1"],
    ["completed", "chat", "chat:turn:idle"],
    ["completed", "agent", "agent:report:run-1"],
  ]);
  assert.equal(sent[2]!.body, "Morning digest — needs you: build broken");
});

test("notifier binds pending request identity and quick answers to attention pushes", async () => {
  const sent: PushPayload[] = [];
  const notifier = createPushNotifier({
    send: async (payload) => { sent.push(payload); },
    projection: async () => ({
      id: "root", projectId: "p", title: "Root task", status: "waiting", createdAt: 1, updatedAt: 1,
    }),
  });
  notifier.attention("root", "question", "que_1", [{
    id: "choice",
    prompt: "Continue?",
    options: ["Yes", "No"],
  }]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.sessionId, "root");
  assert.equal(sent[0]!.requestId, "que_1");
  assert.deepEqual(sent[0]!.quickAnswers, [
    { title: "Yes", answers: { choice: "Yes" } },
    { title: "No", answers: { choice: "No" } },
  ]);
});

test("web-push endpoint reassignment is account-exclusive and scoped", async () => {
  const delivered: string[] = [];
  const activeAccounts = new Set(["usr_alice\0sp_a", "usr_bob\0sp_b"]);
  const service = createPushService({
    file: join(mkdtempSync(join(tmpdir(), "polyth-push-scope-")), "push.json"),
    hasAccess: (account) => activeAccounts.has(`${account.userId}\0${account.spaceId}`),
    fetchFn: (async (url) => {
      delivered.push(String(url));
      return { ok: true, status: 201 } as Response;
    }) as typeof fetch,
  });
  const browser = browserKeys();
  const subscription = { endpoint: "https://push.example.test/shared", keys: { p256dh: browser.p256dh, auth: b64u(browser.authSecret) } };
  const alice = { userId: "usr_alice", spaceId: "sp_a" };
  const bob = { userId: "usr_bob", spaceId: "sp_b" };
  service.subscribe(alice, subscription);
  service.subscribe(bob, subscription);
  assert.equal(service.count(alice), 0);
  assert.equal(service.count(bob), 1);
  assert.equal(service.unsubscribe(alice, subscription.endpoint), false);
  assert.equal(service.count(alice), 0);
  assert.equal(service.count(bob), 1);
  const payload = buildPushPayload("completed", { sessionId: "ses_1", sessionTitle: "Done" });
  assert.deepEqual(await service.send(alice, payload), { sent: 0, dropped: 0, failed: 0, droppedEndpoints: [] });
  assert.deepEqual(await service.send(bob, payload), { sent: 1, dropped: 0, failed: 0, droppedEndpoints: [] });
  assert.deepEqual(delivered, [subscription.endpoint]);
  activeAccounts.delete("usr_bob\0sp_b");
  assert.equal(service.count(bob), 0, "removed accounts lose their destination immediately");
  assert.deepEqual(await service.send(bob, payload), { sent: 0, dropped: 0, failed: 0, droppedEndpoints: [] });
  assert.deepEqual(delivered, [subscription.endpoint]);
  assert.equal(service.removeAccount(bob.userId), 1);
  activeAccounts.add("usr_bob\0sp_b");
  assert.equal(service.count(bob), 0, "recreating a stable account id cannot adopt the old endpoint");
});

test("waitingForPerson replaces an idle chat's turn notification with a question, and skips busy or child sessions", async () => {
  const sent: PushPayload[] = [];
  const projections = new Map<string, SessionProjection>([
    ["idle", { id: "idle", projectId: "p", title: "Fix build", status: "idle", createdAt: 1, updatedAt: 1 } as SessionProjection],
    ["busy", { id: "busy", projectId: "p", title: "Busy", status: "working", createdAt: 1, updatedAt: 1 } as SessionProjection],
    ["child", { id: "child", projectId: "p", parentId: "idle", title: "Child", status: "idle", createdAt: 1, updatedAt: 1 } as SessionProjection],
  ]);
  const notifier = createPushNotifier({ send: async (p) => { sent.push(p); }, projection: async (id) => projections.get(id) });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  notifier.turnStopped("idle", "completed"); await settle();
  for (const id of ["idle", "busy", "child", "missing"]) notifier.waitingForPerson(id);
  await settle();
  assert.deepEqual(sent.map((p) => [p.kind, p.key, p.tag]), [
    ["completed", "idle:turn:idle", "polyth-idle:turn:idle"],
    ["question", "idle:turn:idle", "polyth-idle:turn:idle"],
  ]);
  assert.match(sent[1]!.body, /waiting for your answer/);
});

test("waitingForPerson carries the agent's last reply excerpt", async () => {
  const sent: PushPayload[] = [];
  const projections = new Map<string, SessionProjection>([
    ["idle", { id: "idle", projectId: "p", title: "Fix build", status: "idle", createdAt: 1, updatedAt: 1 } as SessionProjection],
  ]);
  const notifier = createPushNotifier({
    send: async (p) => { sent.push(p); },
    projection: async (id) => projections.get(id),
    tail: async () => [
      ev(1, "turn/started", {}),
      ev(2, "assistant/message", { partId: "a", text: "I need **your** call: ship now?" }),
    ],
  });
  notifier.waitingForPerson("idle");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.kind, "question");
  assert.equal(sent[0]!.key, "idle:turn:idle");
  assert.equal(sent[0]!.projectId, "p");
  assert.equal(sent[0]!.title, "Polyth — Fix build");
  assert.equal(sent[0]!.body, "I need your call: ship now?");
});

// ---- notification content ---------------------------------------------------------

const ev = (seq: number, type: string, data: JsonObject): SessionEvent =>
  ({ seq, type, data, time: seq } as unknown as SessionEvent);

test("plainTextExcerpt strips markdown, fences and keeps intra-word underscores", () => {
  const md = [
    "# Done", "", "I fixed **the bug** in [parser](http://x.y/z) and ![chart](a.png).",
    "```ui", "cards Things", "- a | b", "```",
    "- first item", "1. second", "| a | b |", "|---|---|", "| c | d |",
    "words like user_id keep their underscores, and _this_ is italic.",
  ].join("\n");
  const out = plainTextExcerpt(md);
  assert.equal(
    out,
    "Done I fixed the bug in parser and chart. first item second a, b c, d words like user_id keep their underscores, and this is italic.",
  );
  assert.doesNotMatch(out, /cards Things|```|\*\*/);
});

test("plainTextExcerpt caps on a word boundary, redacts, and never throws", () => {
  const long = plainTextExcerpt("word ".repeat(100));
  assert.ok(long.length <= 200 && long.endsWith("…"));
  assert.doesNotMatch(long, /wor…$/);
  assert.equal(plainTextExcerpt("token: ghp_abcdefghijklmnop1234"), "[redacted]");
  assert.equal(plainTextExcerpt("a\u0000b\u0007c"), "a b c");
  assert.equal(plainTextExcerpt("```\nunclosed"), "");
  assert.equal(plainTextExcerpt(undefined), "");
  assert.equal(plainTextExcerpt({ toString() { throw new Error("x"); } }), "");
});

test("notifier puts the concrete content in the body and falls back to status text", async () => {
  const sent: PushPayload[] = [];
  const base = { projectId: "p", status: "working", createdAt: 1, updatedAt: 1 };
  const projections = new Map<string, SessionProjection>([
    ["root", { id: "root", title: "Root task", ...base } as SessionProjection],
    ["child", { id: "child", parentId: "root", title: "Child task", ...base } as SessionProjection],
    ["quiet", { id: "quiet", title: "Quiet", ...base } as SessionProjection],
  ]);
  const tails: Record<string, SessionEvent[]> = {
    root: [
      ev(1, "turn/started", {}),
      ev(2, "assistant/message", { partId: "a", text: "Working on it" }),
      ev(3, "assistant/message", { partId: "b", text: "All **green**: 12 tests pass." }),
      ev(4, "permission/requested", { requestId: "r1", permission: "bash", patterns: ["npm test"], metadata: { command: "npm test" } }),
      ev(5, "permission/requested", { requestId: "r2", permission: "edit", patterns: ["src/a.ts"] }),
      ev(6, "turn/stopped", { reason: "error", error: "Provider said: api_key=sk_live_abcdefghijklmnop" }),
    ],
    child: [ev(1, "turn/started", {}), ev(2, "assistant/message", { partId: "a", text: "Found 3 files." })],
    quiet: [ev(1, "turn/started", {}), ev(2, "turn/stopped", { reason: "completed" })],
  };
  const notifier = createPushNotifier({
    send: async (p) => { sent.push(p); },
    projection: async (id) => projections.get(id),
    tail: async (id) => { if (id === "boom") throw new Error("x"); return tails[id] ?? []; },
  });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  notifier.turnStopped("root", "completed"); await settle();
  notifier.turnStopped("root", "error"); await settle();
  notifier.attention("root", "permission", "r1"); await settle();
  notifier.attention("root", "permission", "r2"); await settle();
  notifier.attention("root", "question", "q", [{ prompt: "Which database?" }, { prompt: "Why?" }]); await settle();
  notifier.turnStopped("child", "completed"); await settle();
  notifier.turnStopped("quiet", "completed"); await settle();
  assert.deepEqual(sent.map((p) => p.body), [
    "All green: 12 tests pass.",
    "Provider said: [redacted]",
    "Run: npm test",
    "Edit: src/a.ts",
    "Which database? (+1 more)",
    "Child task: Found 3 files.",
    "Quiet — finished",
  ]);
  assert.ok(sent.every((p) => p.title.startsWith("Polyth — ") && p.body.length <= 201));
});

test("a failing tail read falls back to the status text", async () => {
  const sent: PushPayload[] = [];
  const notifier = createPushNotifier({
    send: async (p) => { sent.push(p); },
    projection: async () => ({ id: "s", projectId: "p", title: "S", status: "idle", createdAt: 1, updatedAt: 1 } as SessionProjection),
    tail: async () => { throw new Error("db down"); },
  });
  notifier.turnStopped("s", "completed");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent[0]!.body, "S — finished");
});

// ---- bounded backward paging --------------------------------------------------------

/** A fake store page: the newest `limit` events below `beforeSeq`, ascending —
 *  exactly the contract `store.events(sessionId, 0, { limit, beforeSeq })` has. */
function pagedTail(log: SessionEvent[], calls: Array<number | undefined>, limit = 80) {
  return async (_sessionId: string, beforeSeq?: number) => {
    calls.push(beforeSeq);
    // First index whose seq is >= beforeSeq (the exclusive upper bound).
    const to = beforeSeq === undefined ? log.length : log.findIndex((e) => e.seq >= beforeSeq);
    const end = to === -1 ? log.length : to;
    return log.slice(Math.max(0, end - limit), end);
  };
}

const filler = (seq: number): SessionEvent => ev(seq, "tool/result", { partId: `t${seq}` });

function notifierWithTail(tail: (sessionId: string, beforeSeq?: number) => Promise<readonly SessionEvent[]>, sent: PushPayload[]) {
  return createPushNotifier({
    send: async (p) => { sent.push(p); },
    projection: async () => ({ id: "s", projectId: "p", title: "S", status: "working", createdAt: 1, updatedAt: 1 } as SessionProjection),
    tail,
  });
}

test("the reply walk pages backwards past a window larger than one page", async () => {
  // turn/started + reply are the OLDEST two events; 238 tool results follow.
  const log: SessionEvent[] = [
    ev(1, "turn/started", {}),
    ev(2, "assistant/message", { partId: "deep", text: "Buried **deep** but still mine." }),
  ];
  for (let seq = 3; seq <= 240; seq++) log.push(filler(seq));
  const calls: Array<number | undefined> = [];
  const sent: PushPayload[] = [];
  const notifier = notifierWithTail(pagedTail(log, calls), sent);
  notifier.turnStopped("s", "completed");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent[0]!.body, "Buried deep but still mine.");
  assert.deepEqual(calls, [undefined, 161, 81], "returns the first undefined, then the oldest seq of each page");
});

test("a turn/started on the newest page stops the walk immediately", async () => {
  const log: SessionEvent[] = [];
  for (let seq = 1; seq <= 200; seq++) log.push(filler(seq));
  log.push(ev(201, "turn/started", {}));
  log.push(ev(202, "assistant/message", { partId: "a", text: "Fresh reply." }));
  const calls: Array<number | undefined> = [];
  const sent: PushPayload[] = [];
  const notifier = notifierWithTail(pagedTail(log, calls), sent);
  notifier.turnStopped("s", "completed");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent[0]!.body, "Fresh reply.");
  assert.equal(calls.length, 1, "the newest page alone already crosses turn/started");
});

test("the content walk is capped at four pages and keeps the status text", async () => {
  // The reply sits below 320 newer events with no turn/started in the window.
  const log: SessionEvent[] = [
    ev(1, "turn/started", {}),
    ev(2, "assistant/message", { partId: "old", text: "Too far back to reach." }),
  ];
  for (let seq = 3; seq <= 400; seq++) log.push(filler(seq));
  const calls: Array<number | undefined> = [];
  const sent: PushPayload[] = [];
  const notifier = notifierWithTail(pagedTail(log, calls), sent);
  notifier.turnStopped("s", "completed");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 4, "at most four keyset pages");
  assert.equal(sent[0]!.body, "S — finished");
});

test("the error walk also pages backwards and falls back on a failing tail", async () => {
  const log: SessionEvent[] = [];
  for (let seq = 1; seq <= 200; seq++) log.push(filler(seq));
  log.push(ev(201, "turn/stopped", { reason: "error", error: "boom in page two" }));
  for (let seq = 202; seq <= 280; seq++) log.push(filler(seq));
  const calls: Array<number | undefined> = [];
  const sent: PushPayload[] = [];
  const notifier = notifierWithTail(pagedTail(log, calls), sent);
  notifier.turnStopped("s", "error");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent[0]!.body, "boom in page two");

  const failing: PushPayload[] = [];
  const failingNotifier = notifierWithTail(async () => { throw new Error("db down"); }, failing);
  failingNotifier.turnStopped("s", "error");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(failing[0]!.body, "S — failed");
});

test("a reply on the newest page needs one read even without turn/started in it", async () => {
  // 300 tool results, then the closing reply; the turn started far below.
  const log: SessionEvent[] = [ev(1, "turn/started", {})];
  for (let seq = 2; seq <= 300; seq++) log.push(filler(seq));
  log.push(ev(301, "assistant/message", { partId: "done", text: "All green." }));
  const calls: Array<number | undefined> = [];
  const sent: PushPayload[] = [];
  const notifier = notifierWithTail(pagedTail(log, calls), sent);
  notifier.turnStopped("s", "completed");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent[0]!.body, "All green.");
  assert.equal(calls.length, 1, "the walk stops at the page that already holds the reply");
});
