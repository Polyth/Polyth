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

test("browser actions mirror the controlled-browser API as the agent actor", () => {
  assert.deepEqual(buildControlRequest("browser.session.list", { projectId: "p1", spaceId: "space-1" }), {
    method: "GET",
    path: "/api/browser/sessions?projectId=p1",
    spaceId: "space-1",
  });
  assert.deepEqual(buildControlRequest("browser.session.open", {
    projectId: "p1",
    url: "https://example.com",
    sessionId: "s1",
    spaceId: "space-1",
  }), {
    method: "POST",
    path: "/api/browser/sessions",
    body: { projectId: "p1", url: "https://example.com", sessionId: "s1", actor: "agent" },
    spaceId: "space-1",
  });
  assert.deepEqual(buildControlRequest("browser.navigate", { browserSessionId: "b/1", url: "https://example.com" }), {
    method: "POST",
    path: "/api/browser/sessions/b%2F1/navigate",
    body: { url: "https://example.com", actor: "agent" },
  });
  assert.deepEqual(buildControlRequest("browser.action", {
    browserSessionId: "b1",
    action: { kind: "click", target: { selector: "#go" } },
  }), {
    method: "POST",
    path: "/api/browser/sessions/b1/actions",
    body: { action: { kind: "click", target: { selector: "#go" } }, actor: "agent" },
  });
  assert.throws(() => buildControlRequest("browser.action", { browserSessionId: "b1", action: { text: "x" } }), /kind/);
  assert.deepEqual(buildControlRequest("browser.observe", { browserSessionId: "b1", includeScreenshot: true }), {
    method: "POST",
    path: "/api/browser/sessions/b1/observe",
    body: { includeScreenshot: true },
  });
  assert.deepEqual(buildControlRequest("browser.session.close", { browserSessionId: "b1" }), {
    method: "DELETE",
    path: "/api/browser/sessions/b1",
    body: {},
  });
  assert.equal(buildControlRequest("browser.approvals", { browserSessionId: "b1" }).path, "/api/browser/approvals?browserSessionId=b1");
  assert.throws(() => buildControlRequest("browser.session.open", {}), /projectId is required/);
  assert.throws(() => buildControlRequest("browser.navigate", { browserSessionId: "b1" }), /url is required/);

  // MCP is an agent client: it cannot pose as the user, resume a user's
  // take-control pause, or approve an origin for itself.
  assert.equal(buildControlRequest("browser.session.open", { projectId: "p1", actor: "user" }).body?.actor, "agent");
  assert.equal(buildControlRequest("browser.navigate", { browserSessionId: "b1", url: "https://example.com", actor: "user" }).body?.actor, "agent");
  const browserActions = Object.keys(ACTIONS).filter((name) => name.startsWith("browser."));
  assert.ok(browserActions.length >= 10);
  for (const name of browserActions) assert.equal(ACTIONS[name]?.group, "browser");
  assert.deepEqual(browserActions.filter((name) => /approv/i.test(name)), ["browser.approvals"]);
  assert.deepEqual(browserActions.filter((name) => /pause|auto/i.test(name)), []);
  const control = tools.find((tool) => tool.name === "control");
  assert.match(JSON.stringify(control?.inputSchema), /browser\.observe/);
});
