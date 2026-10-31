// `:has()` may not contain another `:has()`. A selector list with one such
// selector is invalid as a whole, so the browser drops the entire rule —
// including its plain `:hover` selectors — without a console error.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..");

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) cssFiles(path, out);
    else if (name.endsWith(".css")) out.push(path);
  }
  return out;
}

/** Offsets of every `:has(` whose balanced argument contains another `:has(`. */
export function nestedHas(css: string): number[] {
  const found: number[] = [];
  for (let at = css.indexOf(":has("); at >= 0; at = css.indexOf(":has(", at + 1)) {
    let depth = 0;
    for (let i = at + 4; i < css.length; i++) {
      const c = css[i];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
      else if (depth > 0 && css.startsWith(":has(", i)) { found.push(at); break; }
    }
  }
  return found;
}

test("nestedHas finds a :has() inside a :has()", () => {
  assert.deepEqual(nestedHas(".a:has(.b :focus-visible) .c {}"), []);
  assert.deepEqual(nestedHas(".a:has(.b:not(.x)) {}"), []);
  assert.equal(nestedHas(".a:has(.b:has(:focus-visible)) {}").length, 1);
});

test("no stylesheet nests :has() inside :has()", () => {
  const files = [...cssFiles(join(root, "apps", "web", "src")), ...cssFiles(join(root, "packages"))];
  const offenders = files.flatMap((file) => {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    return nestedHas(css).map((at) => `${relative(root, file)}:${css.slice(0, at).split("\n").length}`);
  });
  assert.deepEqual(offenders, []);
});

/**
 * Offsets of every `:has()` followed, in the same selector, by a combinator
 * and a subject with no class/type/id of its own (`*` or a bare `:not(...)`):
 * `.railbar:has(.rail-dynamic) > *`. Chromium then restyles the whole
 * document on every inline-style change anywhere (each keystroke in the
 * composer measured ~2×128 ms on a long chat). Name the state with a class
 * or attribute on the element instead.
 */
export function hasBeforeUniversalSubject(css: string): number[] {
  const found: number[] = [];
  for (let at = css.indexOf(":has("); at >= 0; at = css.indexOf(":has(", at + 1)) {
    let depth = 0;
    let close = -1;
    for (let i = at + 4; i < css.length; i++) {
      if (css[i] === "(") depth++;
      else if (css[i] === ")" && --depth === 0) { close = i; break; }
    }
    if (close < 0) continue;
    let level = 0;
    for (let i = close + 1; i < css.length; i++) {
      const c = css[i]!;
      if (c === "(") { level++; continue; }
      // Leaving the argument that holds the :has() (`:is(.a:has(.b))`)
      // continues the outer compound at the same level.
      if (c === ")") { level = Math.max(0, level - 1); continue; }
      if (level > 0) continue;
      if (c === "{" || c === ",") break;
      if (!/[\s>+~]/.test(c)) continue;
      let next = i;
      while (next < css.length && /[\s>+~]/.test(css[next]!)) next++;
      if (css[next] === "*" || css.startsWith(":not(", next)) { found.push(at); break; }
      i = next - 1;
    }
  }
  return found;
}

test("hasBeforeUniversalSubject finds a :has() before a universal or negation-only subject", () => {
  assert.equal(hasBeforeUniversalSubject(".railbar:has(.rail-dynamic) > * { a: b }").length, 1);
  assert.equal(hasBeforeUniversalSubject(".p:has(> .f) > :not(.a, .b) { a: b }").length, 1);
  assert.equal(hasBeforeUniversalSubject(".p:has(> .f) :not(.a) { a: b }").length, 1);
  assert.deepEqual(hasBeforeUniversalSubject(".a:has(.b) > .c { a: b }"), []);
  assert.deepEqual(hasBeforeUniversalSubject(".a:has(.b):not(.c) { a: b }"), []);
  assert.deepEqual(hasBeforeUniversalSubject(".a:has(.b) { a: b } * { c: d }"), []);
  assert.deepEqual(hasBeforeUniversalSubject(".x:not(:has(.y)) .z, * { a: b }"), []);
  assert.equal(hasBeforeUniversalSubject(":is(.a:has(.b)) > * { a: b }").length, 1);
  assert.deepEqual(hasBeforeUniversalSubject(":is(.a, .w:has(.b)):not(:is(.f) *) { a: b }"), []);
});

test("no stylesheet puts a :has() before a universal or negation-only subject", () => {
  const files = [...cssFiles(join(root, "apps", "web", "src")), ...cssFiles(join(root, "packages"))];
  const offenders = files.flatMap((file) => {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    return hasBeforeUniversalSubject(css).map((at) => `${relative(root, file)}:${css.slice(0, at).split("\n").length}`);
  });
  assert.deepEqual(offenders, []);
});
