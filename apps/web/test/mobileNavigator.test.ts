import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("phone navigator opens silently instead of autofocusing search and raising the keyboard", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");
  // useModalSurface with no initialFocus claims the first focusable element in
  // DOM order, which is the search <input> — that flips onFocus's searchMode
  // and pops the keyboard the instant the drawer opens. The drawer element
  // itself must be the declared focus target (Sheet/SettingsView contract).
  assert.match(source, /initialFocus:\s*"\[data-drawer-focus\]"/);
  assert.match(source, /<nav[\s\S]*?tabIndex=\{-1\}[\s\S]*?data-drawer-focus=""[\s\S]*?>/);
});

test("session swipe actions (Pin to top / Archive) stay hidden until actually swiped", async () => {
  const css = await read("../src/components/mobile/MobileNavigator.css");
  // The row only marks the underlay aria-hidden at rest; without a matching
  // visual rule the "Pin to top"/"Archive" labels paint through the row's
  // transparent background on every session row, all the time.
  assert.match(
    css,
    /\.mobile-nav-session-underlay\[aria-hidden="true"\]\s*\{\s*visibility:\s*hidden;\s*\}/,
  );
});

test("phone navigator uses the canonical viewport, safe-area, and semantic color seams", async () => {
  const css = await read("../src/components/mobile/MobileNavigator.css");

  assert.match(css, /\.mobile-navigator\s*\{[^}]*height:\s*var\(--visual-vh, 100dvh\);/s);
  assert.match(css, /var\(--safe-top\)/);
  assert.match(css, /var\(--safe-bottom\)/);
  assert.doesNotMatch(css, /env\(safe-area-inset-/);
  for (const deprecated of ["--surface", "--text-muted", "--danger", "--warning"]) {
    assert.doesNotMatch(css, new RegExp(`var\\(${deprecated}(?:[,\\)])`), `${deprecated} is deprecated in Navigator CSS`);
  }
});

test("phone navigator keeps the tap floor while compacting its rhythm", async () => {
  const [source, css] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/components/mobile/MobileNavigator.css"),
  ]);

  assert.match(source, /function statusIcon\(kind: MobileStatusKind\)/);
  for (const icon of ["HelpIcon", "ShieldIcon", "SuccessIcon", "ErrorIcon", "WarningIcon", "RefreshIcon"]) {
    assert.match(source, new RegExp(`icon=\\{${icon}\\}`), `${icon} is used for a mobile state`);
  }
  assert.doesNotMatch(source, />(?:↩|◇|✓|!|⚠|↻)</,
    "mobile navigator state marks should not be platform-font glyphs");
  assert.match(css, /\.mobile-nav-state-icon\s*\{[^}]*color:\s*currentColor;/);
  assert.match(css, /\.mobile-nav-project\s*\{[^}]*margin:\s*0 0 var\(--space-1\);/s);
  // Denser type and gutters must never shrink a touch target below the floor.
  for (const control of [
    "\\.mobile-nav-project-head",
    "\\.mobile-nav-project-main",
    "\\.mobile-nav-isolated-head",
  ]) {
    assert.match(css, new RegExp(`${control}[^{]*\\{[^}]*min-height:\\s*var\\(--tap\\);`, "s"), `${control} keeps the tap floor`);
  }
  // Session rows are only denser when the user asks for it: the default value
  // of the row variable is the tap floor, and the smaller values live behind
  // the shared interface-density preference.
  assert.match(css, /\.mobile-navigator\s*\{[^}]*--nav-row-session:\s*var\(--tap\);/s);
  for (const control of ["\\.mobile-nav-session-swipe", "\\.mobile-nav-session-row", "\\.mobile-nav-session-main"]) {
    assert.match(css, new RegExp(`${control}[^{]*\\{[^}]*min-height:\\s*var\\(--nav-row-session\\);`, "s"), `${control} follows the density row height`);
  }
  for (const match of css.match(/--nav-row-session:\s*[^;]+;/g) ?? []) {
    assert.ok(
      /var\(--tap\)/.test(match) || /\[data-density=/.test(css.slice(Math.max(0, css.indexOf(match) - 200), css.indexOf(match))),
      `${match} must be the tap floor or a density opt-in`,
    );
  }
  assert.match(css, /\.mobile-nav-project-action\s*\{[^}]*width:\s*var\(--tap\);[^}]*height:\s*var\(--tap\);/s);
  // Type comes from the shared role scale, so the interface-size setting works.
  assert.doesNotMatch(css, /font-size:\s*\d\d(?:\.\d+)?px/,
    "navigator type must use role tokens, not fixed pixel sizes");
});

test("phone navigator glass is an appearance choice with a readable fallback", async () => {
  const css = await read("../src/components/mobile/MobileNavigator.css");

  assert.match(css, /\.mobile-navigator\s*\{[^}]*background:\s*var\(--material-glass-strong\);/s);
  // Blur only inside @supports, and only while glass is on and the client is
  // not in low-resource mode (the shared Quiet Glass contract).
  const blurBlocks = css.match(/backdrop-filter:[^;]+;/g) ?? [];
  assert.ok(blurBlocks.length > 0);
  const supports = css.slice(css.indexOf("@supports"));
  for (const rule of blurBlocks) assert.ok(supports.includes(rule), `${rule} is gated by @supports`);
  assert.match(supports, /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) \.mobile-navigator/);
});

test("adding a project and starting a chat are visibly different actions", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");

  assert.match(source, /aria-label=\{tr\("sidebar\.addProject"\)\}[\s\S]{0,220}?icon=\{AddProjectIcon\}/,
    "add project uses the folder-plus glyph");
  assert.match(source, /aria-label=\{tr\("sidebar\.newChatInValue"[\s\S]{0,220}?icon=\{NewChatIcon\}/,
    "new chat uses the chat-plus glyph");
  // The isolation shortcut moved into the project menu; the row must not carry
  // a second unlabelled plus-like glyph next to "new chat".
  assert.doesNotMatch(source, /mobile-nav-isolated-glyph/);
  assert.match(source, /id:\s*"isolate"[\s\S]*?openWorktreeSessionDialog\(project\.id\)/);
});

test("session actions stay a nested menu and can copy the session id", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");

  assert.match(source, /copyText\(session\.id\)/);
  assert.match(source, /id:\s*"copy-id"[\s\S]*?label:\s*tr\("sidebar\.sessionlist\.copySessionId"\)/);
  assert.match(source, /id:\s*"delete"[\s\S]*?onSelect:\s*\(\) => void remove\(\)/);
  assert.doesNotMatch(source, /if \(session\.isolation\) return;/,
    "explicit hard-delete stays available while isolation recovery is pending");
  assert.match(source, /session\.isolation[\s\S]*?theLocalIsolationWorkspaceAndEveryFileInItWillAlsoBePermanentlyDeleted/,
    "mobile confirmation names the isolation workspace that will be removed");
  assert.match(source, /<Menu[\s\S]*?phonePresentation="popover"[\s\S]*?open=\{menuOpen\}/);
});

test("phone chats are pinned-first, date-filtered, and grouped without row ages", async () => {
  const [source, css] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/components/mobile/MobileNavigator.css"),
  ]);

  assert.match(source, /list\.sort\(compareSessionNavigation\)/);
  assert.match(source, /sessionMatchesDateFilter\(session, dateFilter\)/);
  assert.match(source, /<SessionDateFilterControls value=\{dateFilter\} onChange=\{setDateFilter\}/);
  assert.match(source, /id: "date-groups"/);
  assert.match(source, /showDateGroups && group.key !== sessionDateInputValue\(now\)/);
  assert.match(source, /className="mobile-nav-date-divider is-pinned"/);
  assert.match(source, /className="mobile-nav-pin-icon"/);
  assert.doesNotMatch(source, /function activityLabel/);
  assert.doesNotMatch(source, /mobile-nav-session-time/);
  assert.match(css, /\.mobile-nav-session-row\.is-pinned:not\(\.is-active\)/);
  assert.match(css, /\.mobile-nav-date-divider::after\s*\{[\s\S]*?background:\s*var\(--border-soft\)/);
});

test("phone navigator shares project sorting and reorders from the project row", async () => {
  const [source, css] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/components/mobile/MobileNavigator.css"),
  ]);

  assert.match(source, /useProjectSortMode\(\)/);
  assert.match(source, /useProjectOrder\(\)/);
  assert.match(source, /sort === "manual"\) return applyManualProjectOrder\(filtered, projectOrder\)/);
  assert.match(source, /id: "manual"[\s\S]*?label: tr\("sidebar\.manualOrder"\)/);
  assert.match(source, /setProjectOrder\(reorderManualProjects\(fullProjectOrder\(\), draggedId, targetId\)\)/);
  assert.doesNotMatch(source, /mobile-nav-project-drag-handle/);
  assert.doesNotMatch(source, /mobile-nav-disclosure/);
  assert.match(source, /className="mobile-nav-project-head"/);
  assert.match(source, /onPointerMove=\{moveProjectDrag\}/);
  assert.match(source, /onPointerUp=\{finishProjectDrag\}/);
  assert.match(source, /data-project-id=\{project\.id\}/);
  assert.match(source, /aria-expanded=\{expanded\}/);
  assert.match(css, /\.mobile-nav-project\.is-dragging > \.mobile-nav-project-head\s*\{[^}]*touch-action:\s*none;/s);
  assert.match(css, /\.mobile-nav-project\.is-drag-over\s*> \.mobile-nav-project-head/);
  assert.match(css, /\.mobile-nav-project\s*\{[^}]*background:\s*color-mix/s);
  assert.doesNotMatch(css, /\.mobile-nav-disclosure/);
  assert.doesNotMatch(css, /\.mobile-nav-project-drag-handle/);
});
