import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("memory browser client keeps project scope and CAS in every mutation route", async () => {
  const source = await read("../src/client.ts");
  assert.match(source, /projectId/);
  assert.match(source, /expectedRevision/);
  assert.match(source, /expectedSettingsRevision/);
  assert.match(source, /confirmation: "clear-project-memory"/);
  assert.match(source, /\/api\/memory\/policy/);
  assert.match(source, /import\/preview/);
  assert.match(source, /mode: "merge" \| "replace"/);
  assert.match(source, /"unlock"/);
});

test("memory service exposes staged import, recovery export, and lock reversal routes", async () => {
  const source = await read("../src/service.ts");
  assert.match(source, /\/api\/memory\/import\/preview/);
  assert.match(source, /input\.mode === "replace"/);
  assert.match(source, /includeArchived/);
  assert.match(source, /unlock/);
});

test("memory settings guards stale project responses and dirty drafts", async () => {
  const source = await read("../widgets/MemorySettings.tsx");
  // The copy moved into the package catalog; the source now references keys.
  const messages = await read("../src/i18n/en.ts");
  assert.match(source, /AbortController/);
  assert.match(source, /generation\.current/);
  assert.match(source, /memory\.confirm\.discardDraft/);
  assert.match(messages, /Discard this unsaved memory draft/);
  assert.match(source, /memory\.editor\.help/);
  assert.match(messages, /Manual saves are user locked/);
  assert.match(messages, /already delivered native context/);
  assert.match(source, /memory\.bulk\.selectVisible/);
  assert.match(messages, /visible filtered page/);
  assert.match(source, /memory\.action\.selectAll/);
  assert.match(messages, /Select all \{count\} filtered/);
  assert.match(source, /requestFilterEpoch/);
  assert.match(messages, /Failed: \{failures\}/);
  assert.match(source, /memory\.action\.downloadRecovery/);
  assert.match(messages, /recovery export/);
  const css = await read("../widgets/styles.css");
  assert.match(css, /max-width: 700px/);
  assert.match(css, /prefers-reduced-motion/);
});
