import { test } from "node:test";
import assert from "node:assert/strict";
import { browserRequestKey, isBrowserRequestForSession, isBrowserToolRequest, shouldAutoRevealBrowserRequest } from "../widgets/browserReveal.ts";

const event = (type: string, data: Record<string, unknown> = {}): any => ({
  id: "ev-1", sessionId: "session-a", seq: 1, time: 1, type, data, v: 1,
});

test("browser reveal recognizes the pre-authorization package request", () => {
  const request = event("package-tool/requested", {
    toolId: "browser.polyth-browser", toolName: "Browser", owner: "browser",
  });
  assert.equal(isBrowserToolRequest(request), true);
  assert.equal(isBrowserRequestForSession(request, "session-a"), true);
  assert.equal(isBrowserRequestForSession(request, "session-b"), false);
});

test("background is quiet by default and auto-show is opt-in for the active session", () => {
  const request = event("package-tool/requested", { toolId: "browser.polyth-browser", owner: "browser" });
  assert.equal(shouldAutoRevealBrowserRequest(request, "session-a", "background"), false);
  assert.equal(shouldAutoRevealBrowserRequest(request, "session-a", "auto-show"), true);
  assert.equal(shouldAutoRevealBrowserRequest(request, "session-b", "auto-show"), false);
});

test("browser reveal recognizes existing tool lifecycle events and ignores unrelated tools", () => {
  assert.equal(isBrowserToolRequest(event("tool/call", { tool: "browser.polyth-browser", callId: "c1" })), true);
  assert.equal(isBrowserToolRequest(event("tool/started", { tool: "browser.snapshot", callId: "c1" })), true);
  assert.equal(isBrowserToolRequest(event("tool/call", { tool: "shell", callId: "c2" })), false);
  assert.equal(isBrowserToolRequest(event("permission/requested", { tool: "browser.polyth-browser" })), false);
});

test("browser request keys deduplicate call lifecycle notifications", () => {
  const call = event("tool/call", { tool: "browser.polyth-browser", callId: "c1" });
  const started = event("tool/started", { tool: "browser.polyth-browser", callId: "c1" });
  assert.equal(browserRequestKey(call), browserRequestKey(started));
});
