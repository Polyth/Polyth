import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const cssPath = fileURLToPath(new URL("../widgets/styles.css", import.meta.url));
const appCssPath = fileURLToPath(new URL("../../../apps/web/src/styles.css", import.meta.url));

/** Count (id, class, type) simple selectors in one complex selector. */
function specificity(selector: string): [number, number, number] {
  // Only attribute/class/type counts matter for these rules; ids are absent.
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?/g) ?? []).length;
  const types = (selector.match(/(?:^|[\s>+~])([a-zA-Z][\w-]*)/g) ?? []).length;
  return [ids, classes, types];
}

function compareSpecificity(a: string, b: string): number {
  const [ai, ac, at] = specificity(a);
  const [bi, bc, bt] = specificity(b);
  return ai - bi || ac - bc || at - bt;
}

/** Strip comments so a selector regex cannot match comment prose. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Extract declarations of rules whose selector list contains `match`. */
function declarationsFor(source: string, match: RegExp): Map<string, string>[] {
  const css = stripComments(source);
  const out: Map<string, string>[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(css)) !== null) {
    if (!match.test(m[1]!)) continue;
    const decls = new Map<string, string>();
    for (const part of m[2]!.split(";")) {
      const idx = part.indexOf(":");
      if (idx < 0) continue;
      decls.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
    out.push(decls);
  }
  return out;
}

test("borderless appearance: caret keeps a visible border-left inside the editor", async () => {
  const css = await readFile(cssPath, "utf8");
  const rules = declarationsFor(css, /\.cm-cursor|\.cm-dropCursor/);
  const caretRules = rules.filter((decls) => decls.get("border-left-color") !== undefined);
  assert.equal(caretRules.length >= 1, true, "a border-left-color rule exists for the caret");
  for (const decls of caretRules) {
    assert.equal(decls.get("border-left-color"), "var(--text) !important");
  }
});

test("borderless caret exception outranks the global hide-borders rule", async () => {
  const css = await readFile(cssPath, "utf8");
  const app = await readFile(appCssPath, "utf8");
  const globalMatch = /body\[data-hide-borders="true"\] \*\s*,\s*body\[data-hide-borders="true"\] \*::before\s*,\s*body\[data-hide-borders="true"\] \*::after/.exec(app);
  assert.ok(globalMatch, "global transparent-border rule found");
  const globalSelector = "body[data-hide-borders=\"true\"] *";

  const caretRule = /([^{}]*\.cm-cursor[^{}]*)\{([^{}]*border-left-color[^{}]*)\}/.exec(stripComments(css));
  assert.ok(caretRule, "borderless caret rule found in editor styles.css");
  const selectorList = caretRule![1]!;
  const selectors = selectorList.split(",").map((s) => s.trim()).filter(Boolean);
  assert.equal(selectors.length >= 2, true, "covers both .cm-cursor and .cm-dropCursor");
  for (const selector of selectors) {
    assert.match(selector, /body\[data-hide-borders="true"\] \.cm-editor \.cm-(?:cursor|dropCursor)$/);
    assert.equal(
      compareSpecificity(selector, globalSelector) > 0,
      true,
      `${selector} must outrank ${globalSelector}`,
    );
  }
  assert.match(caretRule![2]!, /!important/, "exception is important so order cannot defeat it");
});

test("borderless appearance: border-only editor states get a non-border affordance", async () => {
  const css = await readFile(cssPath, "utf8");
  const expectations: Array<[string, Map<string, string>[]]> = [
    [".cm-matchingBracket", declarationsFor(css, /\.cm-matchingBracket/)],
    [".cm-searchMatch", declarationsFor(css, /\.cm-searchMatch/)],
    [".cm-foldPlaceholder", declarationsFor(css, /\.cm-foldPlaceholder/)],
    [".cm-tooltip", declarationsFor(css, /\.cm-tooltip/)],
  ];
  for (const [name, rules] of expectations) {
    assert.equal(rules.length >= 1, true, `${name} has a borderless rule`);
    const decls = rules[0]!;
    const affordance = decls.get("background-color") ?? decls.get("outline") ?? decls.get("box-shadow");
    assert.equal(typeof affordance === "string" && affordance.length > 0, true, `${name} keeps a visible affordance`);
  }
});
