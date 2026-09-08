import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { COMPACT_MAX_WIDTH } from "../src/responsiveShell.ts";

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
  for (const match of css.matchAll(/border(?:-[\w-]+)?-radius\s*:\s*([^;]+)/g)) {
    const value = match[1]!.trim();
    if (/^(?:0(?:\s+0)*|50%|inherit)(?:\s*!important)?$/.test(value)) continue;
    assert.ok(
      value.includes("var(--radius") || value.includes("var(--corner-radius-scale)"),
      `radius must use a semantic token or the shared scale: ${value}`,
    );
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
  // The band's lower bound must sit exactly one pixel above the compact seam
  // (COMPACT_MAX_WIDTH + 1 = 961): below it the navigator is already a drawer
  // (the compact shell owns the layout), so the band and the compact rules can
  // neither overlap nor leave a gap. That guarantees the two rule sets tile
  // cleanly — it does NOT make 960 -> 961 geometrically continuous: at 961 the
  // persistent navigator and a reserved launcher lane enter flow and the
  // primary workspace drops from the full width to ~621px in one pixel. The
  // seam is placed where both sides are usable, not eliminated; see
  // docs/dev/tablet-ux.md. What this test pins is only that a drawer-nav shell
  // hands off to a persistent-nav shell whose idle rail is a bounded floating
  // cluster, with no width where both or neither apply.
  const bandMin = COMPACT_MAX_WIDTH + 1;
  const band = new RegExp(
    `@container app-shell \\(min-width: ${bandMin}px\\) and \\(max-width: 1400px\\)\\s*\\{`,
  );
  assert.match(styles, band, "the tablet band starts one pixel above the compact seam");
  const bandBlock = styles.slice(styles.search(band));
  const bandBody = bandBlock.slice(0, bandBlock.indexOf("\n}\n") + 3);

  // Open/closed is the semantic `.railbar-open` class (React `rail` state), not
  // `:has(.rail)`: a visited keep-alive surface leaves `.rail` mounted-but-
  // hidden after close, so a `:has(.rail)` guard would latch the shell into the
  // open layout for the rest of the session (regression: keepAliveRailState).
  assert.match(
    bandBody,
    /\.railbar:not\(\.railbar-open\)\s*\{[^}]*height:\s*auto/,
    "the idle cluster keys off .railbar-open, the authoritative open state",
  );
  assert.doesNotMatch(
    bandBody,
    /:has\(\.rail\)/,
    "the band must not reverse-engineer rail state from .rail DOM presence",
  );
  // Many packages + short viewport: the cluster is height-bounded and scrolls.
  assert.match(
    bandBody,
    /\.railbar:not\(\.railbar-open\)\s*\{[^}]*max-height:/,
    "the floating cluster is bounded so a long plugin list scrolls, not overflows",
  );
  assert.match(
    bandBody,
    /\.app-shell:not\(:has\(\.railbar-open\)\)[\s\S]*?padding-inline-end:/,
    "chat surfaces reserve a lane for the affordance so nothing renders beneath it",
  );
});
