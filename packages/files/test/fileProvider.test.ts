import test from "node:test";
import assert from "node:assert/strict";
import { fileResourceProvider } from "../widgets/fileProvider.ts";

test("file provider describe marks PNG as binary not text", () => {
  const ref = { scheme: "file", projectId: "p", sessionId: null, locator: "img/logo.png" };
  assert.equal(fileResourceProvider.describe(ref).kind, "binary");
});

test("file provider describe marks TypeScript as text", () => {
  const ref = { scheme: "file", projectId: "p", sessionId: null, locator: "src/app.ts" };
  assert.equal(fileResourceProvider.describe(ref).kind, "text");
});
