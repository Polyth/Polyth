import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SHELL_LOOKS } from "../src/uiPrefs.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

test("every interface style has its layer and the standard shell has none", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  for (const look of SHELL_LOOKS) {
    const scoped = css.includes(`body[data-shell-look="${look}"]`);
    if (look === "standard") assert.equal(scoped, false, "standard is today's shell; nothing restyles it");
    else assert.ok(scoped, `${look} has no rules in shellLooks.css`);
  }
  // The shared base must never match the standard shell either.
  for (const match of css.matchAll(/body\[data-shell-look\](?!=)([^\s{,]*)/g)) {
    assert.match(match[1]!, /^:not\(\[data-shell-look="standard"\]\)/, `unscoped shared selector: ${match[0]}`);
  }
});

test("interface styles load after every other shell stylesheet", async () => {
  const main = await read("../src/main.tsx");
  const imports = [...main.matchAll(/^import "\.\/([^"]+\.css)";/gm)].map((match) => match[1]);
  assert.equal(imports.at(-1), "shellLooks.css");
});

test("interface styles use theme tokens, logical margins and a low-specificity token base", async () => {
  for (const file of ["../src/shellLooks.css", "../src/components/settings/ShellLookPicker.css"]) {
    const css = stripComments(await read(file));
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false, `${file} hard-codes a hex colour`);
    // A mirrored shell flips inline sides, so desktop spacing must be logical.
    for (const [, value] of css.matchAll(/(?:^|[;{\s])(?:margin|padding):\s*([^;}]+)/g)) {
      const sides = value!.replace("!important", "").trim().split(/\s+/);
      assert.ok(sides.length < 4 || sides[1] === sides[3], `${file} sets uneven physical sides: ${value}`);
    }
    assert.equal(/\bmargin-(left|right)\b|\bpadding-(left|right)\b/.test(css), false, `${file} uses a physical side`);
  }
  const css = stripComments(await read("../src/shellLooks.css"));
  // Defaults each look overrides must sit at zero specificity, or they win
  // over the look's own values (a look rule is body[attr]:not(#\#), 1-1-1).
  assert.match(css, /:where\(body\[data-shell-look\]:not\(\[data-shell-look="standard"\]\)\) \{\s*--look-veil:/);
  // Every look rule carries id strength, so a look layers over any theme style
  // recipe (liquidGlassTheme.css and friends use none) whatever its selector.
  for (const rule of css.matchAll(/([^{}]+)\{/g)) {
    const selector = rule[1]!.trim();
    if (!selector.includes("body[data-shell-look") || selector.startsWith(":where(") || selector.startsWith("@")) continue;
    for (const part of selector.split(/,(?![^(]*\))/)) {
      if (part.includes("body[data-shell-look")) assert.match(part, /body\[data-shell-look[^\s]*:not\(#\\#\)/, `look rule without id strength: ${part.trim()}`);
    }
  }
  // Every look follows the real Wallpaper and Transparency settings.
  for (const glass of ["clear", "off"]) {
    assert.ok(css.includes(`html:not([data-background="none"]) body[data-shell-look]:not([data-shell-look="standard"])[data-glass="${glass}"]`), glass);
  }
});

test("over a wallpaper the veils stay readable unless the image's tone matches the theme", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `missing ${selector}`);
    return css.slice(start, css.indexOf("}", start));
  };
  const percent = (body: string, token: string) => Number(body.match(new RegExp(`${token}:\\s*(\\d+)%`))?.[1]);
  const base = 'html:not([data-background="none"]) body[data-shell-look]:not([data-shell-look="standard"])';
  const matched = 'html:is(.light[data-background-tone="light"], :not(.light)[data-background-tone="dark"]):not([data-background="none"]) body[data-shell-look]:not([data-shell-look="standard"])';
  for (const glass of ["", '[data-glass="clear"]', '[data-glass="off"]']) {
    // Another tone, a mixed image or a custom image not sampled yet: every
    // layer under text is thick enough for quiet ink, whatever Transparency says.
    const readable = block(`${base}${glass}:not(#\\#)`);
    for (const token of ["--look-veil", "--look-veil-soft", "--look-a", "--look-float-a", "--look-overlay-a"]) {
      assert.ok(percent(readable, token) >= 84, `${glass || "matte"} ${token} is too thin for an unmatched image`);
    }
    // Only an image in the theme's own tone may show through more.
    const thin = block(`${matched}${glass}:not(#\\#)`);
    assert.ok(percent(thin, "--look-veil") < percent(readable, "--look-veil"), `${glass || "matte"} matched rung`);
    // A phone navigator covers the conversation, not only the wallpaper.
    assert.ok(percent(thin, "--look-overlay-a") >= 92, `${glass || "matte"} overlay over text`);
  }
  // Air and Obsidian write the conversation straight on their canvas, so over
  // a wallpaper that canvas veils as densely as a sheet (never the soft veil).
  for (const rule of [
    css.match(/body\[data-shell-look="air"\]:not\(#\\#\) \.app \{[^}]*\}/)?.[0] ?? "",
    css.match(/html:not\(\[data-background="none"\]\) body\[data-shell-look="obsidian"\]:not\(#\\#\) \.app \{[^}]*\}/)?.[0] ?? "",
    css.match(/html\.light:not\(\[data-background="none"\]\) body\[data-shell-look="obsidian"\]:not\(#\\#\) \.app \{[^}]*\}/)?.[0] ?? "",
  ]) {
    assert.match(rule, /var\(--look-veil\)/, `conversation canvas veil: ${rule.slice(0, 60)}`);
  }
});

test("interface styles keep quiet text readable and speak one selection language", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  // An alpha of --text loses contrast over every lighter backdrop; quiet ink
  // comes from the theme's contrast-checked tokens, and text is never faded.
  for (const [, value] of css.matchAll(/--look-ink-(?:quiet|dim):\s*([^;]+);/g)) {
    assert.match(value!, /^var\(--(?:muted|text-dim|text)\)$/, `quiet ink must be a theme ink: ${value}`);
  }
  assert.equal(/\.(?:project-path|session-title-text|desktop-session-status-end)\s*\{[^}]*opacity/.test(css), false, "text is faded with opacity");
  // Selection, hover and the top-rail controls are styled once, from tokens;
  // a look only sets the tokens, so no look restyles them on its own.
  for (const look of SHELL_LOOKS) {
    if (look === "standard") continue;
    const own = new RegExp(`body\\[data-shell-look="${look}"\\][^{]*(?:\\.session-row\\.active \\.session-btn(?:::before)?|\\.sidebar-project-rail-item\\.active|\\.sidebar-filter \\.ui-icon-btn\\.active|\\.rail-icon)\\s*\\{`);
    assert.equal(own.test(css), false, `${look} restyles a selection outside the shared tokens`);
  }
  const shared = 'body[data-shell-look]:not([data-shell-look="standard"]):not(#\\#)';
  // The shared block states each one, alone or in a role list (:is(...)).
  const sharedSelectors = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((sel) => sel.startsWith(shared));
  for (const selector of [".session-row.active .session-btn::before", ".workspace-mode-switch button.active", ".composer-card:focus-within"]) {
    assert.ok(sharedSelectors.some((sel) => sel === `${shared} ${selector}` || (sel.startsWith(`${shared} :is(`) && sel.includes(selector))), `no shared rule for ${selector}`);
  }
  // A pinned chat is marked by its section, not by a second glass pill.
  assert.match(css, /\.session-row \.session-btn::before \{\s*background: transparent !important;/);
});

test("the suggested prompt stays a line in every look, in its quiet ink", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  const shared = 'body[data-shell-look]:not([data-shell-look="standard"]):not(#\\#)';
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
  const find = (selector: string, declaration: RegExp) => {
    const found = rules.find((r) => r.sel.startsWith(`${shared} `) && r.sel.includes(selector) && declaration.test(r.body));
    assert.ok(found, `no shared rule for ${selector} with ${declaration}`);
    return found;
  };
  // Neither the suggestion nor a queued prompt is an option chip any more.
  const options = find(".attachment-pill", /background: var\(--look-option\) !important;/);
  assert.doesNotMatch(options.sel, /\.composer-suggestion(?!-)|\.queue-chip/, "the pending stack has no plate in any look");
  // Its text is the look's quiet ink, and its own use target hovers and
  // presses in the look's hover rather than the base overlay.
  assert.match(find(".composer-suggestion-text", /color: var\(--look-ink-dim\) !important;/).body, /--look-ink-dim/);
  assert.match(find(".composer-suggestion-use:hover", /background: var\(--look-hover\) !important;/).body, /--look-hover/);
  assert.match(find(".composer-suggestion-use:is(:active, :focus-visible)", /background: var\(--look-hover\) !important;/).body, /--look-hover/);
});

test("every interface style is offered in Settings with translated copy", async () => {
  const [picker, en, uk] = await Promise.all([
    read("../src/components/settings/ShellLookPicker.tsx"),
    read("../src/i18n/locales/en.ts"),
    read("../src/i18n/locales/uk.ts"),
  ]);
  for (const look of SHELL_LOOKS) assert.match(picker, new RegExp(`^\\s+"?${look}"?: \\["settings\\.pages\\.shellLook`, "m"), look);
  for (const key of [...picker.matchAll(/"(settings\.pages\.shellLook[A-Za-z]*)"/g)].map((match) => match[1]!)) {
    assert.ok(en.includes(`"${key}":`), `en lacks ${key}`);
    assert.ok(uk.includes(`"${key}":`), `uk lacks ${key}`);
  }
});

test("Appearance leads with the look, then color, platform style, the background with its surfaces and the window layout", async () => {
  const [pages, layout] = await Promise.all([
    read("../src/components/settings/pages.tsx"),
    read("../src/components/settings/ShellLayoutSection.tsx"),
  ]);
  const page = pages.slice(pages.indexOf("export function AppearancePage"));
  const order = [
    ...["settings.pages.shellLook", "settings.pages.colorGroup", "settings.pages.themeStyle", "settings.pages.backgroundSurfaces"]
      .map((key) => page.indexOf(`title={tr("${key}")}`)),
    page.indexOf("<ShellLayoutSection />"),
    page.indexOf(`title={tr("settings.pages.textGroup")}`),
  ];
  for (const [index, at] of order.entries()) assert.ok(at > 0, `section ${index} is missing`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "Appearance sections are out of order");
  // Transparency and borders belong to the background they sit over.
  const background = page.slice(order[3], order[4]);
  assert.match(background, /itemId="appearance\.glass"/);
  assert.match(background, /itemId="appearance\.hideBorders"/);
  // The bar's surface and the mirror are part of the window's shape.
  assert.match(layout, /itemId="appearance\.topRailSurface"/);
  assert.match(layout, /itemId="appearance\.mirrorLayout"/);
  assert.equal(page.includes("appearance.topRailSurface") || page.includes("appearance.mirrorLayout"), false);
  // The colour section no longer carries the platform style cards.
  const theme = pages.slice(pages.indexOf("function ThemeSection"), pages.indexOf("function RailSizeRange"));
  assert.equal(theme.includes("theme-style-cards"), false);
});

test("picking a look keeps the background the person chose", async () => {
  const picker = await read("../src/components/settings/ShellLookPicker.tsx");
  const pick = picker.slice(picker.indexOf("export function pickShellLook"), picker.indexOf("\n}\n", picker.indexOf("export function pickShellLook")));
  assert.match(pick, /setUiSettings\(\{ shellLook: look \}\);/);
  // Neither the pick nor the tiles reach for a look's own background.
  assert.equal(/setBackground|LOOK_BACKGROUNDS|backgroundPresetArt/.test(picker), false, "a look still carries a background");
});

test("a docked window takes the rail's idle material and Monolith's sheet gives up the strip lane", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  const dock = String.raw`\.railbar:is\(\[data-rail-motion="open"\], \[data-rail-motion="exiting"\]\):has\(> \.rail:not\(\.rail-dynamic\):not\(\.rail-fullscreen\):not\(\.rail-dock-bottom\):not\(\.rail-pinned-narrow\)\)`;
  // Pane and strip share one material, the look's idle rail (--look-dock*).
  assert.match(css, new RegExp(`${dock} > :is\\(\\.rail, \\.plugin-strip\\) \\{[^}]*background: var\\(--look-dock\\) !important;[^}]*backdrop-filter: var\\(--look-dock-blur\\) !important;`));
  assert.match(css, new RegExp(`${dock} > \\.rail \\{[^}]*border: 0 solid var\\(--look-dock-edge\\) !important;`));
  assert.match(css, new RegExp(`${dock} > \\.plugin-strip \\{[^}]*border-inline-start: 1px solid var\\(--look-rail-seam\\) !important;`));
  // By default the docked window sits on the canvas, as the idle rail does.
  assert.match(css, /:where\(body\[data-shell-look\]:not\(\[data-shell-look="standard"\]\)\) \{[^}]*--look-dock: transparent;[^}]*--look-dock-blur: none;/);
  // Islands keep their island; hairline looks keep the rail's start line.
  for (const look of ["air", "obsidian"]) {
    assert.match(css, new RegExp(`body\\[data-shell-look="${look}"\\]:not\\(#\\\\#\\) \\{[^}]*--look-dock: var\\(`), look);
  }
  for (const look of ["line", "editorial"]) {
    assert.match(css, new RegExp(`body\\[data-shell-look="${look}"\\]:not\\(#\\\\#\\) \\{[^}]*--look-dock-edge: var\\(--look-line\\);`), look);
  }
  for (const look of ["monolith", "monolith-reverse"]) {
    // One :has() (CSS forbids nesting it): the host and its docked pane.
    const docked = String.raw`\.app-shell:has\(> \.railbar:is\(\[data-rail-motion="open"\], \[data-rail-motion="exiting"\]\) > \.rail:not\(\.rail-dynamic\):not\(\.rail-fullscreen\):not\(\.rail-dock-bottom\):not\(\.rail-pinned-narrow\)\) > \.workspace`;
    assert.match(css, new RegExp(`body\\[data-shell-look="${look}"\\]:not\\(#\\\\#\\) ${docked} \\{\\s*margin-inline-end: 0;`), look);
  }
});

test("the phone Settings page paints an opaque material, so the list never reads through its slide", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  // The shared block clears the stages' own fills; on the phone they share one
  // grid cell and are both on screen while a page is pushed or popped.
  assert.match(css, /:where\(\.settings-shell \.settings-pane, \.settings-shell \.settings-pane-head, \.settings-shell \.settings-nav, \.question-actions\) \{\s*background: transparent !important;/);
  assert.match(css, /@media \(max-width: 700px\) \{\s*body\[data-shell-look\]:not\(\[data-shell-look="standard"\]\):not\(#\\#\) \.scrim\.settings-scrim > \.settings-shell > \.settings-pane \{\s*background: linear-gradient\(var\(--look-overlay-solid\), var\(--look-overlay-solid\)\), var\(--bg\) !important;/);
  assert.match(css, /:where\(body\[data-shell-look\]:not\(\[data-shell-look="standard"\]\)\) \{[^}]*--look-overlay-solid: var\(--look-float\);/);
  // Obsidian paints its overlays in the panel glass, not in --look-float.
  assert.match(css, /body\[data-shell-look="obsidian"\]:not\(#\\#\) \{[^}]*--look-overlay-solid: var\(--panel\);/);
});

test("phone Settings is a phone layer in every look: full-screen material, the look's cards, no window chrome", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  const look = 'body\\[data-shell-look\\]:not\\(\\[data-shell-look="standard"\\]\\):not\\(#\\\\#\\)';
  const start = css.search(new RegExp(`@media \\(max-width: 700px\\) \\{\\s*${look} \\.scrim\\.settings-scrim > \\.settings-shell > \\.settings-pane`));
  assert.ok(start >= 0);
  const block = css.slice(start, css.indexOf("\n}\n", start));
  // A floating window's corners, edge and scrim would frame the screen, with
  // the wallpaper showing in the corners.
  assert.match(block, /\.scrim\.settings-scrim > \.settings-shell \{[^}]*border: 0 !important;[^}]*border-radius: 0 !important;[^}]*background: var\(--look-phone-layer\) !important;/);
  assert.match(block, /\.scrim\.settings-scrim \{[^}]*background: transparent !important;/);
  // The two-pane nav column's seam and tint stop at the wide window.
  assert.match(block, /\.settings-shell > \.settings-nav \{[^}]*border: 0 !important;[^}]*background: transparent !important;/);
  // Cards speak the look's panel card, so corners and rules match its field.
  assert.match(block, /:is\(\.settings-nav-group-list, \.settings-results\) \{[^}]*border-radius: var\(--look-widget-radius\) !important;[^}]*background: var\(--look-widget\) !important;/);
  // A current row stays visible where the navigator's plate is the card's own material.
  assert.match(block, /\.settings-nav-group-list > \.settings-nav-item\.active \{[^}]*background: var\(--look-list-select\) !important;/);
  assert.match(css, /body\[data-shell-look="monolith"\]:not\(#\\#\) \{[^}]*--look-list-select: var\(--look-select\);/);
  assert.match(css, /body\[data-shell-look="monolith-reverse"\]:not\(#\\#\) \{[^}]*--look-list-select: var\(--look-plane-solid\);/);
  // 11px mono made iOS zoom the page on focus and read as a data readout.
  assert.doesNotMatch(css, /:is\([^)]*\.settings-nav-search[^)]*\) \{\s*font-family: var\(--mono\)/);
});

test("every look owns the chrome a platform style paints, each piece in its role", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  const shared = 'body[data-shell-look]:not([data-shell-look="standard"]):not(#\\#)';
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
  // The shared rule that carries `declaration` must list every selector.
  const role = (name: string, declaration: RegExp, selectors: string[]) => {
    const rule = rules.find((r) => r.sel.startsWith(shared) && declaration.test(r.body) && selectors.every((s) => r.sel.includes(s)));
    assert.ok(rule, `${name}: no shared rule with ${declaration} lists ${selectors.join(", ")}`);
  };
  role("flatten", /background: transparent !important;\s*backdrop-filter: none !important;/, [".statusbar", '.app > .header:not([data-top-rail-surface="floating"])', ".ui-icon-btn--quiet", ".md-code-block-header", ".ui-dialog-foot"]);
  // The default button is the look's option and a destructive one its wash; in
  // :where() so a look that draws its own button (Line, Editorial) wins.
  role("dividers", /border-block-end-color: var\(--look-rule\) !important/, ['.app > .header:not([data-top-rail-surface="floating"])', ".rail-head", ".md-code-block-header", ".ui-dialog-head"]);
  // Islands and sheets part regions without lines: only the ruled looks draw them.
  for (const look of ["paper", "line", "editorial"]) {
    assert.match(css, new RegExp(`body\\[data-shell-look="${look}"\\]:not\\(#\\\\#\\) \\{[^}]*--look-rule: var\\(--look-line\\)`), `${look} rules its regions`);
  }
  role("status bar rule", /border-block-start: 1px solid var\(--look-rule\) !important/, [".statusbar"]);
  role("option chips", /background: var\(--look-option\) !important;[\s\S]*border: 1px solid var\(--look-option-edge\) !important/, [".starter-chip", ".hero-customize-trigger"]);
  // Every text field and select is the look's field, and focus stays visible.
  role("fields", /background: var\(--look-field\) !important;[\s\S]*border-radius: var\(--look-field-radius\) !important/, [".sidebar-search", ".picker-search", ".ui-field-well", ".ui-input", ".ui-textarea", ".sel select", ".theme-picker-current"]);
  role("field focus", /0 0 0 2px var\(--look-focus-ring\) !important/, [".ui-input:focus", ".sidebar-search:focus-within", ".picker-search:focus-within", ".ui-field-well:focus-within"]);
  // A field well is the field, so the input inside it is never painted again;
  // a field frame (a package composer card) draws its own, so neither is its.
  role("bare input in a well", /background: var\(--look-field\) !important/, [".ui-field-well, .palette-field, .lock-field, .ui-field-frame) *)"]);
  // A pill field corner never rounds a text area into an oval.
  role("text area corner", /border-radius: var\(--look-area-radius\) !important/, ["textarea.ui-textarea", ".ui-field-well:has(.ui-textarea)"]);
  role("control surfaces", /background: var\(--look-control\) !important/, [".workspace-mode-switch", ".ui-tabs:not(:is(.module-view, .rail-body, .panel-sheet) *)", ".seg:not(:is(.module-view, .rail-body, .panel-sheet) *)"]);
  role("chosen segment", /background: var\(--look-segment\) !important/, [".workspace-mode-switch button.active", ".ui-tabs:not(:is(.module-view, .rail-body, .panel-sheet) *) > .ui-tab--selected", ".seg:not(:is(.module-view, .rail-body, .panel-sheet) *) > button:is(.active, .on)", ".rail-tabs .tab.active"]);
  role("selection plate", /background: var\(--look-select\) !important/, [".rail-icon.active", ".ui-menu-item--checked", ".settings-nav-item.active", ".model-picker-row.current"]);
  role("hover", /background: var\(--look-hover\) !important/, [".ui-menu-item", ".ui-tabs:not(:is(.module-view, .rail-body, .panel-sheet) *) > .ui-tab", ".statusbar-cluster", ".ui-btn--quiet", ".starter-chip"]);
  role("select corner", /border-radius: var\(--look-select-radius\) !important/, [".session-btn", ".ui-menu-item", ".settings-nav-item", ".model-picker-row", ".ui-icon-btn", ".rail-icon", ".ui-tabs:not(:is(.module-view, .rail-body, .panel-sheet) *) > .ui-tab"]);
  role("control corner", /border-radius: var\(--look-control-radius\) !important/, [".ui-btn", ".config-chip", ".starter-chip", ".ui-tabs:not(:is(.module-view, .rail-body, .panel-sheet) *)", ".desktop-session-status-trigger"]);
  // One selection mark: Fluent's extra accent pill on the active row goes, and
  // a destructive menu row keeps its red through the look's hover.
  role("no second selection mark", /content: none !important/, [".session-row.active .session-btn::after"]);
  role("no second selection mark", /content: none !important/, [".settings-nav-item.active::before"]);
  // Every look states its field.
  for (const look of SHELL_LOOKS.filter((l) => l !== "standard")) {
    assert.match(css, new RegExp(`body\\[data-shell-look="${look}"\\]:not\\(#\\\\#\\) \\{[^}]*--look-field:`), `${look} sets --look-field`);
  }
  role("destructive row", /color: var\(--red\) !important/, [".ui-menu-item--danger"]);
  // The generic hover would out-weigh a destructive row's red, so it skips it.
  role("generic hover skips destructive rows", /background: var\(--look-hover\) !important;\s*color: var\(--text\) !important/, [".ui-menu-item", ".ui-menu-item--danger):hover"]);
  // Disabled buttons keep the base's single neutral look.
  role("default button", /background: var\(--look-option\) !important/, [":where(.ui-btn--quiet:not(:disabled))"]);
  role("destructive button", /background: var\(--red-wash\) !important/, [":where(.ui-btn--danger:not(:disabled))"]);
  // Keyboard focus stays visible on menu rows and fields; an invalid field stays red.
  role("menu focus ring", /box-shadow: inset 0 0 0 2px var\(--look-focus-ring\) !important/, [".ui-menu-item:focus-visible"]);
  role("invalid field", /var\(--red\) 55%/, [".ui-input--invalid"]);
  // A package's own tabs (inside its window or page) keep the package's grammar.
  role("host segments only", /background: var\(--look-segment\) !important/, [".ui-tabs:not(:is(.module-view, .rail-body, .panel-sheet) *) > .ui-tab--selected"]);
  // Mirrored, the Monoliths' strip lane moves to the workspace's inline start.
  for (const look of ["monolith", "monolith-reverse"]) {
    assert.match(css, new RegExp(`body\\[data-shell-look="${look}"\\]:not\\(#\\\\#\\) \\.app\\[data-shell-mirror="true"\\] \\.app-shell > \\.workspace \\{\\s*margin-inline: calc\\(`), look);
  }
  // Every chrome change lives in a role section; no catch-all block of one-off rules.
  assert.doesNotMatch(css, /\.statusbar \{[^}]*background: transparent/, "the status bar is flattened by the shared list, not a rule of its own");
});

test("every look names its floating column corner and the Monoliths keep the strip's inset", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  // The full-height layouts round a floating column from --look-column-radius;
  // without it these looks fall back to the platform style's radius.
  for (const look of ["paper", "monolith", "monolith-reverse", "editorial"]) {
    assert.match(css, new RegExp(`body\\[data-shell-look="${look}"\\]:not\\(#\\\\#\\) \\{[^}]*--look-column-radius:`), look);
  }
  // With Floating columns the launcher strip moves in by --shell-edge, so the
  // sheet's inline-end margin grows by the same inset.
  for (const look of ["monolith", "monolith-reverse"]) {
    assert.match(css, new RegExp(`body\\[data-shell-look="${look}"\\]:not\\(#\\\\#\\) \\.workspace \\{[^}]*margin-inline: 0 calc\\([^;]*\\+ var\\(--shell-edge, 0px\\)\\);`), look);
    // The launcher column and the window it opens end on the sheet's foot line,
    // the window's free foot corner rounded like the sheet (classic only: the
    // full-height layouts own the column geometry).
    assert.match(css, new RegExp(`body\\[data-shell-look="${look}"\\]:not\\(#\\\\#\\) \\.railbar \\{\\s*margin: 0 0 var\\(--space-2\\) !important;`), look);
    assert.match(css, new RegExp(`body\\[data-shell-look="${look}"\\]:not\\(\\[data-shell-layout="columns"\\]\\):not\\(\\[data-shell-layout="bare"\\]\\):not\\(#\\\\#\\) \\.railbar > \\.rail-dynamic \\{\\s*--package-window-foot: 1;`), look);
  }
});

test("every look radius follows Corner rounding: no literal corner but pills and square", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  const literal: string[] = [];
  for (const m of css.matchAll(/(border(?:-[a-z]+)*-radius|--look-[a-z-]*radius|--look-r)\s*:\s*([^;]+);/g)) {
    const value = m[2]!.replace(/!important/, "");
    // Derived from a look radius token (a concentric inset): it scales with it.
    if (/var\(--look-(?:[a-z-]*radius|r)\)/.test(value)) continue;
    // A length outside calc(… * var(--look-round)) never moves with the slider.
    const bare = value.replace(/calc\([^()]*var\(--look-round\)\)/g, "");
    for (const n of bare.matchAll(/(?<![\w.-])(\d+(?:\.\d+)?)px/g)) {
      const px = Number(n[1]);
      if (px !== 0 && px < 999) literal.push(`${m[1]}: ${m[2]!.trim()}`);
    }
  }
  assert.deepEqual(literal, []);
  // --look-round is the platform styles' divisor, so rounding 9 draws these
  // radii and the last notch reaches 1.5× (scale 2.7), matching the platform
  // styles' growth instead of tripling an already large look radius.
  assert.match(css, /--look-round: calc\(var\(--corner-radius-scale\) \/ 1\.8\);/);
  // A look's pill squares with the setting rather than staying a frozen 999px.
  assert.doesNotMatch(css, /radius:\s*999px/);
});

test("Monolith column corners do not reference the rail radius Floating columns derive from them", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  assert.match(css, /\[data-shell-floating="true"\]:not\(#\\#\) \{[^}]*--look-rail-radius: var\(--look-column-radius/);
  assert.doesNotMatch(css, /--look-column-radius: var\(--look-rail-radius\)/);
});

test("the lines above the composer are text in every look", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  // No look turns the status / edited-files line into a card.
  const cards = css.match(/:where\(\.question-card[^)]*\)/)?.[0] ?? "";
  assert.ok(cards, "in-flow card rule");
  for (const line of [".pending-changes-bar", ".agent-status-dock", ".subagent-island", ".queue-chip", ".composer-suggestion"]) {
    assert.doesNotMatch(cards, new RegExp(line.replace(".", "\\.")), `${line} has no plate in any look`);
  }
  assert.doesNotMatch(css, /body\[data-shell-look="obsidian"\][^{]*\.pending-changes-bar/);
  // The status styles left the looks with their material and rules.
  assert.doesNotMatch(css, /data-composer-status-style|--composer-tray-|--composer-header-rule/);
  // No look re-pads the lines: their mark and time keep the stack's columns.
  assert.doesNotMatch(css, /\.(?:agent-status-dock|subagent-island|pending-changes-bar)[^,{]*\{[^}]*padding-inline/);
});

test("Send and Stop share each look's corner, with no glow or ring", async () => {
  const css = stripComments(await read("../src/shellLooks.css"));
  for (const look of ["paper", "editorial"]) {
    assert.match(css, new RegExp(`body\\[data-shell-look="${look}"\\]:not\\(#\\\\#\\) :is\\(\\.send, \\.stop\\) \\{[^}]*--look-control-radius`), `${look}: one silhouette`);
  }
  assert.match(css, /body\[data-shell-look="line"\]:not\(#\\#\) :is\(\.send, \.stop\) \{[^}]*--look-r/);
  assert.doesNotMatch(css, /\.send:not\(:disabled\) \{[^}]*box-shadow:\s*0 /, "no Send glows");
  assert.doesNotMatch(css, /transform:\s*scale\(0\.82\)/, "Send keeps its size");
});
