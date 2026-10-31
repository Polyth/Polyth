import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopSetupClaimBroker, SETUP_CLAIM_REUSE_MARGIN_MS } from "../src/setupClaim.ts";

const TTL = 15 * 60_000;

function broker() {
  let clock = 1_000_000;
  let issued = 0;
  const claims = createDesktopSetupClaimBroker(() => {
    issued += 1;
    return { token: String(issued).padStart(64, "a"), expiresAt: clock + TTL };
  }, () => clock);
  return {
    claims,
    issued: () => issued,
    advance: (ms: number) => { clock += ms; },
  };
}

test("a live claim is reused so a renderer reload keeps its binding", () => {
  const b = broker();
  const first = b.claims.request();
  assert.equal(b.claims.request({}).claimToken, first.claimToken);
  assert.equal(b.claims.request({ fresh: false }).claimToken, first.claimToken);
  assert.equal(first.expiresAt, 1_000_000 + TTL);
  assert.equal(b.issued(), 1);
});

test("an expired or nearly expired claim is replaced instead of handed out again", () => {
  const b = broker();
  const first = b.claims.request();
  b.advance(TTL - SETUP_CLAIM_REUSE_MARGIN_MS);
  const second = b.claims.request();
  assert.notEqual(second.claimToken, first.claimToken);
  b.advance(TTL + 1);
  const third = b.claims.request();
  assert.notEqual(third.claimToken, second.claimToken);
  assert.equal(b.issued(), 3);
});

test("fresh rotates the claim; only an explicit boolean true counts", () => {
  const b = broker();
  const first = b.claims.request();
  for (const request of [undefined, null, "fresh", { fresh: "true" }, { fresh: 1 }]) {
    assert.equal(b.claims.request(request).claimToken, first.claimToken);
  }
  assert.notEqual(b.claims.request({ fresh: true }).claimToken, first.claimToken);
  assert.equal(b.issued(), 2);
});

test("reset forgets the claim of a setup server that went away", () => {
  const b = broker();
  const first = b.claims.request();
  b.claims.reset();
  assert.notEqual(b.claims.request().claimToken, first.claimToken);
});

test("an issuing failure is not cached", () => {
  let fail = true;
  const claims = createDesktopSetupClaimBroker(() => {
    if (fail) throw Object.assign(new Error("Desktop setup is not active"), { code: "setup-not-active" });
    return { token: "b".repeat(64), expiresAt: Date.now() + TTL };
  });
  assert.throws(() => claims.request(), { code: "setup-not-active" });
  fail = false;
  assert.equal(claims.request().claimToken, "b".repeat(64));
});
