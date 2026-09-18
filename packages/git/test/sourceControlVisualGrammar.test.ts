import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gitView = readFileSync(new URL("../widgets/GitView.tsx", import.meta.url), "utf8");
const recentChanges = readFileSync(new URL("../widgets/RecentChangesWidget.tsx", import.meta.url), "utf8");
const packageEntry = readFileSync(new URL("../widgets/index.tsx", import.meta.url), "utf8");
const polish = readFileSync(new URL("../widgets/source-control-polish.css", import.meta.url), "utf8");

test("Source Control keeps stage, unstage, discard, refresh, and sync semantics distinct", () => {
  assert.match(gitView, /icon=\{file\.staged \? MinusIcon : StageIcon\}/);
  assert.match(gitView, /className="git-file-discard"/);
  assert.match(gitView, /iconStart=\{SyncIcon\}[\s\S]*?gitview\.syncRepository/);
  assert.match(gitView, /className="source-refresh-btn"[\s\S]*?gitview\.refreshSourceControl/);
  assert.doesNotMatch(gitView, /file\.staged \? UndoIcon/);
  assert.doesNotMatch(gitView, /iconStart=\{RefreshIcon\}[\s\S]{0,160}gitview\.syncRepository/);
});

test("Source Control rows prioritize filenames and keep full paths available", () => {
  assert.match(gitView, /className="git-file-name">\{identity\.name\}/);
  assert.match(gitView, /className="git-file-directory"/);
  assert.match(gitView, /title=\{title\}/);
  assert.match(recentChanges, /className="git-recent-name">\{identity\.name\}/);
  assert.match(recentChanges, /className="git-recent-directory"/);
});

test("Source Control contextual actions remain discoverable across pointer modes", () => {
  assert.match(polish, /\.git-page \.git-file-actions \{[\s\S]*?opacity: 0;[\s\S]*?pointer-events: none;/);
  assert.match(polish, /\.git-page \.git-file-row:focus-within \.git-file-actions \{[\s\S]*?opacity: 1;[\s\S]*?pointer-events: auto;/);
  assert.match(polish, /@media \(pointer: coarse\) \{[\s\S]*?\.git-page \.git-file-actions \{[\s\S]*?opacity: 1;[\s\S]*?pointer-events: auto;/);
  assert.match(polish, /content-visibility: auto;/);
});

test("Source Control polish stays package-owned", () => {
  assert.match(packageEntry, /import "\.\/source-control-polish\.css";/);
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

test("Source Control refreshes on project change, not on every store notification", () => {
  assert.match(packageEntry, /projectId === scope && !force/);
  assert.match(packageEntry, /host\.store\.subscribe\(\(\) => refreshActive\(\)\)/);
  assert.match(packageEntry, /subscribeSourceControlProfiles\(\(\) => refreshActive\(true\)\)/);
  assert.doesNotMatch(packageEntry, /host\.store\.subscribe\(refreshActive\)/);
});

test("Source Control keeps nested chrome quiet and follows the transparency preference", () => {
  assert.match(
    polish,
    /\.git-page \.git-pane-toolbar\s*\{[\s\S]*?display:\s*grid;[\s\S]*?background:\s*transparent;/,
  );
  assert.match(
    polish,
    /@container git-page \(max-width: 620px\)[\s\S]*?\.git-page \.git-pane-actions\s*\{[\s\S]*?flex-basis:\s*auto;/,
  );
  assert.match(
    polish,
    /\.git-page > \.source-tabs,[\s\S]*?background:\s*transparent;/,
  );
  assert.match(
    polish,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) \.git-page \.git-commit-composer\s*\{[\s\S]*?var\(--material-glass-fill\)[\s\S]*?backdrop-filter:/,
  );
  assert.match(
    polish,
    /body\[data-glass="off"\] \.git-page \.git-commit-composer,[\s\S]*?backdrop-filter:\s*none !important;/,
  );
  assert.match(
    gitView,
    /className="git-commit-msg"[\s\S]{0,140}?minRows=\{1\}[\s\S]{0,140}?maxRows=\{4\}/,
  );
});

