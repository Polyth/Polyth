import assert from "node:assert/strict";
import { test } from "node:test";
import { titleSafeClaudeSessionInfo } from "../src/serverEntry.ts";

test("Claude first-prompt summary is not treated as a native generated title", () => {
  assert.deepEqual(
    titleSafeClaudeSessionInfo({
      summary: "Please inspect every package and fix all visual inconsistencies",
      customTitle: null,
      sessionId: "native-a",
    }),
    {
      summary: "",
      customTitle: null,
      sessionId: "native-a",
    },
  );
});

test("Claude explicit custom title remains trusted", () => {
  const info = {
    summary: "long first prompt",
    customTitle: "Polish package UI consistency",
    sessionId: "native-a",
  };
  assert.equal(titleSafeClaudeSessionInfo(info), info);
});

test("Claude semantic summary remains trusted when the first prompt is available", () => {
  const info = {
    summary: "Polish package UI consistency",
    firstPrompt: "Please inspect every package and fix all visual inconsistencies",
    customTitle: null,
    sessionId: "native-a",
  };
  assert.equal(titleSafeClaudeSessionInfo(info), info);
});
