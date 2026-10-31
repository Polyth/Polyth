import { test } from "node:test";
import assert from "node:assert/strict";
import { logHttp500, sanitizeLoggedError, sanitizeRequestUrl } from "../src/httpLog.ts";

test("sanitizeRequestUrl keeps the path and query names, and redacts every value", () => {
  const out = sanitizeRequestUrl(
    "/api/auth/callback?code=secret-code-value&state=ok&token=super-secret-token&q=hello",
  );
  assert.match(out, /^\/api\/auth\/callback\?/);
  assert.match(out, /code=\[redacted\]/);
  assert.match(out, /state=\[redacted\]/);
  assert.match(out, /token=\[redacted\]/);
  assert.match(out, /q=\[redacted\]/);
  assert.match(out, /token=\[redacted\]&q=\[redacted\]/);
  assert.doesNotMatch(out, /secret-code-value/);
  assert.doesNotMatch(out, /super-secret-token/);
  assert.doesNotMatch(out, /state=ok/);
  assert.doesNotMatch(out, /q=hello/);
});

test("sanitizeRequestUrl redacts credential-shaped and signed-url parameter values", () => {
  const out = sanitizeRequestUrl(
    "/download?client_secret=s3cret&signature=aabbcc&sig=deadbeef&credential=AKIA&X-Amz-Signature=signed&Expires=99",
  );
  for (const key of ["client_secret", "signature", "sig", "credential", "X-Amz-Signature", "Expires"]) {
    assert.match(out, new RegExp(`${key}=\\[redacted\\]`));
  }
  assert.doesNotMatch(out, /s3cret|aabbcc|deadbeef|AKIA|signed|Expires=99/);
});

test("sanitizeRequestUrl redacts unknown keys even when the value looks secret", () => {
  const out = sanitizeRequestUrl("/api/x?weird_future_param=sk-live-abcdefghijklmnopqrstuvwxyz");
  assert.match(out, /weird_future_param=\[redacted\]/);
  assert.doesNotMatch(out, /sk-live-abcdefghijklmnopqrstuvwxyz/);
});

test("sanitizeRequestUrl collapses encoded newlines and control characters", () => {
  const out = sanitizeRequestUrl("/api/x?q=a%0Ab&next=line%0D%0Ainjected");
  assert.doesNotMatch(out, /\n|\r/);
  assert.match(out, /q=\[redacted\]/);
  assert.match(out, /next=\[redacted\]/);
});

test("sanitizeRequestUrl redacts bearer tokens in query values", () => {
  const out = sanitizeRequestUrl("/api/x?authorization=Bearer%20abc123def456ghi789");
  assert.match(out, /authorization=\[redacted\]/);
  assert.doesNotMatch(out, /abc123def456ghi789/);
});

test("sanitizeRequestUrl keeps a path with no query", () => {
  assert.equal(sanitizeRequestUrl("/api/health"), "/api/health");
  assert.equal(sanitizeRequestUrl(""), "/");
  assert.equal(sanitizeRequestUrl(undefined), "/");
});

test("sanitizeRequestUrl does not throw on malformed URL strings", () => {
  const out = sanitizeRequestUrl("::::?foo=bar%zz&%0Aevil=1");
  assert.match(out, /foo=\[redacted\]/);
  assert.doesNotMatch(out, /\n/);
  assert.doesNotMatch(out, /bar/);
});

test("sanitizeLoggedError redacts secrets in message, stack, and cause chain", () => {
  const nested = new Error("password=hunter2-secret");
  const err = new Error("Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz");
  err.cause = nested;
  const out = sanitizeLoggedError(err);
  assert.doesNotMatch(out, /sk-live-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(out, /hunter2-secret/);
  assert.match(out, /\[redacted\]/);
  assert.match(out, / <- /);
  assert.doesNotMatch(out, /\n/);
});

test("logHttp500 writes a single-line operator diagnostic without query values", () => {
  const lines: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args); };
  try {
    logHttp500("GET", "/api/x?token=leaked-token-value-123456", new Error("Bearer abcdef1234567890"));
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  const text = lines[0]!.map(String).join(" ");
  assert.match(text, /\[polyth\] GET /);
  assert.match(text, /token=\[redacted\]/);
  assert.doesNotMatch(text, /leaked-token-value-123456/);
  assert.doesNotMatch(text, /abcdef1234567890/);
  assert.doesNotMatch(text, /\n/);
});
