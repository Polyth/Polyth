import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the phone composer is dock-owned and smoothly expands upward", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(
    css,
    /\.composer-chat\.composer-mobile \{\s*\/\*[^]*?padding: var\(--space-1\) var\(--screen-gutter\);/,
    "the composer does not duplicate the dock or navigator safe-area inset",
  );
  assert.match(
    css,
    /@supports \(interpolate-size: allow-keywords\) \{\s*\.composer-mobile \.composer-card \{\s*height: 56px;\s*interpolate-size: allow-keywords;\s*transition: height var\(--motion-surface\) var\(--motion-ease\)/,
    "opening the composer animates its own height",
  );
  assert.match(
    css,
    /\.composer-mobile\.composer-expanded \.composer-card \{ height: auto; \}/,
  );
});
