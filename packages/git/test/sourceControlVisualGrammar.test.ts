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
