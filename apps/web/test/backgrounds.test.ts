import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BACKGROUND_PRESETS,
  DEFAULT_BACKGROUND_ID,
  backgroundCssImage,
  backgroundEdgeColor,
  backgroundPresetArt,
  backgroundSystemBarColor,
  backgroundTone,
  classifyBackgroundTone,
  parseBackgroundState,
  validateBackgroundFile,
} from "../src/backgrounds.ts";

test("background presets are unique and malformed preferences fall back safely", () => {
  assert.ok(BACKGROUND_PRESETS.length >= 5);
  assert.equal(new Set(BACKGROUND_PRESETS.map(({ id }) => id)).size, BACKGROUND_PRESETS.length);
  assert.equal(parseBackgroundState(null).id, DEFAULT_BACKGROUND_ID);
  assert.equal(parseBackgroundState(JSON.stringify({ id: "unknown" })).id, DEFAULT_BACKGROUND_ID);
  assert.equal(parseBackgroundState(JSON.stringify({ id: "none" })).id, "none");
  assert.equal(parseBackgroundState(JSON.stringify({ id: "custom", customImage: "javascript:alert(1)" })).id, DEFAULT_BACKGROUND_ID);
});

test("workspace presets expose light/dark system-bar fallbacks", () => {
  const paper = parseBackgroundState(JSON.stringify({ id: "paper-prism" }));
  assert.equal(backgroundSystemBarColor(paper, "light"), "#e3eef1");
  assert.equal(backgroundSystemBarColor(paper, "dark"), "#43595f");
  assert.equal(backgroundSystemBarColor(parseBackgroundState(JSON.stringify({ id: "none" })), "light"), null);
});

test("every wallpaper preset carries its bottom-edge tone for the keyboard band", () => {
  for (const preset of BACKGROUND_PRESETS) {
    const value = parseBackgroundState(JSON.stringify({ id: preset.id }));
    if (preset.image === "none") assert.equal(backgroundEdgeColor(value), null);
    else assert.match(backgroundEdgeColor(value) ?? "", /^#[0-9a-f]{6}$/, `${preset.id} has an edge tone`);
  }
  // A custom image is sampled at runtime; there is no static tone to publish.
  const custom = parseBackgroundState(JSON.stringify({ id: "custom", customImage: "data:image/png;base64,aGVsbG8=" }));
  assert.equal(backgroundEdgeColor(custom), null);
});

test("interface-style wallpapers ship with fallbacks and a self-contained image", () => {
  const ids = BACKGROUND_PRESETS.map(({ id }) => id);
  for (const id of ["linen-dawn", "drafting-grid", "cloud-drift", "basalt", "aurora", "dusk-ridge"]) {
    assert.ok(ids.includes(id as (typeof ids)[number]), `${id} is offered`);
    const value = parseBackgroundState(JSON.stringify({ id }));
    assert.equal(value.id, id, `${id} survives a reload`);
    assert.match(backgroundSystemBarColor(value, "dark") ?? "", /^#[0-9a-f]{6}$/);
    assert.match(backgroundSystemBarColor(value, "light") ?? "", /^#[0-9a-f]{6}$/);
  }
  // The ridge is inline SVG: CSP allows data: images, and it must not reach
  // out to anything (no external href, no script) — it renders the same offline.
  const ridge = BACKGROUND_PRESETS.find(({ id }) => id === "dusk-ridge")!.image;
  assert.match(ridge, /^url\("data:image\/svg\+xml,/);
  const svg = decodeURIComponent(ridge.slice('url("data:image/svg+xml,'.length, -2));
  assert.doesNotMatch(svg, /<script|href=|url\(http/i);
});

test("interface-style wallpapers follow the theme and stay inside their tone", () => {
  const paired = ["linen-dawn", "drafting-grid", "cloud-drift", "basalt", "aurora", "dusk-ridge"];
  for (const id of paired) {
    const value = parseBackgroundState(JSON.stringify({ id }));
    const dark = backgroundPresetArt(id, "dark")!;
    const light = backgroundPresetArt(id, "light")!;
    assert.notEqual(dark.image, light.image, `${id} paints its own art in each appearance`);
    assert.notEqual(dark.description, light.description, `${id} describes each art`);
    assert.equal(backgroundCssImage(value, "dark"), dark.image);
    assert.equal(backgroundCssImage(value, "light"), light.image);
    // The measured tone is the appearance's own, so a look keeps its thin veil.
    assert.equal(backgroundTone(value, "dark"), "dark", `${id} dark art`);
    assert.equal(backgroundTone(value, "light"), "light", `${id} light art`);
    assert.match(backgroundEdgeColor(value, "dark") ?? "", /^#[0-9a-f]{6}$/);
    assert.match(backgroundEdgeColor(value, "light") ?? "", /^#[0-9a-f]{6}$/);
    assert.notEqual(backgroundEdgeColor(value, "dark"), backgroundEdgeColor(value, "light"), `${id} edge per art`);
  }
  // Every other preset paints one image in both appearances and has a tone.
  for (const preset of BACKGROUND_PRESETS) {
    const value = parseBackgroundState(JSON.stringify({ id: preset.id }));
    if (preset.image === "none") {
      assert.equal(backgroundTone(value, "dark"), null);
      continue;
    }
    assert.ok(backgroundTone(value, "dark") && backgroundTone(value, "light"), `${preset.id} has a measured tone`);
    if (!paired.includes(preset.id)) assert.equal(backgroundCssImage(value, "dark"), backgroundCssImage(value, "light"));
  }
  // A custom image's tone is sampled at runtime; nothing static is published.
  const custom = parseBackgroundState(JSON.stringify({ id: "custom", customImage: "data:image/png;base64,aGVsbG8=" }));
  assert.equal(backgroundTone(custom, "light"), null);
});

test("image tone classification needs the whole image inside one band", () => {
  const spread = (low: number, high: number) => Array.from({ length: 100 }, (_, index) => low + (high - low) * index / 99);
  assert.equal(classifyBackgroundTone(spread(0.45, 0.95)), "light");
  assert.equal(classifyBackgroundTone(spread(0.002, 0.04)), "dark");
  // A dark photo with a bright sky is neither: the readable veils stay on.
  assert.equal(classifyBackgroundTone([...spread(0.005, 0.03), ...spread(0.5, 0.9)]), "mixed");
  // A few specks outside the band do not change the verdict.
  assert.equal(classifyBackgroundTone([...spread(0.5, 0.9), 0.01, 0.02]), "light");
  assert.equal(classifyBackgroundTone([]), null);
});

test("custom backgrounds accept bounded raster data only", () => {
  const image = "data:image/png;base64,aGVsbG8=";
  const parsed = parseBackgroundState(JSON.stringify({ id: "custom", customImage: image }));
  assert.equal(parsed.id, "custom");
  assert.equal(backgroundCssImage(parsed), `url(${JSON.stringify(image)})`);
  assert.equal(validateBackgroundFile({ type: "image/webp", size: 1024 }), null);
  assert.match(validateBackgroundFile({ type: "image/svg+xml", size: 1024 }) ?? "", /PNG/);
  assert.match(validateBackgroundFile({ type: "image/png", size: 3 * 1024 * 1024 }) ?? "", /2 MB/);
});

test("background and glass controls are wired into Appearance and the held-Shift corner", async () => {
  const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
  const [app, pages, picker, styles, mobileViewportStyles, theme, index] = await Promise.all([
    read("../src/App.tsx"),
    read("../src/components/settings/pages.tsx"),
    read("../src/components/BackgroundPicker.tsx"),
    read("../src/styles.css"),
    read("../src/mobileViewport.css"),
    read("../src/theme.ts"),
    read("../src/index.html"),
  ]);
  assert.match(app, /<BackgroundQuickPicker \/>/);
  assert.match(pages, /itemId="appearance\.background"[\s\S]*<BackgroundPicker \/>/);
  assert.match(pages, /itemId="appearance\.glass"[\s\S]*ui\.glassEffect/);
  assert.match(pages, /<Popover[\s\S]*className="theme-picker-pop"/);
  assert.match(pages, /autoFocus=\{!phone\}/);
  assert.doesNotMatch(styles, /theme-picker-pop \{[\s\S]{0,200}inset:\s*auto 8px/);
  assert.match(picker, /useShiftArmed\(\)/);
  assert.match(styles, /\.background-quick-trigger\s*\{[^}]*position:\s*fixed;[^}]*inset-inline-end:/s);
  assert.match(
    styles,
    /@media \(min-width: 961px\) \{\s*\.background-quick-trigger \{\s*inset-inline-end: calc\([\s\S]*?--rail-strip-width-right[\s\S]*?\);\s*\}/s,
    "the wide-shell corner affordance clears the always-on right rail strip",
  );
  assert.doesNotMatch(styles, /\.workspace > \.main\s*\{[^}]*background:/s);
  assert.match(
    styles,
    /html\[data-background\]:not\(\[data-background="none"\]\)\s*\{[^}]*background-image:[\s\S]*?var\(--app-background-image\)/s,
    "the selected background is rooted at the viewport so it can paint behind the phone safe area",
  );
  assert.match(
    styles,
    /html\[data-background\]:not\(\[data-background="none"\]\) body,\s*html\[data-background\]:not\(\[data-background="none"\]\) \.app\s*\{[^}]*background-color:\s*transparent;[^}]*background-image:\s*none;/s,
    "normal web keeps one root-owned workspace background",
  );
  assert.match(
    styles,
    /html, body, #root\s*\{[^}]*min-height:\s*100vh;[^}]*min-height:\s*100dvh;/s,
    "the root chain cannot end above the dynamic viewport",
  );
  assert.doesNotMatch(
    styles,
    /@supports \(-webkit-touch-callout: none\)[\s\S]*?@media \(display-mode: standalone\)[\s\S]*?\.app\s*\{/s,
    "the base stylesheet must not give iOS standalone a second viewport/background owner",
  );
  assert.match(
    mobileViewportStyles,
    /body:not\(\.desktop-app\) #root\s*\{[^}]*height:\s*var\(--layer-frame-bottom,\s*var\(--visual-frame-bottom,\s*100dvh\)\);/s,
    "the final mobile stylesheet sizes the frame from measured viewport geometry",
  );
  for (const sheet of [styles, mobileViewportStyles]) {
    assert.doesNotMatch(
      sheet,
      /::before\s*\{[^}]*var\(--app-background-image\)/s,
      "mobile wallpaper keeps one definition: no pseudo-element re-derives the image",
    );
  }
  const bandLayer = styles.match(
    /html:not\(\[data-desktop-app\]\)\[data-background\]:not\(\[data-background="none"\]\)::before\s*\{([^}]*)\}/,
  )?.[1] ?? "";
  assert.match(bandLayer, /position:\s*fixed;/, "the keyboard-band wallpaper layer is viewport-fixed");
  assert.match(bandLayer, /height:\s*100lvh;/, "the layer covers the large viewport the keyboard never resizes");
  assert.match(bandLayer, /pointer-events:\s*none;/);
  assert.match(bandLayer, /background:\s*inherit;/, "the layer repaints the HTML root's own wallpaper");
  assert.doesNotMatch(
    mobileViewportStyles,
    /html\[data-background\][\s\S]*background-color:\s*transparent/,
    "mobile does not make the canonical HTML wallpaper canvas transparent",
  );
  assert.doesNotMatch(
    mobileViewportStyles,
    /height:\s*calc\([^;]*--keyboard-inset/,
    "an already-measured visible viewport is never reduced by the keyboard twice",
  );
  assert.match(
    styles,
    /\.stage-new\s*\{[^}]*background:\s*transparent;/s,
    "New Chat must not cover the selected workspace background with an opaque stage",
  );
  assert.match(index, /apple-mobile-web-app-status-bar-style" content="black-translucent"/,
    "the initial standalone iOS shell is edge-to-edge");
  assert.match(index, /polyth\.background\.v1/,
    "the installed web app seeds its system-owned status strip from the saved workspace background before first paint");
  assert.match(index, /--app-system-bar-color/,
    "the initial PWA paint publishes the workspace tint to the document canvas");
  for (const preset of BACKGROUND_PRESETS) {
    if (!preset.systemBar) continue;
    assert.match(index, new RegExp(preset.systemBar.dark.replace("#", "#")));
    assert.match(index, new RegExp(preset.systemBar.light.replace("#", "#")));
  }
  assert.match(theme, /apple-mobile-web-app-status-bar-style[^;]+[\s\S]*?setAttribute\("content", "black-translucent"\)/,
    "light-theme changes must not restore an opaque iOS status-bar band");
  assert.doesNotMatch(theme, /apple-mobile-web-app-status-bar-style[^;]+[\s\S]*?\?\s*"black-translucent"\s*:\s*"default"/,
    "status-bar translucency must not depend on dark appearance");
  assert.match(styles, /backdrop-filter:\s*blur\(var\(--material-glass-blur\)\)\s*saturate\(var\(--material-glass-saturation\)\)/);
  assert.match(await read("../src/backgrounds.ts"), /--app-system-bar-color[\s\S]*?meta\[name="theme-color"\]/,
    "runtime background changes keep both document-canvas tint and browser-owned chrome in sync");
  assert.doesNotMatch(styles, /prefers-reduced-motion:\s*no-preference[\s\S]{0,1200}data-glass/);
});

test("the project rail is a transparent cutout of sidebar glass, not a second pane", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(
    styles,
    /\.sidebar-project-rail\s*\{[^}]*background:\s*transparent;[^}]*-webkit-backdrop-filter:\s*none;[^}]*backdrop-filter:\s*none;/s,
    "the nested project rail never paints or filters a second glass layer",
  );
  assert.match(
    styles,
    /\.sidebar--compact-rail\s*\{[^}]*overflow:\s*hidden;[^}]*border-radius:\s*var\(--radius-surface\);/s,
    "the compact rail drawer follows the selected rounding as one clipped surface",
  );
  assert.doesNotMatch(
    styles,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\)\s*:is\([^)]*\.sidebar-project-rail/s,
    "the shared chrome glass cascade must not include the nested project rail",
  );
  assert.doesNotMatch(
    styles,
    /body\[data-glass="off"\]\s*:is\([^)]*\.sidebar-project-rail/s,
    "glass-off keeps the project rail transparent inside the opaque sidebar",
  );
});

test("the collapsed project-session peek opens as its own panel in the selected material", async () => {
  const [styles, liquidGlass, macos, fluent] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/liquidGlassTheme.css", import.meta.url), "utf8"),
    readFile(new URL("../src/macosTheme.css", import.meta.url), "utf8"),
    readFile(new URL("../src/fluentTheme.css", import.meta.url), "utf8"),
  ]);
  const peek = styles.match(/\.sidebar-sessions-peek\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(
    peek,
    /inset-block:\s*-1px;[^]*inset-inline-start:\s*calc\(100% \+ var\(--space-1\)\);[^]*border:\s*1px solid var\(--material-glass-border\);[^]*border-radius:\s*0;[^]*border-start-start-radius:\s*var\(--radius-surface\);[^]*border-start-end-radius:\s*var\(--radius-surface\);[^]*background:\s*var\(--material-glass\);/,
    "the peek opens clear of the rail on the theme's contour and runs along the rail's block edges",
  );
  assert.doesNotMatch(peek, /border-end-(?:start|end)-radius/, "it runs into the window's bottom edge, square");
  assert.doesNotMatch(
    styles,
    /\.sidebar:has\(\.sidebar-sessions-peek\.open\)/,
    "a separate peek leaves the rail's own corners alone",
  );
  // A backdrop filter on the sidebar would bound the peek's own blur to the
  // rail's box, so the workspace behind the peek would show through sharp.
  assert.match(
    styles,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\)\s*:is\(\s*[^{]*\.sidebar:not\(\.sidebar--rail-collapsed\),/s,
    "the shared chrome glass skips the sidebar while it hosts the peek",
  );
  assert.match(
    styles,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) \.sidebar--rail-collapsed \{[^}]*background:\s*none;[^}]*backdrop-filter:\s*none;/s,
    "the rail-collapsed sidebar is not a backdrop root",
  );
  assert.match(
    styles,
    /\.sidebar--rail-collapsed::before \{[^}]*z-index:\s*-1;[^}]*var\(--material-glass-readable-fill\)[^}]*backdrop-filter:\s*blur\(var\(--material-glass-blur\)\)/s,
    "the rail keeps the same glass on a layer under its content",
  );
  // The recipes' overlay rules round every corner; the peek takes the contour
  // from the shared rules instead, so its bottom stays square in every style.
  for (const [name, recipe] of [["liquid-glass", liquidGlass], ["macos", macos], ["fluent", fluent]] as const) {
    assert.doesNotMatch(recipe, /\.sidebar-sessions-peek/, `${name} leaves the peek to the shared contour rules`);
  }
  assert.match(
    styles,
    /body\[data-hide-borders="true"\] :is\([^{]*\.sidebar-sessions-peek[^{]*\):not\(:focus-visible\) \{\s*border-color: var\(--contour\) !important;/s,
    "the peek keeps its contour under Hide interface borders",
  );
  assert.match(
    styles,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\)\s*:is\([\s\S]*?\.sidebar-sessions-peek[\s\S]*?\)\s*\{[^}]*--material-glass-readable-fill/s,
    "the collapsed peek uses a readable, mode-aware glass fill",
  );
  assert.match(
    styles,
    /body\[data-glass="off"\][^{]*:is\([\s\S]*?\.sidebar-sessions-peek[\s\S]*?\)\s*\{[^}]*backdrop-filter:\s*none !important;/s,
    "glass-off keeps the peek opaque and unfiltered",
  );
});

test("text-bearing glass surfaces keep a readable mode-aware floor", async () => {
  const [styles, tokens, mobile, module] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/tokens.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/mobile/MobileNavigator.css", import.meta.url), "utf8"),
    readFile(new URL("../src/moduleContent.css", import.meta.url), "utf8"),
  ]);

  for (const token of [
    "--material-glass-readable-fill",
    "--material-glass-readable-edge",
    "--material-glass-readable-control-fill",
    "--material-glass-readable-control-edge",
  ]) {
    assert.match(tokens, new RegExp(`${token}: calc\\(`), `${token} is a shared readable floor`);
  }
  assert.match(styles, /\.sidebar-sessions-peek[\s\S]*?var\(--material-glass-readable-fill\)/s);
  assert.match(styles, /\.session-row\.active \.session-btn::before\s*\{[^}]*var\(--material-glass\)/s);
  assert.match(styles, /\.session-row\.pinned:not\(.active\) \.session-btn::before\s*\{[^}]*var\(--material-glass-medium\)/s);
  assert.ok(styles.includes("background: color-mix(in srgb, var(--material-glass-medium) var(--material-glass-readable-fill), transparent);"));
  assert.match(mobile, /\.mobile-nav-search\s*\{[^}]*var\(--material-glass-readable-control-fill\)/s);
  assert.match(module, /\.module-view--phone \.module-view-head[\s\S]*?var\(--material-glass-readable-fill\)/s);
});

test("Matte and Clear glass have visibly different tint, including on light themes", async () => {
  const [styles, tokens, module] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/tokens.css", import.meta.url), "utf8"),
    readFile(new URL("../src/moduleContent.css", import.meta.url), "utf8"),
  ]);
  const block = (source: string, selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `missing ${selector}`);
    return match[1]!;
  };
  const prop = (source: string, name: string): string => {
    const match = source.match(new RegExp(`${name}:\\s*([^;]+);`));
    assert.ok(match, `missing ${name}`);
    return match[1]!;
  };
  const percentage = (source: string, name: string): number => Number(prop(source, name).replace("%", ""));
  const tint = (formula: string, mode: string): number => {
    const match = formula.match(/^calc\((\d+)% \+ var\((--[\w-]+)\) \* ([\d.]+)\)$/);
    assert.ok(match, `unrecognized glass tint: ${formula}`);
    return Number(match[1]) + percentage(mode, match[2]!) * Number(match[3]);
  };
  const matte = block(tokens, ":root");
  const clear = block(styles, 'body[data-glass="clear"]');
  const light = block(styles, 'html[data-appearance="light"] body');
  for (const name of ["--material-glass-readable-fill", "--material-glass-readable-edge"]) {
    const darkMatte = tint(prop(matte, name), matte);
    const darkClear = tint(prop(clear, name), clear);
    const lightMatte = tint(prop(light, name), matte);
    const lightClear = tint(prop(light, name), clear);
    assert.ok(darkMatte - darkClear >= 10, `${name}: dark modes are too similar`);
    assert.ok(lightMatte - lightClear >= 10, `${name}: light modes are too similar`);
    assert.ok(lightMatte < darkMatte && lightClear < darkClear, `${name}: white glass needs a lighter tint`);
  }
  assert.ok(tint(prop(light, "--material-glass-readable-fill"), clear) <= 60);

  const motion = styles.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{([^}]*)\}/)?.[1];
  const desktopMotion = styles.match(/:is\(html\[data-reduce-animations="true"\], body\[data-desktop-low-resource="true"\]\) \*[^{}]*\{([^}]*)\}/)?.[1];
  assert.ok(motion && desktopMotion);
  assert.doesNotMatch(motion, /backdrop-filter/);
  assert.doesNotMatch(desktopMotion, /backdrop-filter/);
  assert.doesNotMatch(styles, /html\[data-reduce-animations="true"\] :is\(\.ui-popover/);
  assert.doesNotMatch(module, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.module-view--phone \.module-view-head/);
  assert.match(styles, /body\[data-desktop-low-resource="true"\] :is\(\.ui-popover[^{}]*\{[^}]*backdrop-filter: none/);
});

test("phone navigation glass keeps a visible conversation silhouette", async () => {
  const [styles, tokens] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/tokens.css", import.meta.url), "utf8"),
  ]);

  const readableFill = tokens.match(/--material-glass-readable-fill:\s*calc\((\d+)%/)?.[1];
  const mobileFill = tokens.match(/--material-glass-mobile-chrome-fill:\s*calc\((\d+)%/)?.[1];
  const readableEdge = tokens.match(/--material-glass-readable-edge:\s*calc\((\d+)%/)?.[1];
  const mobileEdge = tokens.match(/--material-glass-mobile-chrome-edge:\s*calc\((\d+)%/)?.[1];
  assert.ok(readableFill && mobileFill && readableEdge && mobileEdge);
  assert.ok(Number(mobileFill) < Number(readableFill));
  assert.ok(Number(mobileEdge) < Number(readableEdge));

  const clearMode = styles.match(/body\[data-glass="clear"\]\s*\{(?<body>[^}]*)\}/s)?.groups?.body;
  assert.ok(clearMode);
  assert.match(clearMode, /--material-glass-mobile-chrome-fill:\s*calc\(/);
  assert.match(clearMode, /--material-glass-mobile-chrome-edge:\s*calc\(/);

  // The top navigation/action islands are floating controls, not a
  // destination: they share the phone composer's fill and keep their contour.
  // hostGlassAppearance.test.ts compares the rendered materials.
  const floatingChrome = styles.match(/body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) :is\(\s*\.composer\.composer-simple\.composer-mobile \.ui-glass-dock\.composer-card,\s*\.mobile-session-floats \.ui-glass-island:not\(\[data-attention\]\)\s*\)\s*\{(?<body>[^}]*)\}/s)?.groups?.body;
  assert.ok(floatingChrome, "the composer and the top islands share one floating-chrome rule");
  assert.doesNotMatch(floatingChrome, /--material-glass-mobile-chrome/);
  assert.match(floatingChrome, /background-clip: padding-box !important/);
  assert.doesNotMatch(styles, /\.mobile-session-floats \.ui-glass-island[^{}]*\{[^}]*border-color:\s*transparent/);

  const destinations = styles.match(/body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\)\s*:is\(\s*\.mobile-navigator,\s*\.workspace-panel-sheet\.sheet,\s*\.widget-choice-menu\.catalog-picker-menu,\s*\.widget-menu-single\.catalog-picker,\s*\.ui-menu-sheet-custom:has\(\.catalog-picker\)\s*\)\s*\{(?<body>[^}]*)\}/s)?.groups?.body;
  assert.ok(destinations);
  assert.match(destinations, /var\(--material-glass-mobile-chrome-fill\)/);
  assert.match(destinations, /var\(--material-glass-mobile-chrome-edge\)/);
  assert.match(destinations, /backdrop-filter:\s*blur\(var\(--material-glass-blur\)\)/);
  assert.doesNotMatch(destinations, /--material-glass-readable/);
});

test("the widget canvas is a workspace surface, so the selected background reaches it", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  // The canvas used to paint its own tinted fill over the whole workspace,
  // which hid every wallpaper behind it.
  assert.match(
    styles,
    /html\[data-background\]:not\(\[data-background="none"\]\) \.widget-workspace\s*\{[^}]*background:\s*transparent;/s,
    "a selected background is not covered by the canvas fill",
  );
  assert.match(
    styles,
    /html\[data-background\]:not\(\[data-background="none"\]\) \.widget-workspace:not\(\.editing\) \.widget-canvas-grid\s*\{[^}]*background-image:\s*none;/s,
    "the alignment dot grid stays an editing aid instead of a texture over the image",
  );
  // Cards keep an opaque surface: content stays readable over any image.
  assert.match(styles, /\.widget-card\s*\{[^}]*background:\s*var\(--elevated\)/s);
});
