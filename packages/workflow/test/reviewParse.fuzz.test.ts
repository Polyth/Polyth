import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DISPUTES, MAX_DISPUTE_TEXT, MAX_FINDING_MESSAGE, MAX_REVIEW_FINDINGS,
  parseDisputes, parseReviewFindings, parseReviewVerdict,
} from "../src/review.ts";
import { assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["Verdict:", "verdict", "**Verdict**:", "approved", "not approved", "changes requested", "- [blocker] ", "* [Note] ", "1. [minor]", "[blocker]", "src/a.ts:12", "src/a.ts:12-30", "`path:1`", "**", "__", "Disputed:", " — ", " - ", "--", ": "];

test("review parsers never throw and respect their bounds", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const verdict = parseReviewVerdict(input);
    assert.ok(verdict === undefined || verdict === "approved" || verdict === "changes-requested");
    const findings = parseReviewFindings(input);
    assert.ok(findings.length <= MAX_REVIEW_FINDINGS);
    for (const finding of findings) {
      assert.ok(finding.message.length > 0 && finding.message.length <= MAX_FINDING_MESSAGE);
      assert.ok(finding.severity === "blocker" || finding.severity === "note");
      if (finding.line !== undefined) assert.ok(Number.isSafeInteger(finding.line));
    }
    const disputes = parseDisputes(input);
    assert.ok(disputes.length <= MAX_DISPUTES);
    for (const dispute of disputes) {
      assert.ok(dispute.finding && dispute.finding.length <= MAX_DISPUTE_TEXT);
      assert.ok(dispute.reason && dispute.reason.length <= MAX_DISPUTE_TEXT);
    }
  });
});


test("review parsers handle 50k repetitions of each token in bounded time", () => {
  assertBoundedTime(TOKENS, (input) => { parseReviewVerdict(input); parseReviewFindings(input); parseDisputes(input); });
});

// Finding (fixed): `- ` followed by ~40 `**` markers and no `[` backtracked exponentially in FINDING_LINE.
test("parseReviewFindings does not backtrack exponentially on emphasis runs", () => {
  for (const marker of ["**", "__", "*", "_", "`"]) {
    const started = performance.now();
    parseReviewFindings(`- ${marker.repeat(60)}x`);
    assert.ok(performance.now() - started < 200, `${marker} run too slow`);
  }
});
