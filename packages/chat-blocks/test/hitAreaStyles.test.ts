// A stretched, chromeless hit area must not take the host's generic button
// skin. `apps/web/src/styles.css` paints `button:hover { background:
// var(--elevated) }` (and `button:active`), which outranks a lone
// `.chat-block-hit` rule by specificity; the hit button covers the whole card,
// so that background would paint the block's own text out. Guard the
// package-scoped state rule that keeps the hit transparent.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

/** Bodies of rules whose selector matches, from a comment-free stylesheet. */
function rulesFor(css: string, selector: RegExp): string[] {
  const bodies: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rule.exec(css)) !== null) {
    if (selector.test(match[1]!.trim())) bodies.push(match[2]!);
  }
  return bodies;
}

test("the stretched hit area stays transparent through hover and active", async () => {
  const css = (await read("../widgets/styles.css")).replace(/\/\*[\s\S]*?\*\//g, "");

  const base = rulesFor(css, /^\.chat-block-hit$/);
  assert.equal(base.length, 1, "one base .chat-block-hit rule");
  assert.match(base[0]!, /background:\s*transparent/);

  // The state rule must outrank `button:hover`/`button:active`: two classes
  // (`.chat-block` + `.chat-block-hit`) plus the state pseudo-class.
  const states = rulesFor(css, /^\.chat-block \.chat-block-hit:is\(/);
  assert.equal(states.length, 1, "one scoped .chat-block .chat-block-hit state rule");
  assert.match(states[0]!, /background:\s*transparent/);
  assert.doesNotMatch(states[0]!, /background:\s*var\(/);
});
