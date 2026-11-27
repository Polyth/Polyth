import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { parseServiceAccount, playRelease, serviceAccountAssertion, uploadBundle } from "../ci/play-upload.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = {
  client_email: "ci@example.iam.gserviceaccount.com",
  private_key_id: "key-id",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

test("the assertion is an RS256 JWT Google can verify", () => {
  const [header, payload, signature] = serviceAccountAssertion(account, 1_000_000).split(".");
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT", kid: "key-id" });
  assert.deepEqual(decode(payload), {
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1000,
    exp: 4600,
  });
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")));
});

test("a broken service account is refused without echoing it", () => {
  for (const text of ["s3cret not json", JSON.stringify({ private_key: "s3cret" })]) {
    assert.throws(() => parseServiceAccount(text), (error: Error) =>
      /client_email and private_key/.test(error.message) && !error.message.includes("s3cret"));
  }
  assert.equal(parseServiceAccount(JSON.stringify(account)).client_email, account.client_email);
});

test("the channel picks the track and only production defaults to a draft", () => {
  const release = (env: Record<string, string>) => playRelease(env);
  assert.deepEqual(release({ POLYTH_RELEASE_CHANNEL: "nightly" }), { track: "internal", status: "completed" });
  assert.deepEqual(release({ POLYTH_RELEASE_CHANNEL: "test" }), { track: "alpha", status: "completed" });
  assert.deepEqual(release({ POLYTH_RELEASE_CHANNEL: "stable" }), { track: "production", status: "draft" });
  // Empty workflow variables are no override.
  assert.deepEqual(release({
    POLYTH_RELEASE_CHANNEL: "nightly", POLYTH_ANDROID_PLAY_TRACK: "", POLYTH_ANDROID_PLAY_STATUS: "",
  }), { track: "internal", status: "completed" });
});

test("track and status overrides win", () => {
  assert.deepEqual(playRelease({ POLYTH_RELEASE_CHANNEL: "nightly", POLYTH_ANDROID_PLAY_STATUS: "draft" }),
    { track: "internal", status: "draft" });
  assert.deepEqual(playRelease({ POLYTH_RELEASE_CHANNEL: "stable", POLYTH_ANDROID_PLAY_STATUS: "completed" }),
    { track: "production", status: "completed" });
  assert.deepEqual(playRelease({ POLYTH_RELEASE_CHANNEL: "stable", POLYTH_ANDROID_PLAY_TRACK: "beta" }),
    { track: "beta", status: "completed" });
  // The default status follows the track actually released to.
  assert.deepEqual(playRelease({ POLYTH_RELEASE_CHANNEL: "nightly", POLYTH_ANDROID_PLAY_TRACK: "production" }),
    { track: "production", status: "draft" });
  assert.throws(() => playRelease({}), /No Google Play track/);
  assert.throws(() => playRelease({ POLYTH_RELEASE_CHANNEL: "beta" }), /No Google Play track/);
  assert.throws(() => playRelease({ POLYTH_RELEASE_CHANNEL: "nightly", POLYTH_ANDROID_PLAY_STATUS: "inProgress" }),
    /must be one of draft, completed/);
});

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function stubFetch(replies: Array<[number, unknown]>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, headers: init.headers as Record<string, string>, body: init.body });
    const reply = replies.shift();
    assert.ok(reply, `unexpected request to ${url}`);
    return new Response(JSON.stringify(reply[1]), { status: reply[0] });
  };
  return { calls, fetchImpl };
}

const BUNDLE = Buffer.from("aab-bytes");
const options = { account, bundle: BUNDLE, releaseName: "1.2.3-nightly", track: "internal", status: "completed", log: () => {} };

test("one edit: token, insert, bundle upload, track update, commit", async () => {
  const { calls, fetchImpl } = stubFetch([
    [200, { access_token: "token" }],
    [200, { id: "edit1" }],
    [200, { versionCode: 42 }],
    [200, {}],
    [200, { id: "edit1" }],
  ]);
  const result = await uploadBundle({ ...options, fetchImpl });
  assert.deepEqual(result, { track: "internal", status: "completed", versionCode: 42, editId: "edit1" });

  const app = "androidpublisher/v3/applications/com.polyth.mobile/edits";
  const host = "https://androidpublisher.googleapis.com";
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    "POST https://oauth2.googleapis.com/token",
    `POST ${host}/${app}`,
    `POST ${host}/upload/${app}/edit1/bundles?uploadType=media`,
    `PUT ${host}/${app}/edit1/tracks/internal`,
    `POST ${host}/${app}/edit1:commit`,
  ]);
  const form = new URLSearchParams(calls[0].body as string);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  assert.equal(form.get("assertion")!.split(".").length, 3);
  for (const call of calls.slice(1)) assert.equal(call.headers.authorization, "Bearer token");
  assert.equal(calls[2].headers["content-type"], "application/octet-stream");
  assert.equal(calls[2].body, BUNDLE);
  assert.deepEqual(JSON.parse(calls[3].body as string), {
    track: "internal",
    releases: [{ name: "1.2.3-nightly", versionCodes: ["42"], status: "completed" }],
  });
});

test("an API failure stops the sequence before the commit", async () => {
  const { calls, fetchImpl } = stubFetch([
    [200, { access_token: "token" }],
    [200, { id: "edit1" }],
    [403, { error: { message: "Version code 42 has already been used." } }],
  ]);
  await assert.rejects(uploadBundle({ ...options, fetchImpl }),
    /bundles\.upload -> 403 Version code 42 has already been used\./);
  assert.equal(calls.length, 3);
});

test("a refused token exchange reports Google's reason", async () => {
  const { calls, fetchImpl } = stubFetch([[400, { error: "invalid_grant", error_description: "Invalid JWT Signature." }]]);
  await assert.rejects(uploadBundle({ ...options, fetchImpl }), /OAuth token -> 400 Invalid JWT Signature\./);
  assert.equal(calls.length, 1);
});
