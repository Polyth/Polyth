import { test } from "node:test";
import assert from "node:assert/strict";
import { directProviderContext } from "../src/directContext.ts";

test("direct context strips workspace/chat metadata until server-authoritative opt-in", () => {
  const safe = directProviderContext({
    language: "uk-UA",
    keywords: ["Polyth", "internal-symbol"],
    lexicalContext: "recent chat and repository path",
    glossary: { FooBar: "internal" },
  });
  assert.deepEqual(safe, { language: "uk-UA" });
});

test("authoritative opt-in still receives bounded normalized context", () => {
  const allowed = directProviderContext({
    language: "uk-UA",
    keywords: [" Polyth ", "polyth", "x".repeat(140)],
    lexicalContext: "x".repeat(10_000),
  }, true);
  assert.equal(allowed.keywords?.length, 2);
  assert.ok((allowed.keywords?.[1]?.length ?? 0) <= 96);
  assert.equal(allowed.lexicalContext?.length, 8_000);
});
