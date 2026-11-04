import test from "node:test";
import assert from "node:assert/strict";
import {
  liveActivitySessionFromUrl,
  normalizeLiveActivitySnapshot,
  normalizeLiveActivityTexts,
  parseLiveActivityPushToken,
  type LiveActivitySnapshot,
} from "../src/liveActivityPayload.ts";
import { mobileDeepLinkPath } from "../src/runtime.ts";

test("the payload is bounded and an invalid one is refused", () => {
  const base: LiveActivitySnapshot = {
    state: "working", sessionId: "ses_1", title: "x".repeat(500), detail: "line\none\u0007", label: "Working",
    summary: "", staleHint: "Open", done: 5, total: 2,
  };
  const normalized = normalizeLiveActivitySnapshot(base)!;
  assert.equal(Array.from(normalized.title).length, 120);
  assert.equal(normalized.detail, "line one");
  assert.equal(normalized.done, 2);
  assert.equal(normalizeLiveActivitySnapshot({ ...base, sessionId: "../x" }), undefined);
  assert.equal(normalizeLiveActivitySnapshot({ ...base, state: "unread" as never }), undefined);
  assert.equal(normalizeLiveActivitySnapshot({ ...base, title: "  " }), undefined);
});

test("the tap URL is private to the publishing page, not a general deep link", () => {
  assert.equal(liveActivitySessionFromUrl("polyth://live-activity/ses_1"), "ses_1");
  assert.equal(liveActivitySessionFromUrl("polyth://live-activity/ses_1?x=1"), undefined);
  assert.equal(liveActivitySessionFromUrl("polyth://session/ses_1"), undefined);
  assert.equal(liveActivitySessionFromUrl("https://live-activity/ses_1"), undefined);
  assert.equal(liveActivitySessionFromUrl("polyth://live-activity/%2E%2E%2Fx"), undefined);
  // The hub's deep-link router must ignore it, so it never reloads into a server picker.
  assert.equal(mobileDeepLinkPath("polyth://live-activity/ses_1"), undefined);
});

test("push texts are bounded per line and capped at 99 counts", () => {
  const texts = normalizeLiveActivityTexts({
    labels: { "needs-approval": "Approve", "needs-reply": "Reply\nneeded", working: "w".repeat(80), failed: "Failed", done: "Done" },
    waiting: Array.from({ length: 120 }, (_, i) => `${i + 1} waiting`),
    working: ["1 working"],
  });
  assert.equal(texts.labels["needs-reply"], "Reply needed");
  assert.equal(Array.from(texts.labels.working).length, 48);
  assert.equal(texts.waiting.length, 99);
  assert.equal(texts.waiting[98], "99 waiting");
});

test("a push token is accepted only as APNs hex with a known environment", () => {
  const token = { providerToken: "ab".repeat(40), environment: "production" };
  assert.deepEqual(parseLiveActivityPushToken({ ...token, extra: 1 }), token);
  assert.equal(parseLiveActivityPushToken({ ...token, providerToken: "AB".repeat(40) }), undefined);
  assert.equal(parseLiveActivityPushToken({ ...token, providerToken: "ab" }), undefined);
  assert.equal(parseLiveActivityPushToken({ ...token, environment: "staging" }), undefined);
});
