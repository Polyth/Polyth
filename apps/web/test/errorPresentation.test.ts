import test from "node:test";
import assert from "node:assert/strict";
import { classifyUiError, isRequestAbort, isTransportFailure, presentUiError } from "../src/errorPresentation.ts";
import { tr } from "../src/i18n/index.ts";

test("classifies a failure family from the message", () => {
  assert.equal(classifyUiError("Connection lost"), "network");
  assert.equal(classifyUiError("fetch failed"), "network");
  assert.equal(classifyUiError("HTTP 503 Service Unavailable"), "network");
  assert.equal(classifyUiError("Permission denied"), "auth");
  assert.equal(classifyUiError("401 Unauthorized"), "auth");
  assert.equal(classifyUiError("Failed to save file"), "storage");
  assert.equal(classifyUiError("No space left on device"), "storage");
  assert.equal(classifyUiError("HTTP 500 Internal Server Error"), "server");
  assert.equal(classifyUiError("Backend unavailable"), "server");
  assert.equal(classifyUiError("Antigravity couldn’t start"), "error");
  assert.equal(classifyUiError("Operation not supported"), "blocked");
  assert.equal(classifyUiError("Something broke"), "error");
});

test("transport symptoms win over the operation that failed", () => {
  assert.equal(classifyUiError("Couldn’t connect to the server"), "network");
});

test("recognizes a transport loss by engine phrasing, not by error name", () => {
  // iOS/WKWebView — the Capacitor shell included — reports a rejected
  // fetch/XHR/module request with this bare message instead of a status.
  assert.equal(isTransportFailure(new TypeError("Load failed")), true);
  assert.equal(isTransportFailure(new TypeError("Load failed: The network connection was lost.")), true);
  assert.equal(isTransportFailure(new TypeError("The Internet connection appears to be offline.")), true);
  assert.equal(isTransportFailure(new TypeError("net::ERR_CONNECTION_REFUSED")), true);
  assert.equal(isTransportFailure(new TypeError("NetworkError when attempting to fetch resource.")), true);
  // The app's own "no HTTP status" sentinel from httpStatusOf.
  assert.equal(isTransportFailure(Object.assign(new Error("request lost"), { status: 0 })), true);
  assert.equal(isTransportFailure(new Error("session id is invalid")), false);
  assert.equal(isTransportFailure(undefined), false);
});

test("an iOS transport failure is a network problem, not a generic error", () => {
  assert.equal(classifyUiError("Error: Load failed"), "network");
  // The bare engine phrase is presented as the lost connection it is.
  assert.deepEqual(presentUiError("Create session: Load failed"), {
    title: "Create session",
    description: tr("settings.polythConnectionLost"),
    category: "network",
  });
  assert.deepEqual(presentUiError("Load failed"), {
    title: tr("settings.polythConnectionLost"),
    description: "",
    category: "network",
  });
  assert.equal(presentUiError("TypeError: Failed to fetch").title, tr("settings.polythConnectionLost"));
  // A sentence that only mentions a failed load keeps its own words.
  assert.equal(presentUiError("Load failed for 3 of 4 files").title, "Load failed for 3 of 4 files");
});

test("splits a compact head into title and detail", () => {
  assert.deepEqual(presentUiError("Connection lost: Check your network and retry."), {
    title: "Connection lost",
    description: "Check your network and retry.",
    category: "network",
  });
  assert.deepEqual(presentUiError("Failed to save file — Disk is full or unavailable."), {
    title: "Failed to save file",
    description: "Disk is full or unavailable.",
    category: "storage",
  });
});

test("an explicit newline is an author-provided split", () => {
  const view = presentUiError("Antigravity couldn’t start\nCannot replace exact native history; start a new session.");
  assert.equal(view.title, "Antigravity couldn’t start");
  assert.equal(view.description, "Cannot replace exact native history; start a new session.");
  assert.equal(view.category, "error");
});

test("a single line stays one dominant title with no repeated body", () => {
  const view = presentUiError("Couldn’t open the session link");
  assert.equal(view.title, "Couldn’t open the session link");
  assert.equal(view.description, "");
});

test("a URL head never becomes a fake title", () => {
  const view = presentUiError("https://example.test: cannot reach the relay");
  assert.equal(view.title, "https://example.test: cannot reach the relay");
  assert.equal(view.description, "");
});

test("long copy stays bounded", () => {
  const view = presentUiError(`Error: ${"x".repeat(400)}`);
  assert.equal(view.title, "Error");
  assert.ok(view.description.length <= 240);
  assert.ok(view.description.endsWith("…"));
});

test("a raw HTML gateway page renders as readable copy, never tags", () => {
  const view = presentUiError(
    "HTTP 504 Gateway Time-out — <html>\n<head><title>504 Gateway Time-out</title></head>\n<body><center><h1>504 Gateway Time-out</h1></center></body></html>",
  );
  assert.equal(view.title, "504 Gateway Time-out");
  assert.equal(view.title.includes("<"), false);
  assert.equal(view.description.includes("<"), false);
  assert.equal(view.category, "network");
});

test("unwraps an upstream JSON error payload and classifies 402 as blocked", () => {
  const view = presentUiError(
    '402: {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}',
  );
  assert.deepEqual(view, {
    title: "Upstream request failed: Insufficient account funds",
    description: "HTTP 402",
    category: "blocked",
  });
});

test("an aborted or timed-out request never shows the engine's abort phrase", () => {
  // iOS WebKit rejects every aborted fetch — a session-open deadline included —
  // with "Fetch is aborted"; the toast read "Error / Fetch is aborted".
  assert.deepEqual(presentUiError("Error: Fetch is aborted"), {
    title: tr("settings.polythConnectionLost"),
    description: "",
    category: "network",
  });
  assert.equal(presentUiError("Open session: The operation timed out.").description, tr("settings.polythConnectionLost"));
  assert.equal(presentUiError("AbortError: signal is aborted without reason").title, tr("settings.polythConnectionLost"));
  assert.equal(classifyUiError("Error: The operation was aborted."), "network");
  assert.equal(isRequestAbort(new DOMException("Fetch is aborted", "AbortError")), true);
  assert.equal(isRequestAbort(new DOMException("The operation timed out.", "TimeoutError")), true);
  assert.equal(isRequestAbort(new Error("Fetch is aborted")), true);
  // Not a transport loss: create/send recovery must not retry a cancellation.
  assert.equal(isTransportFailure(new DOMException("Fetch is aborted", "AbortError")), false);
  // A sentence that merely mentions an abort keeps its own words.
  assert.equal(isRequestAbort(new Error("Build was aborted by the user")), false);
  assert.equal(presentUiError("Turn aborted by the runtime").title, "Turn aborted by the runtime");
});
