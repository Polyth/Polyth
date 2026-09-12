import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readWebStyles } from "./webStyles.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("queue reorders by dragging while pane tabs retain keyboard controls", async () => {
  const [moveControls, queue, pane, css] = await Promise.all([
    read("../src/components/MoveControls.tsx"),
    read("../src/components/QueuedMessageList.tsx"),
    read("../src/components/workspace/PaneHost.tsx"),
    readWebStyles(),
  ]);

  assert.match(moveControls, /className="reorder-control"/);
  assert.match(moveControls, /disabled=\{index <= 0\}/);
  assert.match(moveControls, /disabled=\{index >= count - 1\}/);
  assert.match(queue, /draggable/);
  assert.doesNotMatch(queue, /<MoveControls/);
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
  // The rename shortcut's touch alternative is the persistent row menu
  // trigger (Rename is the first entry of the row's ui/Menu).
  assert.match(sessions, /className="session-menu-trigger"/);
  assert.match(sessions, /id: "rename", label: tr\("common\.rename"\)/);
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

  assert.match(css, /--radius-control:\s*calc\(8px \* var\(--corner-radius-scale\)\)/);
  assert.match(css, /--radius:\s*var\(--radius-control\)/);
  assert.match(css, /--motion-surface:\s*240ms/);
  assert.match(css, /--focus-ring:\s*var\(--accent\)/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/s);
  assert.match(css, /\.modal\s*\{[^}]*animation:\s*rise var\(--motion-surface\) var\(--motion-ease\)/s);
  assert.match(css, /\.empty-state\s*\{[^}]*animation:\s*empty-state-enter var\(--motion-surface\)/s);
  assert.match(css, /\.empty-state-mark\s*\{[^}]*background:\s*var\(--accent-wash\)[^}]*box-shadow:\s*var\(--inset-hi\)/s);
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

test("shared selects render the chosen value once and use field styling", async () => {
  const [select, picker, css] = await Promise.all([
    read("../src/components/ui/Select.tsx"),
    read("../src/components/Picker.tsx"),
    readWebStyles(),
  ]);

  assert.match(select, /className=\{`picker-select\$\{/);
  assert.match(picker, /<Popover[\s\S]*side=\{_direction\}/);
  assert.doesNotMatch(picker, /close\(\); emptyAction\.run\(\)/);
  assert.doesNotMatch(picker, /menu-backdrop/);
  assert.match(css, /\.picker-select \.chip-k\s*\{\s*display:\s*none;/);
  assert.match(css, /\.picker-select \.picker-chip\s*\{[\s\S]*?background:\s*var\(--elevated\)/);
  assert.match(css, /\.ui-popover\s*\{[\s\S]*?position:\s*fixed/);
});

test("P1 mobile refinements remain wired to their visible surfaces", async () => {
  const [sessions, sessionDates, sidebar, settings, models, folder, empty, haptics, css] = await Promise.all([
    read("../src/components/sidebar/SessionList.tsx"),
    read("../src/sessionDates.ts"),
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
  assert.match(sessions, /groupSessionsByActivityDate/, "session recency is shown once per date group");
  assert.match(sessionDates, /new Intl\.RelativeTimeFormat\(locale, \{ numeric: "auto" \}\)/,
    "recent date dividers use localized relative labels before calendar dates");
  assert.match(sidebar, /className=\{`pull-refresh/, "the project/session picker supports pull-to-refresh");
  assert.match(settings, /isEdgeBackSwipe/, "settings supports the mobile back gesture");
  assert.match(models, /className="model-row-provider-logo"/, "mobile model rows identify providers");
  assert.match(models, /onBack=\{\(\) => closeDetails\(true\)\}/,
    "phone model details return focus to their originating information control");
  assert.match(folder, /className="folder-path mono"/, "the full-screen project picker keeps search/path entry");
  assert.match(empty, /aria-busy=\{busy \|\| undefined\}/, "settings empty states distinguish loading");
  assert.match(haptics, /navigator\.vibrate\(PATTERNS\[kind\]\)/, "key touch outcomes use bounded native haptics");
  assert.match(css, /\* \{ scrollbar-width: thin; scrollbar-color: var\(--border\) transparent; \}/,
    "long mobile surfaces share scroll affordances");
  assert.match(css, /\.session-row\[data-swipe="revealed"\] \.session-quick > \.session-quick-btn\s*\{[\s\S]*?width:\s*var\(--tap\)/,
    "swiping reveals the named archive/delete pair at full touch size");
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.settings-mobile-page \.settings-pane\s*\{[\s\S]*?animation:\s*settings-page-in/,
    "full-screen settings stages use a directional transition");
  assert.match(css, /\.composer-actions :is\([\s\S]*?\.composer-add-files,[\s\S]*?\)\s*\{[\s\S]*?width:\s*var\(--tap\)/,
    "composer attachments retain a 44px touch box");
});

test("agent questions use shared controls and complete tab semantics", async () => {
  const [questions, css] = await Promise.all([
    read("../src/components/QuestionCards.tsx"),
    readWebStyles(),
  ]);

  assert.match(questions, /<IconButton[\s\S]*?icon=\{MarkdownIcon\}/);
  assert.match(questions, /<Button size="sm" variant="primary"/);
  assert.match(questions, /<Button size="sm" variant="danger"/);
  assert.match(questions, /const groupName = useId\(\)/);
  assert.match(questions, /name=\{groupName\}/, "radio names are scoped per rendered question");
  assert.match(questions, /aria-controls=\{`\$\{id\}-panel`\}/);
  assert.match(questions, /event\.key === "ArrowRight"/);
  assert.match(questions, /tabIndex=\{i === step \? 0 : -1\}/);
  assert.match(css, /\.question-card\s*\{[^}]*container-type:\s*inline-size[^}]*border-radius:\s*var\(--radius-card\)/s);
  assert.match(css, /@container \(max-width: 420px\)[^}]*\.question-actions \.ui-btn/s);
  assert.match(css, /\.scrim\.settings-scrim > \.settings-shell\s*\{[^}]*border-radius:\s*0/s,
    "the full-screen settings geometry wins over user-selectable sheet rounding");
});

test("project picking and destructive confirmations use shared controls", async () => {
  const [projectPicker, alertDialog, css] = await Promise.all([
    read("../src/components/ProjectFolderDialog.tsx"),
    read("../src/components/AlertDialog.tsx"),
    readWebStyles(),
  ]);

  assert.match(projectPicker, /<IconButton icon=\{CloseIcon\}/);
  assert.match(projectPicker, /<TextInput[\s\S]*?className="folder-path mono"/);
  assert.match(projectPicker, /<Switch[\s\S]*?checked=\{hidden\}/);
  assert.match(projectPicker, /<Button[\s\S]*?variant="primary"[\s\S]*?className="folder-open-btn"/);
  assert.doesNotMatch(projectPicker, /className="(?:icon-btn|small-btn|primary-btn)/);
  assert.match(alertDialog, /import \{ Button, Dialog, TextInput \} from "\.\/ui\/index\.ts"/);
  assert.match(alertDialog, /variant=\{alert\.kind === "confirm" && alert\.destructive \? "danger" : "primary"\}/);
  assert.doesNotMatch(alertDialog, /<(?:button|input)\b/);
  assert.doesNotMatch(css, /\.alert-dialog-actions/);
});

test("secondary core dialogs and utility actions use shared primitives", async () => {
  const sources = await Promise.all([
    "../src/components/AgentProfileForm.tsx",
    "../src/components/ComposerAddMenu.tsx",
    "../src/components/ComposerFocusDialog.tsx",
    "../src/components/ImportSessionsDialog.tsx",
    "../src/components/ProjectAppearanceDialog.tsx",
    "../src/components/WorktreeSessionDialog.tsx",
    "../src/components/EmptyState.tsx",
    "../src/components/CopyButton.tsx",
  ].map(read));

  for (const source of sources) {
    assert.doesNotMatch(source, /className="(?:primary-btn|small-btn|danger-btn|icon-btn)(?:\s|")/);
  }
  for (const source of sources.slice(0, 6)) {
    assert.match(source, /Dialog/);
    assert.doesNotMatch(source, /import Dialog from "\.\/a11y\/Dialog\.tsx"/);
  }
  assert.match(sources[3]!, /<Checkbox/);
  assert.match(sources[6]!, /<Button variant="primary"/);
  assert.match(sources[7]!, /<IconButton/);
});

test("workspace fallbacks use shared actions and resize focus targets current controls", async () => {
  const [workspaceHost, errorBoundary, header, css] = await Promise.all([
    read("../src/components/workspace/WorkspaceHost.ts"),
    read("../src/components/ViewErrorBoundary.ts"),
    read("../src/components/Header.tsx"),
    readWebStyles(),
  ]);

  assert.match(workspaceHost, /import \{ buttonClassName \} from "\.\.\/ui\/buttonClassName\.ts"/);
  assert.match(workspaceHost, /className: buttonClassName\(\{ variant: "primary"/);
  assert.doesNotMatch(workspaceHost, /primary-btn/);
  assert.match(errorBoundary, /import \{ buttonClassName \} from "\.\/ui\/buttonClassName\.ts"/);
  assert.match(errorBoundary, /className: buttonClassName\(\{ variant: "primary" \}\)/);
  assert.doesNotMatch(errorBoundary, /primary-btn/);
  assert.match(header, /q\("\.sidebar \.sidebar-expand"\) \?\? q\("\.sidebar \.sidebar-search input"\)/);
  assert.match(header, /prev\.closest\("\.sidebar"\)\) target = q\("\.header-drawer-btn"\)/);
  assert.match(header, /document\.activeElement !== target && typeof requestAnimationFrame === "function"/);
  assert.doesNotMatch(header, /\.side-icons \.icon-btn/);
  assert.match(css, /\.hero-open-project\s*\{\s*margin-top:\s*var\(--space-4\);\s*\}/);
});
