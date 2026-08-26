import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readWebStyles } from "./webStyles.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("document viewport exposes safe areas with a fixed chat scale", async () => {
  const html = await read("../src/index.html");
  const viewport = html.match(/<meta name="viewport" content="([^"]+)" \/>/)?.[1] ?? "";

  for (const directive of [
    "width=device-width",
    "initial-scale=1",
    "viewport-fit=cover",
    "interactive-widget=resizes-content",
  ]) {
    assert.ok(viewport.includes(directive), `viewport includes ${directive}`);
  }
  assert.ok(viewport.includes("maximum-scale=1"), "pinch zoom is capped");
  assert.ok(viewport.includes("user-scalable=no"), "user zoom is disabled");
  assert.match(
    html,
    /<meta name="mobile-web-app-capable" content="yes" \/>/,
    "the standards-based installed-app capability tag is present",
  );
});

test("global CSS provides mobile-first sizing, touch, overflow, and focus contracts", async () => {
  const css = await readWebStyles();
  const foundation = css.slice(0, css.indexOf("/* Electron desktop chrome."));

  assert.match(foundation, /\*,\s*\n\*::before,\s*\n\*::after\s*\{\s*box-sizing:\s*border-box/);
  assert.match(foundation, /html\s*\{[^}]*overflow-x:\s*hidden[^}]*overscroll-behavior:\s*none[^}]*scroll-behavior:\s*smooth/s);
  assert.match(foundation, /body\s*\{[^}]*overflow-x:\s*hidden[^}]*overscroll-behavior:\s*none/s);
  assert.match(
    foundation,
    /-webkit-tap-highlight-color:\s*rgba\(var\(--accent-rgb\),\s*\.18\)/,
    "touch feedback uses the shared accent wash instead of the browser flash",
  );
  assert.match(foundation, /touch-action:\s*manipulation/);
  assert.match(css, /font-size:\s*max\(var\(--font-input\), 1em\)/);
  assert.match(foundation, /--font-title:\s*clamp\(/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)[^}]*box-shadow:/s);
  assert.match(css, /\.app\s*\{[^}]*height:\s*100dvh/s);
});

test("specific phone and coarse-pointer fields retain the 16px iOS input guard", async () => {
  const css = await readWebStyles();
  const guard = css;

  assert.match(guard, /@media \(max-width: 480px\), \(pointer: coarse\)/);
  for (const selector of [
    ".composer-card textarea",
    ".sidebar-search input",
    ".editor-ta",
    ".browser-address input",
    ".term-search input",
    ".lock-input",
  ]) {
    assert.ok(guard.includes(selector), `${selector} keeps the iOS input guard`);
  }
  assert.match(guard, /font-size:\s*16px/);
});

test("safe-area utilities cover every viewport edge", async () => {
  const css = await readWebStyles();

  for (const [token, inset] of [
    ["--safe-top", "top"],
    ["--safe-right", "right"],
    ["--safe-bottom", "bottom"],
    ["--safe-left", "left"],
  ] as const) {
    assert.match(css, new RegExp(`${token}: env\\(safe-area-inset-${inset}, 0px\\)`));
  }
  assert.match(css, /\.safe-area-inset\s*\{[^}]*padding-top:\s*var\(--safe-top\)[^}]*padding-right:\s*var\(--safe-right\)[^}]*padding-bottom:\s*var\(--safe-bottom\)[^}]*padding-left:\s*var\(--safe-left\)/s);
  assert.match(css, /\.safe-area-inset-x\s*\{[^}]*var\(--safe-right\)[^}]*var\(--safe-left\)/s);
  assert.match(
    css,
    /@media \(max-width: 480px\)[\s\S]*?\.header\s*\{[^}]*height:\s*calc\(56px \+ var\(--safe-top\)\)[^}]*padding:\s*var\(--safe-top\)/,
    "the generic phone header clears the top safe area",
  );
});

test("latest-message control remains a full coarse-pointer target", async () => {
  const css = await readWebStyles();
  assert.match(
    css,
    /@media \(pointer: coarse\), \(max-width: 480px\)\s*\{[\s\S]*?\.jump-latest\s*\{\s*min-width:\s*44px;\s*min-height:\s*44px;/,
  );
  const anchor = css.slice(css.indexOf(".timeline-latest-reveal-anchor {"));
  assert.doesNotMatch(
    anchor,
    /\.timeline-latest-reveal-anchor \.jump-latest\s*\{[^}]*27px/,
    "the late anchor rule must not shrink the touch target",
  );
});

test("compact shell keeps drawer and bottom navigation reachable", async () => {
  const [header, sidebar, bottomNav, css] = await Promise.all([
    read("../src/components/Header.tsx"),
    read("../src/components/Sidebar.tsx"),
    read("../src/components/workspace/WorkspaceBottomNav.tsx"),
    readWebStyles(),
  ]);

  assert.match(header, /aria-controls="polyth-session-drawer"/);
  assert.match(sidebar, /className=\{`sidebar \$\{drawerOpen \? "open" : ""\}/);
  assert.match(sidebar, /useModalSurface\(\{/);
  assert.match(bottomNav, /className="workspace-bottom-nav/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.workspace-bottom-nav\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.sidebar\.open\s*\{\s*transform:\s*none;\s*visibility:\s*visible/);
});

test("375px chat keeps a safe-area-aware bottom navigator and docked composer", async () => {
  const css = await readWebStyles();
  const contract = css;

  assert.match(
    contract,
    /@media \(max-width: 480px\), \(max-height: 480px\) and \(pointer: coarse\)[\s\S]*?\.app\.mode-chat\.view-session > \.session-bottom-nav\s*\{\s*display:\s*flex/,
  );
  assert.match(
    contract,
    /\.app\.mode-chat\.view-session \.workspace\s*\{[^}]*padding-bottom:\s*calc\(68px \+ var\(--safe-bottom\)\)/s,
  );
  assert.match(
    contract,
    /\.app\.mode-chat\.view-session \.composer-chat\.composer-mobile\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0/s,
  );
  assert.match(
    contract,
    /body\[data-keyboard="open"\] \.app\.mode-chat\.view-session > \.session-bottom-nav\s*\{[^}]*display:\s*none/s,
    "the keyboard yields the navigation row's space to the composer",
  );
});

test("phone and coarse-pointer standalone controls share the 44px hit-box floor", async () => {
  const css = await readWebStyles();
  const contract = css;

  assert.match(contract, /@media \(max-width: 480px\), \(pointer: coarse\)/);
  assert.match(contract, /button:not\(\.file-ref\),[\s\S]*?\[role="switch"\][\s\S]*?min-height:\s*var\(--tap\)\s*!important/);
  assert.match(contract, /button:not\(\.file-ref\),[\s\S]*?summary,[\s\S]*?\[role="switch"\][\s\S]*?min-width:\s*var\(--tap\)\s*!important/);
});

test("phone touch targets and bottom sheets retain audit geometry", async () => {
  const css = await readWebStyles();
  const auditPhoneStart = css.search(
    /@media \(max-width: 480px\), \(max-height: 480px\) and \(pointer: coarse\)\s*\{\s*\.question-copy-btn,/,
  );
  assert.ok(auditPhoneStart >= 0, "the phone audit rules exist");
  const finalPhoneRules = css.slice(auditPhoneStart);

  assert.match(css, /\.question-tabs\s*\{[^}]*overflow-x:\s*auto[^}]*touch-action:\s*pan-x/s);
  assert.match(finalPhoneRules, /\.question-copy-btn,[\s\S]*?\.question-actions button\s*\{[^}]*min-height:\s*var\(--tap\)/);
  assert.match(finalPhoneRules, /\.question-option\s*\{\s*min-height:\s*var\(--tap\)/);
  assert.match(finalPhoneRules, /\.attachment-pill \.att-remove\s*\{[^}]*min-width:\s*var\(--tap\)[^}]*min-height:\s*var\(--tap\)/s);
  assert.match(finalPhoneRules, /\.queue-chip button\s*\{[^}]*min-width:\s*var\(--tap\)[^}]*min-height:\s*var\(--tap\)/s);
  assert.match(finalPhoneRules, /\.msg\.assistant \.msg-action-btn,[\s\S]*?\.msg\.assistant \.msg-actions-entry\s*\{[^}]*min-height:\s*var\(--tap\)/);
  assert.match(css, /\.sheet-search-clear\s*\{[^}]*width:\s*var\(--tap\)[^}]*height:\s*var\(--tap\)/s);
  assert.match(css, /@media \(pointer: coarse\)\s*\{[\s\S]*?\.thinking-slider input\s*\{[^}]*min-height:\s*var\(--tap\)/);
  assert.match(css, /\.panel-sheet \.rail-body\s*\{[^}]*padding-bottom:\s*calc\(10px \+ env\(safe-area-inset-bottom, 0px\)\)/s);
  assert.match(css, /\.package-tour-skips\s*\{[^}]*padding:[^;]*env\(safe-area-inset-bottom, 0px\)/s);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*?\.pane-tab-close\s*\{[^}]*min-width:\s*var\(--tap\)[^}]*min-height:\s*var\(--tap\)/s);
});
