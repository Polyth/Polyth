import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleClient, GoogleError, type FetchLike } from "../src/http.ts";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const googleFailure = (status: number, reason: string, message = "failure") =>
  json(status, { error: { code: status, message, errors: [{ reason, message }] } });

function client(responses: Array<Response | Error>, tokens: string[] = []) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  };
  let issued = 0;
  const refreshes: boolean[] = [];
  const google = createGoogleClient({
    tokens: {
      async accessToken(options) {
        refreshes.push(options?.refresh === true);
        return tokens[issued++] ?? "token";
      },
    },
    fetch,
    sleep: async () => {},
    random: () => 0,
  });
  return { google, calls, refreshes };
}

test("requests carry the bearer token and reject non-Google origins", async () => {
  const { google, calls } = client([json(200, { ok: true })]);
  assert.deepEqual(await google.json({ url: "https://www.googleapis.com/drive/v3/about", query: { fields: "user", list: ["a", "b"] } }), { ok: true });
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), "Bearer token");
  assert.equal(calls[0]!.url, "https://www.googleapis.com/drive/v3/about?fields=user&list=a&list=b");
  await assert.rejects(google.json({ url: "https://evil.example/steal" }), (error: unknown) => error instanceof GoogleError && error.code === "invalid-request");
});

test("a 401 refreshes the token once and retries", async () => {
  const { google, refreshes } = client([googleFailure(401, "authError"), json(200, { ok: 1 })], ["stale", "fresh"]);
  assert.deepEqual(await google.json({ url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" }), { ok: 1 });
  assert.deepEqual(refreshes, [false, true]);
});

test("a repeated 401 becomes invalid-credentials", async () => {
  const { google } = client([googleFailure(401, "authError"), googleFailure(401, "authError")]);
  await assert.rejects(google.json({ url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" }), { code: "invalid-credentials" });
});

test("insufficient scope is distinguished from other denials", async () => {
  const scope = client([json(403, { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } })]);
  await assert.rejects(scope.google.json({ url: "https://www.googleapis.com/calendar/v3/users/me/calendarList" }), { code: "insufficient-scope" });
  const denied = client([googleFailure(403, "forbidden", "The caller does not have permission")]);
  await assert.rejects(denied.google.json({ url: "https://www.googleapis.com/drive/v3/files/x" }), (error: unknown) =>
    error instanceof GoogleError && error.code === "permission-denied" && /does not have permission/.test(error.message));
});

test("reads retry rate limits and server errors; mutations retry only rejected rate limits", async () => {
  const read = client([googleFailure(429, "rateLimitExceeded"), new Response("", { status: 503 }), json(200, { ok: true })]);
  assert.deepEqual(await read.google.json({ url: "https://www.googleapis.com/drive/v3/files" }), { ok: true });
  assert.equal(read.calls.length, 3);

  const write = client([googleFailure(403, "userRateLimitExceeded"), json(200, { id: "m1" })]);
  assert.deepEqual(await write.google.json({ method: "POST", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", json: {} }), { id: "m1" });

  const unknown = client([new Response("", { status: 500 })]);
  await assert.rejects(unknown.google.json({ method: "POST", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", json: {} }), { code: "mutation-outcome-unknown" });
  assert.equal(unknown.calls.length, 1);

  const dropped = client([new TypeError("socket hang up")]);
  await assert.rejects(dropped.google.json({ method: "DELETE", url: "https://www.googleapis.com/drive/v3/files/x" }), { code: "mutation-outcome-unknown" });
  assert.equal(dropped.calls.length, 1);
});

test("quota exhaustion and persistent network failures are not retried forever", async () => {
  const quota = client([googleFailure(403, "dailyLimitExceeded")]);
  await assert.rejects(quota.google.json({ url: "https://www.googleapis.com/drive/v3/files" }), { code: "rate-limited" });
  assert.equal(quota.calls.length, 1);
  const offline = client([new TypeError("offline"), new TypeError("offline"), new TypeError("offline")]);
  await assert.rejects(offline.google.json({ url: "https://www.googleapis.com/drive/v3/files" }), { code: "network-error" });
  assert.equal(offline.calls.length, 3);
});

test("not found, conflicts and oversized responses map to stable codes", async () => {
  await assert.rejects(client([googleFailure(404, "notFound")]).google.json({ url: "https://www.googleapis.com/drive/v3/files/x" }), { code: "not-found" });
  await assert.rejects(client([googleFailure(410, "deleted")]).google.json({ url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/x" }), { code: "not-found" });
  await assert.rejects(client([googleFailure(412, "conditionNotMet")]).google.json({ method: "PATCH", url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/x", json: {} }), { code: "conflict" });
  const big = client([new Response(new Uint8Array(2048), { status: 200 })]);
  await assert.rejects(big.google.raw({ url: "https://www.googleapis.com/drive/v3/files/x", query: { alt: "media" }, maxBytes: 1024 }), { code: "too-large" });
});

test("cancellation is reported as cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const { google, calls } = client([json(200, {})]);
  await assert.rejects(google.json({ url: "https://www.googleapis.com/drive/v3/files", signal: controller.signal }), { code: "cancelled" });
  assert.equal(calls.length, 0);
});

test("error messages never echo the access token", async () => {
  const { google } = client([googleFailure(400, "invalid", "bad request")], ["ya29.secret-token"]);
  await assert.rejects(google.json({ url: "https://www.googleapis.com/drive/v3/files" }), (error: unknown) =>
    error instanceof GoogleError && !error.message.includes("ya29") && error.code === "invalid-request");
});
