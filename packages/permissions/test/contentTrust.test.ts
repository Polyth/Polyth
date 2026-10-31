import assert from "node:assert/strict";
import test from "node:test";
import {
  contentTrustMatches,
  issueContentTrustReceipt,
  type ContentTrustSubject,
} from "../src/index.ts";

const subject: ContentTrustSubject = {
  spaceId: "space-1",
  projectId: "project-1",
  sourceKind: "agents-loop",
  sourceIdentity: "/repo/.agents/loops/review.md",
  contentDigest: "a".repeat(64),
  semanticDigest: "b".repeat(64),
};

test("content trust receipt matches only the exact subject and scope", () => {
  const receipt = issueContentTrustReceipt(subject, "current-version", 123);
  assert.equal(receipt.approvedAt, 123);
  assert.equal(contentTrustMatches(receipt, subject), true);
  assert.equal(contentTrustMatches(receipt, subject, "current-version"), true);
  assert.equal(contentTrustMatches(receipt, subject, "once"), false);

  for (const patch of [
    { spaceId: "space-2" },
    { projectId: "project-2" },
    { sourceKind: "project-command" },
    { sourceIdentity: "/repo/.agents/loops/other.md" },
    { contentDigest: "c".repeat(64) },
    { semanticDigest: "d".repeat(64) },
  ] satisfies Array<Partial<ContentTrustSubject>>) {
    assert.equal(contentTrustMatches(receipt, { ...subject, ...patch }), false);
  }
});

test("malformed/incomplete subjects cannot issue receipts", () => {
  assert.throws(
    () => issueContentTrustReceipt({ ...subject, contentDigest: "" }, "current-version"),
    /incomplete/,
  );
});
