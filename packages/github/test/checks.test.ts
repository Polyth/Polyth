import { test } from "node:test";
import assert from "node:assert/strict";
import { anyCheckPending, normalizeCheck, summarizeChecks, type RollupEntry } from "@polyth/github";
import type { PrCheck } from "@polyth/contracts";

const check = (name: string, status: PrCheck["status"]): PrCheck => ({ id: name, name, status });

test("normalizeCheck maps CheckRun status+conclusion", () => {
  const cases: Array<[RollupEntry, string]> = [
    [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }, "success"],
    [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }, "failure"],
    [{ name: "build", status: "COMPLETED", conclusion: "SKIPPED" }, "skipped"],
    [{ name: "build", status: "COMPLETED", conclusion: "TIMED_OUT" }, "timed_out"],
    [{ name: "build", status: "COMPLETED", conclusion: "ACTION_REQUIRED" }, "action_required"],
    [{ name: "build", status: "IN_PROGRESS" }, "in_progress"],
    [{ name: "build", status: "QUEUED" }, "queued"],
  ];
  for (const [entry, expected] of cases) {
    assert.equal(normalizeCheck(entry, 0).status, expected, JSON.stringify(entry));
  }
});

test("normalizeCheck maps legacy StatusContext state and keeps name from context", () => {
  const c = normalizeCheck({ context: "ci/legacy", state: "ERROR", targetUrl: "http://x" }, 3);
  assert.equal(c.name, "ci/legacy");
  assert.equal(c.status, "failure");
  assert.equal(c.url, "http://x");
  const pending = normalizeCheck({ context: "ci/wait", state: "PENDING" }, 0);
  assert.equal(pending.status, "queued");
});

test("rerun with the same name gets a distinct id via index", () => {
  const a = normalizeCheck({ name: "tests", status: "COMPLETED", conclusion: "FAILURE" }, 0);
  const b = normalizeCheck({ name: "tests", status: "COMPLETED", conclusion: "SUCCESS" }, 1);
  assert.notEqual(a.id, b.id);
});

test("summarizeChecks is failure-first, then running, then success", () => {
  const mixed = summarizeChecks([
    check("a", "success"), check("b", "failure"), check("c", "in_progress"), check("d", "skipped"),
  ]);
  assert.equal(mixed.headline, "1 failing");
  assert.equal(mixed.state, "failure");
  assert.deepEqual(mixed.groups.map((g) => g.id), ["failed", "running", "succeeded", "skipped"]);

  const running = summarizeChecks([check("a", "success"), check("b", "queued")]);
  assert.equal(running.headline, "1 running");
  assert.equal(running.state, "pending");

  const green = summarizeChecks([check("a", "success"), check("b", "success")]);
  assert.equal(green.headline, "All 2 checks passed");
  assert.equal(green.state, "success");
});

test("summarizeChecks: empty, all skipped, and skipped required check keeps its name", () => {
  const empty = summarizeChecks([]);
  assert.equal(empty.headline, "No checks reported");
  assert.equal(empty.state, "none");
  assert.deepEqual(empty.groups, []);

  const skipped = summarizeChecks([check("required-lint", "skipped"), check("b", "neutral")]);
  assert.equal(skipped.headline, "All 2 checks skipped");
  assert.equal(skipped.state, "none");
  assert.equal(skipped.groups[0]?.checks[0]?.name, "required-lint");

  const partial = summarizeChecks([check("a", "success"), check("b", "skipped")]);
  assert.equal(partial.headline, "1 of 2 passed");
  assert.equal(partial.state, "success");
});

test("anyCheckPending drives polling only while nonterminal checks exist", () => {
  assert.equal(anyCheckPending([check("a", "queued")]), true);
  assert.equal(anyCheckPending([check("a", "in_progress"), check("b", "success")]), true);
  assert.equal(anyCheckPending([check("a", "failure"), check("b", "success")]), false);
  assert.equal(anyCheckPending([]), false);
});
