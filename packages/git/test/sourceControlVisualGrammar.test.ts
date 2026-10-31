import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gitLocales } from "../src/i18n/index.ts";

const gitView = readFileSync(new URL("../widgets/GitView.tsx", import.meta.url), "utf8");
const changeList = readFileSync(new URL("../widgets/ChangeList.tsx", import.meta.url), "utf8");
const recentChanges = readFileSync(new URL("../widgets/RecentChangesWidget.tsx", import.meta.url), "utf8");
const packageEntry = readFileSync(new URL("../widgets/index.tsx", import.meta.url), "utf8");
// One package-owned layer styles the whole GitView surface, at every width.
const polish = readFileSync(new URL("../widgets/source-control.css", import.meta.url), "utf8");
const mobileCss = polish;

test("Source Control keeps stage, unstage, discard, refresh, and sync semantics distinct", () => {
  assert.match(changeList, /icon=\{file\.staged \? MinusIcon : StageIcon\}/);
  assert.match(changeList, /className="git-file-discard"/);
  assert.match(gitView, /iconStart=\{SyncIcon\}[\s\S]*?gitview\.syncRepository/);
  assert.match(gitView, /className="source-refresh-btn"[\s\S]*?gitview\.refreshSourceControl/);
  assert.doesNotMatch(gitView + changeList, /file\.staged \? UndoIcon/);
  assert.doesNotMatch(gitView, /iconStart=\{RefreshIcon\}[\s\S]{0,160}gitview\.syncRepository/);
});

test("Source Control rows prioritize filenames and keep full paths available", () => {
  assert.match(changeList, /className="git-file-name">\{identity\.name\}/);
  assert.match(changeList, /className="git-file-directory"/);
  assert.match(changeList, /title=\{title\}/);
  assert.match(recentChanges, /className="git-recent-name">\{identity\.name\}/);
  assert.match(recentChanges, /className="git-recent-directory"/);
});

test("Source Control contextual actions remain discoverable across pointer modes", () => {
  assert.match(polish, /\.git-page \.git-file-actions \{[\s\S]*?opacity: 0;[\s\S]*?pointer-events: none;/);
  assert.match(polish, /\.git-page \.git-file-row:has\(:focus-visible\) \.git-file-actions,\n\.git-page \.git-file-row:has\(\[aria-expanded="true"\]\) \.git-file-actions \{[\s\S]*?opacity: 1;[\s\S]*?pointer-events: auto;/);
  assert.match(polish, /@media \(pointer: coarse\) \{[\s\S]*?\.git-page \.git-file-actions \{[\s\S]*?opacity: 1;[\s\S]*?pointer-events: auto;/);
  assert.match(polish, /content-visibility: auto;/);
});

test("Source Control polish stays package-owned", () => {
  assert.match(packageEntry, /import "\.\/source-control\.css";/);
  assert.doesNotMatch(packageEntry, /source-control-polish\.css|mobile\.css|hunk-actions\.css/);
  assert.match(polish, /^\/\* Source control interaction grammar\./);
});

test("edited-files rows use compact technical type instead of editor code size", () => {
  const styles = readFileSync(new URL("../widgets/styles.css", import.meta.url), "utf8");
  assert.match(
    styles,
    /\.pending-changes-file\s*\{[^}]*font:\s*400 var\(--font-meta\) \/ 1\.4 var\(--mono\)/s,
  );
  assert.match(styles, /\.pending-changes-file\s*\{[^}]*min-height:\s*var\(--control-h-sm\)/s);
  assert.doesNotMatch(styles, /\.pending-changes-file-name\s*\{[^}]*font-size:\s*var\(--font-code\)/s);
  assert.match(styles, /\.pending-changes-file::after\s*\{[^}]*var\(--hit-min\)/s);
});

test("edited files above the composer are a borderless line in every look", () => {
  const styles = readFileSync(new URL("../widgets/styles.css", import.meta.url), "utf8");
  const bar = readFileSync(new URL("../widgets/PendingChangesBar.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(bar, /ui-glass-dock/);
  assert.doesNotMatch(bar, /meta=\{bubbleCount\}/, "the folded line's title already carries the count");
  assert.doesNotMatch(styles, /\.pending-changes-bar\s*\{[^}]*box-shadow:\s*var\(--material-glass-highlight\)/s);
  // Files hang from the activity thread; Borderless keeps it.
  assert.match(styles, /\.pending-changes-list::before \{[^}]*background:\s*var\(--borderless-edge\)/s);
  assert.match(styles, /body\[data-composer-status-style="tab"\] \.pending-changes-bar \{[^}]*var\(--composer-status-tab-inset, var\(--space-4\)\)/s);
  assert.match(styles, /body\[data-composer-status-style="capsule"\] \.pending-changes-bar--collapsed > \.ui-run-summary \{[^}]*width:\s*fit-content;[^}]*box-shadow:\s*inset 0 0 0 1px var\(--borderless-edge\)/s);
});

test("narrow Source Control header wraps by unit instead of clipping mid-word", () => {
  // The header always wraps by whole unit. In a phone-width pane its wrappers
  // dissolve into two rows: branch … Sync, then identity … remote, menu and
  // refresh, split by a zero-height break item; each item truncates instead
  // of breaking its own label.
  assert.match(mobileCss, /\.git-page \.source-control-head\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(mobileCss, /@container git-page \(max-width: 519px\)\s*\{[\s\S]*?\.source-control-head \.workspace-surface-header-context/);
  assert.match(
    mobileCss,
    /\.source-control-head \.workspace-surface-header-context,[\s\S]*?\.source-control-head \.source-remote-buttons\s*\{\s*display:\s*contents;/,
  );
  assert.match(mobileCss, /\.git-page \.source-control-head::after\s*\{[^}]*order:\s*4;[^}]*flex:\s*0 0 100%;/);
  assert.match(mobileCss, /\.git-page \.source-remote-buttons > \.source-sync-btn\s*\{\s*order:\s*3;\s*margin-inline-start:\s*auto;/);
  assert.match(mobileCss, /\.git-page \.source-control-title > \.source-branch\s*\{[^}]*flex:\s*1 1 0;\s*max-width:\s*max-content;/);
  assert.match(mobileCss, /\.git-page \.git-remote-context\s*\{\s*order:\s*6;/);
  assert.match(
    mobileCss,
    /\.git-page \.source-control-identity\s*\{[^}]*flex-wrap:\s*nowrap;/,
  );
  assert.match(mobileCss, /\.git-page \.source-control-title\s*\{[^}]*flex-wrap:\s*nowrap;/);
});

test("Source Control refreshes on project change, not on every store notification", () => {
  assert.match(packageEntry, /projectId === scope && !force/);
  assert.match(packageEntry, /host\.store\.subscribe\(\(\) => refreshActive\(\)\)/);
  assert.match(packageEntry, /subscribeSourceControlProfiles\(\(\) => refreshActive\(true\)\)/);
  assert.doesNotMatch(packageEntry, /host\.store\.subscribe\(refreshActive\)/);
});

test("Source Control keeps nested chrome quiet and follows the transparency preference", () => {
  // The pane toolbar is sticky over the scrolling change list, so it must keep
  // an occluding background instead of scrolling rows bleeding through it.
  assert.match(
    polish,
    /\.git-page \.git-pane-toolbar\s*\{[^}]*display:\s*grid;[^}]*padding:\s*var\(--space-3\);[^}]*background:\s*var\(--panel\);/,
  );
  assert.match(
    polish,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) \.git-page \.git-pane-toolbar\s*\{[\s\S]*?backdrop-filter:/,
  );
  assert.match(
    polish,
    /body\[data-glass="off"\] \.git-page \.git-pane-toolbar,[\s\S]*?background:\s*var\(--panel\);[\s\S]*?backdrop-filter:\s*none;/,
  );
  assert.match(polish, /\.git-page \.git-pane-actions\s*\{[^}]*flex-basis:\s*auto;/);
  assert.match(polish, /\.git-page \.ui-tabs\.source-tabs\s*\{[^}]*background:\s*transparent;/);
  assert.match(
    polish,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) \.git-page \.git-commit-composer\s*\{[\s\S]*?var\(--material-glass-fill\)[\s\S]*?backdrop-filter:/,
  );
  assert.match(
    polish,
    /body\[data-glass="off"\] \.git-page \.git-commit-composer,[\s\S]*?backdrop-filter:\s*none;/,
  );
  assert.match(
    gitView,
    /className="git-commit-msg"[\s\S]{0,140}?minRows=\{1\}[\s\S]{0,140}?maxRows=\{4\}/,
  );
  assert.doesNotMatch(polish, /!important/);
});

test("clean changes use the shared empty state inside the list without nested chrome", () => {
  const list = gitView.slice(gitView.indexOf('<div className="git-change-groups">'), gitView.indexOf('<section className="git-detail-pane"'));
  // The default variant: a Look repaints compact/panel states as cards, which
  // would nest a second card inside the pane. A clean tree reads as done.
  const clean = /all\.length === 0 && <EmptyState([\s\S]*?)\n\s*\/>\}/.exec(list)?.[1] ?? "";
  assert.match(clean, /mark=\{<UiIcon icon=\{CheckIcon\}[\s\S]*?tr\("gitview.workingTreeClean"\)[\s\S]*?tr\("gitview.localEditsWillAppearHere"\)/);
  assert.doesNotMatch(clean, /variant=/);
  assert.match(polish, /\.git-page :is\(\.git-change-groups, \.git-graph, \.git-resource-card\) > \.empty-state\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/);
});

test("empty lists hug their message at the top instead of growing into a full-height card", () => {
  const row = /\.git-page :is\(\.empty-state--compact, :is\(\.git-change-groups, \.git-graph, \.git-resource-card\) > \.empty-state\)\s*\{([^}]*)\}/.exec(polish)?.[1] ?? "";
  assert.match(row, /flex:\s*none;/);
  assert.match(row, /margin:\s*0;/);
  // Each empty list names what is missing instead of the shared default clock.
  for (const key of ["gitview.noStashes", "gitview.reviewNoChanges", "gitview.noLinkedWorktrees", "gitview.noCommitsMatchThisFilter"]) {
    const at = gitView.indexOf(`tr("${key}"`);
    assert.ok(at > 0, key);
    assert.match(gitView.slice(gitView.lastIndexOf("<EmptyState", at), at), /mark=\{<UiIcon icon=/, `${key} has a mark`);
  }
});

test("tabs retain overflow fades through measurement and display every zero count", () => {
  assert.match(gitView, /new ResizeObserver\(measure\)/);
  assert.match(gitView, /observer\.disconnect\(\)/);
  assert.match(gitView, /overflow \? " ui-scroll-tabs" : ""/);
  assert.match(gitView, /label: tabLabel\(tr\("gitview.tabChanges"\), all\.length/);
  assert.match(gitView, /tabLabel\(tr\("gitview.tabStashes"\), stashes\.length\)/);
  assert.doesNotMatch(mobileCss + polish, /mask-image:\s*none/);
  const styles = readFileSync(new URL("../widgets/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(styles + polish, /@container[^}]*\{\s*\.source-tabs/);
  assert.equal((mobileCss.match(/\.git-page \.ui-tabs\.source-tabs\s*\{/g) ?? []).length, 1);
});

test("tabs keep the underline grammar in every theme style", () => {
  // Theme styles (fluent, macos) draw .ui-tabs as a segmented well with a
  // 2px gap and a raised selected segment. The strip and tab selectors carry
  // one more class than that recipe, so the well, its gap and the selected
  // plate never reach Source Control; the package owns no per-style copy.
  assert.doesNotMatch(polish, /data-theme-style/);
  assert.match(polish, /\.git-page \.ui-tabs\.source-tabs\s*\{[^}]*gap:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;/);
  assert.match(polish, /\.git-page \.ui-tabs\.source-tabs > \.ui-tab\s*\{[^}]*min-width:\s*var\(--hit-min\);[^}]*padding:\s*0 var\(--sc-tab-pad\);[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/);
  // The indicator spans the label, not the tab's padding.
  assert.match(polish, /\.git-page \.ui-tabs\.source-tabs > \.ui-tab\.ui-tab--selected::after\s*\{[^}]*inset-inline:\s*var\(--sc-tab-pad\);[^}]*width:\s*auto;/);
});

test("header controls share one height and one type size", () => {
  assert.match(polish, /\.git-page \.source-control-head\s*\{[^}]*--sc-head-h:\s*max\(var\(--control-h-sm\), var\(--hit-min\)\);/);
  for (const selector of [
    String.raw`\.source-control-title > \.source-branch`,
    String.raw`\.source-control-title > \.git-ahead-behind`,
    String.raw`\.source-control-title \.source-control-identity-trigger`,
    String.raw`\.source-remote-buttons > \.source-sync-btn`,
  ]) assert.match(polish, new RegExp(`\\.git-page ${selector}\\s*\\{[^}]*min-height:\\s*var\\(--sc-head-h\\);`), selector);
  assert.match(polish, /\.git-page \.source-remote-buttons > \.source-sync-btn\s*\{[^}]*font-size:\s*var\(--font-meta\);/);
});

test("identity/provider selection keeps the existing slot context", () => {
  const identity = readFileSync(new URL("../widgets/SourceControlIdentity.tsx", import.meta.url), "utf8");
  assert.match(identity, /iconEnd=\{ChevronDownIcon\}/);
  assert.match(identity, /slot="git.repository.identity.provider" context=\{\{\s*projectId,\s*sourceControlProfileId:[\s\S]*?sourceControlProvider: resolution.provider,\s*resolutionSource: resolution.source,/);
  // One provider summary per chip: the instance owner's checkout identity and
  // a member's own commit identity (Spaces §14.4). The GitHub provider copy is
  // pinned by the GitHub package's own host visual-grammar test.
  assert.equal((identity.match(/slot="git.repository.identity.provider"/g) ?? []).length, 2);
});

test("Git locale catalogs share keys and interpolations", () => {
  const keys = Object.keys(gitLocales.en).sort() as (keyof typeof gitLocales.en)[];
  for (const [locale, catalog] of Object.entries(gitLocales)) {
    assert.deepEqual(Object.keys(catalog).sort(), keys, `${locale}: catalog keys`);
    for (const key of keys) {
      const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(placeholders(catalog[key]!), placeholders(gitLocales.en[key]!), `${locale}: ${key}`);
    }
  }
});
