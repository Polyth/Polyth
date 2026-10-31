// A positional pseudo-class (`:first-child`, `:nth-child()`, …) outside a
// selector's rightmost compound makes Chromium's invalidation set for that
// pseudo-class reach the descendants named by the rightmost compound —
// shared by every rule using it. `X > div:first-child > span` therefore
// restyles every <span> below any element whose first-child state changes, and
// `X > :first-child > :first-child` (no class or attribute on the right) or a
// positional `::first-letter` restyles its whole subtree. Opening the phone
// navigator inserts it before `.workspace`, which changed `.workspace`'s
// first-child state: a whole-chat restyle (~250 ms on a long chat, 1× CPU)
// at the moment the navigator began to slide (docs/dev/styles.md, "Motion
// and restyle cost"). Name the element with a class instead.
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

const POSITIONAL = /:(?:first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|nth-child\(|nth-last-child\(|nth-of-type\(|nth-last-of-type\()/;

/** Split at top-level separators (outside parentheses and brackets). */
function splitTop(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && separator.test(c)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The compounds of one complex selector, left to right. */
function compounds(selector: string): string[] {
  return splitTop(selector.replace(/\s*([>+~])\s*/g, " "), /\s/).map((part) => part.trim()).filter(Boolean);
}

/** Why a selector makes a positional invalidation set reach a subtree, or null. */
export function broadPositional(selector: string): string | null {
  const parts = compounds(selector);
  if (!parts.length) return null;
  const rightmost = parts.at(-1)!;
  const [subject = "", pseudoElement = ""] = rightmost.split(/(?=::)/);
  if (POSITIONAL.test(subject) && /::first-(?:letter|line)/.test(pseudoElement)) return "positional ::first-letter/::first-line";
  if (!parts.slice(0, -1).some((part) => POSITIONAL.test(part))) return null;
  // Classes, ids and attributes in the rightmost compound keep the
  // invalidation to elements that carry them; a bare tag or nothing does not.
  // `:is()`/`:where()` lend their arguments' features; `:not()`/`:has()` do not.
  const named = /[.#[]/.test(subject.replace(/:(?:not|has)\([^)]*\)/g, ""));
  return named ? null : "positional pseudo-class left of a subject with no class, id or attribute";
}

test("broadPositional names the selector shapes that restyle a subtree", () => {
  assert.equal(broadPositional(".a > div:first-child > span"), "positional pseudo-class left of a subject with no class, id or attribute");
  assert.equal(broadPositional(".a > :first-child > :first-child"), "positional pseudo-class left of a subject with no class, id or attribute");
  assert.equal(broadPositional(".a > :first-child::first-letter"), "positional ::first-letter/::first-line");
  assert.equal(broadPositional(".a > div:first-child > .note"), null);
  assert.equal(broadPositional(".a > :first-child"), null);
  assert.equal(broadPositional(".a > * > :first-child"), null);
  assert.equal(broadPositional(".a li:nth-child(2n) .b"), null);
  assert.equal(broadPositional(".a:not(:first-child)"), null);
  assert.equal(broadPositional(".a > .b:last-child > :is(.c, .d):last-child"), null);
  assert.equal(broadPositional(".a > .b:last-child > :not(.c)"), "positional pseudo-class left of a subject with no class, id or attribute");
});

test("no stylesheet lets a positional pseudo-class restyle a subtree", () => {
  const files = [...cssFiles(join(root, "apps", "web", "src")), ...cssFiles(join(root, "apps", "mobile", "src")), ...cssFiles(join(root, "packages"))];
  const offenders: string[] = [];
  for (const file of files) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
    for (const match of css.matchAll(/([^{}@;]+)\{/g)) {
      const prelude = match[1]!.trim();
      if (!prelude || prelude.startsWith("@") || /^(?:from|to|\d+%)/.test(prelude)) continue;
      for (const selector of splitTop(prelude, /,/)) {
        const reason = broadPositional(selector.trim());
        if (reason) offenders.push(`${relative(root, file)}:${css.slice(0, match.index).split("\n").length} ${selector.trim()} — ${reason}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
