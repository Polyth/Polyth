import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("the core token contract is isolated, imported first, and fully documented", async () => {
  const [tokens, styles, guide] = await Promise.all([
    read("../src/tokens.css"),
    read("../src/styles.css"),
    read("../../../docs/dev/styles.md"),
  ]);
  const cssWithoutComments = tokens.replace(/\/\*[\s\S]*?\*\//g, "").trim();

  assert.match(cssWithoutComments, /^:root\s*\{[\s\S]*\}$/);
  assert.equal(cssWithoutComments.replace(/^:root\s*\{/, "").replace(/\}$/, "").includes("{"), false);
  assert.match(styles, /^@import "\.\/tokens\.css";/);
  assert.doesNotMatch(styles, /(^|\n)\s*:root\s*\{/);

  const tokenNames = [...tokens.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1]!);
  assert.equal(new Set(tokenNames).size, tokenNames.length, "tokens are declared once");
  for (const token of tokenNames) {
    assert.ok(guide.includes(`\`${token}\``), `${token} is documented in the style guide`);
  }
});

test("radius compatibility names only alias the canonical semantic scale", async () => {
  const tokens = await read("../src/tokens.css");

  for (const [legacy, canonical] of [
    ["--radius", "--radius-control"],
    ["--radius-sm", "--radius-control"],
    ["--radius-md", "--radius-card"],
    ["--radius-lg", "--radius-card"],
    ["--radius-xl", "--radius-surface"],
  ]) {
    assert.match(tokens, new RegExp(`${legacy}:\\s*var\\(${canonical}\\)`));
  }
  for (const token of ["control", "card", "surface", "sheet"]) {
    assert.match(tokens, new RegExp(`--radius-${token}:\\s*calc\\([^;]*var\\(--corner-radius-scale\\)`));
  }
});

test("Usage layout is container-responsive in narrow docked surfaces", async () => {
  const usage = await read("../../../packages/usage/widgets/styles.css");

  assert.match(usage, /\.usage-dashboard\s*\{[^}]*container:\s*usage-dashboard\s*\/\s*inline-size/s);
  assert.doesNotMatch(usage, /@media[^{]*max-width/);
  assert.match(
    usage,
    /@container usage-dashboard \(max-width: 820px\)[\s\S]*?\.usage-dashboard-toolbar\s*\{[\s\S]*?flex-wrap:\s*wrap/,
  );
  assert.doesNotMatch(usage, /usage-dashboard-hero|usage-hero-status|usage-eyebrow/);
});

test("shared style behavior is owned by core instead of copied across packages", async () => {
  const [styles, entries] = await Promise.all([
    read("../src/styles.css"),
    readdir(new URL("../../../packages/", import.meta.url), { withFileTypes: true }),
  ]);
  const packageStyles = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      try {
        return await read(`../../../packages/${entry.name}/widgets/styles.css`);
      } catch {
        return "";
      }
    }));
  const packages = packageStyles.join("\n");

  assert.doesNotMatch(packages, /(^|\n)\s*:root\s*\{/);
  assert.doesNotMatch(packages, /--scroll-affordance:/);
  assert.doesNotMatch(packages, /:is\(\.empty-state,\s*\.set-empty,\s*\.rail-empty/);
  assert.doesNotMatch(packages, /\.view-page:not\(\.github-page\):not\(\.git-page\)/);
  assert.doesNotMatch(packages, /--tt-radius-/);
  assert.doesNotMatch(packages, /:is\(\s*\.audit-(?:note|list),/);
  assert.doesNotMatch(packages, /\.settings-pane-body :is\(/);
  assert.doesNotMatch(packages, /\.dialog-panel > :is\(/);

  assert.equal((styles.match(/--scroll-affordance:/g) ?? []).length, 1);
  assert.match(styles, /\.empty-state--compact,[\s\S]*?\.empty-state--panel\s*\{/);
  assert.match(styles, /\.view-page,\s*\.rail-body,[\s\S]*?container:\s*feature-panel\s*\/\s*inline-size/);
  assert.match(styles, /:is\(\s*\.audit-note,[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(styles, /\.settings-pane-body :is\([\s\S]*?\.ha-settings[\s\S]*?min-width:\s*0/);
});

test("mobile Canvas chrome uses the shared tap target", async () => {
  const styles = await read("../src/styles.css");

  assert.match(
    styles,
    /@media \(max-width: 760px\)\s*\{\s*\.widget-canvas-grid[\s\S]*?\.widget-card-more,[\s\S]*?\.widget-resize-handle\s*\{[^}]*width:\s*var\(--tap\)[^}]*height:\s*var\(--tap\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 760px\)\s*\{\s*\.widget-canvas-grid[\s\S]*?\.widget-menu-trigger\s*\{\s*min-height:\s*var\(--tap\)/,
  );
});
