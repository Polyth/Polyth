import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { COMPACT_MAX_WIDTH } from "../src/responsiveShell.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

/** Top-level rules of a comment-free stylesheet, as selector + body. */
function topLevelRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  let depth = 0;
  let prelude = "";
  let start = 0;
  for (let at = 0; at < css.length; at += 1) {
    const character = css[at];
    if (character === "{") {
      if (depth === 0) {
        rules.push({ selector: prelude.replace(/\s+/g, " ").trim(), body: "" });
        start = at + 1;
      }
      prelude = "";
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && rules.length > 0) rules[rules.length - 1]!.body = css.slice(start, at);
      prelude = "";
    } else if (depth === 0) {
      prelude += character;
    }
  }
  return rules;
}

test("the core token contract is isolated, imported first, and fully documented", async () => {
  const [tokens, styles, guide] = await Promise.all([
    read("../src/tokens.css"),
    read("../src/styles.css"),
    read("../../../docs/dev/styles.md"),
  ]);
  const cssWithoutComments = tokens.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const rules = topLevelRules(cssWithoutComments);

  // One vocabulary: the :root declaration plus the declared type-surface rules
  // that re-resolve it inside a conversation (see "Type surfaces" in
  // docs/dev/styles.md). Any other top-level selector here would be a second
  // place that defines shell-wide values.
  // `[dir="rtl"]`/`[dir="ltr"]` only set the direction token (`--stack-dir`),
  // wherever `dir` is set: <html> for the locale, shell frames for a mirrored
  // shell (shellDirection.ts).
  assert.deepEqual(rules.map((rule) => rule.selector), [
    ":root",
    '[dir="rtl"]',
    '[dir="ltr"]',
    ":root, .focus-conversation, .widget-conversation, .activity-group, .agent-status-dock, .subagent-island, .prompt-nav-panel",
    ".focus-conversation, .widget-conversation",
    ".activity-group, .agent-status-dock, .subagent-island, .prompt-nav-panel",
    "@media (pointer: coarse)",
  ]);
  assert.equal(rules[0]!.body.includes("{"), false, ":root declares values only");
  assert.match(styles, /^@import "\.\/tokens\.css";/);
  assert.doesNotMatch(styles, /(^|\n)\s*:root\s*\{/);

  // A token is declared once per surface. Only the surface bindings may repeat
  // one, and only in a declared type-surface rule.
  const surfaceRules = new Set(rules.slice(1).map((rule) => rule.selector));
  for (const selector of ['[dir="rtl"]', '[dir="ltr"]']) {
    const directionRule = rules.find((rule) => rule.selector === selector);
    assert.deepEqual([...(directionRule?.body ?? "").matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]), ["--stack-dir"]);
  }
  const declaredIn = new Map<string, string[]>();
  for (const rule of rules) {
    for (const match of rule.body.matchAll(/^\s*(--[\w-]+)\s*:/gm)) {
      const token = match[1];
      if (token === undefined) continue;
      declaredIn.set(token, [...(declaredIn.get(token) ?? []), rule.selector]);
    }
  }
  for (const [token, selectors] of declaredIn) {
    assert.equal(new Set(selectors).size, selectors.length, token + " is declared once per rule");
    for (const selector of selectors.slice(1)) {
      assert.ok(surfaceRules.has(selector), token + " is re-declared only on a type surface: " + selector);
    }
    assert.ok(guide.includes("`" + token + "`"), token + " is documented in the style guide");
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

test("settings right pane uses the active theme surface", async () => {
  const styles = await read("../src/styles.css");

  assert.match(styles, /\.settings-pane\s*\{[^}]*background:\s*var\(--bg\)/s);
});

test("runtime CSS does not introduce unscaled radius literals", async () => {
  const [core, mobile, entries] = await Promise.all([
    read("../src/styles.css"),
    read("../../mobile/src/styles.css"),
    readdir(new URL("../../../packages/", import.meta.url), { withFileTypes: true }),
  ]);
  const packages = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      try {
        return await read(`../../../packages/${entry.name}/widgets/styles.css`);
      } catch {
        return "";
      }
    }));
  const css = [core, mobile, ...packages].join("\n");
  // Local radius aliases (e.g. `--desktop-chrome-radius: var(--radius-sheet)`)
  // count as semantic tokens.
  const aliases = [...css.matchAll(/(--[\w-]*radius[\w-]*)\s*:\s*var\(--radius[\w-]*\)/g)].map((match) => match[1]!);
  for (const match of css.matchAll(/border(?:-[\w-]+)?-radius\s*:\s*([^;]+)/g)) {
    const value = match[1]!.trim();
    if (/^(?:0(?:\s+0)*|50%|inherit)(?:\s*!important)?$/.test(value)) continue;
    assert.ok(
      value.includes("var(--radius") || value.includes("var(--corner-radius-scale)")
        || aliases.some((alias) => value.includes(`var(${alias})`)),
      `radius must use a semantic token or the shared scale: ${value}`,
    );
  }
});

test("Corner rounding notches are even steps: square at 0, native at 9, one more step at 10", async () => {
  const { cornerRadiusScale, CORNER_ROUNDING_STEP } = await import("../src/uiPrefs.ts");
  assert.equal(cornerRadiusScale(0), 0);
  assert.equal(cornerRadiusScale(9), 1.8, "the default draws every style's native radii");
  assert.equal(cornerRadiusScale(10), 2.25, "the last notch is 1.25× native, not a doubled shape");
  // Every notch past square is the same ratio, so the top notches change as
  // visibly as the low ones and the last one is no jump.
  for (let r = 2; r <= 10; r += 1) {
    const ratio = cornerRadiusScale(r) / cornerRadiusScale(r - 1);
    assert.ok(Math.abs(ratio - CORNER_ROUNDING_STEP) < 0.01, `notch ${r - 1} → ${r} is ×${ratio.toFixed(3)}`);
  }
  assert.equal(cornerRadiusScale(42), cornerRadiusScale(10));
  assert.equal(cornerRadiusScale(-3), 0);
});

test("Corner rounding reaches every pill and scales every platform style's radii with no last-notch floor", async () => {
  const [tokens, fluent, macos, glass, styles, composer] = await Promise.all([
    read("../src/tokens.css"),
    read("../src/fluentTheme.css"),
    read("../src/macosTheme.css"),
    read("../src/liquidGlassTheme.css"),
    read("../src/styles.css"),
    read("../src/composerAdaptive.css"),
  ]);
  // A pill squares with the setting; only --radius-circle keeps its shape.
  assert.match(tokens, /--radius-round:\s*calc\(14px \* var\(--corner-radius-scale\)\);/);
  assert.match(tokens, /--radius-circle:\s*999px/);
  // A switch is a full pill from the default rounding up and squares with the
  // rest; only --radius-circle keeps its shape at every notch.
  assert.match(tokens, /--radius-switch:\s*calc\(6\.25px \* var\(--corner-radius-scale\)\);/);
  // The last notch once swapped native radii for 22–32px floors and 999px
  // pills, doubling cards and menus in one step. It is the curve's next step now.
  for (const css of [tokens, fluent, macos, glass]) assert.doesNotMatch(css, /--radius-max-|--corner-max/);
  assert.match(glass, /html\[data-theme-style="liquid-glass"\] \.switch \{\s*width:\s*40px;\s*\}/,
    "the liquid-glass switch button shares its 40px track box, so the focus ring follows the capsule");
  for (const [css, round] of [[fluent, "--fluent-round"], [macos, "--macos-round"], [glass, "--lg-round"]] as const) {
    for (const role of ["control", "card", "surface", "sheet", "island", "dock", "composer", "round"]) {
      assert.match(css, new RegExp(`--radius-${role}:\\s*calc\\(\\d+px \\* var\\(${round}\\)\\);`), `${round} ${role}`);
    }
  }
  // The project and branch chips sit on one baseline: the shared .chip hover
  // lift must not move a context chip, and its surface cue is the only change.
  assert.match(styles, /\.context-selector \.picker-chip:hover:where\(:not\(:disabled\)\) \{[^}]*transform:\s*none;/,
    "context chips keep their baseline on hover instead of lifting like a standalone chip");
  assert.match(styles, /\.context-selector \.picker-chip:hover:where\(:not\(:disabled\)\) svg \{ color:\s*var\(--faint\); \}/,
    "a context chip keeps its project or branch glyph ink on hover instead of taking the accent");
  // Controls beside the composer's edge never freeze into a circle of their own.
  assert.match(styles, /\.composer-simple \.composer-rail \.send \{[^}]*border-radius:\s*var\(--radius-round\)/);
  assert.match(styles, /\.composer-simple \.composer-stop-primary \{[^}]*border-radius:\s*var\(--radius-round\)/);
  // The running Send is that same .send: no corner of its own to freeze.
  assert.doesNotMatch(composer, /\.composer-running-send[^{]*\{[^}]*border-radius/);
  // The navigation island takes the corner of the action island it sits beside.
  assert.doesNotMatch(styles, /\.mobile-float-navigation \{ border-radius/);
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
  assert.doesNotMatch(packages, /\.view-page|\.module-view(?:-body|-content)?/,
    "packages cannot own or restyle the shared module frame");
  assert.doesNotMatch(packages, /--tt-radius-/);
  assert.doesNotMatch(packages, /:is\(\s*\.audit-(?:note|list),/);
  assert.doesNotMatch(packages, /\.settings-pane-body :is\(/);
  assert.doesNotMatch(packages, /\.dialog-panel > :is\(/);

  assert.equal((styles.match(/--scroll-affordance:/g) ?? []).length, 1);
  assert.match(styles, /\.empty-state--compact,[\s\S]*?\.empty-state--panel\s*\{/);
  assert.match(styles, /\.module-view-content,\s*\.settings-pane-body,[\s\S]*?container:\s*feature-panel\s*\/\s*inline-size/);
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

test("tablet-class width is a container-query layout state, not a media pile", async () => {
  const styles = await read("../src/styles.css");

  assert.match(
    styles,
    /\.app-shell\s*\{[^}]*container:\s*app-shell\s*\/\s*inline-size/,
    ".app-shell is the shell container the tablet band queries",
  );
  const bandMin = COMPACT_MAX_WIDTH + 1;
  const band = new RegExp(
    `@container app-shell \\(min-width: ${bandMin}px\\) and \\(max-width: 1400px\\)\\s*\\{`,
  );
  assert.match(styles, band, "the tablet band starts one pixel above the compact seam");
  const bandBlock = styles.slice(styles.search(band));
  const bandBody = bandBlock.slice(0, bandBlock.indexOf("\n}\n") + 3);

  assert.match(
    bandBody,
    /\.railbar:not\(\.railbar-open\):not\(\[data-rail-motion="exiting"\]\)\s*\{[^}]*height:\s*auto/,
    "the idle cluster keys off canonical open state but never interrupts its exit transition",
  );
  assert.doesNotMatch(
    bandBody,
    /:has\(\.rail\)/,
    "the band must not reverse-engineer rail state from .rail DOM presence",
  );
  assert.match(
    bandBody,
    /\.railbar:not\(\.railbar-open\):not\(\[data-rail-motion="exiting"\]\)\s*\{[^}]*max-height:/,
    "the floating cluster is bounded so a long plugin list scrolls, not overflows",
  );
  assert.match(
    bandBody,
    /\.app-shell:not\(:has\(\.railbar-open:not\(\.railbar-dynamic\)\)\):not\(:has\(\.railbar\[data-rail-motion="exiting"\]:not\(\.railbar-dynamic\)\)\)[\s\S]*?padding-inline-end:/,
    "chat surfaces reserve a lane for the affordance so nothing renders beneath it",
  );
});

test("the canvas reserves the idle rail's lane at every desktop width", async () => {
  const styles = await read("../src/styles.css");
  // Several blocks share this query; take the one that owns the rail overlay.
  const desktop = new RegExp(`@media \\(min-width: ${COMPACT_MAX_WIDTH + 1}px\\)\\s*\\{[\\s\\S]*?\\n\\}\\n`, "g");
  const block = [...styles.matchAll(desktop)]
    .map((match) => match[0])
    .find((body) => body.includes(".widget-canvas-grid")) ?? "";

  // The idle rail is `position: absolute` at the shell's inline end from this
  // width up, and it now renders in Canvas as well as Chat. A full-bleed
  // canvas must not put widgets (or the add-widget trigger) underneath it.
  assert.match(
    block,
    /\.railbar\s*\{[^}]*position:\s*absolute[^}]*inset-inline-end:\s*0/s,
    "the idle rail overlays the shell edge on desktop",
  );
  assert.match(
    block,
    /\.app-shell:not\(:has\(\.railbar-open\)\) \.widget-canvas-grid\s*\{[^}]*padding-inline-end:/,
    "the canvas grid reserves the launcher lane",
  );
  assert.match(
    block,
    /\.app-shell:not\(:has\(\.railbar-open\)\) \.widget-menu-trigger\s*\{[^}]*right:/,
    "the add-widget trigger clears the launcher lane",
  );
  assert.match(
    block,
    /\.app-shell:not\(:has\(\.railbar-open\)\) \.widget-menu-single\s*\{[^}]*right:/,
    "the add-widget panel clears the launcher lane",
  );
});
