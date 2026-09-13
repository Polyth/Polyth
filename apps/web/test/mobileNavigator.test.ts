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
  const [css, polish] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.css"),
    read("../src/components/mobile/MobileNavigatorPolish.css"),
  ]);

  assert.match(css, /\.mobile-navigator\s*\{[^}]*height:\s*var\(--visual-vh, 100dvh\);/s);
  assert.match(css, /var\(--safe-top\)/);
  assert.match(css, /var\(--safe-bottom\)/);
  assert.doesNotMatch(css, /env\(safe-area-inset-/);
  for (const deprecated of ["--surface", "--text-muted", "--danger", "--warning"]) {
    assert.doesNotMatch(css, new RegExp(`var\\(${deprecated}(?:[,\\)])`), `${deprecated} is deprecated in Navigator CSS`);
    assert.doesNotMatch(polish, new RegExp(`var\\(${deprecated}(?:[,\\)])`), `${deprecated} is deprecated in Navigator polish CSS`);
  }
});

test("phone navigator uses a compact rhythm and vector status icons", async () => {
  const [source, css, polish] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/components/mobile/MobileNavigator.css"),
    read("../src/components/mobile/MobileNavigatorPolish.css"),
  ]);

  assert.match(source, /function statusIcon\(kind: MobileStatusKind\)/);
  for (const icon of ["HelpIcon", "ShieldIcon", "SuccessIcon", "ErrorIcon", "WarningIcon", "RefreshIcon"]) {
    assert.match(source, new RegExp(`icon=\\{${icon}\\}`), `${icon} is used for a mobile state`);
  }
  assert.doesNotMatch(source, />(?:↩|◇|✓|!|⚠|↻)</,
    "mobile navigator state marks should not be platform-font glyphs");
  assert.match(css, /\.mobile-nav-state-icon\s*\{[^}]*color:\s*currentColor;/);
  assert.match(polish, /\.mobile-nav-project\s*\{[^}]*margin:\s*0 0 var\(--space-1\);/s);
  assert.match(polish, /\.mobile-nav-project-head\s*\{[^}]*min-height:\s*var\(--tap\);/s);
  assert.match(polish, /\.mobile-nav-session-swipe,[\s\S]*?\.mobile-nav-session-main,[\s\S]*?min-height:\s*var\(--tap\);/s);
  assert.match(polish, /\.mobile-nav-project-action\s*\{[^}]*width:\s*var\(--tap\);[^}]*height:\s*var\(--tap\);/s);
  assert.match(polish, /\.mobile-nav-project-body\s*\{[^}]*padding-left:\s*var\(--space-4\);/s);
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
  assert.match(source, /className="mobile-nav-date-divider is-pinned"/);
  assert.match(source, /className="mobile-nav-pin-icon"/);
  assert.doesNotMatch(source, /function activityLabel/);
  assert.doesNotMatch(source, /mobile-nav-session-time/);
  assert.match(css, /\.mobile-nav-session-row\.is-pinned:not\(\.is-active\)/);
  assert.match(css, /\.mobile-nav-date-divider::before,[\s\S]*?background:\s*var\(--border-soft\)/);
});

test("phone navigator shares project sorting and exposes touch-safe manual reordering", async () => {
  const [source, css] = await Promise.all([
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/components/mobile/MobileNavigator.css"),
  ]);

  assert.match(source, /useProjectSortMode\(\)/);
  assert.match(source, /useProjectOrder\(\)/);
  assert.match(source, /sort === "manual"\) return applyManualProjectOrder\(filtered, projectOrder\)/);
  assert.match(source, /id: "manual"[\s\S]*?label: tr\("sidebar\.manualOrder"\)/);
  assert.match(source, /setProjectOrder\(reorderManualProjects\(fullProjectOrder\(\), draggedId, targetId\)\)/);
  assert.match(source, /className="mobile-nav-project-drag-handle"/);
  assert.match(source, /onPointerMove=\{moveProjectDrag\}/);
  assert.match(source, /onPointerUp=\{finishProjectDrag\}/);
  assert.match(source, /data-project-id=\{project\.id\}/);
  assert.match(css, /\.mobile-nav-project-drag-handle\s*\{[\s\S]*?width:\s*var\(--tap\);[\s\S]*?touch-action:\s*none;/);
  assert.match(css, /\.mobile-nav-project\.is-drag-over\s*> \.mobile-nav-project-head/);
});
