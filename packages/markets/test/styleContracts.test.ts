import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const widgets = resolve(import.meta.dirname, "../widgets");

async function marketsCss(): Promise<string> {
  const names = (await readdir(widgets)).filter((name) => name.endsWith(".css")).sort();
  return (await Promise.all(names.map((name) => readFile(join(widgets, name), "utf8")))).join("\n");
}

test("Markets CSS uses the canonical visible-focus contract", async () => {
  const css = await marketsCss();
  assert.doesNotMatch(css, /box-shadow:\s*var\(--focus-ring\)/,
    "--focus-ring is a color token, not a box-shadow value");
  assert.match(css, /outline:\s*2px solid var\(--focus-ring\)/);
  assert.match(css, /box-shadow:\s*0 0 0 4px var\(--focus-wash\)/);
});

test("Markets CSS avoids deprecated semantic aliases", async () => {
  const css = await marketsCss();
  for (const token of [
    "surface",
    "fg",
    "text-primary",
    "text-muted",
    "danger",
    "warning",
    "success",
    "info",
    "border-subtle",
  ]) {
    assert.doesNotMatch(css, new RegExp(`var\\(--${token}(?:[,\\)])`), `--${token} is deprecated`);
  }
});

test("Markets embedded UI responds to containers rather than viewport media queries", async () => {
  const css = await marketsCss();
  assert.doesNotMatch(css, /@media\s*\([^)]*max-width/);
  assert.match(css, /@container\s*\(max-width:/);
});
