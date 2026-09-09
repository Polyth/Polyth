import { test } from "node:test";
import assert from "node:assert/strict";
import { createDictationService, type DictationContext, type SttAdapter } from "@polyth/dictation";

test("dictation service normalizes context before provider stream creation", () => {
  let received: DictationContext | undefined;
  const adapter: SttAdapter = {
    engine: "context-test",
    createStream({ context }) {
      received = context;
      return { push() {}, finalize: async () => "" };
    },
  };
  const service = createDictationService({ adapter });
  service.create({
    language: "uk-UA",
    context: {
      keywords: ["Polyth", " polyth ", "x".repeat(200)],
      localeHints: ["uk-UA", "uk-UA", "en-US"],
      lexicalContext: "z".repeat(20_000),
    },
  });
  assert.equal(received?.language, "uk-UA");
  assert.deepEqual(received?.localeHints, ["uk-UA", "en-US"]);
  assert.equal(received?.keywords?.length, 2);
  assert.ok((received?.keywords?.[1]?.length ?? 0) <= 96);
  assert.equal(received?.lexicalContext?.length, 8_000);
});
