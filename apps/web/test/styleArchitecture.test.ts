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

test("Workspace chrome does not restyle package-owned Usage content", async () => {
  const [premium, widgetFixes, sessionUsage] = await Promise.all([
    read("../src/workspacePanelPremium.css"),
    read("../src/workspacePanelWidgetFixes.css"),
    read("../../../packages/usage/widgets/sessionUsage.css"),
  ]);
  const host = `${premium}\n${widgetFixes}`;

  assert.doesNotMatch(host, /\.usage-[\w-]+/, "host Workspace CSS must not target package-owned Usage selectors");
  assert.match(sessionUsage, /\.usage-session-widget\s*\{[^}]*container:\s*usage-session\s*\/\s*inline-size/s);
  assert.match(sessionUsage, /@container usage-session \(max-width: 520px\)/);
  assert.doesNotMatch(sessionUsage, /@media[^{]*max-width/,
    "embedded Usage content responds to its container, not the viewport");
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
    /\.railbar:not\(\.railbar-open\)\s*\{[^}]*height:\s*auto/,
    "the idle cluster keys off .railbar-open, the authoritative open state",
  );
  assert.doesNotMatch(
    bandBody,
    /:has\(\.rail\)/,
    "the band must not reverse-engineer rail state from .rail DOM presence",
  );
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
});
