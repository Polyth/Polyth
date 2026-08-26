import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readWebStyles } from "./webStyles.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("drag-reorder surfaces expose explicit keyboard and touch controls", async () => {
  const [moveControls, queue, pane, css] = await Promise.all([
    read("../src/components/MoveControls.tsx"),
    read("../src/components/QueuedMessageList.tsx"),
    read("../src/components/workspace/PaneHost.tsx"),
    readWebStyles(),
  ]);

  assert.match(moveControls, /className="reorder-control"/);
  assert.match(moveControls, /disabled=\{index <= 0\}/);
  assert.match(moveControls, /disabled=\{index >= count - 1\}/);
  assert.match(queue, /<MoveControls/);
  assert.match(queue, /moveQueuedMessageValueUp/);
  assert.match(queue, /moveQueuedMessageValueDown/);
  assert.match(pane, /<MoveControls/);
  assert.match(pane, /moveTab\(p, t\.id, targetIndex\)/);
  assert.match(css, /@media \(pointer: coarse\), \(max-width: 480px\)[\s\S]*?\.pane-tab-group\.active > \.reorder-controls\s*\{\s*display:\s*inline-flex/);
});

test("every remaining double-click shortcut has a discoverable mobile alternative", async () => {
  const [terminal, sessions, sidebar, folder, ssh] = await Promise.all([
    read("../../../packages/terminal/widgets/TerminalView.tsx"),
    read("../src/components/sidebar/SessionList.tsx"),
    read("../src/components/Sidebar.tsx"),
    read("../src/components/ProjectFolderDialog.tsx"),
    read("../../../packages/ssh/widgets/ssh/SshProjectSource.tsx"),
  ]);

  assert.match(terminal, /onDoubleClick=\{\(\) => startRename\(t\)\}/);
  assert.match(terminal, /className="term-tab-rename-action"/);
  assert.match(sessions, /onDoubleClick=\{\(\) => \{ setTitle/);
  assert.match(sessions, /className="session-quick-btn session-more-btn"/);
  assert.match(sidebar, /onDoubleClick=\{\(\) => \{ setRenamingProject/);
  assert.match(sidebar, /tr\("sidebar\.renameProject"\)/);
  assert.match(folder, /matchMedia\?\.\("\(pointer: coarse\)"\)/);
  assert.match(folder, /className="folder-row-enter"/);
  assert.match(ssh, /matchMedia\?\.\("\(pointer: coarse\)"\)/);
  assert.match(ssh, /className="folder-row-enter"/);
});

test("coarse pointers, focus, motion, radii, and empty states share polish tokens", async () => {
  const css = await readWebStyles();
  const coarse = css;

  assert.match(css, /--radius:\s*calc\(12px \* var\(--corner-radius-scale\)\)/);
  assert.match(css, /--motion-surface:\s*240ms/);
  assert.match(css, /--focus-ring:\s*var\(--text\)/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/s);
  assert.match(css, /\.modal\s*\{[^}]*animation:\s*rise var\(--motion-surface\) var\(--motion-ease\)/s);
  assert.match(css, /\.empty-state\s*\{[^}]*animation:\s*empty-state-enter var\(--motion-surface\)/s);
  assert.match(css, /\.empty-state-mark\s*\{[^}]*linear-gradient[^}]*var\(--shadow-sm\)/s);
  for (const selector of [
    ".agent-reply-actions",
    ".term-tab-rename-action",
    ".session-worktree-actions",
    ".git-file-actions",
    ".files-row .file-row-actions",
    ".session-folder-del",
  ]) {
    assert.ok(coarse.includes(selector), `${selector} is visible to coarse pointers`);
  }
});

test("P1 mobile refinements remain wired to their visible surfaces", async () => {
  const [sessions, sidebar, settings, models, folder, empty, haptics, css] = await Promise.all([
    read("../src/components/sidebar/SessionList.tsx"),
    read("../src/components/Sidebar.tsx"),
    read("../src/components/SettingsView.tsx"),
    read("../../../packages/models/widgets/ModelPicker.tsx"),
    read("../src/components/ProjectFolderDialog.tsx"),
    read("../src/components/settings/parts.tsx"),
    read("../src/haptics.ts"),
    readWebStyles(),
  ]);

  assert.match(sessions, /aria-busy=\{opening \|\| undefined\}/, "session switching exposes loading state");
  assert.match(sessions, /data-swipe=\{/, "session rows expose swipe state");
  assert.match(sessions, /numeric: "auto"/, "timestamps use smart relative labels");
  assert.match(sidebar, /className=\{`pull-refresh/, "the project/session picker supports pull-to-refresh");
  assert.match(settings, /isEdgeBackSwipe/, "settings supports the mobile back gesture");
  assert.match(models, /className="model-row-provider-logo"/, "mobile model rows identify providers");
  assert.match(folder, /className="folder-path mono"/, "the full-screen project picker keeps search/path entry");
  assert.match(empty, /aria-busy=\{busy \|\| undefined\}/, "settings empty states distinguish loading");
  assert.match(haptics, /navigator\.vibrate\(PATTERNS\[kind\]\)/, "key touch outcomes use bounded native haptics");
  assert.match(css, /:is\(\.side-scroll, \.timeline, \.settings-pane-body, \.sheet-body, \.folder-list, \.rail-body\)/,
    "long mobile surfaces share scroll affordances");
  assert.match(css, /\.session-row\[data-swipe="revealed"\] \.session-quick > \.session-more-btn\s*\{\s*display:\s*none/,
    "swiping reveals the named archive/delete pair without crowding");
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.settings-mobile-page \.settings-pane\s*\{[\s\S]*?animation:\s*settings-page-in/,
    "full-screen settings stages use a directional transition");
  assert.match(css, /\.composer-actions :is\([\s\S]*?\.composer-add-files,[\s\S]*?\)\s*\{[\s\S]*?width:\s*var\(--tap\)/,
    "composer attachments retain a 44px touch box");
});
