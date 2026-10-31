import test from "node:test";
import assert from "node:assert/strict";
import { friendlyError } from "../src/settings.ts";
import { tr } from "../src/i18n/index.ts";

// The host owns the user-facing phrasing for action failures. A gateway/proxy
// can answer with a full HTML page; that page must never reach the banner.
test("friendlyError strips a gateway HTML body", () => {
  const page = "HTTP 504 Gateway Time-out — <html>\n<head><title>504 Gateway Time-out</title></head>\n<body><center><h1>504 Gateway Time-out</h1></center></body></html>";
  assert.equal(friendlyError("Generate", new Error(page)), "Generate: HTTP 504 Gateway Time-out");
});

test("friendlyError handles an HTML body separated by a hyphen", () => {
  const raw = "HTTP 504 - <html><head><title>504 Gateway Time-out</title></head><body>nope</body></html>";
  const message = friendlyError("Generate", new Error(raw));
  assert.equal(message.includes("<"), false);
  assert.equal(message.includes(">"), false);
  assert.match(message, /^Generate: /);
});

test("friendlyError keeps the structured JSON detail", () => {
  const raw = 'HTTP 409 Conflict — {"error":"conflict","message":"Branch already exists"}';
  assert.equal(friendlyError("Create branch", new Error(raw)), "Create branch: HTTP 409 Conflict — Branch already exists");
});

test("friendlyError leaves ordinary messages untouched", () => {
  assert.equal(friendlyError("Load", new Error("offline")), "Load: offline");
});

test("friendlyError identifies an iOS transport failure as the Polyth connection", () => {
  // WKWebView rejects a dropped fetch with this message and no status; it must
  // not reach the banner as a raw "Load failed".
  assert.equal(friendlyError("Create session", new TypeError("Load failed")), `Create session: ${tr("settings.polythConnectionLost")}`);
  assert.equal(
    friendlyError("Create session", new TypeError("The network connection was lost.")),
    `Create session: ${tr("settings.polythConnectionLost")}`,
  );
});

test("generic unavailable and provider errors never claim recovery; unknown mutations never invite retry", () => {
  for (const component of ["auth", "provider", "storage", "server"]) {
    assert.equal(friendlyError("Send", Object.assign(new Error("service unavailable"), { component, status: 503 })), "Send: service unavailable");
  }
  assert.equal(friendlyError("Send", Object.assign(new Error("lost response"), { mutationOutcome: "unknown", recovery: "reconnecting" })), `Send: ${tr("settings.mutationOutcomeUnknown")}`);
  assert.equal(friendlyError("Read", Object.assign(new Error("lost"), { component: "harness-transport", recovery: "reconnecting" })), tr("settings.harnessReconnecting"));
});

test("friendlyError formats upstream JSON error payloads with status codes", () => {
  const raw = '402: {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}';
  assert.equal(
    friendlyError("Send", new Error(raw)),
    "Send: Upstream request failed: Insufficient account funds (HTTP 402)",
  );
});

test("friendlyError presents a deadline-aborted read as the lost connection", () => {
  // WebKit's message for any aborted fetch; it reached the phone as a raw toast.
  assert.equal(friendlyError("Error", new DOMException("Fetch is aborted", "AbortError")), `Error: ${tr("settings.polythConnectionLost")}`);
  assert.equal(friendlyError("Open session", new DOMException("The operation timed out.", "TimeoutError")), `Open session: ${tr("settings.polythConnectionLost")}`);
});

test("an unknown outcome is described without a session or draft that may not exist", () => {
  // The same helper reports archive, git, files and settings actions.
  const message = friendlyError("Archive", Object.assign(new Error("upstream outcome is unknown; reconciliation is required"), { code: "outcome-unknown" }));
  assert.equal(message, `Archive: ${tr("settings.mutationOutcomeUnknown")}`);
  assert.doesNotMatch(tr("settings.mutationOutcomeUnknown"), /draft|session|reconciliation/i);
});
