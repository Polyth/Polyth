import assert from "node:assert/strict";
import test from "node:test";
import { isSignInExpiryNews, sanitizeSignInExpiryLedger, withSignInExpiryMark } from "../widgets/signInExpiryLedger.ts";

const NOW = Date.UTC(2026, 10, 4, 12);
const ENDS = Date.UTC(2026, 10, 12);

test("each level of one sign-in end is announced once; a new end date starts over", () => {
  let ledger = sanitizeSignInExpiryLedger(undefined, NOW);
  assert.equal(isSignInExpiryNews(ledger, "claude-work", ENDS, "soon", "notified"), true);
  ledger = withSignInExpiryMark(ledger, "claude-work", ENDS, "soon", "notified", NOW);
  assert.equal(isSignInExpiryNews(ledger, "claude-work", ENDS, "soon", "notified"), false);
  assert.equal(isSignInExpiryNews(ledger, "claude-work", ENDS, "imminent", "notified"), true);
  // Notified and dismissed are separate marks.
  assert.equal(isSignInExpiryNews(ledger, "claude-work", ENDS, "imminent", "dismissed"), true);
  ledger = withSignInExpiryMark(ledger, "claude-work", ENDS, "imminent", "dismissed", NOW);
  assert.deepEqual(ledger.harnesses["claude-work"], { expiresAt: ENDS, notified: "soon", dismissed: "imminent" });
  assert.equal(isSignInExpiryNews(ledger, "claude-work", ENDS, "ended", "dismissed"), true);
  // Signing in again moves the end: everything is news again.
  assert.equal(isSignInExpiryNews(ledger, "claude-work", ENDS + 30 * 24 * 60 * 60 * 1000, "soon", "notified"), true);
  ledger = withSignInExpiryMark(ledger, "claude-work", ENDS + 1, "soon", "notified", NOW);
  assert.deepEqual(ledger.harnesses["claude-work"], { expiresAt: ENDS + 1, notified: "soon" });
});

test("a synced record is validated, pruned and bounded", () => {
  const ledger = sanitizeSignInExpiryLedger(JSON.stringify({
    version: 1,
    harnesses: {
      claude: { expiresAt: ENDS, notified: "imminent", dismissed: "loud" },
      "../escape": { expiresAt: ENDS },
      old: { expiresAt: NOW - 40 * 24 * 60 * 60 * 1000, notified: "ended" },
      broken: { expiresAt: "soon" },
      ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`extra-${index}`, { expiresAt: ENDS - index }])),
    },
  }), NOW);
  assert.deepEqual(ledger.harnesses.claude, { expiresAt: ENDS, notified: "imminent" });
  assert.equal(ledger.harnesses["../escape"], undefined);
  assert.equal(ledger.harnesses.old, undefined);
  assert.equal(ledger.harnesses.broken, undefined);
  assert.equal(Object.keys(ledger.harnesses).length, 32);
  assert.deepEqual(sanitizeSignInExpiryLedger("not json", NOW), { version: 1, harnesses: {} });
  assert.deepEqual(sanitizeSignInExpiryLedger([1, 2], NOW), { version: 1, harnesses: {} });
});
