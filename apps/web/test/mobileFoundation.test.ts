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
  const [css, mobileViewport] = await Promise.all([
    readWebStyles(),
    read("../src/mobileViewport.css"),
  ]);
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
  assert.match(
    mobileViewport,
    /html:not\(\[data-desktop-app\]\),\s*body:not\(\.desktop-app\),\s*body:not\(\.desktop-app\) #root\s*\{[^}]*height:\s*var\(--layer-frame-bottom, var\(--visual-frame-bottom, 100dvh\)\);[^}]*max-height:\s*var\(--layer-frame-bottom, var\(--visual-frame-bottom, 100dvh\)\)/s,
    "the whole mobile chain is bounded by the measured frame bottom edge",
  );
  // Measured on iOS 26: Safari resolves 100%/vh/dvh — and the containing
  // block of a `position: fixed` box — against the LARGE viewport, which the
  // keyboard does not shrink. Any of them re-creates the scroll range Safari
  // then pans. `.app` is exempt: its parent already carries measured pixels.
  const chain = /html:not\(\[data-desktop-app\]\),\s*body:not\(\.desktop-app\),\s*body:not\(\.desktop-app\) #root\s*\{([^}]*)\}/
    .exec(mobileViewport);
  assert.ok(chain, "the mobile document chain shares one measured height rule");
  assert.doesNotMatch(chain[1]!, /100%|100[dls]?vh(?!\))/,
    "the mobile chain must not be sized from the viewport — Safari keeps it at the large viewport");
  // iOS standalone (WebKit) can report a dynamic viewport that stops above the
  // Home-indicator canvas; the installed app fills 100vh only while the
  // keyboard is closed, so the measured frame still owns the keyboard band.
  const standaloneFill = /@supports \(-webkit-touch-callout: none\)\s*\{\s*@media \(display-mode: standalone\)\s*\{\s*html:not\(\[data-keyboard-frame="open"\]\) body:not\(\.desktop-app\),\s*html:not\(\[data-keyboard-frame="open"\]\) body:not\(\.desktop-app\) #root\s*\{\s*min-height:\s*100vh;/
    .exec(mobileViewport);
  assert.ok(standaloneFill,
    "the installed iOS app fills the layout viewport while the keyboard is closed");
  const documentOverflow = /html:not\(\[data-desktop-app\]\),\s*body:not\(\.desktop-app\)\s*\{([^}]*)\}/s
    .exec(mobileViewport);
  assert.ok(documentOverflow, "the mobile document overflow rule is explicit");
  assert.match(documentOverflow[1]!, /overflow:\s*clip/,
    "html and body must not remain Safari scroll containers during keyboard resize");
  assert.doesNotMatch(documentOverflow[1]!, /overflow:\s*hidden/,
    "overflow:hidden leaves a Safari scroll boundary during focus handoff");
  assert.doesNotMatch(mobileViewport.replace(/\/\*[\s\S]*?\*\//g, ""), /position:\s*fixed/,
    "no box in the mobile viewport sheet may be fixed — Safari lays it out against the large viewport");
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
    ".lock-field .ui-input",
  ]) {
    assert.ok(guard.includes(selector), `${selector} keeps the iOS input guard`);
  }
  assert.match(guard, /font-size:\s*16px/);
  assert.match(guard, /--font-input:\s*max\(16px, var\(--ui-font-size, 15px\)\)/,
    "shared lock fields retain the mobile floor while respecting larger font preferences");
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

test("the 44px hit-box floor is owned per surface, never one global rule", async () => {
  const css = await readWebStyles();

  assert.match(css, /@media \(max-width: 480px\), \(pointer: coarse\)/);
  // A global `:where(button, …) { min-height: var(--tap) !important }` once
  // inflated unrelated shell controls (tour step dots); each surface now
  // scopes its own floor under its root (Files: packages/files/test).
  assert.doesNotMatch(css, /(?:^|[,}]\s*):where\(\s*button:not\(\.file-ref\)/m);
});

test("a wrapped file reference keeps its prose line box on a phone", async () => {
  const css = await read("../src/components/resource-link.css");
  const phone = /@media \(max-width: 480px\), \(max-height: 480px\) and \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

  assert.match(phone, /\.resource-link\.file-ref\s*\{/, "phone reference links own a touch-box rule");
  assert.match(
    phone,
    /padding-block:\s*calc\(\(var\(--tap\) - 1em\) \/ 2\)[\s\S]*?margin-block:\s*calc\(\(1em - var\(--tap\)\) \/ 2\)/,
    "the target grows with padding and removes that padding again",
  );
  assert.doesNotMatch(
    phone,
    /min-height:\s*var\(--tap\)/,
    "a fixed one-line height collapses a wrapped reference onto the prose above and below",
  );
  assert.match(phone, /text-align:\s*start/, "a wrapped reference keeps the paragraph reading edge");
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
