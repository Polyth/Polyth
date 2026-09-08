import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileResourceProvider } from "../widgets/fileProvider.ts";
import { registerResourceProvider, getResourceProvider } from "../../../apps/web/src/resources/providers.ts";

test("file provider describe marks PNG as binary not text", () => {
  const ref = { scheme: "file", projectId: "p", sessionId: null, locator: "img/logo.png" };
  assert.equal(fileResourceProvider.describe(ref).kind, "binary");
});

test("file provider describe marks TypeScript as text", () => {
  const ref = { scheme: "file", projectId: "p", sessionId: null, locator: "src/app.ts" };
  assert.equal(fileResourceProvider.describe(ref).kind, "text");
});

test("file provider describe marks archives as unknown", () => {
  const ref = { scheme: "file", projectId: "p", sessionId: null, locator: "dist/archive.zip" };
  assert.equal(fileResourceProvider.describe(ref).kind, "unknown");
});

test("file provider describe marks extensionless files as unknown", () => {
  const ref = { scheme: "file", projectId: "p", sessionId: null, locator: "README" };
  assert.equal(fileResourceProvider.describe(ref).kind, "unknown");
});

test("fileProvider module does not self-register a resource provider", async () => {
  const source = await readFile(new URL("../widgets/fileProvider.ts", import.meta.url), "utf8");
  assert.equal(source.includes("registerResourceProvider"), false);
});

test("resource provider register disposes cleanly", () => {
  const scheme = `file-prov-${process.pid}`;
  const off = registerResourceProvider({ ...fileResourceProvider, scheme });
  assert.ok(getResourceProvider(scheme));
  off();
  assert.equal(getResourceProvider(scheme), undefined);
});
