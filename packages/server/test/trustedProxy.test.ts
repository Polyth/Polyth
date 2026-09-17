import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { createProxyTrust } from "../src/trustedProxy.ts";

const request = (remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage =>
  ({ headers, socket: { remoteAddress } } as unknown as IncomingMessage);

test("forwarded TLS is trusted only from a listed proxy peer that reports https", () => {
  const trust = createProxyTrust("100.75.147.3, ::ffff:10.0.0.9");

  assert.equal(trust.secure(request("100.75.147.3", { "x-forwarded-proto": "https" })), true);
  // IPv4-mapped and bare forms are the same operator-listed peer, both ways.
  assert.equal(trust.secure(request("::ffff:100.75.147.3", { "x-forwarded-proto": "https" })), true);
  assert.equal(trust.secure(request("10.0.0.9", { "x-forwarded-proto": "HTTPS" })), true);

  // A header alone is never authority: an unlisted peer stays plaintext.
  assert.equal(trust.secure(request("192.168.1.50", { "x-forwarded-proto": "https" })), false);
  assert.equal(trust.secure(request("127.0.0.1", { "x-forwarded-proto": "https" })), false);
  // A listed peer that did not terminate TLS is still plaintext.
  assert.equal(trust.secure(request("100.75.147.3", { "x-forwarded-proto": "http" })), false);
  assert.equal(trust.secure(request("100.75.147.3")), false);
});

test("no configured proxy trusts nothing", () => {
  for (const raw of ["", "   ", ","]) {
    const trust = createProxyTrust(raw);
    assert.equal(trust.size, 0);
    assert.equal(trust.peer("127.0.0.1"), false);
    assert.equal(trust.secure(request("127.0.0.1", { "x-forwarded-proto": "https" })), false);
  }
});
