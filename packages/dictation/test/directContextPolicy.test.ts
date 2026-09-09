import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDictationContext } from "../src/providers.ts";

/** Direct provider transports cannot be filtered by the Polyth server after
 * audio leaves the browser. Until a server-authoritative runtime config says
 * context injection is enabled, callers must use this language-only shape. */
const directContext = (input: Parameters<typeof normalizeDictationContext>[0], authoritative = false) => {
  const normalized = normalizeDictationContext(input);
  return authoritative
    ? normalized
    : {
        language: normalized.language,
        ...(normalized.localeHints?.length ? { localeHints: normalized.localeHints } : {}),
      };
};

test("direct cloud context fails closed without server-authoritative opt-in", () => {
  const context = directContext({
    language: "uk-UA",
    keywords: ["Polyth", "secret-repo-symbol"],
    lexicalContext: "Recent conversation and repository context",
    glossary: { FooBar: "internal symbol" },
  });
  assert.deepEqual(context, { language: "uk-UA" });
  assert.equal("keywords" in context, false);
  assert.equal("lexicalContext" in context, false);
  assert.equal("glossary" in context, false);
});

test("server-authoritative opt-in may retain bounded normalized context", () => {
  const context = directContext({
    language: "uk-UA",
    keywords: [" Polyth ", "polyth", "x".repeat(120)],
    lexicalContext: "x".repeat(10_000),
  }, true);
  assert.deepEqual(context.keywords?.slice(0, 1), ["Polyth"]);
  assert.equal(context.keywords?.length, 2);
  assert.ok((context.keywords?.[1]?.length ?? 0) <= 96);
  assert.equal(context.lexicalContext?.length, 8_000);
});
