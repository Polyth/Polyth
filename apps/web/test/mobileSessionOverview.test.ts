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

test("mobile session overview uses compact locale-safe progress and truthful harness metadata", () => {
  const source = read("../src/components/mobile/MobileSessionHeader.tsx");
  assert.match(source, /formatNumber\(currentStep\).*formatNumber\(tasks\.length\)/s);
  assert.doesNotMatch(source, /\$\{currentStep\} of \$\{tasks\.length\}/);
  assert.doesNotMatch(source, /session\?\.resolvedHarnessId \?\? descriptor\?\.providerName/);
});

test("mobile session overview inherits canonical sheet geometry and mobile hit targets", () => {
  const css = read("../src/components/mobile/MobileSessionHeader.css");
  assert.doesNotMatch(css, /86dvh|max-height:\s*min\(/);
  assert.doesNotMatch(css, /--safe-top/);
  assert.doesNotMatch(css, /@media\s*\(max-width:\s*380px\)/);
  assert.doesNotMatch(css, /width:\s*38px/);
  assert.match(css, /padding:\s*var\(--space-2\) var\(--screen-gutter\) 0/);
  assert.match(css, /\.mobile-island-prompt-toggle[\s\S]*?min-height:\s*max\(var\(--control-h-sm\), var\(--hit-min\)\)/);
});
