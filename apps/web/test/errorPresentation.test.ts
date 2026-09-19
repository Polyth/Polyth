import test from "node:test";
import assert from "node:assert/strict";
import { classifyUiError, presentUiError } from "../src/errorPresentation.ts";

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
