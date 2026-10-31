// Buttons answer the pointer only while they are enabled, and hover only where
// a pointer can hover ("Buttons" in docs/dev/design-system.md). Every :hover or
// :active rule that can reach a button — in the shell and in every package —
// carries a disabled guard, and every :hover rule lives in a hover-capable
// media query: a touch screen keeps :hover on the last tapped point.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const root = join(import.meta.dirname, "..", "..", "..");

function files(dir: string, test: (name: string) => boolean, out: string[] = []): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (["node_modules", "dist", "test", "native", "android", "ios"].includes(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, test, out);
    else if (test(name)) out.push(path);
  }
  return out;
}

const sourceRoots = () => [
  join(root, "apps/web/src"),
  join(root, "apps/mobile/src"),
  ...readdirSync(join(root, "packages")).map((name) => join(root, "packages", name, "widgets")),
];

/** Split at top-level occurrences of `separator` (outside (), [] and strings). */
function splitTop(text: string, separator: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && separator.test(ch)) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The compound with the arguments of functional pseudo-classes removed. */
function topLevel(compound: string): string {
  let out = "";
  let depth = 0;
  for (const ch of compound) {
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/** Every style rule's selector list with the at-rule preludes around it. */
export function styleRules(css: string): Array<{ prelude: string; media: string }> {
  const rules: Array<{ prelude: string; media: string }> = [];
  const stack: Array<{ kind: "at" | "style"; prelude: string }> = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    const ch = css[i];
    if (ch === "\"" || ch === "'") {
      for (i++; i < css.length && css[i] !== ch; i++) if (css[i] === "\\") i++;
      continue;
    }
    if (ch === "{") {
      const prelude = css.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (prelude.startsWith("@")) stack.push({ kind: "at", prelude });
      else {
        stack.push({ kind: "style", prelude });
        rules.push({ prelude, media: stack.filter((s) => s.kind === "at").map((s) => s.prelude).join(" ") });
      }
      start = i + 1;
    } else if (ch === "}") {
      stack.pop();
      start = i + 1;
    } else if (ch === ";") start = i + 1;
  }
  return rules;
}

const STATE_TOKENS = /^(active|selected|current|on|open|done|checked|pressed|expanded|hovered|picked|linked|unread|danger|primary|(is|has)-[\w-]+)$/;
const BUTTON_NAME = /^ui-(icon-)?btn\b|(^|[-_])(btn|button)s?([-_]|$)/;
const HOVER_MEDIA = /\((?:any-)?hover:\s*hover\)|\(pointer:\s*fine\)/;
const TOUCH_MEDIA = /\((?:any-)?hover:\s*none\)|\((?:any-)?pointer:\s*coarse\)/;
const GUARD = /:where\(:not\(:disabled|:not\(:disabled\)|:not\(\[disabled\]\)|:enabled|:disabled/;

/** Classes the sources put on a button (`<button>`, `Button`, `IconButton`, role="button"). */
export function buttonClasses(sourceFiles: string[]): Set<string> {
  const classes = new Set<string>();
  const tokens = (node: ts.Node, out: Set<string>) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) node.text.split(/\s+/).forEach((t) => out.add(t));
    else if (ts.isTemplateExpression(node)) {
      node.head.text.split(/\s+/).forEach((t) => out.add(t));
      for (const span of node.templateSpans) {
        tokens(span.expression, out);
        span.literal.text.split(/\s+/).forEach((t) => out.add(t));
      }
      return;
    }
    ts.forEachChild(node, (child) => tokens(child, out));
  };
  for (const file of sourceFiles) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("className")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source);
        let className: ts.Node | undefined;
        let role = "";
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
          const name = attr.name.getText(source);
          if (name === "className") className = attr.initializer;
          if (name === "role") role = attr.initializer.getText(source);
        }
        if (className && (tag === "button" || /Button$/.test(tag) || /"button"/.test(role))) tokens(className, classes);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const token of [...classes]) if (!/^-?[_a-zA-Z][\w-]*$/.test(token) || STATE_TOKENS.test(token)) classes.delete(token);
  return classes;
}

/** Selectors of one rule that break the button-state contract, with the reason. */
export function violations(rule: { prelude: string; media: string }, buttons: Set<string>): string[] {
  const found: string[] = [];
  for (const selector of splitTop(rule.prelude, /,/)) {
    for (const compound of splitTop(selector, /[\s>+~]/)) {
      const top = topLevel(compound);
      const hover = /:hover(?![\w-])/.test(top);
      const active = /:active(?![\w-])/.test(top);
      const grouped = /:(?:is|where)\([^)]*:(?:hover|active)(?![\w-])/.test(compound);
      // A rule about the disabled state (`:disabled:hover`) is its own guard.
      if ((!hover && !active && !grouped) || /:disabled(?![\w-])/.test(top)) continue;
      const own = compound.replace(/:(?:not|has)\((?:[^()]|\([^()]*\))*\)/g, "");
      const button = /(^|[^\w-])button(?![\w-])/.test(own)
        || [...own.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].some(([, name]) => buttons.has(name!) || BUTTON_NAME.test(name!));
      if (!button) continue;
      if (!GUARD.test(compound)) found.push(`${selector}  — no :where(:not(:disabled)) guard`);
      else if (hover && !HOVER_MEDIA.test(rule.media) && !TOUCH_MEDIA.test(rule.media)) {
        found.push(`${selector}  — :hover outside @media (hover: hover)`);
      }
    }
  }
  return found;
}

test("the checker flags unguarded and touch-reachable button hovers only", () => {
  const buttons = new Set(["save-btn", "chip"]);
  const check = (css: string) => styleRules(css).flatMap((rule) => violations(rule, buttons));
  assert.deepEqual(check("@media (hover: hover) { .chip:hover:where(:not(:disabled)) { color: red; } }"), []);
  assert.deepEqual(check(".chip:active:where(:not(:disabled)) { transform: scale(.98); }"), []);
  assert.deepEqual(check(".row:hover { background: red; } .row:hover .chip { opacity: 1; }"), [], "rows and reveals are not buttons");
  assert.deepEqual(check(".chip:focus-visible { outline: 0; } .chip[aria-pressed=\"true\"] { color: red; }"), []);
  assert.match(check(".chip:hover { color: red; }")[0] ?? "", /no :where\(:not\(:disabled\)\) guard/);
  assert.match(check(".x .save-btn:active { color: red; }")[0] ?? "", /no :where\(:not\(:disabled\)\) guard/);
  assert.match(check("button:hover:not(:disabled) { color: red; }")[0] ?? "", /outside @media \(hover: hover\)/);
  assert.match(
    check("@media (max-width: 480px) { .chip:hover:where(:not(:disabled)) { color: red; } }")[0] ?? "",
    /outside @media \(hover: hover\)/,
    "a layout query is not a pointer query",
  );
  assert.deepEqual(check(".chip:is(:hover, :focus-visible):where(:not(:disabled)) { color: red; }"), [],
    "a hover grouped with focus must also apply to a keyboard on touch");
  assert.deepEqual(check(".chip:disabled:hover { background: transparent; }"), [], "a rule about the disabled state is its own guard");
});

test("every button hover and press in the shell and packages is guarded and hover-only", () => {
  const roots = sourceRoots();
  const buttons = buttonClasses(roots.flatMap((dir) => files(dir, (name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"))));
  assert.ok(["memory-button", "chip", "gallery-send-button"].every((name) => buttons.has(name)), "the source scan finds button classes");
  const stylesheets = roots.flatMap((dir) => files(dir, (name) => name.endsWith(".css")));
  assert.ok(stylesheets.length > 80, "every shell and package stylesheet is audited");
  const found = stylesheets.flatMap((file) => {
    const css = readFileSync(file, "utf8");
    return styleRules(css).flatMap((rule) => violations(rule, buttons)).map((line) => `${relative(root, file)}: ${line}`);
  });
  assert.deepEqual(found, [], "a disabled button must not answer hover or press, and touch must not keep a hover");
});

/** Button classes a stylesheet styles as `[aria-disabled="true"]` whose hover still answers. */
export function ariaDisabledHovers(css: string, buttons: Set<string>): string[] {
  const rules = styleRules(css);
  const classesOf = (compound: string) => [...compound.replace(/:(?:not|has|where|is)\((?:[^()]|\([^()]*\))*\)/g, "").matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(([, name]) => name!);
  const ariaDisabled = new Set<string>();
  for (const rule of rules) {
    for (const selector of splitTop(rule.prelude, /,/)) {
      for (const compound of splitTop(selector, /[\s>+~]/)) {
        if (/^[^:]*\[aria-disabled="true"\]/.test(compound.replace(/:(?:not|where)\((?:[^()]|\([^()]*\))*\)/g, ""))) {
          for (const name of classesOf(compound)) if (buttons.has(name) || BUTTON_NAME.test(name)) ariaDisabled.add(name);
        }
      }
    }
  }
  const found: string[] = [];
  for (const rule of rules) {
    for (const selector of splitTop(rule.prelude, /,/)) {
      for (const compound of splitTop(selector, /[\s>+~]/)) {
        if (!/:hover(?![\w-])/.test(topLevel(compound))) continue;
        if (!classesOf(compound).some((name) => ariaDisabled.has(name))) continue;
        if (!/:not\([^)]*\[aria-disabled="true"\]/.test(compound)) found.push(`${selector}  — hover answers aria-disabled`);
      }
    }
  }
  return found;
}

test("a focusable aria-disabled button does not answer hover either", () => {
  const buttons = new Set(["pick"]);
  assert.deepEqual(ariaDisabledHovers(".pick[aria-disabled=\"true\"] { color: gray; } .pick:hover:where(:not(:disabled, [aria-disabled=\"true\"])) { color: red; }", buttons), []);
  assert.equal(ariaDisabledHovers(".pick[aria-disabled=\"true\"] { color: gray; } .pick:hover:where(:not(:disabled)) { color: red; }", buttons).length, 1);
  const roots = sourceRoots();
  const classes = buttonClasses(roots.flatMap((dir) => files(dir, (name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"))));
  const found = roots.flatMap((dir) => files(dir, (name) => name.endsWith(".css")))
    .flatMap((file) => ariaDisabledHovers(readFileSync(file, "utf8"), classes).map((line) => `${relative(root, file)}: ${line}`));
  assert.deepEqual(found, []);
});

test("disabled buttons are gray and inert at rest, through the shared tokens", () => {
  const tokens = readFileSync(join(root, "apps/web/src/tokens.css"), "utf8");
  const styles = readFileSync(join(root, "apps/web/src/styles.css"), "utf8");
  for (const token of ["--control-disabled-bg", "--control-disabled-border", "--control-disabled-ink"]) {
    assert.match(tokens, new RegExp(`${token}:\\s*color-mix\\(`), `${token} derives from the theme ink`);
  }
  assert.match(styles, /\nbutton:disabled \{ opacity: 0\.5; filter: grayscale\(1\); cursor: default; \}/,
    "a package-painted disabled button turns gray instead of fading its accent");
  const primitive = /\.ui-btn:disabled:not\(\[aria-busy="true"\]\) \{([^}]*)\}/.exec(styles)?.[1] ?? "";
  assert.match(primitive, /background: var\(--control-disabled-bg\) !important/);
  assert.match(primitive, /border-color: var\(--control-disabled-border\) !important/);
  assert.match(primitive, /color: var\(--control-disabled-ink\) !important/);
  assert.match(primitive, /box-shadow: none !important/);
  assert.match(styles, /\.ui-btn\[aria-busy="true"\] \{ opacity: 1; filter: none; cursor: progress; \}/,
    "busy keeps its variant: the spinner carries the state");
  assert.match(styles, /:where\(button:disabled, \[aria-disabled="true"\]\) \{ -webkit-tap-highlight-color: transparent; \}/);
});

test("a tap never repaints a button: the base hover is pointer-only and nothing flattens it on touch", () => {
  const styles = readFileSync(join(root, "apps/web/src/styles.css"), "utf8");
  assert.match(styles, /@media \(hover: hover\) \{\nbutton:hover:where\(:not\(:disabled, \[aria-disabled="true"\]\)\) \{/);
  // The old touch reset painted every tapped button transparent, erasing the
  // fill of selected tabs, pressed toggles and filled package actions.
  for (const rule of styleRules(styles)) {
    if (TOUCH_MEDIA.test(rule.media)) assert.doesNotMatch(rule.prelude, /^button:not\(/, `touch reset is gone: ${rule.prelude}`);
  }
  // Press feedback composes with the button's own fill (an inset wash), so a
  // filled, selected or colored button stays readable under the finger.
  assert.match(styles, /button:active:where\(:not\(:disabled, \[aria-disabled="true"\], \.ui-btn\)\) \{\n  box-shadow: inset 0 0 0 100vmax var\(--surface-overlay-strong\);/);
});
