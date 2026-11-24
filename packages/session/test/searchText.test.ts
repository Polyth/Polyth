// The shared chat-search text rules: fold, terms, stems, cross-field AND.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldSearchText,
  matchesSearchTerms,
  searchExcerpt,
  searchHighlightRanges,
  searchTermStem,
  searchTerms,
} from "../src/searchText.ts";

test("fold is Unicode-aware: Cyrillic case, diacritics and apostrophes, length kept", () => {
  assert.equal(foldSearchText("Пошук"), "пошук");
  assert.equal(foldSearchText("Café"), "cafe");
  assert.equal(foldSearchText("п’ять пʼять"), "п'ять п'ять");
  assert.equal(foldSearchText("Їжак").length, "Їжак".length);
});

test("terms: words and quoted phrases, folded, de-duplicated, bounded", () => {
  assert.deepEqual(searchTerms('  Auth "Login Flow"  auth '), ["auth", "login flow"]);
  assert.deepEqual(searchTerms('"'), []);
  assert.equal(searchTerms(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")).length, 12);
});

test("stems cut Ukrainian and English endings, leave short words, numbers and paths", () => {
  assert.equal(searchTermStem("пошуків"), "пошук");
  assert.equal(searchTermStem("messages"), "messa");
  assert.equal(searchTermStem("chat"), undefined);
  assert.equal(searchTermStem("v22"), undefined);
  assert.equal(searchTermStem("src/a.ts"), undefined);
});

test("every word must occur somewhere among the fields, not in one field", () => {
  assert.ok(matchesSearchTerms(["Auth", "fix/login"], searchTerms("login auth")));
  assert.ok(matchesSearchTerms(["Пошук у чатах"], searchTerms("пошуків")));
  assert.ok(!matchesSearchTerms(["Auth", "fix/login"], searchTerms("auth deploy")));
  assert.ok(matchesSearchTerms([undefined, null, ""], []));
});

test("highlights exact words, falls back to the stem, merges adjacent ranges", () => {
  const text = "Пошук у SessionSearch";
  const ranges = searchHighlightRanges(text, searchTerms("пошуків search"));
  assert.deepEqual(ranges.map(([a, b]) => text.slice(a, b)), ["Пошук", "Search"]);
  const excerpt = searchExcerpt(`${"x ".repeat(200)}needle here${" y".repeat(200)}`, ["needle"], 60);
  assert.ok(excerpt.snippet.length <= 62);
  assert.deepEqual(excerpt.ranges.map(([a, b]) => excerpt.snippet.slice(a, b)), ["needle"]);
});
