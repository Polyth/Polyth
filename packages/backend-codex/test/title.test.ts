import assert from "node:assert/strict";
import { test } from "node:test";
import { codexThreadTitlePrompt, parseCodexThreadTitle } from "../src/title.ts";

test("Codex title prompt is semantic, language-preserving, and byte bounded", () => {
  const prompt = codexThreadTitlePrompt(`  ${"Перевір мобільний композер 🚀 ".repeat(100)}  `);
  assert.match(prompt, /under five words where possible/);
  assert.match(prompt, /Write in the user's language/);
  assert.match(prompt, /User prompt:/);
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 960);
  assert.doesNotMatch(prompt, /\uFFFD/);
});

test("Codex generated titles are normalized and bounded", () => {
  assert.equal(parseCodexThreadTitle('{"title":"  `Fix mobile composer!`  "}'), "Fix mobile composer");
  assert.equal(parseCodexThreadTitle('{"title":"Перевір заголовки сесій"}'), "Перевір заголовки сесій");
  assert.equal(parseCodexThreadTitle("not json"), undefined);
  assert.equal(parseCodexThreadTitle('{"title":""}'), undefined);
  assert.equal(parseCodexThreadTitle(JSON.stringify({ title: "x".repeat(80) }))?.length, 36);
});
