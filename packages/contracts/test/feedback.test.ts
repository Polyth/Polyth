import assert from "node:assert/strict";
import test from "node:test";

import { FEEDBACK_LIMITS, composeFeedback, feedbackStatus, parseFeedback, type FeedbackPayload } from "../src/feedback.ts";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const JPEG = "/9j/4AAQ";

function feedback(): FeedbackPayload {
  return {
    version: 1,
    feedbackId: "6f1c2b9e-4d3a-4c1b-9a8e-0123456789ab",
    install: "0123456789abcdef0123456789abcdef",
    createdAt: "2026-11-25T11:59:00.000Z",
    kind: "bug",
    text: "The composer jumps when I paste.",
    contact: "ann@example.com",
    consent: { technical: true, screenshot: true, profile: true, contact: true },
    basics: { version: "1.2.380", channel: "stable", edition: "standard", locale: "uk" },
    technical: {
      app: {
        version: "1.2.380", channel: "stable", edition: "standard", platform: "darwin", arch: "arm64",
        osVersion: "24.6.0", electron: "39.2.1", chromium: "142.0.7444.59", packaged: true, locale: "uk",
      },
      web: { build: "abc123", serverVersion: "1.2.380", view: "chat", viewport: { width: 1440, height: 900, scale: 2 } },
      settings: { "ui.theme": "midnight" },
      packages: [{ id: "voice-mode", version: "0.3.0" }],
      errors: [],
    },
    profile: { role: "lawyer", experience: "new" },
    screenshot: { type: "image/jpeg", width: 1600, height: 1000, data: JPEG },
  };
}

const minimal = (kind: FeedbackPayload["kind"] = "idea"): FeedbackPayload => ({
  ...feedback(),
  kind,
  contact: "",
  consent: { technical: false, screenshot: false, profile: false, contact: false },
  technical: null,
  profile: null,
  screenshot: null,
});

test("a complete feedback and a text-only one parse to equal copies", () => {
  assert.deepEqual(parseFeedback(structuredClone(feedback()), NOW), feedback());
  assert.deepEqual(parseFeedback(structuredClone(minimal()), NOW), minimal());
  for (const kind of ["bug", "idea", "pain", "praise"] as const) assert.ok(parseFeedback(minimal(kind), NOW), kind);
});

test("each optional part must match its consent flag, both ways", () => {
  const refuse = (value: unknown, label: string) => assert.equal(parseFeedback(value, NOW), null, label);
  refuse({ ...feedback(), consent: { ...feedback().consent, technical: false } }, "technical sent without consent");
  refuse({ ...minimal(), consent: { ...minimal().consent, technical: true } }, "technical consent without data");
  refuse({ ...feedback(), consent: { ...feedback().consent, profile: false } }, "profile sent without consent");
  refuse({ ...minimal(), consent: { ...minimal().consent, profile: true } }, "profile consent without data");
  refuse({ ...feedback(), consent: { ...feedback().consent, screenshot: false } }, "screenshot sent without consent");
  refuse({ ...minimal(), consent: { ...minimal().consent, screenshot: true } }, "screenshot consent without data");
  refuse({ ...feedback(), consent: { ...feedback().consent, contact: false } }, "contact sent without consent");
  refuse({ ...minimal(), consent: { ...minimal().consent, contact: true } }, "contact consent without contact");
});

test("the wire is exact and bounded", () => {
  const refuse = (mutate: (value: Record<string, any>) => void, label: string) => {
    const value = structuredClone(feedback()) as Record<string, any>;
    mutate(value);
    assert.equal(parseFeedback(value, NOW), null, label);
  };
  refuse((v) => { v.extra = 1; }, "unknown top-level field");
  refuse((v) => { v.profile.name = "Ann"; }, "unknown profile field");
  refuse((v) => { v.profile.role = "wizard"; }, "role outside the list");
  refuse((v) => { v.profile.experience = "expert"; }, "experience outside the list");
  refuse((v) => { v.kind = "rant"; }, "unknown kind");
  refuse((v) => { v.text = "   "; }, "blank text");
  refuse((v) => { v.text = "x".repeat(FEEDBACK_LIMITS.textChars + 1); }, "text over the limit");
  refuse((v) => { v.contact = "two words"; }, "contact with a space");
  refuse((v) => { v.contact = "a".repeat(FEEDBACK_LIMITS.contactChars + 1); }, "contact over the limit");
  refuse((v) => { v.basics.channel = "nightly"; }, "channel disagrees with the version");
  refuse((v) => { v.technical.app.version = "1.2.381"; }, "technical and basics describe different builds");
  refuse((v) => { v.createdAt = "2026-11-10T12:00:00.000Z"; }, "older than the outbox allows");
  refuse((v) => { v.install = "short"; }, "install id shape");
  refuse((v) => { v.feedbackId = "not-a-uuid"; }, "feedback id shape");
  refuse((v) => { v.screenshot.data = "not base64!"; }, "screenshot bytes");
  assert.equal(parseFeedback("nope", NOW), null);
  assert.equal(parseFeedback(null, NOW), null);
});

test("a handle is a valid contact; a technical block may carry a browser app", () => {
  assert.ok(parseFeedback({ ...feedback(), contact: "octo-cat" }, NOW));
  assert.ok(parseFeedback({ ...feedback(), contact: "@octo-cat" }, NOW));
  const value = structuredClone(feedback()) as Record<string, any>;
  value.technical.app = {
    client: "browser", version: "1.2.380", channel: "stable", edition: "standard", platform: "ios",
    browser: "Safari 18", serverPlatform: "linux", serverArch: "x64", locale: "uk",
  };
  assert.ok(parseFeedback(value, NOW));
});

test("statuses", () => {
  assert.equal(feedbackStatus("received"), 200);
  assert.equal(feedbackStatus("invalid"), 400);
  assert.equal(feedbackStatus("rate"), 429);
  assert.equal(feedbackStatus("unavailable"), 503);
});

test("composeFeedback derives consent from presence and picks the pseudonym", () => {
  const full = feedback();
  const input = {
    now: NOW,
    feedbackId: full.feedbackId,
    kind: "bug",
    text: "  The composer jumps.  ",
    contact: " ann@example.com ",
    basics: full.basics,
    technical: full.technical,
    profile: full.profile,
    screenshot: full.screenshot,
    dailyInstall: "d".repeat(32),
    personInstall: "b".repeat(32),
  };
  const known = composeFeedback(input);
  assert.ok(known);
  assert.equal(known.install, "b".repeat(32), "a person who shares a profile or contact is one stable pseudonym");
  assert.equal(known.text, "The composer jumps.");
  assert.equal(known.contact, "ann@example.com");
  assert.deepEqual(known.consent, { technical: true, screenshot: true, profile: true, contact: true });

  const anonymous = composeFeedback({ ...input, contact: "", profile: null, technical: null, screenshot: null, kind: "idea" });
  assert.ok(anonymous);
  assert.equal(anonymous.install, "d".repeat(32), "otherwise the pseudonym changes every day");
  assert.deepEqual(anonymous.consent, { technical: false, screenshot: false, profile: false, contact: false });

  assert.equal(composeFeedback({ ...input, text: "   " }), null, "blank text");
  assert.equal(composeFeedback({ ...input, kind: "rant" }), null, "unknown kind");
  assert.equal(composeFeedback({ ...input, profile: { role: "wizard", experience: "new" } }), null, "profile outside the lists");
  assert.equal(composeFeedback({ ...input, contact: 5, profile: null })?.consent.contact, false, "a non-string contact counts as none");
});
