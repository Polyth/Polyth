import test from "node:test";
import assert from "node:assert/strict";
import { descendants, matchDispute, parseDisputes, parseReviewFindings, parseReviewVerdict, reworkTargets, verdictFromFindings } from "../src/review.ts";
import { buildNodePrompt, buildReworkPrompt } from "../src/prompt.ts";

test("the verdict line is read from the end of a report in its common shapes", () => {
  assert.equal(parseReviewVerdict("Looks right.\n\nVerdict: approved"), "approved");
  assert.equal(parseReviewVerdict("- Verdict: APPROVED."), "approved");
  assert.equal(parseReviewVerdict("**Verdict:** Changes requested."), "changes-requested");
  assert.equal(parseReviewVerdict("Verdict: not approved"), "changes-requested", "a negation is not an approval");
  assert.equal(parseReviewVerdict("Verdict: needs work on the tests"), "changes-requested");
  assert.equal(parseReviewVerdict("Verdict：通过 approved"), "approved", "a full-width colon is tolerated");
  assert.equal(
    parseReviewVerdict("Verdict: changes requested\n\nAfter re-checking:\n\nVerdict: approved"),
    "approved",
    "the last verdict line wins",
  );
  assert.equal(parseReviewVerdict("No verdict here, just prose about approvals."), undefined);
  assert.equal(parseReviewVerdict("Verdict: hmm"), undefined, "an unreadable verdict never sends work back");
  assert.equal(parseReviewVerdict(""), undefined);
});

test("a review sends work back only to the executors directly before it", () => {
  const graph = {
    nodes: [
      { id: "lead", role: "Lead", prompt: "plan", kind: "lead" as const },
      { id: "a", role: "A", prompt: "build", kind: "worker" as const },
      { id: "b", role: "B", prompt: "build" },
      { id: "first-review", role: "First", prompt: "review", kind: "review" as const },
      { id: "review", role: "Reviewer", prompt: "review", kind: "review" as const },
      { id: "final", role: "Final", prompt: "finish" },
    ],
    edges: [
      { id: "lead-a", source: "lead", target: "a" },
      { id: "lead-b", source: "lead", target: "b" },
      { id: "a-review", source: "a", target: "review" },
      { id: "b-review", source: "b", target: "review" },
      { id: "lead-review", source: "lead", target: "review" },
      { id: "first-review-review", source: "first-review", target: "review" },
      { id: "review-final", source: "review", target: "final" },
    ],
  };
  assert.deepEqual(reworkTargets(graph, "review").sort(), ["a", "b"], "leads and other reviews are not reworked; an untagged unit is an executor");
  assert.deepEqual(reworkTargets(graph, "first-review"), []);
  assert.deepEqual([...descendants(graph, ["a"])].sort(), ["final", "review"]);
});

test("review units are told to end with a verdict and rework turns stay short when resumed", () => {
  const review = { id: "review", role: "Reviewer", prompt: "Inspect the diff.", kind: "review" as const };
  const worker = { id: "build", role: "Builder", prompt: "Build it.", kind: "worker" as const };
  assert.match(buildNodePrompt(review, "Ship it"), /# Review verdict[\s\S]*`Verdict: approved` or `Verdict: changes requested`/);
  assert.doesNotMatch(buildNodePrompt(worker, "Ship it"), /# Review verdict/);

  const findings = [{ node: review, output: "1. Gallery icon is still a box.\n\nVerdict: changes requested", sessionId: "review-child", direct: true }];
  const resumed = buildReworkPrompt(worker, "Ship it", { round: 2, sources: findings, resumed: true });
  assert.match(resumed, /# Rework \(round 2\)/);
  assert.match(resumed, /Gallery icon is still a box/);
  assert.match(resumed, /review-child/);
  assert.doesNotMatch(resumed, /# Role/, "a resumed session already holds the brief");

  const fresh = buildReworkPrompt(worker, "Ship it", { round: 2, sources: findings, resumed: false, previousOutput: "Built v1." }, { sources: [] });
  assert.match(fresh, /# Role\n\nBuilder/, "a fresh session receives the brief again");
  assert.match(fresh, /# Your previous report \(round 1\)\n\nBuilt v1\./);

  const reReview = buildReworkPrompt(review, "Ship it", {
    round: 2, resumed: true,
    sources: [{ node: worker, output: "Replaced the box icon with the gallery glyph.", direct: true }],
  });
  assert.match(reReview, /# Re-review \(round 2\)/);
  assert.match(reReview, /# Rework reports[\s\S]*Replaced the box icon/);
  assert.match(reReview, /`Verdict: approved` or `Verdict: changes requested`/);
});

test("findings: severity words, synonyms, emphasis, case and locations", () => {
  const findings = parseReviewFindings([
    "Summary prose that mentions a blocker in passing.",
    "- [blocker] src/a.ts:12 — null deref when the list is empty",
    "* **[Critical]** `src/b.ts:3-9`: loop never ends",
    "1. [MUST-FIX] lib/c.ts - missing await",
    "- `[major]` no path but a message",
    "- [warning] src/d.ts:7 – unused import",
    "- [Nit] style only",
    "- _[suggestion]_ docs/e.md:2 — add an example",
    "- [optional] could be shorter",
    "- an ordinary bullet that is not a finding",
    "Verdict: changes requested",
  ].join("\n"));
  assert.deepEqual(findings.map((f) => [f.severity, f.path, f.line, f.message]), [
    ["blocker", "src/a.ts", 12, "null deref when the list is empty"],
    ["blocker", "src/b.ts", 3, "loop never ends"],
    ["blocker", "lib/c.ts", undefined, "missing await"],
    ["blocker", undefined, undefined, "no path but a message"],
    ["note", "src/d.ts", 7, "unused import"],
    ["note", undefined, undefined, "style only"],
    ["note", "docs/e.md", 2, "add an example"],
    ["note", undefined, undefined, "could be shorter"],
  ]);
});

test("plain bullets with a severity word are prose, so the verdict line decides", () => {
  const report = [
    "- Note: I could not run the tests",
    "- Warning: flaky CI",
    "1. Major refactor needed in the loader",
    "- Critical: the loader still leaks handles",
    "",
    "Verdict: changes requested",
  ].join("\n");
  assert.deepEqual(parseReviewFindings(report), []);
  assert.equal(verdictFromFindings(parseReviewFindings(report)), undefined);
  assert.equal(parseReviewVerdict(report), "changes-requested");
});

test("findings: bounded in count and message length, empty messages dropped", () => {
  const many = Array.from({ length: 50 }, (_, index) => `- [blocker] f${index}.ts:1 — problem ${index}`).join("\n");
  assert.equal(parseReviewFindings(many).length, 30);
  assert.equal(parseReviewFindings(`- [blocker] a.ts:1 — ${"x".repeat(1_000)}`)[0]!.message.length, 400);
  assert.deepEqual(parseReviewFindings("- [blocker] a.ts:1 —"), []);
  assert.deepEqual(parseReviewFindings(""), []);
});

test("the blockers decide, whatever the verdict line says", () => {
  assert.equal(verdictFromFindings([]), undefined);
  assert.equal(verdictFromFindings(parseReviewFindings("- [note] a — b")), "approved");
  assert.equal(verdictFromFindings(parseReviewFindings("- [note] a — b\n- [blocker] c — d")), "changes-requested");
});

test("disputes: one per line with a reason, bounded", () => {
  assert.deepEqual(parseDisputes("Done.\n\nDisputed: cache key tenant — already scoped upstream\n- **Disputed:** retry loop - intentional\nDisputed: no reason here"), [
    { finding: "cache key tenant", reason: "already scoped upstream" },
    { finding: "retry loop", reason: "intentional" },
  ]);
  const many = Array.from({ length: 50 }, (_, index) => `Disputed: item ${index} — reason`).join("\n");
  assert.equal(parseDisputes(many).length, 30);
  assert.equal(parseDisputes(`Disputed: a — ${"y".repeat(900)}`)[0]!.reason.length, 400);
});

test("a dispute matches by path or shared words and otherwise stays unanswered", () => {
  const disputes = [
    { finding: "cache key tenant", reason: "scoped upstream" },
    { finding: "src/retry.ts", reason: "intentional" },
  ];
  assert.equal(matchDispute({ message: "the cache key ignores the tenant" }, disputes)?.reason, "scoped upstream");
  assert.equal(matchDispute({ path: "src/retry.ts", message: "wrong" }, disputes)?.reason, "intentional");
  assert.equal(matchDispute({ message: "unrelated problem entirely" }, disputes), undefined);
  // Words everyone uses never make a match.
  assert.equal(matchDispute({ message: "this is not the right place for that with the other" },
    [{ finding: "the build is flaky for this and that", reason: "unrelated" }]), undefined);
});
