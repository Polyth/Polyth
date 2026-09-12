import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

test("mobile session overview only renders sections that have content", () => {
  const source = read("../src/components/mobile/MobileSessionHeader.tsx");
  assert.match(source, /\{requests\.length > 0 && \(/);
  assert.match(source, /\{tasks\.length > 0 && \(/);
  assert.match(source, /\{recent\.length > 0 && \(/);
  assert.doesNotMatch(source, /mobile\.island\.noTasks|mobile\.island\.noRecent/);
  assert.match(source, /origin="top"/);
});

test("mobile session overview removes duplicated chrome and keeps useful state semantic", () => {
  const source = read("../src/components/mobile/MobileSessionHeader.tsx");
  assert.match(source, /formatNumber\(currentStep\).*formatNumber\(tasks\.length\)/s);
  assert.match(source, /tasksForIsland\(model\.tasks, model\.messages\)/);
  assert.doesNotMatch(source, /mobile-island-session|mobile-island-meta/);
  assert.doesNotMatch(source, /mobile\.island\.showFullPrompt|mobile\.island\.hideFullPrompt/);
  assert.doesNotMatch(source, /meta=\{itemStatus|trailing=\{/);
  assert.match(source, /eventsHaveCodeChanges\(events\[item\.id\]\).*mobile\.island\.codeChanged/s);
});

test("mobile session overview inherits canonical sheet geometry and uses quiet dense rows", () => {
  const css = read("../src/components/mobile/MobileSessionHeader.css");
  assert.doesNotMatch(css, /86dvh|max-height:\s*min\(/);
  assert.doesNotMatch(css, /--safe-top/);
  assert.doesNotMatch(css, /@media\s*\(max-width:\s*380px\)/);
  assert.doesNotMatch(css, /mobile-island-prompt-toggle/);
  assert.match(css, /\.mobile-island-sheet \.sheet-close[\s\S]*?width:\s*var\(--tap\);[\s\S]*?height:\s*var\(--tap\);/);
  assert.match(css, /\.mobile-island-sheet \.mobile-task-list li[\s\S]*?min-height:\s*var\(--tap\);/);
  assert.match(css, /\.mobile-island-sheet \.mobile-task-list li\.active[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.mobile-island-sheet \.sheet-row-main[\s\S]*?min-height:\s*var\(--tap\);/);
});
