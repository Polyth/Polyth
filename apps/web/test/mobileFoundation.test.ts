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
  assert.ok(viewport.includes("minimum-scale=1"), "zooming out is capped");
  assert.ok(viewport.includes("maximum-scale=1"), "pinch zoom is capped");
  assert.ok(viewport.includes("user-scalable=no"), "user zoom is disabled");
  assert.match(
    html,
    /<meta name="mobile-web-app-capable" content="yes" \/>/,
    "the standards-based installed-app capability tag is present",
  );
});

test("touch zoom is restricted at the document for pages and portaled modals without blocking pans", async () => {
  const css = await read("../src/mobileViewport.css");
  assert.match(css, /@media \(any-pointer: coarse\)\s*\{\s*html\s*\{\s*touch-action: pan-x pan-y;/);
  const main = await read("../src/main.tsx");
  assert.ok(main.indexOf('import "./mobileViewport.css"') < main.indexOf("await prepareMobileLaunch()"),
    "the policy loads before the connection screen or app branch");
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
  assert.match(foundation, /--header-font-size:\s*24px/);
  assert.match(foundation, /--font-title:\s*24px/);
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
    ".editor-code",
    ".cm-textfield",
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
    assert.match(
      css,
      new RegExp(`${token}: var\\(--safe-area-inset-${inset}, env\\(safe-area-inset-${inset}, 0px\\)\\)`),
    );
  }
  assert.match(css, /\.safe-area-inset\s*\{[^}]*padding-top:\s*var\(--safe-top\)[^}]*padding-right:\s*var\(--safe-right\)[^}]*padding-bottom:\s*var\(--safe-bottom\)[^}]*padding-left:\s*var\(--safe-left\)/s);
  assert.match(css, /\.safe-area-inset-x\s*\{[^}]*var\(--safe-right\)[^}]*var\(--safe-left\)/s);
  assert.match(
    css,
    /@media \(max-width: 480px\)[\s\S]*?\.header\s*\{[^}]*height:\s*calc\(56px \+ var\(--safe-top\)\)[^}]*padding:\s*var\(--safe-top\)/,
    "the generic phone header clears the top safe area",
  );
});

test("package mobile chrome consumes canonical safe-area variables", async () => {
  const [chat, browser, terminal] = await Promise.all([
    read("../../../packages/chat-workspace/widgets/styles.css"),
    read("../../../packages/browser/widgets/styles.css"),
    read("../../../packages/terminal/widgets/styles.css"),
  ]);

  for (const css of [chat, browser, terminal]) {
    assert.doesNotMatch(css, /env\(safe-area-inset-/);
  }
  assert.match(chat, /\.chat-workspace\s*\{[^}]*padding-bottom:\s*var\(--safe-bottom\)/s);
  assert.match(browser, /padding-left:\s*max\(var\(--space-2\), var\(--safe-left\)\)/);
  assert.match(browser, /padding-right:\s*max\(var\(--space-2\), var\(--safe-right\)\)/);
  assert.match(terminal, /max\(var\(--space-1\), var\(--safe-bottom\)\)/);
});

test("chat workspace narrow dropdown beats its default hidden state", async () => {
  const css = await read("../../../packages/chat-workspace/widgets/styles.css");
  const defaultRule = css.indexOf(".chat-workspace-tab-active-dropdown {\n  display: none;");
  const narrowRule = css.indexOf("@container (max-width: 420px)");
  const visibleRule = css.indexOf(".chat-workspace-tab-active-dropdown {\n    display: inline-flex;", narrowRule);

  assert.ok(defaultRule >= 0 && narrowRule > defaultRule && visibleRule > narrowRule);
});

test("haptics are local feedback, not a reduced-motion side effect", async () => {
  const haptics = await read("../src/haptics.ts");

  assert.match(haptics, /typeof navigator\.vibrate !== "function"/);
  assert.doesNotMatch(haptics, /reduceAnimations|prefers-reduced-motion|desktopLowResource/);
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

test("compact shell keeps drawer navigation while every phone view owns floating controls", async () => {
  const [header, mobileHeader, sidebar, css] = await Promise.all([
    read("../src/components/Header.tsx"),
    read("../src/components/mobile/MobileSessionHeader.tsx"),
    read("../src/components/Sidebar.tsx"),
    readWebStyles(),
  ]);

  assert.match(header, /aria-controls="polyth-session-drawer"/);
  assert.match(header, /<MobileSessionHeader \/>/);
  assert.doesNotMatch(header, /WorkspaceBottomNav/);
  assert.match(sidebar, /className=\{`sidebar \$\{drawerOpen \? "open" : ""\}/);
  assert.match(sidebar, /useModalSurface\(\{/);
  assert.match(mobileHeader, /className="mobile-session-floats"/);
  assert.match(css, /\.mobile-session-floats\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.sidebar\.open\s*\{\s*transform:\s*none;\s*visibility:\s*visible/);
});

test("375px chat keeps a safe-area-aware floating shell and docked composer", async () => {
  const css = await readWebStyles();
  const contract = css;

  // Three independent islands float below the safe area; the wrapper itself
  // stays transparent and non-interactive.
  assert.match(
    contract,
    /\.mobile-session-floats\s*\{[^}]*inset-block-start:\s*calc\(var\(--safe-top\) \+ var\(--conversation-chrome-inset\)\)[^}]*pointer-events:\s*none/s,
  );
  assert.match(contract, /\.ui-glass-island\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(
    contract,
    /\.app\.mode-chat\.view-session \.workspace\s*\{[^}]*padding-bottom:\s*0/s,
  );
  assert.match(
    contract,
    /\.app\.mode-chat\.view-session \.composer-chat\.composer-mobile\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0/s,
  );
  assert.doesNotMatch(contract, /session-bottom-nav/, "the obsolete bottom navigation is removed");
});

test("only active chat composition obscures competing mobile surfaces", async () => {
  const css = await readWebStyles();
  const state = ":has(.composer-mobile.composer-input-active)";

  assert.ok(css.includes(state), "focused chat composition owns the competing-surface visibility state");
  assert.match(
    css,
    /:is\(\.sidebar\.open, \.rail-fullscreen, \.panel-sheet, \.settings-scrim\)\s*\{[\s\S]*?transition:[\s\S]*?opacity var\(--motion-fast\)[\s\S]*?transform var\(--motion-fast\)/,
    "project and settings surfaces return with the shared motion tokens",
  );
  assert.match(
    css,
    /body:has\(\.composer-mobile\.composer-input-active\)\s*:is\(\.sidebar\.open, \.rail-fullscreen, \.panel-sheet, \.settings-scrim\),[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none;[\s\S]*?opacity:\s*0;/,
    "competing panels become immediately invisible and inert while composing",
  );
  const ownership = css.slice(css.indexOf("/* Mobile COMPOSER focus owns the chat band."));
  assert.doesNotMatch(
    ownership.slice(0, ownership.indexOf("/* Agent execution language")),
    /\[data-keyboard="open"\]/,
    "a keyboard inside Settings or an editor never hides its owning surface",
  );
});

test("shared mobile sheets consume the visible viewport exactly once", async () => {
  const css = await readWebStyles();
  assert.match(css, /\.sheet-backdrop\s*\{[^}]*top:\s*var\(--visual-offset, 0px\)[^}]*height:\s*var\(--visual-vh, 100dvh\)/s,
    "the sheet backdrop follows the visual viewport instead of the covered layout viewport");
  const start = css.indexOf(".sheet {");
  const sheet = css.slice(start, css.indexOf("@keyframes sheet-rise", start));

  assert.match(sheet, /max-height:\s*calc\(var\(--visual-vh, 100dvh\)/);
  assert.doesNotMatch(sheet, /(?:height|margin-bottom):[^;]*--keyboard-inset/,
    "native resize and visualViewport already removed the covered keyboard band");
});

test("late dictation finals remain owned by their originating composer", async () => {
  const voice = await read("../../../packages/dictation/widgets/voice.tsx");
  const stop = voice.slice(voice.indexOf("const stop = () =>"), voice.indexOf("const startBrowser ="));

  assert.match(stop, /const generation = startGeneration\.current/);
  assert.match(stop, /const originScope = originScopeRef\.current/);
  assert.match(stop, /composerScopeKey\(\) !== originScope/);
  assert.ok(stop.indexOf("streamRef.current = null") > stop.indexOf(".then((text)"),
    "the provider stream remains cancellable until finalization settles");
  assert.ok(stop.indexOf("requestComposerInsert") > stop.indexOf("composerScopeKey() !== originScope"),
    "insertion follows the generation and project/session scope checks");
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
    /@media \(max-width: 480px\), \(max-height: 480px\) and \(pointer: coarse\)\s*\{\s*\.attachment-pill/,
  );
  assert.ok(auditPhoneStart >= 0, "the phone audit rules exist");
  const finalPhoneRules = css.slice(auditPhoneStart);

  assert.match(css, /\.question-tabs\s*\{[^}]*overflow-x:\s*auto[^}]*touch-action:\s*pan-x/s);
  assert.match(css, /\.question-tab\s*\{[^}]*min-width:\s*max\(var\(--control-h-sm\), var\(--hit-min\)\)[^}]*height:\s*max\(var\(--control-h-sm\), var\(--hit-min\)\)/s);
  assert.match(css, /\.question-option\s*\{[^}]*min-height:\s*max\(var\(--control-h-sm\), var\(--hit-min\)\)/s);
  assert.match(css, /\.ui-btn\s*\{[^}]*min-height:\s*max\(var\(--control-h-sm\), var\(--hit-min\)\)/s);
  assert.match(css, /\.ui-icon-btn::after\s*\{[^}]*width:\s*max\(100%, var\(--hit-min\)\)[^}]*height:\s*max\(100%, var\(--hit-min\)\)/s);
  assert.match(finalPhoneRules, /\.attachment-pill \.att-remove\s*\{[^}]*min-width:\s*var\(--tap\)[^}]*min-height:\s*var\(--tap\)/s);
  assert.match(finalPhoneRules, /\.queue-chip button\s*\{[^}]*min-width:\s*var\(--tap\)[^}]*min-height:\s*var\(--tap\)/s);
  assert.match(finalPhoneRules, /\.msg\.assistant \.msg-action-btn,[\s\S]*?\.msg\.assistant \.msg-actions-entry\s*\{[^}]*min-height:\s*var\(--tap\)/);
  assert.match(css, /\.sheet-search-clear\s*\{[^}]*width:\s*var\(--tap\)[^}]*height:\s*var\(--tap\)/s);
  // P2-W3A: config chips (model/agent/effort) share one phone touch box.
  assert.match(css, /\.composer-mobile \.composer-config \.config-chip,[\s\S]*?\.composer-mobile \.composer-config \.picker-chip\s*\{[^}]*min-height:\s*var\(--tap\)/);
  assert.match(css, /\.panel-sheet \.rail-body\s*\{[^}]*padding-bottom:\s*calc\(10px \+ var\(--safe-bottom\)\)/s);
  assert.match(css, /\.package-tour-skips\s*\{[^}]*padding:[^;]*var\(--safe-bottom\)/s);
  assert.match(css, /@media \(max-width: 960px\)[\s\S]*?\.pane-tab-close\s*\{[^}]*min-width:\s*var\(--tap\)[^}]*min-height:\s*var\(--tap\)/s);
});
