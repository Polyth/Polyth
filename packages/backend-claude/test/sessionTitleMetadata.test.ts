import assert from "node:assert/strict";
import { test } from "node:test";
import { titleSafeClaudeSdk, titleSafeClaudeSessionInfo } from "../src/serverEntry.ts";

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

test("Claude SDK calls receive the resolved executable and child env without mutating process.env", () => {
  let seen: Record<string, unknown> | undefined;
  const sdk = {
    query(params: { prompt: string; options?: Record<string, unknown> }) {
      seen = params;
      return {};
    },
    getSessionInfo: async () => null,
  };
  const originalPath = process.env.PATH;
  const wrapped = titleSafeClaudeSdk(
    sdk as unknown as Parameters<typeof titleSafeClaudeSdk>[0],
    "/tmp/claude",
    { PATH: "/tmp/claude", KEEP_ME: "yes" },
  );
  wrapped.query({ prompt: "hello", options: { env: { CUSTOM: "yes" } } });
  assert.equal(process.env.PATH, originalPath);
  assert.equal(seen?.options && (seen.options as Record<string, unknown>).pathToClaudeCodeExecutable, "/tmp/claude");
  assert.deepEqual(seen?.options && (seen.options as Record<string, unknown>).env, {
    PATH: "/tmp/claude",
    KEEP_ME: "yes",
    CUSTOM: "yes",
  });
});
