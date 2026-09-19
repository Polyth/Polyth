import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectGeminiHelp } from "../src/serverEntry.ts";

test("Gemini compatibility requires official ACP mode", () => {
  assert.equal(inspectGeminiHelp("Usage: gemini [options]\n  --acp  Run as an ACP agent\n"), true);
  assert.equal(inspectGeminiHelp("Usage: gemini [options]\n  --model <name>\n"), false);
});
