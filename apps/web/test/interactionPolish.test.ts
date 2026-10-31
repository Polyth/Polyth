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
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.pane-tab-group\.active > \.reorder-controls\s*\{\s*display:\s*inline-flex/);
  assert.match(css, /@media \(any-pointer: coarse\)[\s\S]*?\.pane-tab-group\.active > \.reorder-controls\s*\{\s*display:\s*none/);
});

test("terminal tabs omit rename chrome; other double-click shortcuts have mobile alternatives", async () => {
  const [terminal, sessions, sidebar, folder] = await Promise.all([
    read("../../../packages/terminal/widgets/TerminalView.tsx"),
    read("../src/components/sidebar/SessionList.tsx"),
    read("../src/components/Sidebar.tsx"),
    read("../src/components/ProjectFolderDialog.tsx"),
  ]);

  assert.match(terminal, /onDoubleClick=\{\(\) => startRename\(t\)\}/);
  assert.doesNotMatch(terminal, /className="term-tab-rename-action"/);
  // Double-click renames only for people who may manage the chat.
  assert.match(sessions, /onDoubleClick=\{\(\) => \{ if \(manage && !selectMode\) \{ setTitle/);
  // The rename shortcut's touch alternative is the row menu (long-press,
  // context menu, or the ellipsis on the active/open row). Rename is the
  // first entry of the row's ui/Menu.
  assert.match(sessions, /className="session-menu-trigger"/);
  assert.match(sessions, /id: "rename", label: tr\("common\.rename"\)/);
  assert.match(sidebar, /onDoubleClick=\{\(\) => \{ setRenamingProject/);
  assert.match(sidebar, /tr\("sidebar\.renameProject"\)/);
  assert.match(folder, /matchMedia\?\.\("\(pointer: coarse\)"\)/);
  assert.match(folder, /className="folder-row-enter"/);
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
    ".session-worktree-actions",
    ".git-file-actions",
    ".files-row .file-row-actions",
    ".session-folder-del",
  ]) {
    assert.ok(coarse.includes(selector), `${selector} is visible to coarse pointers`);
  }
});

test("tablet rest state does not paint Shift/hover edit chrome on every item", async () => {
  const css = await readWebStyles();
  assert.doesNotMatch(
    css,
    /@media \(any-pointer: coarse\) \{[\s\S]{0,800}?\.msg-actions \{ opacity:\s*1/,
    "message hover actions are not forced onto every hybrid-tablet row",
  );
  assert.doesNotMatch(
    css,
    /@media \(any-pointer: coarse\) \{[\s\S]{0,1200}?\.session-worktree-actions,[\s\S]{0,80}?opacity:\s*1/,
    "worktree and folder edit buttons are not forced onto every group",
  );
  assert.doesNotMatch(
    css,
    /@media \(any-pointer: coarse\), \(max-width: 960px\) \{\s*\.session-row\.active \.session-menu-trigger/,
    "session ⋯ is not persistent on every hybrid-tablet row including active",
  );
  assert.match(
    css,
    /@media \(any-pointer: coarse\), \(max-width: 960px\) \{[\s\S]*?\.session-row\.menu-open \.session-menu-trigger/,
    "an open row menu still exposes its trigger",
  );
  assert.match(
    css,
    /@media \(any-pointer: coarse\) and \(min-width: 481px\) \{\s*\.msg-actions \{ display:\s*none;/,
    "tablet messages use the overflow entry instead of an always-on hover strip",
  );
  assert.match(
    css,
    /@media \(any-pointer: coarse\) \{[\s\S]*?\.project-actions,[\s\S]*?opacity:\s*0/,
    "project row actions hide in rest on touch-capable screens",
  );
  assert.match(
    css,
    /@media \(any-pointer: coarse\) \{[\s\S]*?\.sidebar-focused-project > \.project-card-shell \.project-actions,\s*\.project-actions:has\(button\[aria-expanded="true"\]\) \{\s*opacity:\s*1;\s*pointer-events:\s*auto;/,
    "the focused project keeps a tap route to its menu on touch tablets",
  );
  assert.match(
    css,
    /@media \(hover: hover\) and \(pointer: fine\) \{\s*\.session-worktree-head:hover \.session-worktree-actions/,
    "worktree actions reveal only on mouse-only hover",
  );
});

// A tap leaves a sticky :hover on iOS. The coarse-pointer hide block sits at
// equal specificity later in the sheet, so without a phone-scoped restatement
// it faded the always-available phone quick actions to nothing and took their
// taps away right after the message was touched.
test("phone quick actions keep their contrast and taps after a touch", async () => {
  const css = await readWebStyles();
  // The phone contract: the row is always in flow and visible.
  assert.match(
    css,
    /Phone quick actions are immediately available[\s\S]*?\.focus-conversation \.msg \.msg-actions \{[\s\S]*?display:\s*flex;[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/,
    "the phone keeps its always-available quick-action row",
  );
  // The coarse-pointer block that hides hover chrome must restate the phone
  // contract after itself, or a sticky tap-hover fades the row and eats taps.
  const hide = css.lastIndexOf(".msg-meta:focus-within .msg-actions, .msg-actions:focus-within{");
  const restore = css.lastIndexOf(".focus-conversation .msg > .msg-meta:hover .msg-actions,");
  assert.ok(hide > 0 && restore > hide, "the phone restore comes after the coarse-pointer hide");
  assert.match(
    css.slice(restore),
    /^[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/,
    "the restore returns full contrast and taps",
  );
});

// The dock rule derives the tail clearance from the shared message/group gaps.
// It is the last word for the wider shells, but the phone authored a smaller
// 24px clearance; re-deriving it there over-reserved the runway and made the
// bottom mask ramp the transcript out too early. The fresh-turn runway the
// Timeline publishes must still add on top, or a new answer loses its reserve.
test("the phone keeps its own transcript tail clearance", async () => {
  const css = await readWebStyles();
  const dockRule = css.lastIndexOf("  --timeline-pad-bottom: calc(var(--conversation-message-gap) + var(--conversation-group-gap) + var(--timeline-turn-sheet-space, 0px));");
  const phoneRule = css.lastIndexOf("    --timeline-pad-bottom: calc(24px + var(--timeline-turn-sheet-space, 0px));\n    scroll-padding-bottom: 24px;");
  assert.ok(dockRule > 0 && phoneRule > dockRule, "the phone tail clearance is stated after the shared dock rule");
  assert.match(
    css.slice(Math.max(0, phoneRule - 260), phoneRule + 80),
    /@media \(max-width: 480px\), \(max-height: 480px\) and \(pointer: coarse\)[\s\S]*?\.focus-conversation:has\(> \.conversation-composer-dock\) \.timeline/,
    "the phone override keeps the dock rule's specificity",
  );
});

test("shared selects render the chosen value once and use field styling", async () => {
  const [select, picker, css] = await Promise.all([
    read("../src/components/ui/Select.tsx"),
    read("../src/components/Picker.tsx"),
    readWebStyles(),
  ]);

  assert.match(select, /className=\{`picker-select\$\{/);
  assert.match(picker, /<Popover[\s\S]*side=\{_direction === "up" \? "up" : "down"\}/);
  assert.doesNotMatch(picker, /close\(\); emptyAction\.run\(\)/);
  assert.doesNotMatch(picker, /menu-backdrop/);
  assert.match(css, /\.picker-select \.chip-k\s*\{\s*display:\s*none;/);
  assert.match(css, /\.picker-select \.picker-chip\s*\{[\s\S]*?background:\s*var\(--elevated\)/);
  assert.match(css, /\.ui-popover\s*\{[\s\S]*?position:\s*fixed/);
});

test("P1 mobile refinements remain wired to their visible surfaces", async () => {
  const [sessions, sessionDates, sidebarPrefs, sidebar, settings, models, folder, empty, haptics, css] = await Promise.all([
    read("../src/components/sidebar/SessionList.tsx"),
    read("../src/sessionDates.ts"),
    read("../src/sidebarPrefs.ts"),
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
  assert.match(sessions, /sessionGroupsOf\(arrangeSessions\(/, "the session list draws one heading per group of its arrangement");
  assert.match(sidebarPrefs, /id: "date",[\s\S]*?sessionDateGroupLabel\(/, "session recency is shown once per date group");
  assert.match(sessionDates, /new Intl\.RelativeTimeFormat\(locale, \{ numeric: "auto" \}\)/,
    "recent date dividers use localized relative labels before calendar dates");
  assert.match(sidebar, /className=\{`pull-refresh/, "the project/session picker supports pull-to-refresh");
  assert.match(settings, /useEdgeSwipeBack\(\{[\s\S]*?under: settingsNav/,
    "a settings page goes Back with a swipe that follows the finger, the list peeking in");
  assert.match(settings, /attachSwipeSurface\(\{[\s\S]*?direction: origin === "start" \? "toward-start" : "toward-end"/,
    "Settings is dismissed by a swipe toward the edge it came from");
  assert.match(models, /className="model-row-provider-logo"/, "mobile model rows identify providers");
  assert.match(models, /onBack=\{closeDetails\}\s*focusBack=\{phone\}/,
    "phone model details move focus to their back control");
  assert.match(folder, /className="folder-path mono"/, "the full-screen project picker keeps search/path entry");
  assert.match(empty, /aria-busy=\{busy \|\| undefined\}/, "settings empty states distinguish loading");
  assert.match(haptics, /navigator\.vibrate\(PATTERNS\[kind\]\)/, "key touch outcomes use bounded native haptics");
  assert.match(css, /\* \{ scrollbar-width: thin; scrollbar-color: var\(--border\) transparent; \}/,
    "long mobile surfaces share scroll affordances");
  assert.match(css, /\.session-row\[data-swipe="revealed"\] \.session-quick > \.session-quick-btn\s*\{[\s\S]*?width:\s*var\(--tap\)/,
    "swiping reveals the named archive/delete pair at full touch size");
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.settings-shell\[data-stage-motion="push"\] > \.settings-pane\s*\{\s*animation:\s*stack-in var\(--motion-stack\)/,
    "full-screen settings stages push and pop with the phone stack grammar");
  assert.match(css, /\.composer-actions :is\([\s\S]*?\.composer-add-files,[\s\S]*?\)\s*\{[\s\S]*?width:\s*var\(--tap\)/,
    "composer attachments retain a 44px touch box");
});

test("agent questions use shared controls and complete tab semantics", async () => {
  const [questions, css] = await Promise.all([
    read("../src/components/QuestionCards.tsx"),
    readWebStyles(),
  ]);

  assert.match(questions, /<IconButton[\s\S]*?icon=\{MarkdownIcon\}/);
  assert.match(questions, /<Button[\s\S]*?variant="primary"/);
  assert.match(questions, /<Button[\s\S]*?variant="ghost"[\s\S]*?className="question-reject"/,
    "declining is a quiet action, not a red button competing with Submit");
  assert.match(questions, /const groupName = useId\(\)/);
  assert.match(questions, /name=\{groupName\}/, "radio names are scoped per rendered question");
  assert.match(questions, /aria-controls=\{`\$\{id\}-panel`\}/);
  assert.match(questions, /event\.key === "ArrowRight"/);
  assert.match(questions, /tabIndex=\{i === step \? 0 : -1\}/);
  assert.match(css, /\.question-card\s*\{[^}]*container-type:\s*inline-size[^}]*border-radius:\s*var\(--radius-card\)/s);
  assert.match(css, /@container \(max-width: 420px\)[\s\S]*?\.question-actions-end > \.ui-btn:last-child\s*\{[^}]*flex:\s*1 1 auto/);
  assert.match(css, /\.question-actions\s*\{[^}]*position:\s*sticky[^}]*inset-block-end:\s*0/s,
    "the decision row stays reachable while a tall question scrolls with the chat");
  assert.doesNotMatch(css, /\.question-cards\b/, "no separate, height-capped question dock");
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
  assert.match(projectPicker, /kind: "switch", checked: hidden/);
  assert.match(projectPicker, /<Button[\s\S]*?variant="primary"[\s\S]*?className="folder-open-btn"/);
  assert.doesNotMatch(projectPicker, /className="(?:icon-btn|small-btn|primary-btn)/);
  assert.match(alertDialog, /import \{ Button, Dialog, TextInput \} from "\.\/ui\/index\.ts"/);
  assert.match(alertDialog, /variant=\{alert\.kind === "confirm" && alert\.destructive \? "danger" : "primary"\}/);
  assert.doesNotMatch(alertDialog, /<(?:button|input)\b/);
  assert.doesNotMatch(css, /\.alert-dialog-actions/);
});

test("secondary core dialogs and utility actions use shared primitives", async () => {
  const sources = await Promise.all([
    "../src/components/ComposerFocusDialog.tsx",
    "../src/components/ProjectAppearanceDialog.tsx",
    "../src/components/WorktreeSessionDialog.tsx",
    "../src/components/EmptyState.tsx",
    "../src/components/CopyButton.tsx",
  ].map(read));

  for (const source of sources) {
    assert.doesNotMatch(source, /className="(?:primary-btn|small-btn|danger-btn|icon-btn)(?:\s|")/);
  }
  for (const source of sources.slice(0, 3)) {
    assert.match(source, /Dialog/);
    assert.doesNotMatch(source, /import Dialog from "\.\/a11y\/Dialog\.tsx"/);
  }
  assert.match(sources[3]!, /<Button variant="primary"/);
  assert.match(sources[4]!, /<IconButton/);
});

test("workspace fallbacks use shared actions and resize focus targets current controls", async () => {
  const [workspaceHost, projectEmpty, errorBoundary, header, css] = await Promise.all([
    read("../src/components/workspace/WorkspaceHost.ts"),
    read("../src/components/workspace/ProjectEmptyState.ts"),
    read("../src/components/ViewErrorBoundary.ts"),
    read("../src/components/Header.tsx"),
    readWebStyles(),
  ]);

  assert.match(workspaceHost, /import ProjectEmptyState from "\.\/ProjectEmptyState\.ts"/);
  assert.match(projectEmpty, /import \{ buttonClassName \} from "\.\.\/ui\/buttonClassName\.ts"/);
  assert.match(projectEmpty, /className: buttonClassName\(\{ variant: "primary"/);
  assert.doesNotMatch(projectEmpty, /primary-btn/);
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
