import test from "node:test";
import assert from "node:assert/strict";
import { parseTrackSteps } from "../src/trackForm.ts";

test("track form parses sequential steps with optional detailed prompts", () => {
  assert.deepEqual(
    parseTrackSteps(
      "Create store :: Add a durable SQLite store\n\nWire UI\nRun migration :: migrate old records",
      "node --test focused.test.ts",
    ),
    [
      {
        title: "Create store",
        prompt: "Add a durable SQLite store",
        testCommand: "node --test focused.test.ts",
      },
      {
        title: "Wire UI",
        prompt: "Wire UI",
        testCommand: "node --test focused.test.ts",
      },
      {
        title: "Run migration",
        prompt: "migrate old records",
        testCommand: "node --test focused.test.ts",
      },
    ],
  );
});

test("track form requires a declared test command", () => {
  assert.deepEqual(parseTrackSteps("Step one\nStep two", "   "), []);
});
