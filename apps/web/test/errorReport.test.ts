import test from "node:test";
import assert from "node:assert/strict";
import { errorReportText } from "../src/errorReport.ts";

const now = new Date("2026-11-09T12:00:00.000Z");

test("a server error report carries its diagnostics and the harness reason", () => {
  const error = Object.assign(new Error("upstream outcome is unknown; reconciliation is required"), {
    status: 409,
    code: "outcome-unknown",
    mutationOutcome: "unknown",
    component: "server",
    operation: "POST",
    requestId: "req-1",
    details: "Claude Code did not confirm the operation (Claude Code process exited with code 1)",
  });
  const report = errorReportText(error, { action: "Start a new chat", shown: "New chat not confirmed", now });
  assert.deepEqual(report.split("\n"), [
    "Polyth error report",
    "Time: 2026-11-09T12:00:00.000Z",
    "Action: Start a new chat",
    "Shown: New chat not confirmed",
    "Error: Error: upstream outcome is unknown; reconciliation is required",
    "HTTP status: 409",
    "Code: outcome-unknown",
    "Outcome: unknown",
    "Component: server",
    "Operation: POST",
    "Request id: req-1",
    "Details: Claude Code did not confirm the operation (Claude Code process exited with code 1)",
  ]);
});

test("a transport failure report names the engine error and its cause", () => {
  const error = new TypeError("Failed to fetch", { cause: new Error("net::ERR_BLOCKED_BY_CLIENT") });
  const report = errorReportText(error, { action: "Start a new chat", shown: "Connection dropped", now });
  assert.match(report, /^Error: TypeError: Failed to fetch$/m);
  assert.match(report, /^Cause: Error: net::ERR_BLOCKED_BY_CLIENT$/m);
  assert.doesNotMatch(report, /HTTP status/);
});

test("long values are clipped and non-Error values still report", () => {
  const report = errorReportText("x".repeat(2_000), { action: "Start a new chat", shown: "Oops", now });
  const line = report.split("\n").find((entry) => entry.startsWith("Error: "))!;
  assert.equal(line.length, "Error: ".length + 600 + 1);
  assert.ok(line.endsWith("…"));
});
