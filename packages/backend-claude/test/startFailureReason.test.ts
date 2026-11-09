import test from "node:test";
import assert from "node:assert/strict";
import { claudeStartFailureReason } from "../src/index.ts";

test("a start failure names Claude Code's own last stderr lines, on one line", () => {
  assert.equal(
    claudeStartFailureReason(
      "Claude Code process exited with code 1",
      "loading settings\n\nError: gateway refused model work-sonnet\n  status 403\n",
    ),
    "Claude Code process exited with code 1 (stderr: loading settings · Error: gateway refused model work-sonnet · status 403)",
  );
});

test("secrets on stderr are redacted and an empty stderr adds nothing", () => {
  assert.equal(
    claudeStartFailureReason("exited", "Authorization failed for Bearer abcdefghijklmnop1234"),
    "exited (stderr: Authorization failed for Bearer [redacted])",
  );
  assert.equal(claudeStartFailureReason("exited", " \n\n"), "exited");
});

test("a long stderr keeps its end, where the reason is", () => {
  const reason = claudeStartFailureReason("exited", `${"x".repeat(1_000)} final cause`);
  assert.ok(reason.endsWith("final cause)"));
  assert.ok(reason.length <= "exited (stderr: )".length + 300);
});
