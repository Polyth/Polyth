import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCALES,
  chatBlockStrings,
  fill,
  en,
  uk,
  ar,
  bg,
  de,
  es,
  fr,
  it,
  pl,
  ptBR,
  pt,
  zhCN,
  type ChatBlockStrings,
} from "../widgets/strings.ts";

const PLACEHOLDER_REGEX = /\{(\w+)\}/g;

function extractPlaceholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_REGEX)].map((m) => m[1]!).sort();
}

function isPurePlaceholdersAndPunctuation(value: string): boolean {
  return value.replace(PLACEHOLDER_REGEX, "").replace(/[\p{P}\p{S}\p{Z}]/gu, "").length === 0;
}

/** Words the language spells exactly like English: a translation, not a missed string. */
const SAME_WORD_AS_ENGLISH = new Set(["es.no", "it.no"]);

const ALL_LOCALES: Record<string, ChatBlockStrings> = {
  en,
  uk,
  ar,
  bg,
  de,
  es,
  fr,
  it,
  pl,
  "pt-BR": ptBR,
  pt,
  "zh-CN": zhCN,
};

test("every locale table matches the keys of en and contains no empty values", () => {
  const enKeys = Object.keys(en).sort();
  assert.ok(enKeys.length > 60, "expected en table to have around 66-75 keys");

  for (const [localeCode, table] of Object.entries(ALL_LOCALES)) {
    const tableKeys = Object.keys(table).sort();
    const missingKeys = enKeys.filter((k) => !(k in table));
    const extraKeys = tableKeys.filter((k) => !(k in en));

    assert.deepEqual(
      missingKeys,
      [],
      `locale table "${localeCode}" is missing keys: ${missingKeys.join(", ")}`,
    );
    assert.deepEqual(
      extraKeys,
      [],
      `locale table "${localeCode}" has extra keys: ${extraKeys.join(", ")}`,
    );

    for (const [key, value] of Object.entries(table)) {
      assert.equal(
        typeof value,
        "string",
        `locale table "${localeCode}" key "${key}" must be a string`,
      );
      assert.ok(
        value.trim().length > 0,
        `locale table "${localeCode}" key "${key}" must not be empty`,
      );
    }
  }
});

test("every locale table value has identical placeholder sets as English", () => {
  for (const [localeCode, table] of Object.entries(ALL_LOCALES)) {
    for (const [key, enValue] of Object.entries(en)) {
      const locValue = table[key as keyof ChatBlockStrings];
      const enPlaceholders = extractPlaceholders(enValue);
      const locPlaceholders = extractPlaceholders(locValue);

      assert.deepEqual(
        locPlaceholders,
        enPlaceholders,
        `placeholder set mismatch in "${localeCode}.${key}": expected [${enPlaceholders.join(
          ", ",
        )}], got [${locPlaceholders.join(", ")}]`,
      );
    }
  }
});

test("non-English locale values are not byte-identical to English unless purely placeholders/punctuation", () => {
  for (const [localeCode, table] of Object.entries(ALL_LOCALES)) {
    if (localeCode === "en") continue;

    for (const [key, enValue] of Object.entries(en)) {
      const locValue = table[key as keyof ChatBlockStrings];
      if (locValue === enValue && !SAME_WORD_AS_ENGLISH.has(`${localeCode}.${key}`)) {
        assert.ok(
          isPurePlaceholdersAndPunctuation(locValue),
          `locale "${localeCode}" key "${key}" is byte-identical to English ("${enValue}"), which is only allowed for purely placeholders/punctuation`,
        );
      }
    }
  }
});

test("chatBlockStrings resolves pt-BR, pt, zh-CN, zh, de-AT (-> de) and unknown (-> en)", () => {
  // pt-BR and pt must stay distinct
  const resolvedPtBR = chatBlockStrings("pt-BR");
  const resolvedPt = chatBlockStrings("pt");
  assert.equal(resolvedPtBR, ptBR);
  assert.equal(resolvedPt, pt);
  assert.notEqual(resolvedPtBR, resolvedPt, "pt-BR and pt must stay distinct");

  // zh-CN must resolve for zh-CN and zh
  assert.equal(chatBlockStrings("zh-CN"), zhCN);
  assert.equal(chatBlockStrings("zh"), zhCN);

  // de-AT must fall back to de
  assert.equal(chatBlockStrings("de-AT"), de);

  // unknown locale falls back to en
  assert.equal(chatBlockStrings("unknown"), en);
  assert.equal(chatBlockStrings("xx-YY"), en);
  assert.equal(chatBlockStrings(""), en);
});

test("LOCALES map contains all shell locales and handles case-insensitive exact matching", () => {
  const expectedCodes = ["ar", "bg", "de", "en", "es", "fr", "it", "pl", "pt", "pt-BR", "uk", "zh", "zh-CN"];
  for (const code of expectedCodes) {
    assert.ok(code in LOCALES, `LOCALES map missing "${code}"`);
  }

  assert.equal(chatBlockStrings("pt-br"), ptBR);
  assert.equal(chatBlockStrings("zh-cn"), zhCN);
});

test("fill correctly interpolates variables and preserves unmatched keys", () => {
  assert.equal(fill("{shown} of {total}", { shown: 3, total: 10 }), "3 of 10");
  assert.equal(fill("Done {count}", { count: 42 }), "Done 42");
  assert.equal(fill("{path} was not found", { path: "doc.txt" }), "doc.txt was not found");
  assert.equal(fill("{shown} of {missing}", { shown: 1 }), "1 of {missing}");
});
