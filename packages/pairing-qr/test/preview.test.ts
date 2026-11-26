import test from "node:test";
import assert from "node:assert/strict";
import { isPairingLink, pairingLinkFromText, previewPairingLink } from "../src/index.ts";

test("pairing preview rejects oversized, control, and non-pair URLs", () => {
  assert.equal(isPairingLink("polyth://pair?v=1&t=abc"), true);
  assert.equal(previewPairingLink("https://evil.example/pair").ok, false);
  assert.equal(previewPairingLink("polyth://pair?v=1&t=abc\u0000").ok, false);
  assert.equal(previewPairingLink("polyth://pair?v=1&t=" + "A".repeat(20_000)).ok, false);
});

test("a pairing link is found anywhere in pasted text and normalized", () => {
  const canonical = "polyth://pair?v=1&t=abc_DEF-123";
  for (const raw of [
    canonical,
    "polyth://pair/?v=1&t=abc_DEF-123",
    "https://polyth.app/join#v=1&t=abc_DEF-123",
    "https://polyth.app/join/#v=1&t=abc_DEF-123",
    `Open Polyth to join the team: ${canonical} — see you there.`,
    `Hi! Your invitation:\nhttps://polyth.app/join#v=1&t=abc_DEF-123\nIt expires in 7 days.\n`,
    "https://example.com/redirect?next=https://polyth.app/join#v=1&t=abc_DEF-123",
  ]) {
    assert.equal(pairingLinkFromText(raw), canonical, raw);
  }
});

test("a pairing link is not invented from lookalikes, other schemes or other paths", () => {
  for (const raw of [
    "",
    "no link here",
    "http://polyth.app/join#v=1&t=abc",
    "http://polyth.app/join/#v=1&t=abc",
    "https://polyth.app.evil.example/join#v=1&t=abc",
    "https://polyth.app/other#v=1&t=abc",
    "https://polyth.app/join#t=abc&v=1",
    "https://polyth.app/join#v=2&t=abc",
    "polyth://pair?v=1&t=",
    "polyth://pair?v=1&t=abc/def",
    "polyth://pair?v=1&t=abc\u0000",
    "polyth://pair?v=1&t=" + "A".repeat(20_000),
    "xpolyth://pair?v=1&t=abc",
  ]) {
    assert.equal(pairingLinkFromText(raw), null, raw);
  }
});
