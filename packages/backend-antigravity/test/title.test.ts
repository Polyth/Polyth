import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAntigravityTitleReader, parseAntigravityAnnotationTitle } from "../src/title.ts";

test("antigravity annotation titles parse and unescape", () => {
  assert.equal(parseAntigravityAnnotationTitle('title:"Fix the login race"'), "Fix the login race");
  assert.equal(parseAntigravityAnnotationTitle('title:"Line one\\nLine two"'), "Line one Line two");
  assert.equal(parseAntigravityAnnotationTitle('title:"Quote \\"x\\" here"'), 'Quote "x" here');
  assert.equal(parseAntigravityAnnotationTitle("other:1"), undefined);
  assert.equal(parseAntigravityAnnotationTitle('title:""'), undefined);
});

test("antigravity title reader stays inside its annotation directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-annotations-"));
  await writeFile(join(dir, "conversation-a.pbtxt"), 'title:"Network Connectivity Test"\n');
  const reader = createAntigravityTitleReader(dir);
  assert.equal(await reader.read("conversation-a"), "Network Connectivity Test");
  assert.equal(await reader.read("../conversation-a"), undefined);
  assert.equal(await reader.read("a/b"), undefined);
  assert.equal(await reader.read("missing"), undefined);
});
