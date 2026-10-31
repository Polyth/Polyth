import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("phone modules expose Back to Workspace and a separate dismiss control", async () => {
  const moduleView = await read("../src/components/ui/ModuleView.ts");

  assert.match(moduleView, /const phone = shellMode === "phone"/);
  // Only a presented frame may become the resume target: a closed keep-alive
  // frame stays mounted under a placeholder id and must never reopen/close the
  // Workspace that Back just returned to.
  assert.match(moduleView, /if \(phone && presented\) rememberMobileWorkspacePackage\(id\)/);
  assert.match(moduleView, /presented = true/);
  // Back names the Workspace as the destination before the package leaves.
  assert.match(moduleView, /const phoneBack = \(\) => \{\s*showMobileWorkspaceHome\(\);\s*onClose\(\);\s*\};/);
  assert.match(moduleView, /systemAction\(BackIcon, tr\("common\.back"\), phoneBack/);
  assert.match(moduleView, /module-view-close module-view-dismiss/);
  assert.match(moduleView, /!phone && dockActions/);
  assert.match(moduleView, /!phone && onTogglePin/);
  assert.match(moduleView, /!phone && onToggleFullscreen/);
  assert.match(moduleView, /module-view--phone/);
});

test("phone modules share restrained glass chrome, touch targets, safe spacing and overflow rules", async () => {
  const css = await read("../src/moduleContent.css");

  assert.match(css, /\.module-view--phone \.module-view-head\s*\{/);
  assert.match(css, /background:\s*var\(--bg\)/);
  assert.match(css, /background:\s*color-mix\(in srgb, var\(--material-glass\) var\(--material-glass-readable-fill\), transparent\)/);
  assert.match(css, /blur\(calc\(var\(--material-glass-blur\) \* \.45\)\)/);
  assert.match(css, /box-shadow:\s*none/);
  assert.match(css, /min-height:\s*calc\(var\(--tap\) \+ var\(--space-2\)\)/);
  assert.match(css, /\.module-view--phone \.module-view-back,/);
  assert.match(css, /\.module-view--phone \.module-view-dismiss/);
  assert.match(css, /width:\s*var\(--tap\)/);
  assert.match(css, /font-size:\s*max\(16px, var\(--font-input\)\)/);
  assert.match(css, /overscroll-behavior:\s*contain/);
  assert.match(css, /--module-content-inline:\s*var\(--screen-gutter\)/);
});

test("mobile Workspace navigation restores a dismissed package and keeps the root title-free", async () => {
  const navigation = await read("../src/mobileWorkspaceNavigation.ts");
  const sessionHeader = await read("../src/components/mobile/MobileSessionHeader.tsx");
  const viewHeader = await read("../src/components/mobile/MobileViewHeader.tsx");
  const workspaceCss = await read("../src/workspacePanelWidgetFixes.css");

  assert.match(navigation, /lastPackageId: string \| null/);
  assert.match(navigation, /showMobileWorkspaceHome/);
  assert.match(navigation, /hideMobileWorkspaceHome/);
  assert.match(sessionHeader, /workspaceNav\.lastPackageId/);
  assert.match(sessionHeader, /capability\.descriptor\.open\(\)/);
  assert.match(viewHeader, /workspaceNav\.lastPackageId/);
  assert.match(workspaceCss, /\.workspace-panel-sheet \.sheet-title\s*\{\s*display:\s*none;/s);
});

// Phone card geometry (a clean card hugs its content) is pinned live in
// packages/git/test/sourceControlLayout.test.ts; this guards the wiring.
test("Source control uses quiet underline tabs and one page stylesheet on every width", async () => {
  const css = await read("../../../packages/git/widgets/source-control.css");
  const index = await read("../../../packages/git/widgets/index.tsx");

  assert.match(index, /import "\.\/source-control\.css"/);
  assert.doesNotMatch(index, /import "\.\/mobile\.css"/);
  assert.match(css, /\.git-page \.ui-tabs\.source-tabs\s*\{[^}]*box-shadow:\s*inset 0 -1px 0 var\(--hair\)/);
  assert.match(css, /\.source-tabs > \.ui-tab\.ui-tab--selected::after\s*\{[^}]*background:\s*var\(--accent\);[^}]*opacity:\s*1;/);
});

test("a tab just selected by touch keeps its fill: no hover reaches a tapped button", async () => {
  const css = await read("../src/styles.css");
  // Touch keeps :hover on the tapped point. Button hovers live in
  // `@media (hover: hover)` (buttonStates.test.ts), so nothing repaints the
  // selection the finger just made — the old touch reset that flattened every
  // stuck hover also erased selected tabs, pressed toggles and filled actions.
  assert.doesNotMatch(css, /@media \(hover: none\) \{\s*button:not\(/, "no touch reset paints tapped buttons transparent");
  assert.match(css, /@media \(hover: hover\) \{\s*\.ui-tab:hover:not\(:disabled\) \{/, "tab hover is pointer-only");
  assert.match(css, /\.ui-tab--selected \{ background: var\(--elevated\);/, "a selected tab owns its fill");
  assert.match(css, /\.ui-icon-btn\[aria-pressed="true"\] \{ color: var\(--accent\); background: var\(--accent-wash\); \}/, "a pressed toggle owns its fill");
});
