import test from "node:test";
import assert from "node:assert/strict";
import { lineRangeOf } from "../../../apps/web/src/chatclip.ts";
import {
  languageLabelOf,
  languageOf,
  lineRangeFromOffsets,
  PLAIN_TEXT_LABEL,
  setLanguageLoaderForTest,
} from "../widgets/languages.ts";

test("honest language ids: JS, JSX, TS, and TSX are distinct; unknown stays plain text", () => {
  assert.equal(languageOf("src/app.js")?.id, "javascript");
  assert.equal(languageOf("src/app.jsx")?.id, "javascriptJsx");
  assert.equal(languageOf("src/app.ts")?.id, "typescript");
  assert.equal(languageOf("src/app.tsx")?.id, "typescriptTsx");
  assert.equal(languageOf("src/app.js")?.label, "JavaScript");
  assert.equal(languageOf("src/app.jsx")?.label, "JavaScript (JSX)");
  assert.equal(languageOf("src/app.ts")?.label, "TypeScript");
  assert.equal(languageOf("src/app.tsx")?.label, "TypeScript (TSX)");
  assert.equal(languageOf("data.json")?.id, "json");
  assert.equal(languageOf("data.yaml")?.id, "yaml");
  assert.equal(languageOf("README.md")?.id, "markdown");
  assert.equal(languageOf("App.vue"), null);
  assert.equal(languageOf("data.json5"), null);
  assert.equal(languageOf("styles.scss"), null);
  assert.equal(languageLabelOf("main.rs"), PLAIN_TEXT_LABEL);
});

test("language loaders are not aliased across JS/JSX/TS/TSX", async () => {
  const seen: string[] = [];
  setLanguageLoaderForTest(async (id) => {
    seen.push(id);
    return [];
  });
  await languageOf("a.js")?.load();
  await languageOf("a.jsx")?.load();
  await languageOf("a.ts")?.load();
  await languageOf("a.tsx")?.load();
  assert.deepEqual(seen, ["javascript", "javascriptJsx", "typescript", "typescriptTsx"]);
  setLanguageLoaderForTest(null);
});

test("lineRangeFromOffsets matches chatclip [start,end) newline rule", () => {
  const content = "one\ntwo\nthree\n";
  const lineAt = (offset: number) => {
    let line = 1;
    const end = Math.max(0, Math.min(offset, content.length));
    for (let i = 0; i < end; i++) if (content.charCodeAt(i) === 10) line += 1;
    return line;
  };
  const charAt = (offset: number) => content[offset] ?? "";
  const cases: Array<[number, number]> = [
    [0, 0],
    [0, 3],
    [0, 4],
    [4, 8],
    [4, 9],
    [0, content.length],
    [8, 8],
  ];
  for (const [from, to] of cases) {
    assert.deepEqual(
      lineRangeFromOffsets(lineAt, charAt, from, to, content.length),
      lineRangeOf(content, from, to),
      `${from}:${to}`,
    );
  }
});
