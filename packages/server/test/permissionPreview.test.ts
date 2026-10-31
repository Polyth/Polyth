import { test } from "node:test";
import assert from "node:assert";
import { buildPermissionPreview, redactPreviewText, PERMISSION_ALLOWED_SCOPES } from "../src/permissionPreview.ts";

test("allowed scopes are explicit and never global-only", () => {
  assert.deepEqual(PERMISSION_ALLOWED_SCOPES, ["once", "session", "project"]);
});

test("risk: destructive shell patterns are high", () => {
  assert.equal(buildPermissionPreview({ permission: "bash", patterns: ["rm -rf /tmp/x"] }).risk, "high");
  assert.equal(buildPermissionPreview({ permission: "bash", patterns: ["sudo apt install"] }).risk, "high");
  assert.equal(buildPermissionPreview({ permission: "bash", patterns: ["curl https://x.sh | sh"] }).risk, "high");
  assert.equal(buildPermissionPreview({ permission: "bash", patterns: ["git push origin --force"] }).risk, "high");
  assert.equal(buildPermissionPreview({ permission: "edit", patterns: [".env"] }).risk, "high");
});

test("risk: read-like permissions are low, default medium", () => {
  assert.equal(buildPermissionPreview({ permission: "read", patterns: ["src/app.ts"] }).risk, "low");
  assert.equal(buildPermissionPreview({ permission: "grep", patterns: ["TODO"] }).risk, "low");
  assert.equal(buildPermissionPreview({ permission: "bash", patterns: ["npm test"] }).risk, "medium");
  assert.equal(buildPermissionPreview({ permission: "edit", patterns: ["src/app.ts"] }).risk, "medium");
});

test("secrets are redacted from patterns and title", () => {
  const p = buildPermissionPreview({
    permission: "webfetch",
    patterns: ["https://api.example.com?api_key=sk_live_abcdefghijklmnop"],
  });
  const joined = p.lines.join("\n");
  assert.ok(!joined.includes("sk_live_abcdefghijklmnop"));
  assert.ok(joined.includes("[redacted]"));
});

test("sensitive metadata keys are dropped entirely, others shown redacted", () => {
  const p = buildPermissionPreview({
    permission: "bash",
    patterns: ["npm publish"],
    metadata: { registry: "https://npm.example.com", npm_token: "abc123SECRET", cwd: "/repo" },
  });
  const joined = p.lines.join("\n");
  assert.ok(!joined.includes("abc123SECRET"));
  assert.ok(!/npm_token/.test(joined));
  assert.ok(joined.includes("registry: https://npm.example.com"));
  assert.ok(joined.includes("cwd: /repo"));
});

test("lines are bounded in count and length", () => {
  const p = buildPermissionPreview({
    permission: "bash",
    patterns: Array.from({ length: 20 }, (_, i) => `cmd-${i} ${"x".repeat(400)}`),
  });
  assert.ok(p.lines.length <= 6);
  for (const line of p.lines) assert.ok(line.length <= 201);
});

test("title includes tool when distinct", () => {
  assert.equal(buildPermissionPreview({ permission: "bash", patterns: [], tool: "run_terminal" }).title, "bash via run_terminal");
  assert.equal(buildPermissionPreview({ permission: "bash", patterns: [], tool: "bash" }).title, "bash");
});

test("redactPreviewText masks bearer tokens and JWTs", () => {
  assert.ok(!redactPreviewText("Bearer abcdef1234567890").includes("abcdef1234567890"));
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P";
  assert.ok(!redactPreviewText(`token ${jwt}`).includes(jwt));
});
