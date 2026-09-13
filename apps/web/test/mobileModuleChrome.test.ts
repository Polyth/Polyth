import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("phone modules expose Back to Workspace and a separate dismiss control", async () => {
  const moduleView = await read("../src/components/ui/ModuleView.ts");

  assert.match(moduleView, /const phone = shellMode === "phone"/);
  assert.match(moduleView, /if \(phone\) rememberMobileWorkspacePackage\(id\)/);
  assert.match(moduleView, /showMobileWorkspaceHome\(\)/);
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
  assert.match(css, /background:\s*color-mix\(in srgb, var\(--material-glass\) 78%, transparent\)/);
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

test("Source control mobile surface removes the giant card treatment and uses quiet tabs", async () => {
  const css = await read("../../../packages/git/widgets/mobile.css");
  const index = await read("../../../packages/git/widgets/index.tsx");

  assert.match(index, /import "\.\/mobile\.css"/);
  assert.match(css, /\.git-changes-layout > \.git-master-detail,[\s\S]*?border:\s*0;/);
  assert.match(css, /\.source-tabs\s*\{[\s\S]*?border-bottom:\s*1px solid var\(--hair\)/);
  assert.match(css, /\.source-tabs > \.ui-tab\.ui-tab--selected[\s\S]*?box-shadow:\s*inset 0 -2px 0 var\(--accent\)/);
  assert.match(css, /\.source-sync-btn[\s\S]*?border-color:\s*transparent/);
});
