import test from "node:test";
import assert from "node:assert/strict";

import { ACTIONS, buildControlRequest, tools } from "../src/index.ts";

test("MCP tool names do not duplicate the Polyth server prefix", () => {
  assert.deepEqual(tools.map((tool) => tool.name), ["capabilities", "configure", "control"]);
});

test("session.create requires and normalizes a human-readable title", () => {
  assert.throws(
    () => buildControlRequest("session.create", { projectId: "p1" }),
    /title is required/,
  );
  assert.throws(
    () => buildControlRequest("session.create", { projectId: "p1", title: "   " }),
    /title is required/,
  );
  assert.throws(
    () => buildControlRequest("session.create", { projectId: "p1", title: "x".repeat(121) }),
    /120 characters or fewer/,
  );
  assert.deepEqual(buildControlRequest("session.create", {
    projectId: "p1",
    title: "  Fix   mobile navigation  ",
    message: "Audit and fix the mobile project navigator.",
    spaceId: "space-1",
  }), {
    method: "POST",
    path: "/api/agent/sessions",
    body: {
      projectId: "p1",
      title: "Fix mobile navigation",
      message: "Audit and fix the mobile project navigator.",
    },
    spaceId: "space-1",
  });

  const control = tools.find((tool) => tool.name === "control");
  assert.match(JSON.stringify(control?.inputSchema), /session\.create/);
  assert.match(JSON.stringify(control?.inputSchema), /"required":\["title"\]/);
});

test("control catalog covers the complete session lifecycle and safe API escape hatch", () => {
  assert.ok(Object.keys(ACTIONS).length >= 50);
  assert.deepEqual(buildControlRequest("session.send", {
    sessionId: "s/1",
    text: "continue",
    delivery: "steer",
    model: { providerID: "command-code", modelID: "gpt-5.6-terra" },
    spaceId: "space-1",
  }), {
    method: "POST",
    path: "/api/agent/sessions/s%2F1/messages",
    body: {
      text: "continue",
      delivery: "steer",
      model: { providerID: "command-code", modelID: "gpt-5.6-terra" },
    },
    spaceId: "space-1",
  });
  assert.deepEqual(buildControlRequest("secret.dismiss", {
    sessionId: "s1", requestId: "r1", value: "must-not-leak",
  }).body, { action: "dismiss" });
  assert.throws(
    () => buildControlRequest("api.request", { path: "/api/sessions/s1/secrets/r1", method: "POST", body: { value: "x" } }),
    /non-auth, non-secret/,
  );
  assert.throws(
    () => buildControlRequest("api.request", { path: "/api/secure-safe", method: "POST", body: { value: "x" } }),
    /non-auth, non-secret/,
  );
});
