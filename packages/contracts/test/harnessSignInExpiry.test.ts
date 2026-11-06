import assert from "node:assert/strict";
import { test } from "node:test";
import { HARNESS_SIGN_IN_IMMINENT_MS, HARNESS_SIGN_IN_SOON_MS, harnessSignInExpiry } from "@polyth/contracts";

const NOW = Date.UTC(2026, 10, 4, 12);

test("a sign-in end is soon from 10 days, imminent in the last 48 hours and ended after", () => {
    assert.deepEqual(harnessSignInExpiry(undefined, NOW), { level: "none" });
    assert.deepEqual(harnessSignInExpiry(Number.NaN, NOW), { level: "none" });
    assert.equal(harnessSignInExpiry(NOW + HARNESS_SIGN_IN_SOON_MS + 1, NOW).level, "none");
    assert.equal(harnessSignInExpiry(NOW + HARNESS_SIGN_IN_SOON_MS, NOW).level, "soon");
    assert.equal(harnessSignInExpiry(NOW + HARNESS_SIGN_IN_IMMINENT_MS + 1, NOW).level, "soon");
    assert.equal(harnessSignInExpiry(NOW + HARNESS_SIGN_IN_IMMINENT_MS, NOW).level, "imminent");
    assert.equal(harnessSignInExpiry(NOW + 1, NOW).level, "imminent");
    assert.deepEqual(harnessSignInExpiry(NOW, NOW), { level: "ended", remainingMs: 0 });
    assert.deepEqual(harnessSignInExpiry(NOW - 5, NOW), { level: "ended", remainingMs: -5 });
});
