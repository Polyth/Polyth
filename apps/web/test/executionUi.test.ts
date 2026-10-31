import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import type { JsonObject } from "@polyth/contracts";
import { Window } from "happy-dom";
import {
  classifyTool,
  cleanShellCommand,
  compactUrl,
  executionGroupLabel,
  executionPathParts,
  executionPresentation,
  isImagePath,
  middleTruncatePath,
  normalizedInputEntries,
  readFragment,
  reasoningContinuation,
  reasoningHead,
  reasoningPreview,
  reasoningTail,
} from "../src/execution.ts";
import { mcpResultBodies, mcpResultValue } from "../src/toolCallView.ts";
import type { TaskActivityMsg, ToolMsg } from "../src/reduce.ts";
import { api } from "@polyth/session/web-api";
import { en } from "../src/i18n/locales/en.ts";

const tool = (patch: Partial<ToolMsg> = {}): ToolMsg => ({
  kind: "tool",
  id: "call-1",
  callId: "call-1",
  eventSeq: 1,
  tool: "bash",
  input: { command: "cd /workspace && git diff -- apps/web/src/components/Timeline.tsx" },
  output: "clean",
  metadata: { exit: 0, cwd: "/workspace" },
  status: "done",
  time: 1_000,
  finishTime: 1_420,
  ...patch,
});

test("file summaries keep the filename primary and make project paths relative", () => {
  assert.deepEqual(
    executionPathParts("/workspace/apps/web/src/Timeline.tsx", "/workspace"),
    { filename: "Timeline.tsx", directory: "apps/web/src", relativePath: "apps/web/src/Timeline.tsx" },
  );
  assert.deepEqual(
    executionPathParts("src/components/Composer.tsx", "/workspace"),
    { filename: "Composer.tsx", directory: "src/components", relativePath: "src/components/Composer.tsx" },
  );
});

test("read output is stripped back to source and its real starting line", () => {
  assert.deepEqual(
    readFragment("<file>\n00012| const a = 1;\n00013| const b = 2;\n</file>"),
    { code: "const a = 1;\nconst b = 2;", startLine: 12 },
  );
  assert.deepEqual(
    readFragment("     1→export function x() {\n     2→  return 1;\n\n(File has more lines)"),
    { code: "export function x() {\n  return 1;", startLine: 1 },
  );
  // Prose that merely contains numbers is not a numbered read.
  assert.deepEqual(readFragment("all good\nno changes"), { code: "all good\nno changes", startLine: 1 });
  assert.ok(isImagePath("docs/shot.PNG") && !isImagePath("icon.svg") && !isImagePath("a.ts"));
});

test("shell previews remove setup noise and keep raw commands in details only", () => {
  assert.equal(cleanShellCommand("cd /workspace && git status --short"), "git status --short");
  assert.equal(
    cleanShellCommand("cd /workspace && export NODE_ENV=test && env CI=1 npm run test"),
    "npm run test",
  );
  assert.equal(
    cleanShellCommand("FOO=bar node /workspace/apps/web/src/components/a/very/long/directory/ExecutionRow.tsx"),
    "node /workspace/apps/web/src/…/ExecutionRow.tsx",
  );
  assert.equal(
    executionPresentation(tool()).preview,
    "Review changes",
  );
  assert.equal(executionPresentation(tool()).kind, "git");
  assert.equal(executionPresentation(tool({ input: { command: "command -v chromium || true" } })).preview, "Check command availability");
});

test("browser helper and native tools show actions without IDs or typed values", () => {
  const helper = "node ~/.config/opencode/skills/polyth-browser/scripts/polyth-browser.mjs";
  const cases = [
    ["open proj-1 https://example.com?token=private chat-1", "Open page · example.com"],
    ["navigate browser-1 https://example.com/help", "Go to · example.com/help"],
    ["snapshot browser-1", "Read page"],
    ["snapshot browser-1 '#main'", "Read page · #main"],
    ["click browser-1 'a[href*=\"iana.org\"]'", 'Click · a[href*="iana.org"]'],
    ["type browser-1 '#search' 'private typed value' submit", "Type · #search"],
    ["scroll browser-1 down", "Scroll · down"],
    ["capture browser-1 /tmp/page.png", "Screenshot"],
    ["close browser-1", "Close page"],
    ["capability", "Check browser capability"],
    ["projects", "List projects"],
    ["sessions proj-1", "List browser sessions"],
  ];
  for (const [args, expected] of cases) {
    const command = `${helper} ${args}`;
    const presentation = executionPresentation(tool({ input: { command } }));
    assert.equal(presentation.kind, "browser", args);
    assert.equal(presentation.label, "Browser", args);
    assert.equal(presentation.preview, expected, args);
    assert.equal(presentation.command, command, "keep original command in details");
  }
  const compound = `${helper} click browser-1 '#more' && ${helper} snapshot browser-1`;
  assert.equal(executionPresentation(tool({ input: { command: compound } })).preview, "Click · #more; Read page");
  assert.equal(executionPresentation(tool({ input: { command: `/bin/bash -lc '${helper} snapshot browser-1'` } })).preview, "Read page");
  assert.equal(executionPresentation(tool({ input: { command: `POLYTH_URL=http://localhost:4400 ${helper} snapshot browser-1` } })).preview, "Read page");
  for (const command of [
    `echo ${helper} snapshot browser-1`,
    "node unrelated-polyth-browser.mjs snapshot browser-1",
    `${helper} snapshot browser-1 && node other.mjs`,
    `${helper} unknown browser-1`,
  ]) assert.notEqual(classifyTool("bash", { command }), "browser", command);

  for (const name of ["polyth-agent-tools_polyth_browser", "mcp__polyth-agent-tools__polyth_browser", "mcp__browser__open", "browser.open"]) {
    const presentation = executionPresentation(tool({
      tool: name, input: { action: "browser.open", parameters: { url: "https://example.com?private=value" } },
    }));
    assert.equal(presentation.kind, "browser", name);
    assert.equal(presentation.preview, "Open page · example.com", name);
  }
  assert.equal(executionPresentation(tool({
    tool: "polyth_browser", input: { action: "browser.type", parameters: { selector: "#search", value: "private typed value" } },
  })).preview, "Type · #search");
});

test("shell-backed repository inspection is presented by semantic action", () => {
  const searchTool = tool({
    input: { command: "/bin/bash -lc 'rg -n -C 12 -S \"harnessTransition\" packages/server/test/harnessSwitch.test.ts'" },
  });
  const search = executionPresentation(searchTool);
  assert.equal(search.kind, "search");
  assert.equal(search.label, "Search");
  assert.equal(search.preview, "“harnessTransition” · …/harnessSwitch.test.ts");

  const readTool = tool({
    input: { command: "/bin/bash -lc \"sed -n '1,185p' packages/server/test/harnessSwitch.test.ts\"" },
  });
  const read = executionPresentation(readTool);
  assert.equal(read.kind, "read");
  assert.equal(read.label, "Read");
  assert.equal(read.preview, "packages/server/test/harnessSwitch.test.ts · L1–185");

  assert.equal(executionPresentation(tool({ input: { command: "sed -i 's/a/b/' file.ts" } })).kind, "shell");
  assert.equal(executionGroupLabel([searchTool, readTool]), "Repository inspection");

  const compound = executionPresentation(tool({
    input: { command: "/bin/bash -lc \"printf '%s\\\\n' '--- files ---'; rg --files -g '!!!node_modules!!!' | sed -n '1,20p'\"" },
  }));
  assert.equal(compound.kind, "search");
  assert.equal(compound.label, "Search");
  assert.equal(compound.preview, "Workspace files");

  const inventory = executionPresentation(tool({
    input: { command: "/bin/bash -lc \"printf '%s\\\\n' '--- repo top ---'; find ../polyth -maxdepth 2 -type d -print | sort\"" },
  }));
  assert.equal(inventory.kind, "search");
  assert.equal(inventory.label, "Search");
  assert.equal(inventory.preview, "Workspace items · ../polyth");
  assert.equal(executionPresentation(tool({ input: { command: "find . -exec rm {} \\;" } })).kind, "shell");

  const acpSearch = executionPresentation(tool({
    tool: "search",
    input: { pattern: "ExecutionRow", path: "apps/web/src" },
    output: "apps/web/src/components/ExecutionRow.tsx:42:export default ExecutionRow;",
  }));
  assert.equal(acpSearch.kind, "search");
  assert.match(acpSearch.preview, /ExecutionRow/);
  assert.match(acpSearch.preview, /1 match/);

  const acpRead = executionPresentation(tool({
    tool: "read",
    input: { path: "apps/web/src/execution.ts", offset: 12 },
    output: "export function executionPresentation() {}",
  }));
  assert.equal(acpRead.kind, "read");
  assert.equal(acpRead.path, "apps/web/src/execution.ts");
  assert.match(acpRead.preview, /execution\.ts/);
});

test("shell-backed tests use human summaries across harness command shapes", () => {
  const direct = executionPresentation(tool({
    input: { command: "node --experimental-strip-types --test --test-name-pattern=\"Files keeps its draft\" apps/web/test/responsiveOverlays.test.ts" },
  }));
  assert.equal(direct.kind, "test");
  assert.equal(direct.preview, "apps/web/test/responsiveOverlays.test.ts · “Files keeps its draft”");

  const build = executionPresentation(tool({ input: { command: "npm run build:web" } }));
  assert.equal(build.kind, "test");
  assert.equal(build.preview, "Build web");

  const whitespace = executionPresentation(tool({ input: { command: "git diff --check" } }));
  assert.equal(whitespace.kind, "git");
  assert.equal(whitespace.preview, "Check diff whitespace");
});

test("file, URL, edit, search, MCP, and subagent previews are semantic", () => {
  assert.equal(
    middleTruncatePath("apps/web/src/components/workspace/very/deep/Composer.tsx", 38),
    "apps/web/src/…/Composer.tsx",
  );
  assert.equal(
    compactUrl("https://github.com/acme/polyth/pull/2693?tab=files"),
    "github.com/acme/polyth/pull/2693",
  );
  const edit = executionPresentation(tool({
    tool: "edit",
    input: { filePath: "apps/web/src/components/Composer.tsx", oldString: "one\ntwo", newString: "one\nthree\nfour" },
  }));
  assert.equal(edit.label, "Edit");
  assert.equal(edit.preview, "apps/web/src/components/Composer.tsx");
  assert.deepEqual(edit.stats, { add: 2, del: 1 });
  assert.equal(edit.files?.length, 1);
  assert.match(edit.diff ?? "", /@@ -1,2 \+1,3 @@/);
  assert.match(edit.diff ?? "", /\n one\n-two\n\+three\n\+four/);
  const create = executionPresentation(tool({
    tool: "create",
    input: { filePath: "apps/web/src/new.ts", content: "one\ntwo" },
  }));
  assert.equal(create.preview, "apps/web/src/new.ts");
  assert.deepEqual(create.stats, { add: 2, del: 0 });
  assert.equal(create.files?.[0]?.status, "added");
  const write = executionPresentation(tool({
    tool: "write",
    input: { filePath: "apps/web/src/new.ts", newString: "one\ntwo" },
  }));
  assert.equal(write.preview, "apps/web/src/new.ts");
  assert.deepEqual(write.stats, { add: 2, del: 0 });

  const patch = executionPresentation(tool({
    tool: "apply_patch",
    input: {
      patchText: [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-old",
        "+new",
        "*** Add File: src/b.ts",
        "+hello",
        "*** End Patch",
      ].join("\n"),
    },
  }));
  assert.equal(patch.preview, "2 files");
  assert.deepEqual(patch.stats, { add: 2, del: 1 });
  assert.equal(patch.files?.length, 2);
  assert.equal(patch.files?.[0]?.path, "src/a.ts");
  assert.equal(patch.files?.[1]?.path, "src/b.ts");
  assert.equal(patch.files?.[1]?.status, "added");

  const multi = executionPresentation(tool({
    tool: "multiedit",
    input: {
      filePath: "src/app.ts",
      edits: [
        { oldString: "alpha", newString: "beta" },
        { old_string: "one", new_string: "two" },
      ],
    },
  }));
  assert.equal(multi.preview, "src/app.ts");
  assert.deepEqual(multi.stats, { add: 2, del: 2 });

  const piEdit = executionPresentation(tool({
    tool: "edit",
    input: {
      path: "src/pi.ts",
      edits: [{ oldText: "one\ntwo", newText: "one\nthree\nfour" }],
    },
  }));
  assert.equal(piEdit.kind, "edit");
  assert.equal(piEdit.preview, "src/pi.ts");
  assert.deepEqual(piEdit.stats, { add: 2, del: 1 });
  assert.equal(piEdit.files?.length, 1);

  const antigravityEdit = executionPresentation(tool({
    tool: "replace_file_content",
    input: {
      TargetFile: "/repo/src/agy.ts",
      TargetContent: "const value = 1;",
      ReplacementContent: "const value = 2;",
    },
  }));
  assert.equal(antigravityEdit.kind, "edit");
  assert.equal(antigravityEdit.preview, "/repo/src/agy.ts");
  assert.deepEqual(antigravityEdit.stats, { add: 1, del: 1 });
  assert.equal(antigravityEdit.files?.[0]?.path, "/repo/src/agy.ts");

  const antigravityWrite = executionPresentation(tool({
    tool: "write_to_file",
    input: { TargetFile: "/repo/src/new.ts", CodeContent: "export const created = true;\n" },
  }));
  assert.equal(antigravityWrite.kind, "write");
  assert.deepEqual(antigravityWrite.stats, { add: 1, del: 0 });
  assert.equal(antigravityWrite.files?.[0]?.status, "added");

  const antigravityDiffOutput = executionPresentation(tool({
    tool: "replace_file_content",
    input: { TargetFile: "/repo/src/agy.ts" },
    output: [
      "The following changes were made by the replace_file_content tool to: /repo/src/agy.ts.",
      "[diff_block_start]",
      "@@ -1 +1 @@",
      "-const value = 1;",
      "+const value = 2;",
      "[diff_block_end]",
    ].join("\n"),
  }));
  assert.equal(antigravityDiffOutput.files?.[0]?.path, "/repo/src/agy.ts");
  assert.deepEqual(antigravityDiffOutput.stats, { add: 1, del: 1 });
  assert.doesNotMatch(antigravityDiffOutput.files?.[0]?.diff ?? "", /The following changes/);

  const sedEdit = executionPresentation(tool({
    tool: "sed_file",
    input: { TargetFile: "/repo/src/sed.ts", TargetContent: "a", ReplacementContent: "b" },
  }));
  assert.equal(sedEdit.kind, "edit");

  const search = executionPresentation(tool({
    tool: "grep",
    input: { pattern: "visualViewport" },
    output: "a.ts:1\nb.ts:2\nc.ts:3",
  }));
  assert.equal(search.preview, '"visualViewport" · 3 matches');

  const mcp = executionPresentation(tool({
    tool: "mcp__github__get_pull_request",
    input: { description: "Read pull request #2693", owner: "otto-assistant", repo: "polyth" },
  }));
  assert.equal(mcp.label, "GitHub");
  assert.equal(mcp.preview, "Read pull request #2693");

  const subagent = executionPresentation(tool({
    tool: "task",
    input: { description: "Review mobile UX implementation", subagent_type: "general" },
  }));
  assert.equal(subagent.label, "Subagent");
  assert.equal(subagent.preview, "Review mobile UX implementation");

  const canonicalSpawn = executionPresentation(tool({
    tool: "mcp__polyth-agent-tools__polyth",
    input: {
      action: "agent.spawn",
      parameters: { title: "Responsive UI reviewer", prompt: "Audit the tablet layout." },
    },
    output: JSON.stringify({ session: { id: "child-1", title: "Responsive UI reviewer" } }),
    metadata: { childSessionId: "child-1", childTitle: "Responsive UI reviewer" },
  }));
  assert.equal(canonicalSpawn.kind, "subagent");
  assert.equal(canonicalSpawn.label, "Subagent");
  assert.equal(canonicalSpawn.preview, "Responsive UI reviewer");

  const packageTool = executionPresentation(tool({
    tool: "polyth-agent-tools_personal-coach_coach-propose-goal-af6bc22515351df5",
    input: { title: "Build strength" },
  }));
  assert.equal(packageTool.kind, "mcp");
  assert.equal(packageTool.label, "Coach propose goal");
  assert.equal(packageTool.preview, "Personal coach");
  assert.equal(classifyTool(
    "mcp__polyth-agent-tools__personal-coach_coach-propose-goal-af6bc22515351df5",
    {},
  ), "mcp");
});

test("normalized details hide bulky payloads until level three", () => {
  assert.deepEqual(normalizedInputEntries({
    command: "rm -rf build",
    content: "thousands of characters",
    cwd: "/workspace",
    timeout: 30_000,
  }), [
    { key: "cwd", value: "/workspace" },
    { key: "timeout", value: "30000" },
  ]);
});

test("MCP results expose human fields and lists without rendering inline JSON", () => {
  assert.deepEqual(mcpResultBodies(mcpResultValue(JSON.stringify({
    data: {
      title: "Fix execution UI",
      status: "open",
      number: 42,
      html_url: "https://github.com/acme/polyth/pull/42",
      author: { login: "octocat" },
      updatedAt: "2026-10-08",
    },
  }))), [{
    kind: "fields",
    fields: [
      { label: "Title", value: "Fix execution UI" },
      { label: "Status", value: "Open" },
      { label: "Number", value: "42" },
      {
        label: "Html url",
        value: "https://github.com/acme/polyth/pull/42",
        href: "https://github.com/acme/polyth/pull/42",
      },
      { label: "Author", value: "octocat" },
    ],
  }]);
  assert.deepEqual(mcpResultBodies(mcpResultValue(JSON.stringify([
    { type: "text", text: JSON.stringify([
      { title: "Fix execution UI", html_url: "https://github.com/polyth/pull/42", state: "open" },
      { name: "Responsive polish", url: "https://linear.app/polyth/issue/UX-7" },
    ]) },
  ]))), [{
    kind: "list",
    label: "Results",
    total: 2,
    items: [
      { title: "Fix execution UI", href: "https://github.com/polyth/pull/42", meta: "Open" },
      { title: "Responsive polish", href: "https://linear.app/polyth/issue/UX-7", meta: "linear.app" },
    ],
  }]);
});

test("groups get semantic labels and streaming thinking previews the newest thought", () => {
  assert.equal(executionGroupLabel([
    tool({ tool: "read", input: { path: "a.ts" } }),
    tool({ tool: "grep", input: { pattern: "x" } }),
  ]), "Repository inspection");
  // The live tail is the last non-empty line, stripped of markdown markers.
  assert.equal(
    reasoningTail("Found the event reducer.\n\n## Next step\n\n- Updating the *compact* execution rows now.\n\n"),
    "Updating the compact execution rows now.",
  );
  assert.equal(reasoningTail(""), "");
  assert.equal(reasoningTail("\n\n  \n"), "");
  // Very long lines stay bounded for the one-line summary slot.
  const long = reasoningTail(`start\n${"reasoning ".repeat(40)}end`);
  assert.ok(long.length <= 111, `tail stays bounded, got ${long.length}`);
  assert.ok(long.endsWith("…"));
  // The settled preview is the first non-empty line, same stripping.
  assert.equal(
    reasoningHead("\n\n## Plan\n\n- Found the event reducer.\n"),
    "Plan",
  );
  assert.equal(reasoningHead(""), "");
  assert.equal(reasoningHead("  \n\n"), "");
  assert.equal(reasoningPreview("## Plan\n\n- Inspect the reducer\n- Update the row"), "Plan\nInspect the reducer");
  assert.equal(reasoningPreview("Short thought"), "Short thought");
  const shortLongLine = "x".repeat(200);
  assert.equal(reasoningPreview(shortLongLine, false, 0), shortLongLine);
  assert.equal(reasoningPreview("one\ntwo\nthree", true), "two\nthree");
  assert.equal(reasoningContinuation("## Plan\n\n- Inspect the reducer\n- Update the row\n- Verify the row"), "- Update the row\n- Verify the row");
  assert.equal(reasoningContinuation("Short thought"), "");
  assert.equal(reasoningContinuation("one\ntwo"), "");
});

test("execution code surfaces override the global prose font preference", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const override = css.match(/html\[data-font\] body :is\([\s\S]*?execution-viewer > pre[\s\S]*?\)\s*\{\s*font-family:\s*var\(--mono\);\s*\}/);
  assert.ok(override, "commands, output, diffs, and the full viewer retain the monospace font");
  assert.match(css, /\.activity-group-expand-shell,\s*\.task-list-expand-shell\s*\{[\s\S]*?width:\s*100%;[\s\S]*?align-self:\s*stretch;/,
    "activity details stretch with the chat column instead of using content width");
  assert.match(css, /\.execution-details \.git-diff\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*auto;/);
  assert.match(css, /\.execution-diff-stat-slot\s*\{/);
  const rowSource = await readFile(new URL("../src/components/ExecutionRow.tsx", import.meta.url), "utf8");
  assert.match(rowSource, /reverted \? tr\("execution\.redo"\) : tr\("execution\.revertChanges"\)/);
  assert.equal(en["execution.redo"], "Redo");
  assert.equal(en["execution.revertChanges"], "Revert changes");
  assert.match(rowSource, /reverted \? RedoIcon : UndoIcon/);
  assert.match(rowSource, /applyUnifiedDiff\(current, file\.diff, direction\)/);
  assert.match(rowSource, /api\.abort\(sessionId, "execution"\)/);
  // The Stop arms on pointerdown (a Send→Stop remount can deliver a bare click).
  assert.match(rowSource, /armPointer: \(\) => \{ stopPointerAt\.current = Date\.now\(\); \}/);
  assert.match(rowSource, /onPointerDown=\{armPointer\}/);
  assert.match(css, /grid-template-rows var\(--motion-normal\)[\s\S]*?opacity var\(--motion-normal\)/);
  assert.match(css, /\.reasoning-preview\s*\{[\s\S]*?-webkit-mask-image:\s*linear-gradient\(to right, #000 90%, transparent 100%\);[\s\S]*?mask-image:\s*linear-gradient\(to right, #000 90%, transparent 100%\);/);
});

test("the inline stop action is a red outline with no fill and a preserved hit area", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = /\.execution-stop\.ui-btn\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /min-height:\s*var\(--control-h-sm\)/);
  assert.match(rule, /padding-inline:\s*var\(--control-pad-x-sm\)/);
  // One of the few contours in the transcript: red ink and outline, no fill.
  assert.match(rule, /background:\s*transparent/);
  assert.match(rule, /border-color:\s*var\(--execution-stop-line\)/);
  assert.match(rule, /--execution-stop-line:\s*color-mix\(in srgb, var\(--red\) 38%, transparent\)/);
  // Borderless appearance clears every border; the Stop outline is kept.
  assert.match(css, /body\[data-hide-borders="true"\] \.execution-stop\.ui-btn \{\s*border-color: var\(--execution-stop-line\) !important;/);
  assert.match(css, /\.execution-stop\.ui-btn::after\s*\{[^}]*var\(--hit-min\)[^}]*var\(--control-h-sm\)/s);
});

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement, Fragment, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ExecutionRow } = await import("../src/components/ExecutionRow.tsx");
const { default: StatusBar } = await import("../src/components/StatusBar.tsx");
const { installStatusbarWidgets } = await import("../src/widgets/statusbarWidgets.tsx");
const { default: Timeline, ActivityGroupView, UserPrompt } = await import("../src/components/Timeline.tsx");
const { getUiSettings, setUiSettings } = await import("../src/uiPrefs.ts");
installStatusbarWidgets();
const { default: SessionWorkspace } = await import("../../../packages/files/widgets/SessionWorkspace.tsx");

/** Build the derived activity projection the timeline hands to the group view. */
const activityGroup = (
  id: string,
  items: Array<ToolMsg | TaskActivityMsg>,
  ms = 420,
) => ({
  kind: "activity" as const,
  id,
  items,
  tools: items.filter((item): item is ToolMsg => item.kind === "tool"),
  tasks: items.filter((item): item is TaskActivityMsg => item.kind === "task"),
  thoughts: [],
  ms,
  settled: !items.some((item) => item.kind === "tool" && (item.status === "pending" || item.status === "running")),
});

/** Full store → reduce → Timeline mount: the reproducer shape behind the
 *  reported bug. Uses the same projection path as the running app. */
let timelineHostSeq = 0;
const timelineHost = () => {
  const sessionId = `activity-status-${++timelineHostSeq}`;
  const { viewport, host } = activityTimelineHost();
  const root = createRoot(host);
  const event = (seq: number, type: string, data: JsonObject, time = seq) => ({
    id: `ev-${sessionId}-${seq}`,
    sessionId,
    seq,
    time,
    type,
    data,
    v: 1 as const,
  });
  return {
    event,
    host,
    async render(events: ReturnType<typeof event>[]) {
      await act(async () => {
        activateProject("activity-status-test");
        setSessions("activity-status-test", [{
          id: sessionId,
          projectId: "activity-status-test",
          title: "Activity status",
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        }]);
        activateSession(sessionId);
        for (const ev of events) applyEvent(ev);
        root.render(createElement(Timeline, { model: reduceSessionModel(sessionId, getState().events[sessionId] ?? []) }));
      });
    },
    async cleanup() {
      await act(async () => {
        activateSession(null);
        setSessions("activity-status-test", []);
      });
      await act(async () => root.unmount());
      viewport.remove();
    },
  };
};
/** Minimal timeline shell for activity ordering and scheduling tests. */
const activityTimelineHost = () => {
  const viewport = document.createElement("div");
  viewport.className = "timeline-viewport";
  const timeline = document.createElement("div");
  timeline.className = "timeline";
  const host = document.createElement("div");
  timeline.appendChild(host);
  viewport.append(timeline);
  document.body.appendChild(viewport);
  return { viewport, timeline, host };
};
const { default: PermissionBanner } = await import("../../../packages/permissions/widgets/PermissionBanner.tsx");
const { AutoApproveAction } = await import("../../../packages/permissions/widgets/index.tsx");
const { loadApprovalDefaults } = await import("../../../packages/permissions/widgets/approvalDefaults.ts");
const { resolveAlert } = await import("../src/alerts.ts");
const {
  activateProject,
  activateSession,
  applyEvent,
  applyEventWithPendingSend,
  applyProjectUpsert,
  endPendingSend,
  getState,
  setEditorFile,
  setRailPlugin,
  setSessions,
  subscribeStore,
  reduceSessionModel,
} = await import("../src/store.ts");
const { reportEditorCursor } = await import("../src/resources/views.ts");

test("browser activity rows expose readable summaries and retain command details", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const command = "node ~/.config/opencode/skills/polyth-browser/scripts/polyth-browser.mjs snapshot browser-1";
  try {
    await act(async () => root.render(createElement(ExecutionRow, { message: tool({ input: { command } }) })));
    assert.equal(container.querySelector(".execution-row")?.getAttribute("data-execution-kind"), "browser");
    assert.equal(container.querySelector(".tool-name")?.textContent, "Browser");
    assert.equal(container.querySelector(".tool-preview")?.textContent, "Read page");
    const disclosure = container.querySelector<HTMLButtonElement>(".execution-summary")!;
    assert.equal(disclosure.getAttribute("aria-label"), "Expand Browser: Read page");
    await act(async () => disclosure.click());
    assert.ok(container.querySelector(".execution-details")?.textContent?.includes("polyth-browser.mjs"));
    assert.ok(container.querySelector('button[aria-label="View execution details"]'), "browser helper commands keep raw details behind the terminal action");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("execution row renders collapsed value first, expands inline, and opens level three on demand", async () => {
  const timeline = document.createElement("div");
  timeline.className = "timeline";
  const container = document.createElement("div");
  timeline.appendChild(container);
  document.body.appendChild(timeline);
  const root = createRoot(container);
  const output = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");
  try {
    await act(async () => root.render(createElement(ExecutionRow, { message: tool({ output }) })));
    const disclosure = container.querySelector<HTMLButtonElement>(".execution-summary");
    assert.ok(disclosure);
    assert.equal(disclosure.getAttribute("aria-expanded"), "false");
    // Historical rows render immediately; the accessible name follows the
    // same human summary while the raw command stays inside the disclosure.
    assert.ok((disclosure.getAttribute("aria-label") ?? "")
      .includes("Expand Git: Review changes"));
    assert.equal(container.querySelector(".execution-details"), null, "raw details do not clutter the collapsed row");

    await act(async () => disclosure.click());
    assert.equal(disclosure.getAttribute("aria-expanded"), "true");
    assert.match(container.querySelector(".execution-command")?.textContent ?? "", /cd \/workspace && git diff/);
    assert.match(container.querySelector(".execution-output")?.textContent ?? "", /line 12/);
    assert.doesNotMatch(container.querySelector(".execution-output")?.textContent ?? "", /line 18/);
    assert.equal(container.querySelectorAll(".execution-terminal").length, 1, "command and output share one terminal");
    assert.equal(container.querySelector(".execution-detail-heading"), null, "the terminal needs no Command or Output headings");
    assert.equal(container.querySelector(".execution-input"), null, "transport options stay out of the transcript");
    assert.equal(container.querySelector(".execution-metadata"), null, "elapsed time and successful exit are not repeated");
    assert.equal(container.querySelector(".execution-terminal-command")?.getAttribute("title"), "/workspace");

    const full = container.querySelector<HTMLButtonElement>('.execution-terminal-footer button[aria-label="Open full output"]');
    assert.ok(full);
    timeline.scrollTop = 640;
    full.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event);
    full.focus();
    timeline.scrollTop = 881;
    const focusFull = full.focus.bind(full);
    full.focus = () => {
      timeline.scrollTop = 881;
      focusFull();
    };
    await act(async () => full.click());
    const viewer = document.body.querySelector<HTMLElement>(".execution-viewer");
    assert.ok(viewer, "large output opens in the explicit level-three viewer");
    assert.ok(viewer.classList.contains("dialog-full"), "viewer uses the shared accessible Dialog primitive");
    assert.equal(document.body.style.overflow, "hidden", "modal locks page scrolling");
    assert.equal(timeline.getAttribute("aria-hidden"), "true", "modal hides background content from assistive technology");
    assert.equal(timeline.hasAttribute("inert"), true, "modal makes background content inert");
    assert.equal(document.activeElement, viewer.querySelector('input[type="search"]'), "search receives initial focus");
    assert.match(viewer.textContent ?? "", /line 18/);
    const close = viewer.querySelector<HTMLButtonElement>(".execution-viewer-close");
    assert.ok(close);
    const lastControl = viewer.querySelector<HTMLButtonElement>(".execution-viewer-tools button");
    assert.ok(lastControl);
    lastControl.focus();
    const tab = new dom.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    lastControl.dispatchEvent(tab as unknown as Event);
    assert.equal(tab.defaultPrevented, true, "Tab is contained by the modal focus trap");
    await act(async () => {
      close.click();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
    assert.equal(document.body.querySelector(".execution-viewer"), null);
    assert.equal(document.body.style.overflow, "", "closing restores page scrolling");
    assert.equal(timeline.hasAttribute("aria-hidden"), false, "closing restores background accessibility");
    assert.equal(timeline.hasAttribute("inert"), false, "closing restores background interactivity");
    assert.equal(timeline.scrollTop, 640, "closing restores the timeline anchor after opener focus");

    await act(async () => disclosure.click());
    assert.ok(container.querySelector(".execution-details"), "details remain mounted for the exit transition");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    assert.equal(container.querySelector(".execution-details"), null, "details unmount after the motion-normal collapse");
    // The summary is semantic; the full command remains in the details above.
    assert.match(disclosure.textContent ?? "", /Git.*Review changes.*420ms.*✓/s);
  } finally {
    await act(async () => root.unmount());
    timeline.remove();
  }
});

test("command transports render a terminal even when their tool name is not a shell alias", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExecutionRow, { message: tool({ tool: "exec_command", input: { cmd: "pwd", workdir: "/workspace" }, output: "/workspace" }) })));
    await act(async () => container.querySelector<HTMLButtonElement>(".execution-summary")!.click());
    assert.equal(container.querySelector(".execution-command")?.textContent, "pwd");
    assert.equal(container.querySelector(".execution-output")?.textContent, "/workspace");
    assert.ok(container.querySelector('.execution-terminal button[aria-label="Copy command"]'));
    assert.ok(container.querySelector('.execution-terminal button[aria-label="Copy output"]'));
    assert.equal(container.querySelector(".execution-input"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("terminal copies the command and complete result independently and keeps raw details available", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const copied: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const secureContext = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  const command = "printf 'first\\nsecond\\n'\nnode scripts/check.mjs --verbose";
  const output = Array.from({ length: 18 }, (_, index) => `result ${index + 1}`).join("\n");
  try {
    await act(async () => root.render(createElement(ExecutionRow, { message: tool({ input: { command, timeout: 10000 }, output }) })));
    const disclosure = container.querySelector<HTMLButtonElement>(".execution-summary")!;
    await act(async () => disclosure.click());
    const copyCommand = container.querySelector<HTMLButtonElement>('.execution-terminal-command button[aria-label="Copy command"]')!;
    const copyOutput = container.querySelector<HTMLButtonElement>('.execution-terminal-result button[aria-label="Copy output"]')!;
    assert.ok(copyCommand && copyOutput);
    await act(async () => copyCommand.click());
    await act(async () => copyOutput.click());
    assert.deepEqual(copied, [command, output], "copy uses the complete payload, without the prompt glyph or truncation");
    assert.equal(copyCommand.getAttribute("aria-label"), "Copied");
    assert.equal(copyOutput.getAttribute("aria-label"), "Copied");
    assert.equal(disclosure.getAttribute("aria-expanded"), "true", "copy never collapses the command");

    const showAll = container.querySelector<HTMLButtonElement>(".execution-terminal-footer button")!;
    await act(async () => showAll.click());
    assert.match(container.querySelector(".execution-output")?.textContent ?? "", /result 18/);
    assert.equal(showAll.getAttribute("aria-expanded"), "true");
    await act(async () => showAll.click());
    assert.doesNotMatch(container.querySelector(".execution-output")?.textContent ?? "", /result 18/);

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="View execution details"]')!.click());
    const viewer = document.body.querySelector<HTMLElement>(".execution-viewer")!;
    assert.match(viewer.textContent ?? "", /"timeout": 10000/);
    assert.match(viewer.textContent ?? "", /"cwd": "\/workspace"/);
    await act(async () => viewer.querySelector<HTMLButtonElement>(".execution-viewer-close")!.click());
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else delete (navigator as unknown as Record<string, unknown>).clipboard;
    if (secureContext) Object.defineProperty(globalThis, "isSecureContext", secureContext);
    else delete (globalThis as Record<string, unknown>).isSecureContext;
  }
});

test("terminal preserves live output, errors, and quiet empty completion", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExecutionRow, { message: tool({ status: "running", output: undefined }) })));
    await act(async () => container.querySelector<HTMLButtonElement>(".execution-summary")!.click());
    assert.equal(container.querySelector(".execution-terminal-empty"), null, "an active command is not described as having no output");
    await act(async () => root.render(createElement(ExecutionRow, { message: tool({ status: "running", output: "partial" }) })));
    assert.equal(container.querySelector(".execution-output")?.textContent, "partial");
    assert.equal(container.querySelector(".execution-terminal-result")?.getAttribute("aria-busy"), "true");
    await act(async () => root.render(createElement(ExecutionRow, { message: tool({ status: "error", output: "partial", error: "Permission denied", metadata: { exit: 1 } }) })));
    assert.equal(container.querySelector(".execution-output")?.textContent, "partial\nPermission denied");
    assert.equal(container.querySelector(".execution-terminal-result")?.hasAttribute("aria-busy"), false);
    assert.equal(container.querySelector(".execution-terminal-exit")?.textContent, "Exit code 1");
    await act(async () => root.render(createElement(ExecutionRow, { message: tool({ output: "" }) })));
    assert.equal(container.querySelector(".execution-terminal-empty")?.textContent, "No output");
    assert.equal(container.querySelector(".execution-terminal-result"), null);
    assert.equal(container.querySelector(".execution-terminal-footer"), null, "successful empty commands have no extra footer");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a live block names its newest step in its own line; nothing mounts outside it", async () => {
  const { viewport, host } = activityTimelineHost();
  const root = createRoot(host);
  const first = tool({ id: "call-first", callId: "call-first", eventSeq: 1 });
  const latest = tool({
    id: "call-latest",
    callId: "call-latest",
    eventSeq: 2,
    input: { command: "npm test" },
    status: "running",
    output: undefined,
    finishTime: undefined,
    time: Date.now(),
  });
  const queued = tool({
    id: "call-queued",
    callId: "call-queued",
    eventSeq: 3,
    input: { command: "npm run build" },
    status: "running",
    output: undefined,
    finishTime: undefined,
    time: Date.now(),
  });
  try {
    await act(async () => root.render(createElement(ActivityGroupView, {
      g: activityGroup("activity-motion", [first, latest]),
      subagents: null,
      state: "active",
      entering: true,
      ticking: true,
    })));
    const line = () => viewport.querySelector<HTMLElement>(".ui-run-summary .activity-ticker")!;
    assert.equal(line().dataset.tickerEntry, "call-latest", "the line names the newest step at once");
    assert.match(line().textContent ?? "", /Run tests/);
    assert.equal(host.children.length, 1, "the block is one row: no live row is mounted beside it");
    assert.equal(viewport.querySelectorAll(".execution-row").length, 0, "a folded block shows no step rows");
    const toggle = viewport.querySelector<HTMLButtonElement>(".ui-run-summary")!;
    assert.match(toggle.getAttribute("aria-label") ?? "", /Run tests/, "the visible line is part of the block's name");

    // A burst does not queue: within the dwell the line holds, then it skips
    // straight to the newest step, in place.
    await act(async () => root.render(createElement(ActivityGroupView, {
      g: activityGroup("activity-motion", [first, latest, queued]),
      subagents: null,
      state: "active",
      entering: true,
      ticking: true,
    })));
    assert.equal(line().dataset.tickerEntry, "call-latest", "the current line keeps its dwell");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 950)); });
    assert.equal(line().dataset.tickerEntry, "call-queued", "then the newest step takes the line");
    assert.equal(host.children.length, 1, "still one row");
    assert.equal(toggle.getAttribute("aria-expanded"), "false", "the block never opens itself while work runs");

    await act(async () => toggle.click());
    const folded = [...viewport.querySelectorAll(".activity-group-items .execution-row")];
    assert.equal(folded.length, 3, "opened, the block lists every step in order, running ones included");
    assert.notEqual(folded[0]?.querySelector(".tool-preview")?.textContent, "", "history never retypes from empty");
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("a long sent prompt keeps four lines in the log and expands on demand", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const proto = dom.HTMLElement.prototype as unknown as HTMLElement;
  const original = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  // happy-dom has no layout: stand in for a body taller than its own clamp.
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) { return this.classList?.contains("user-prompt") ? 400 : 0; },
  });
  try {
    await act(async () => root.render(createElement(UserPrompt, {
      text: Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n\n"),
      id: "prompt-1",
    })));
    const body = container.querySelector(".user-prompt");
    const toggle = container.querySelector<HTMLButtonElement>(".user-prompt-toggle");
    assert.ok(body?.classList.contains("clipped"), "an overlong prompt is clamped and faded");
    assert.ok(!body?.classList.contains("open"), "a sent prompt starts collapsed");
    assert.ok(toggle, "and offers a way out of the clamp");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");

    await act(async () => toggle.click());
    assert.ok(container.querySelector(".user-prompt")?.classList.contains("open"), "it expands in place");
    assert.equal(container.querySelector(".user-prompt-toggle")?.getAttribute("aria-expanded"), "true",
      "and the control stays available to collapse it again");
  } finally {
    if (original) Object.defineProperty(proto, "scrollHeight", original);
    else delete (proto as unknown as Record<string, unknown>).scrollHeight;
    await act(async () => root.unmount());
    container.remove();
  }

  // A prompt that fits carries no chrome at all.
  const short = document.createElement("div");
  document.body.appendChild(short);
  const shortRoot = createRoot(short);
  try {
    await act(async () => shortRoot.render(createElement(UserPrompt, { text: "short", id: "prompt-2" })));
    assert.equal(short.querySelector(".user-prompt-toggle"), null);
    assert.equal(short.querySelector(".user-prompt")?.className, "user-prompt");
  } finally {
    await act(async () => shortRoot.unmount());
    short.remove();
  }
});

test("expanded actions read as the thing they did, not as raw transport", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const expand = async () => {
    await act(async () => container.querySelector<HTMLButtonElement>(".execution-summary")!.click());
  };
  try {
    // Shell: the command keeps its syntax roles instead of being flat text.
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({ input: { command: 'rg --hidden "needle" apps/web' } }),
    })));
    await expand();
    const command = container.querySelector(".execution-command");
    assert.match(command?.innerHTML ?? "", /class="tok-str"/, "quoted arguments are highlighted");
    assert.match(command?.innerHTML ?? "", /class="tok-punc">--hidden/, "flags read as modifiers");
    assert.equal(command?.textContent, 'rg --hidden "needle" apps/web', "and it still reads as the real command");

    // Read: a numbered fragment becomes source with a real gutter.
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({
        id: "call-read",
        callId: "call-read",
        tool: "read",
        input: { filePath: "/workspace/apps/web/src/app.ts", offset: 12 },
        output: "<file>\n00012| const answer = 42;\n00013| export default answer;\n</file>",
      }),
    })));
    await expand();
    const lines = [...container.querySelectorAll(".execution-code-line")];
    assert.equal(lines.length, 2, "the fragment renders line by line");
    assert.equal(lines[0]?.querySelector(".execution-code-ln")?.textContent, "12", "the gutter carries the file's own numbers");
    assert.match(lines[0]?.innerHTML ?? "", /tok-kw/, "the fragment is highlighted");
    assert.doesNotMatch(container.textContent ?? "", /00012\|/, "the read transport never reaches the reader");

    // ...and the file itself is a destination, not a printed path.
    const open = container.querySelector<HTMLButtonElement>(".execution-file-open");
    assert.ok(open, "the file opens from the action");
    await act(async () => open.click());
    assert.equal(getState().editorFile, "/workspace/apps/web/src/app.ts");

    // Image: shown as the image, opening the shared full-screen viewer.
    activateProject("execution-image-project");
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({
        id: "call-image",
        callId: "call-image",
        tool: "read",
        input: { filePath: "docs/shot.png" },
        output: "[image content]",
      }),
    })));
    await expand();
    const thumb = container.querySelector<HTMLImageElement>(".execution-image-open img");
    assert.ok(thumb, "the image is shown, not described");
    assert.match(thumb.src, /\/api\/files\/raw\?projectId=execution-image-project&path=docs%2Fshot\.png/);
    assert.equal(container.querySelector(".execution-output"), null, "and its byte payload is not printed alongside it");
    await act(async () => container.querySelector<HTMLButtonElement>(".execution-image-open")!.click());
    assert.ok(document.body.querySelector(".attachment-preview-dialog"), "clicking opens the same viewer attachments use");
  } finally {
    await act(async () => {
      activateProject(null);
      root.unmount();
    });
    container.remove();
  }
});

test("execution file links retain their owning session across navigation and reject untrusted absolute repository paths", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const project = { id: "resource-owner", path: "/workspace", name: "Resource owner", createdAt: 1,
    repositories: [{ id: "primary", alias: "Primary", path: "/workspace" }, { id: "secondary", alias: "Secondary", path: "/workspace-secondary" }] };
  const session = { id: "resource-session", projectId: project.id, title: "History", status: "idle" as const, createdAt: 1, updatedAt: 1,
    workspace: { mode: "subset" as const, revision: 1, repositories: [{ repositoryId: "secondary", alias: "Secondary", path: "/workspace-secondary" }] } };
  const message = tool({ id: "resource-call", callId: "resource-call", tool: "read",
    input: { filePath: "src/app.ts" }, metadata: { repositoryId: "secondary" } });
  try {
    applyProjectUpsert(project);
    activateProject(project.id);
    setSessions(project.id, [session]);
    activateSession(session.id);
    await act(async () => root.render(createElement(ExecutionRow, { message, sessionId: session.id })));
    await act(async () => container.querySelector<HTMLButtonElement>(".execution-summary")?.click());
    const link = container.querySelector<HTMLButtonElement>(".resource-link");
    assert.ok(link, "a relative path with explicit repository provenance uses ResourceLink");
    assert.equal(link?.getAttribute("draggable"), "true", "the link keeps the secondary repository identity for drag/drop");

    await act(async () => root.render(createElement(ExecutionRow, {
      message: { ...message, input: { filePath: "/tmp/escaped.ts" } }, sessionId: session.id,
    })));
    await act(async () => container.querySelector<HTMLButtonElement>(".execution-summary")?.click());
    assert.equal(container.querySelector(".resource-link"), null, "an absolute locator never becomes a repository-qualified link");
    assert.ok(container.querySelector(".execution-file-open"), "unsafe provenance keeps the guarded local action");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    activateSession(null);
    activateProject(null);
    setSessions(project.id, []);
  }
});

test("historical timeline markdown keeps its owning project after navigation", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const oldProject = { id: "markdown-old", path: "/old", name: "Old", createdAt: 1 };
  const newProject = { id: "markdown-new", path: "/new", name: "New", createdAt: 1 };
  try {
    applyProjectUpsert(oldProject);
    applyProjectUpsert(newProject);
    activateProject(oldProject.id);
    await act(async () => root.render(createElement(UserPrompt, {
      text: "See src/old.ts:4",
      id: "historical-prompt",
      resourceContext: { projectId: oldProject.id, sessionId: "old-session", repositoryId: "secondary" },
    })));
    assert.ok(container.querySelector(".resource-link"), "historical markdown has an explicit resource context");
    activateProject(newProject.id);
    await act(async () => root.render(createElement(UserPrompt, {
      text: "See src/old.ts:4",
      id: "historical-prompt",
      resourceContext: { projectId: oldProject.id, sessionId: "old-session", repositoryId: "secondary" },
    })));
    assert.ok(container.querySelector(".resource-link"), "navigation does not fall back to the new active project");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    activateProject(null);
  }
});

test("status bar drops stale git context when the active project changes", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const projects = [
    { id: "status-old", path: "/old", name: "Old", createdAt: 1 },
    { id: "status-new", path: "/new", name: "New", createdAt: 1 },
  ];
  const originalStatus = api.gitStatus;
  const originalRuns = api.listWorkflowRuns;
  const pending = new Map<string, { resolve: (value: Awaited<ReturnType<typeof api.gitStatus>>) => void }>();
  api.gitStatus = async (projectId) => new Promise((resolve) => { pending.set(projectId, { resolve }); });
  api.listWorkflowRuns = async () => [];
  const status = (branch: string, path?: string) => ({ branch, ahead: 0, behind: 0,
    staged: [], unstaged: path ? [{ path, status: "modified", staged: false }] : [], untracked: [], conflicted: [] });
  try {
    for (const project of projects) applyProjectUpsert(project);
    activateProject(projects[0]!.id);
    setUiSettings({ statusBar: "always" });
    await act(async () => root.render(createElement(StatusBar)));
    assert.ok(pending.has("status-old"));
    activateProject(projects[1]!.id);
    await act(async () => {});
    assert.equal(pending.has("status-new"), false, "scope changes wait behind the active serial probe");
    await act(async () => { pending.get("status-old")!.resolve(status("old-branch", "old.ts")); });
    await act(async () => {});
    assert.ok(pending.has("status-new"));
    assert.doesNotMatch(container.textContent ?? "", /old-branch|changed file/,
      "an old project response cannot repopulate the pending new-project bar");
    await act(async () => { pending.get("status-new")!.resolve(status("new-branch", "new.ts")); });
    assert.match(container.textContent ?? "", /new-branch/);
    assert.match(container.textContent ?? "", /1 changed file/);
  } finally {
    setUiSettings({ statusBar: "off" });
    api.gitStatus = originalStatus;
    api.listWorkflowRuns = originalRuns;
    await act(async () => root.unmount());
    container.remove();
    activateProject(null);
  }
});

test("status bar summarizes multi-repository changes without replacing editor context", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const project = {
    id: "status-aggregate",
    path: "/workspace",
    name: "Aggregate",
    createdAt: 1,
    repositories: [
      { id: "web", alias: "Web", path: "/workspace/web" },
      { id: "api", alias: "API", path: "/workspace/api" },
    ],
  };
  const originalStatus = api.gitStatus;
  const originalRuns = api.listWorkflowRuns;
  let inFlight = 0;
  let maxInFlight = 0;
  api.gitStatus = async (_projectId, _sessionId, repositoryId) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight--;
    return {
      branch: repositoryId === "api" ? "feature/api" : "feature/web",
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [{ path: `${repositoryId ?? "root"}.ts`, status: "modified" as const, staged: false }],
      untracked: [],
      conflicted: [],
    };
  };
  api.listWorkflowRuns = async () => [];
  try {
    applyProjectUpsert(project);
    activateProject(project.id);
    setUiSettings({ statusBar: "always" });
    await act(async () => root.render(createElement(StrictMode, null, createElement(StatusBar))));
    await act(async () => {});
    assert.match(container.textContent ?? "", /2 repos · 2 changed files/);
    assert.equal(maxInFlight, 1, "StrictMode remounts keep Git status probes serial");
  } finally {
    setUiSettings({ statusBar: "off" });
    api.gitStatus = originalStatus;
    api.listWorkflowRuns = originalRuns;
    await act(async () => root.unmount());
    container.remove();
    activateProject(null);
  }
});

test("status bar follows only the live cursor for the focused resource", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const project = {
    id: "cursor-status",
    path: "/workspace",
    name: "Cursor status",
    createdAt: 1,
    repositories: [
      { id: "web", alias: "Web", path: "/workspace/web" },
      { id: "api", alias: "API", path: "/workspace/api" },
    ],
  };
  const session = { id: "cursor-session", projectId: project.id, title: "Cursor", status: "idle" as const, createdAt: 1, updatedAt: 1 };
  const originalStatus = api.gitStatus;
  const originalRuns = api.listWorkflowRuns;
  api.gitStatus = async () => ({ branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] });
  api.listWorkflowRuns = async () => [];
  try {
    applyProjectUpsert(project);
    setSessions(project.id, [session]);
    activateProject(project.id);
    activateSession(session.id);
    setRailPlugin("files");
    setEditorFile("src/app.ts", "api");
    setUiSettings({ statusBar: "always" });
    await act(async () => root.render(createElement(StatusBar)));
    const resource = { scheme: "file" as const, projectId: project.id, sessionId: session.id, repositoryId: "api", locator: "src/app.ts" };
    await act(async () => { reportEditorCursor(resource, { line: 12, column: 7 }); });
    assert.match(container.textContent ?? "", /Ln 12, Col 7/);
    assert.equal(getState().editorFile, "src/app.ts", "cursor reports do not navigate");
    await act(async () => { reportEditorCursor(resource, { line: 12, column: 7 }); });
    assert.match(container.textContent ?? "", /Ln 12, Col 7/);
    await act(async () => { reportEditorCursor({ ...resource, repositoryId: "web" }, { line: 99, column: 4 }); });
    assert.doesNotMatch(container.textContent ?? "", /Ln 99, Col 4/);
    await act(async () => { reportEditorCursor({ ...resource, sessionId: "old-session" }, { line: 88, column: 2 }); });
    assert.doesNotMatch(container.textContent ?? "", /Ln 88, Col 2/);
  } finally {
    setUiSettings({ statusBar: "off" });
    reportEditorCursor({ scheme: "file", projectId: project.id, sessionId: session.id, repositoryId: "api", locator: "src/app.ts" }, null);
    api.gitStatus = originalStatus;
    api.listWorkflowRuns = originalRuns;
    setEditorFile(null);
    setRailPlugin(null);
    await act(async () => root.unmount());
    container.remove();
    activateSession(null);
    activateProject(null);
    setSessions(project.id, []);
  }
});

test("missing session workspace locates repositories through the owning project", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const project = {
    id: "workspace-locate",
    path: "/workspace",
    name: "Locate",
    createdAt: 1,
    repositories: [
      { id: "web", alias: "Web", path: "/workspace/web" },
      { id: "api", alias: "API", path: "/workspace/api" },
    ],
  };
  const session = {
    id: "workspace-locate-session",
    projectId: project.id,
    title: "Missing API",
    status: "idle" as const,
    createdAt: 1,
    updatedAt: 1,
    workspace: {
      mode: "subset" as const,
      revision: 2,
      repositories: [
        { repositoryId: "web", alias: "Web", path: "/workspace/web", state: "ready" as const },
        { repositoryId: "api", alias: "API", path: "/workspace/api", state: "missing" as const },
      ],
    },
  };
  let opened: string | null = null;
  try {
    applyProjectUpsert(project);
    activateProject(project.id);
    setSessions(project.id, [session]);
    activateSession(session.id);
    await act(async () => root.render(createElement(SessionWorkspace, {
      placement: "header",
      openRepositories: (projectId: string) => { opened = projectId; },
    })));
    await act(async () => container.querySelector<HTMLButtonElement>(".files-workspace-indicator")?.click());
    const locate = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Locate repositories"));
    assert.ok(locate);
    await act(async () => locate!.click());
    assert.equal(opened, project.id);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    activateSession(null);
    activateProject(null);
    setSessions(project.id, []);
  }
});

test("session workspace repairs only selected ordinary repositories after relocation", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const project = {
    id: "workspace-relocate",
    path: "/workspace",
    name: "Relocate",
    createdAt: 1,
    repositories: [
      { id: "web", alias: "Web", path: "/new/web" },
      { id: "api", alias: "API", path: "/api" },
    ],
  };
  const session = {
    id: "workspace-relocate-session",
    projectId: project.id,
    title: "Relocate Web",
    status: "idle" as const,
    createdAt: 1,
    updatedAt: 1,
    workspace: {
      mode: "subset" as const,
      revision: 7,
      repositories: [{ repositoryId: "web", alias: "Web", path: "/old/web", state: "ready" as const }],
    },
  };
  const originalUpdate = api.updateSessionWorkspace;
  const calls: unknown[] = [];
  api.updateSessionWorkspace = async (_sessionId, selection) => {
    calls.push(selection);
    return session;
  };
  try {
    applyProjectUpsert(project);
    setSessions(project.id, [session]);
    activateProject(project.id);
    activateSession(session.id);
    await act(async () => root.render(createElement(SessionWorkspace, { placement: "header" })));
    await act(async () => container.querySelector<HTMLButtonElement>(".files-workspace-indicator")?.click());
    const useLocated = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Use located repositories"));
    assert.ok(useLocated);
    await act(async () => useLocated!.click());
    assert.deepEqual(calls, [{ repositoryIds: ["web"], relocateRepositoryIds: ["web"], expectedRevision: 7 }]);
  } finally {
    api.updateSessionWorkspace = originalUpdate;
    await act(async () => root.unmount());
    container.remove();
    activateSession(null);
    activateProject(null);
    setSessions(project.id, []);
  }
});

test("edit rows show added/removed counts and a git-like file changes view", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({
        tool: "edit",
        input: {
          filePath: "apps/web/src/components/Composer.tsx",
          oldString: "one\ntwo",
          newString: "one\nthree\nfour",
        },
      }),
    })));
    const disclosure = container.querySelector<HTMLButtonElement>(".execution-summary")!;
    assert.match(disclosure.getAttribute("aria-label") ?? "", /2 added, 1 removed/);
    assert.match(container.querySelector(".execution-diff-stat")?.textContent ?? "", /\+2/);
    assert.match(container.querySelector(".execution-diff-stat")?.textContent ?? "", /−1/);
    assert.equal(container.querySelector(".execution-details"), null);

    await act(async () => disclosure.click());
    assert.equal(container.querySelector(".execution-file-toggle"), null,
      "a single-file edit does not repeat the path in a nested file header");
    assert.equal(container.querySelector(".execution-input"), null,
      "the file path is not repeated in the details list");
    assert.equal(container.querySelector(".execution-result"), null,
      "trivial ok output stays hidden when the diff is shown");
    const pathMentions = [...container.querySelectorAll(".execution-summary .tool-name, .execution-file-path")]
      .map((el) => el.textContent ?? "")
      .filter((text) => text.includes("Composer.tsx"));
    assert.equal(pathMentions.length, 1);
    assert.equal(container.querySelectorAll(".execution-diff-stat").length, 1);
    assert.equal(container.querySelectorAll(".git-diff-line").length, 4);
    assert.equal(container.querySelector(".git-diff-line.diff-hunk"), null,
      "hunk headers stay out of the inline change list");
    const added = [...container.querySelectorAll(".git-diff-line.diff-add")];
    assert.equal(added.length, 2);
    assert.equal(added[0]?.querySelector(".git-diff-ln")?.textContent, "2");
    assert.match(added[0]?.textContent ?? "", /\+three/);
    assert.equal(container.querySelector(".execution-metadata"), null,
      "file diffs do not repeat elapsed time, raw result, or a second copy");
    const actions = container.querySelector(".execution-file-actions")!;
    assert.match(actions.textContent ?? "", /Revert changes/);
    assert.match(actions.textContent ?? "", /Open in Files/);
    const diffEl = container.querySelector(".git-diff");
    assert.equal(diffEl?.nextElementSibling, actions,
      "Open in Files / copy sit below the change lines");
    assert.equal(container.querySelectorAll(".execution-details .copy-btn").length, 1);
    assert.equal(actions.querySelector(".copy-btn")?.getAttribute("aria-label"), "Copy diff");
    assert.equal(container.querySelectorAll(".execution-output-actions button").length, 0,
      "short edits stay inline instead of opening a separate viewer");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("execution summary columns stay aligned whether or not a row has line counts", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const shell = tool();
  const edit = tool({
    id: "call-edit",
    callId: "call-edit",
    eventSeq: 2,
    tool: "edit",
    input: {
      filePath: "apps/web/src/components/Composer.tsx",
      oldString: "one\ntwo",
      newString: "one\nthree\nfour",
    },
  });
  const group = activityGroup("activity-align", [shell, edit]);
  try {
    await act(async () => root.render(createElement(ActivityGroupView, { g: group, subagents: null })));
    const toggle = container.querySelector<HTMLButtonElement>(".ui-run-summary")!;
    assert.deepEqual(
      [...toggle.children].map((child) =>
        ["ui-run-summary-mark", "ui-run-summary-copy", "ui-run-summary-diff", "ui-run-summary-chevron"]
          .find((track) => child.classList.contains(track))),
      ["ui-run-summary-mark", "ui-run-summary-copy", "ui-run-summary-diff", "ui-run-summary-chevron"],
      "state, copy, aggregate line counts, and chevron stay in fixed tracks",
    );
    assert.equal(toggle.querySelector(".ui-run-summary-copy strong")?.textContent, "Ran 1 command, edited 1 file",
      "the block is named by the actions inside it");
    assert.match(toggle.getAttribute("aria-label") ?? "", /^Expand activity, Ran 1 command, edited 1 file · /);
    await act(async () => toggle.click());
    const summaries = [...container.querySelectorAll(".execution-summary")];
    assert.equal(summaries.length, 2);
    for (const summary of summaries) {
      assert.equal(summary.children.length, 5, "icon, preview, stats slot, status, and chevron stay in fixed tracks");
      assert.ok(summary.children[2]?.classList.contains("execution-diff-stat-slot"));
      assert.ok(summary.children[3]?.classList.contains("execution-status"));
      assert.ok(summary.children[4]?.classList.contains("tool-chevron"));
    }
    assert.equal(summaries[0]?.querySelector(".execution-diff-stat"), null);
    assert.ok(summaries[1]?.querySelector(".execution-diff-stat"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("activity is a bare thread of steps whose open summary pins with glass only while stuck", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const block = rule(".activity-group");
  assert.match(block, /overflow:\s*visible;/, "the activity container must not trap its sticky summary");
  assert.match(block, /margin:\s*0 calc\(-1 \* var\(--activity-bleed\)\);/, "copy starts on the prose edge; hover bands bleed into the gutter");
  assert.doesNotMatch(block, /background|border:|box-shadow/, "activity has no plate, border or shadow");
  assert.doesNotMatch(css, /\.activity-group::before/, "no glass plate is painted behind the block");
  assert.doesNotMatch(css, /:is\(\.activity-group, \.task-list\)|\.activity-group\.open\s*\{[^}]*box-shadow/,
    "no shared glass card treatment reaches the activity block");
  assert.match(block, /--activity-thread:\s*var\(--borderless-edge\);/,
    "the thread survives Borderless appearance, like the composer edge");
  assert.match(rule(".activity-group-items::before"), /background:\s*var\(--activity-thread\);/, "steps hang from one thread");
  assert.match(rule(".activity-group.current .activity-group-items::before"), /var\(--activity-thread-live\)/, "a live block warms its thread");
  assert.match(css, /@supports \(container-type: scroll-state\) \{\s*\.activity-group\.open > \.ui-run-summary \{[^}]*position:\s*sticky;[^}]*inset-block-start:\s*0;[^}]*z-index:\s*2;[^}]*container-type:\s*scroll-state;/,
    "an open summary pins only where it can tell that it is stuck");
  assert.match(css, /@container scroll-state\(stuck: top\) \{\s*\.activity-group\.open > \.ui-run-summary::before \{ opacity: 1; \}/,
    "the pinned summary takes its glass only while stuck, so it never sits bare on scrolling steps");
  // The step in progress is the block's own line: no separate live row
  // exists to fold away, so the block never adds or removes a row while it
  // works. Its swap animates transform and opacity only.
  assert.doesNotMatch(css, /\.activity-live(?:-stage|-content)?\b(?!-stop)/, "no live row outside the block");
  assert.match(rule(".activity-ticker-line.entering"), /animation:\s*activity-ticker-in/);
  assert.match(css, /@keyframes activity-ticker-in \{\s*from \{ opacity: 0; transform: translate3d\(0, \.55em, 0\); \}/);
  assert.match(css, /@keyframes activity-ticker-out \{\s*from \{ opacity: 1; transform: none; \}\s*to \{ opacity: 0; transform: translate3d\(0, -\.55em, 0\); \}/);
  assert.doesNotMatch(css, /grid-template-rows var\(--activity-live-exit\)/, "no step folds by resizing layout");
  // A task row reads like a step: the task in the step-name voice, then its kind.
  const timeline = await readFile(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8");
  assert.match(timeline, /<span className="task-activity-text">\{activity\.text\}<\/span>\s*<span className="task-activity-kind">\{label\}<\/span>/);
  assert.match(css, /\.activity-group \.task-activity-text \{[^}]*font:\s*500 var\(--font-tool-label\)/s);
  assert.match(css, /\.activity-group \.task-activity-kind \{[^}]*flex:\s*0 1000 auto/s, "the kind gives way first");
});

test("activity block looks are body-level CSS, so a setting restyles blocks already in the transcript", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const start = css.indexOf("/* Activity block looks");
  assert.ok(start >= 0, "the looks section exists");
  const looks = css.slice(start, css.indexOf("\n.execution-summary.tool-disclosure {", start));
  // Every look but the thread drops the thread.
  assert.match(looks, /body\[data-activity-style="ledger"\], body\[data-activity-style="chip"\], body\[data-activity-style="margin"\]\)\s*\.activity-group-items::before \{ display: none; \}/);
  // Ledger: the summary runs into a hairline; steps are ruled by hairlines.
  assert.match(looks, /data-activity-style="ledger"\] \.activity-group > \.ui-run-summary \.ui-run-summary-copy::after \{[^}]*background:\s*var\(--borderless-edge\)/s);
  assert.match(looks, /data-activity-style="ledger"\] \.activity-group-items > \* \+ \* \{ box-shadow: inset 0 1px 0 var\(--borderless-edge\); \}/);
  // Chip: an outlined pill that hugs its words, accent while live.
  assert.match(looks, /data-activity-style="chip"\] \.activity-group > \.ui-run-summary \{[^}]*width:\s*fit-content;[^}]*border-radius:\s*var\(--radius-round\);[^}]*box-shadow:\s*inset 0 0 0 1px var\(--borderless-edge\)/s);
  assert.match(looks, /data-activity-style="chip"\] \.activity-group\.current > \.ui-run-summary \{[^}]*var\(--accent\)/s);
  // Margin: icons hang only where the frame leaves a gutter.
  assert.match(looks, /@media \(min-width: 961px\) and \(not \(\(max-height: 480px\) and \(pointer: coarse\)\)\) \{\s*body\[data-activity-style="margin"\] \.focus-conversation/);
  // Outlines never come from borders, which Borderless erases.
  assert.doesNotMatch(looks, /\bborder(?:-[a-z]+)?:\s*1px/);
});

test("multi-file patches list each file with its own line counts", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({
        tool: "apply_patch",
        input: {
          patchText: [
            "*** Begin Patch",
            "*** Update File: src/a.ts",
            "@@ -1,1 +1,1 @@",
            "-old",
            "+new",
            "*** Add File: src/b.ts",
            "+hello",
            "*** End Patch",
          ].join("\n"),
        },
      }),
    })));
    const disclosure = container.querySelector<HTMLButtonElement>(".execution-summary")!;
    assert.match(disclosure.getAttribute("aria-label") ?? "", /2 files, 2 added, 1 removed/);
    await act(async () => disclosure.click());
    const files = container.querySelectorAll(".execution-file-toggle");
    assert.equal(files.length, 2);
    assert.match(files[0]?.textContent ?? "", /src\/a\.ts/);
    assert.match(files[1]?.textContent ?? "", /src\/b\.ts/);
    assert.ok(container.querySelector(".git-diff-line.diff-add"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("long edit previews provide a full diff viewer", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const content = Array.from({ length: 130 }, (_, index) => `line ${index + 1}`).join("\n");
  try {
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({
        tool: "create",
        input: { filePath: "apps/web/src/generated.ts", content },
      }),
    })));
    await act(async () => container.querySelector<HTMLButtonElement>(".execution-summary")!.click());
    assert.equal(container.querySelector(".execution-file-toggle"), null);
    assert.equal(container.querySelector(".execution-metadata"), null);
    assert.equal(container.querySelectorAll(".git-diff-line").length, 120);
    assert.equal(container.querySelectorAll(".git-diff-line.diff-add").length, 120);
    assert.equal(container.querySelector(".git-diff-line.diff-hunk"), null);
    const fullDiff = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "View full diff");
    assert.ok(fullDiff);
    await act(async () => fullDiff.click());
    const viewer = document.body.querySelector<HTMLElement>(".execution-viewer");
    assert.match(viewer?.textContent ?? "", /Create .*generated\.ts/);
    assert.match(viewer?.querySelector(".git-diff-line.diff-add:last-child")?.textContent ?? "", /line 130/);
    await act(async () => viewer?.querySelector<HTMLButtonElement>(".execution-viewer-close")?.click());
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("pending and running execution states stay visually and accessibly distinct", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  let abortRequest: { url: string; method: string; body: string } | undefined;
  try {
    await act(async () => {
      setSessions("execution-status-test", [{
        id: "execution-status-session",
        projectId: "execution-status-test",
        title: "Running command",
        status: "working",
        createdAt: 1,
        updatedAt: 1,
      }]);
      activateSession("execution-status-session");
      applyEvent({
        id: "execution-status-turn-started",
        sessionId: "execution-status-session",
        seq: 1,
        time: 1,
        type: "turn/started",
        data: { turnId: "turn-1" },
        v: 1,
      });
      applyEvent({
        id: "execution-status-tool-started",
        sessionId: "execution-status-session",
        seq: 2,
        time: 2,
        type: "tool/started",
        data: { callId: "call-1", tool: "bash", input: { command: "sleep 10" } },
        v: 1,
      });
    });
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({ status: "pending", output: undefined, finishTime: undefined }),
    })));
    assert.match(container.querySelector(".execution-status")?.getAttribute("aria-label") ?? "", /^Pending in /);
    assert.equal(container.querySelector(".execution-status-icon")?.textContent, "○");
    assert.equal(container.querySelector(".execution-stop"), null, "queued commands cannot be stopped before they start");
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({ status: "running", output: undefined, finishTime: undefined }),
    })));
    assert.match(container.querySelector(".execution-status")?.getAttribute("aria-label") ?? "", /^Running in /);
    assert.ok(container.querySelector(".execution-status-icon .ui-spinner"), "running status uses an animated spinner");
    const stop = container.querySelector<HTMLButtonElement>(".execution-stop");
    assert.equal(stop?.textContent, "Stop");
    globalThis.fetch = async (input, init) => {
      abortRequest = {
        url: String(input),
        method: String(init?.method ?? "GET"),
        body: String(init?.body ?? ""),
      };
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    await act(async () => { stop?.click(); });
    assert.deepEqual(abortRequest, {
      url: "/api/sessions/execution-status-session/abort",
      method: "POST",
      body: JSON.stringify({ source: "execution" }),
    });
    await act(async () => {
      applyEvent({
        id: "execution-status-turn-stopped",
        sessionId: "execution-status-session",
        seq: 3,
        time: 3,
        type: "turn/stopped",
        data: { turnId: "turn-1", reason: "aborted" },
        v: 1,
      });
    });
    assert.equal(container.querySelector(".execution-stop"), null, "stop disappears as soon as the turn settles");
    await act(async () => {
      applyEvent({
        id: "execution-status-next-turn",
        sessionId: "execution-status-session",
        seq: 4,
        time: 4,
        type: "turn/started",
        data: { turnId: "turn-2" },
        v: 1,
      });
    });
    assert.equal(container.querySelector(".execution-stop"), null, "a later turn cannot revive a stale stop control");
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => {
      activateSession(null);
      setSessions("execution-status-test", []);
    });
    await act(async () => root.unmount());
    container.remove();
  }
});

test("orphaned-tool interrupt reasons map to cancelled vs failed display status", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({ status: "error", error: "Interrupted", output: undefined }),
    })));
    assert.match(container.querySelector(".execution-status")?.getAttribute("aria-label") ?? "", /^Cancelled in /);

    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({ status: "error", error: "Stopped", output: undefined }),
    })));
    assert.match(container.querySelector(".execution-status")?.getAttribute("aria-label") ?? "", /^Cancelled in /);

    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({ status: "error", error: "Turn ended before tool completed", output: undefined }),
    })));
    assert.match(container.querySelector(".execution-status")?.getAttribute("aria-label") ?? "", /^Failed in /);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

for (const [reason, expected] of [["stopped", "completed"], ["error", "failed"], ["aborted", "cancelled"]] as const) {
  test(`a ${reason} turn settles activity and a new turn cannot revive it`, async () => {
    const t = timelineHost();
    const state = () => t.host.querySelector<HTMLElement>(".activity-group > .ui-run-summary")?.dataset.state;
    try {
      await t.render([
        t.event(1, "turn/started", { turnId: "turn-1" }),
        t.event(2, "task/snapshot", { revision: 1, items: [{ id: "1", text: "Fix", status: "active" }] }),
      ]);
      assert.equal(state(), "active");
      await t.render([t.event(3, "turn/stopped", { turnId: "turn-1", reason })]);
      assert.equal(state(), expected);
      assert.equal(t.host.querySelector(".activity-group .ui-spinner"), null);
      // Equal timestamps still belong to different canonical turns.
      await t.render([t.event(4, "turn/started", { turnId: "turn-2" }, 2)]);
      assert.ok(!["active", "waiting"].includes(state() ?? ""), "a new turn cannot revive old activity");
      await t.render([
        t.event(5, "assistant/message", { partId: "p1", text: "Next step." }),
        t.event(6, "tool/started", { callId: "call-2", tool: "bash", input: { command: "npm test" } }),
      ]);
      const summaries = [...t.host.querySelectorAll<HTMLElement>(".activity-group > .ui-run-summary")];
      assert.equal(summaries.length, 2);
      assert.equal(summaries[1]?.dataset.state, "active", "new work is still live");
    } finally {
      await t.cleanup();
    }
  });
}

test("a composer `!` command prints as its own open terminal row, outside agent activity", async () => {
  const t = timelineHost();
  const shell = <T extends object>(event: T) => Object.assign(event, { producerPlugin: "composer-shell" });
  try {
    await t.render([
      t.event(1, "user/message", { text: "check the tree" }),
      t.event(2, "turn/started", { turnId: "turn-1" }),
      t.event(3, "tool/started", { callId: "call-1", tool: "bash", input: { command: "ls" } }),
      t.event(4, "tool/result", { callId: "call-1", output: "a\nb" }),
      t.event(5, "assistant/message", { partId: "p1", text: "Done." }),
      t.event(6, "turn/stopped", { turnId: "turn-1", reason: "stopped" }),
      shell(t.event(7, "tool/call", { callId: "shell_1", tool: "shell", input: { command: "git status --short" } })),
      shell(t.event(8, "tool/result", {
        callId: "shell_1",
        tool: "shell",
        output: " M apps/web/src/utils.ts\n",
        title: "!git status --short",
        input: { command: "git status --short" },
        metadata: { exitCode: 0, timedOut: false, truncated: false },
      })),
    ]);
    const row = t.host.querySelector<HTMLElement>(".msg.composer-shell");
    assert.ok(row, "the shell command has its own timeline row");
    assert.equal(row.closest(".activity-group"), null, "never folded into an activity block");
    assert.equal(row.querySelector(".tool-disclosure"), null, "nothing to expand: it is already open");
    assert.equal(row.querySelector(".execution-command")?.textContent, "git status --short");
    // The newest row prints its output in over a few frames.
    for (let frame = 0; frame < 20 && !/utils/.test(row.querySelector(".execution-output")?.textContent ?? ""); frame += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    assert.match(row.querySelector(".execution-output")?.textContent ?? "", /M apps\/web\/src\/utils\.ts/);
    assert.equal(row.querySelector(".execution-status")?.classList.contains("done"), true);
    assert.equal(t.host.querySelectorAll(".activity-group").length, 1, "the agent's own work still groups");
    await t.render([
      shell(t.event(9, "tool/call", { callId: "shell_2", tool: "shell", input: { command: "false" } })),
      shell(t.event(10, "tool/result", { callId: "shell_2", tool: "shell", output: "", input: { command: "false" }, metadata: { exitCode: 1 } })),
    ]);
    const failed = t.host.querySelectorAll<HTMLElement>(".msg.composer-shell")[1];
    assert.equal(failed?.classList.contains("error"), true, "a non-zero exit reads as a failure");
    assert.equal(failed?.querySelector(".execution-status")?.classList.contains("error"), true);
    assert.match(failed?.querySelector(".execution-terminal-exit")?.textContent ?? "", /Exit code 1/);
  } finally {
    await t.cleanup();
  }
});

test("a task that completes in a later activity block does not leave earlier blocks spinning", async () => {
  // Task snapshots push started/completed as separate history entries, so a
  // prose answer between them splits them into two blocks. The block holding
  // only the started entry must not read active forever.
  const t = timelineHost();
  try {
    await t.render([
      t.event(1, "turn/started", { turnId: "turn-1" }),
      t.event(2, "task/snapshot", { revision: 1, items: [{ id: "1", text: "Fix", status: "active" }] }),
      t.event(3, "assistant/chunk", { partId: "p1", text: "Starting on it." }),
      t.event(4, "assistant/message", { partId: "p1", text: "Starting on it." }),
      t.event(5, "task/snapshot", { revision: 2, items: [{ id: "1", text: "Fix", status: "done" }] }),
      t.event(6, "assistant/chunk", { partId: "p2", text: "Done." }),
      t.event(7, "assistant/message", { partId: "p2", text: "Done." }),
    ]);
    const summaries = () => [...t.host.querySelectorAll<HTMLElement>(".activity-group > .ui-run-summary")];
    assert.equal(summaries().length, 2, "the prose splits the task entries into two blocks");
    assert.deepEqual(summaries().map((summary) => summary.dataset.state), ["completed", "active"],
      "only the latest block follows the ongoing turn");
    await t.render([t.event(8, "turn/stopped", { turnId: "turn-1", reason: "stopped" })]);
    assert.deepEqual(summaries().map((summary) => summary.dataset.state), ["completed", "completed"]);
  } finally {
    await t.cleanup();
  }
});

test("reasoning stays visible as a quiet separator between activity groups", async () => {
  const t = timelineHost();
  const longThought = "x".repeat(300);
  try {
    await t.render([
      t.event(1, "user/message", { text: "inspect the flow" }),
      t.event(2, "assistant/reasoning-chunk", { partId: "thought-1", text: "First line\nSecond line\nThird line" }),
      t.event(3, "assistant/message", { partId: "thought-1", text: "", reasoning: "First line\nSecond line\nThird line" }),
      t.event(4, "tool/call", { callId: "call-1", tool: "read", input: { path: "a.ts" } }),
      t.event(5, "tool/result", { callId: "call-1", output: "ok" }),
      t.event(6, "assistant/reasoning-chunk", { partId: "thought-2", text: "Next thought\nStill thinking" }),
      t.event(7, "assistant/message", { partId: "thought-2", text: "", reasoning: "Next thought\nStill thinking" }),
      t.event(8, "tool/call", { callId: "call-2", tool: "read", input: { path: "b.ts" } }),
      t.event(9, "tool/result", { callId: "call-2", output: "ok" }),
      t.event(10, "assistant/reasoning-chunk", { partId: "thought-3", text: longThought }),
      t.event(11, "assistant/message", { partId: "thought-3", text: "", reasoning: longThought }),
    ]);
    const thoughts = [...t.host.querySelectorAll<HTMLElement>(".reasoning-row .reasoning")];
    assert.equal(thoughts.length, 3);
    assert.equal(t.host.querySelectorAll(".activity-group").length, 2);
    assert.equal(t.host.querySelector(".activity-group .reasoning"), null,
      "reasoning must not be nested in either activity box");
    assert.equal(thoughts[0]?.querySelector(".reasoning-preview")?.textContent, "First line\nSecond line");
    assert.equal(thoughts[0]?.querySelector(".reasoning-fade"), null, "the compact separator has no bottom strip");
    const short = thoughts[1];
    assert.equal(short?.querySelector(".reasoning-toggle"), null, "short reasoning has no expand control");
    assert.equal(short?.querySelector(".reasoning-chevron"), null, "short reasoning has no chevron");
    assert.doesNotMatch(short?.querySelector(".reasoning-preview")?.textContent ?? "", /…/);
    assert.ok(thoughts[2]?.querySelector(".reasoning-toggle"), "a long one-line thought still has a disclosure");
    const toggle = thoughts[0]!.querySelector<HTMLButtonElement>(".reasoning-toggle")!;
    assert.equal(toggle.getAttribute("aria-expanded"), "false", "the separator starts folded");
    assert.equal(thoughts[0]?.querySelector(".reasoning-body"), null);

    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(thoughts[0]?.querySelector(".reasoning-preview"), null,
      "the opened thought takes the preview's place instead of repeating it above");
    assert.ok(toggle.getAttribute("aria-label"), "the chevron-only control keeps its accessible name");
    assert.match(thoughts[0]?.querySelector(".reasoning-body")?.textContent ?? "", /First line\s*Second line\s*Third line/,
      "the opened body is the whole thought in source order");
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.equal(thoughts[0]?.querySelector(".reasoning-body"), null, "the collapse finishes before the body is removed");
  } finally {
    await t.cleanup();
  }
});

test("opening a folded thought always reveals its whole text, continuing the preview in place", async () => {
  const t = timelineHost();
  // One long paragraph: two clamped header lines, no third source line.
  const paragraph = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ").repeat(2);
  // A long first paragraph: the clamp hides the second source line.
  const layered = `**Plan**\n\n${"Inspect the reducer and the row. ".repeat(12)}\n\nThen verify the fix.\n\nFinally report.`;
  try {
    await t.render([
      t.event(1, "user/message", { text: "inspect" }),
      t.event(2, "assistant/message", { partId: "one-paragraph", text: "", reasoning: paragraph }),
      t.event(3, "tool/call", { callId: "call-1", tool: "read", input: { path: "a.ts" } }),
      t.event(4, "tool/result", { callId: "call-1", output: "ok" }),
      t.event(5, "assistant/message", { partId: "layered", text: "", reasoning: layered }),
    ]);
    const thoughts = [...t.host.querySelectorAll<HTMLElement>(".reasoning-row .reasoning")];
    assert.equal(thoughts.length, 2);
    for (const [index, source] of [paragraph, layered].entries()) {
      const thought = thoughts[index]!;
      const toggle = thought.querySelector<HTMLButtonElement>(".reasoning-toggle")!;
      assert.ok(toggle, `thought ${index} has a disclosure`);
      await act(async () => toggle.click());
      const opened = thought.querySelector<HTMLButtonElement>(".reasoning-toggle");
      assert.ok(opened === toggle, "the same control stays focused across the toggle");
      assert.equal(toggle.getAttribute("aria-expanded"), "true");
      const blocks = [...(thought.querySelector(".reasoning-body")?.children ?? [])].map((block) => block.textContent);
      const body = blocks.join(" ").replace(/\s+/g, " ").trim();
      const expected = source.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
      assert.equal(body, expected, `thought ${index} opens to its complete text, nothing skipped`);
      assert.equal(thought.querySelector(".reasoning-preview"), null,
        "the clamped preview gives way to the full text instead of repeating above it");
      await act(async () => toggle.click());
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      assert.ok(thought.querySelector(".reasoning-preview"), "the folded preview returns");
    }
  } finally {
    await t.cleanup();
  }
});

test("a new thought lands at once under its block, whose line then settles on its summary", async () => {
  const t = timelineHost();
  const now = Date.now();
  try {
    await t.render([
      t.event(1, "user/message", { text: "inspect the flow" }, now - 100),
      t.event(2, "turn/started", { turnId: "turn-thinking-handoff" }, now - 90),
      t.event(3, "tool/call", { callId: "call-thinking-handoff", tool: "read", input: { path: "a.ts" } }, now),
    ]);
    const line = () => t.host.querySelector<HTMLElement>(".activity-group .activity-ticker")!;
    assert.equal(line().dataset.tickerEntry, "call-thinking-handoff", "the working block names its action");
    await t.render([
      t.event(4, "tool/result", { callId: "call-thinking-handoff", output: "ok" }, now + 10),
      t.event(5, "assistant/reasoning-chunk", { partId: "thought-after-action", text: "Now inspect the result" }, now + 20),
    ]);
    // Nothing is held back: the agent moved on, so its thought is on screen.
    assert.ok(t.host.querySelector(".reasoning-row"), "the thought mounts the moment it arrives");
    assert.match(t.host.querySelector(".reasoning-row")?.textContent ?? "", /Now/);
    assert.equal(t.host.querySelector(".activity-group")?.nextElementSibling === t.host.querySelector(".reasoning-row"), true,
      "the thought sits right under its block");
    // The block's line keeps the action for its dwell, then settles in place.
    assert.equal(line().dataset.tickerEntry, "call-thinking-handoff");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 950)); });
    assert.equal(line().dataset.tickerEntry, "summary", "the line settles on the block's summary");
  } finally {
    await t.cleanup();
  }
});

test("ungrouped actions render separately and keep Thinking outside activity cards", async () => {
  const previous = getUiSettings();
  const t = timelineHost();
  try {
    await act(async () => setUiSettings({ actionGrouping: "ungrouped", thinkingDisplayMode: "collapsed" }));
    await t.render([
      t.event(1, "user/message", { text: "inspect the flow" }),
      t.event(2, "assistant/reasoning-chunk", { partId: "thought-1", text: "Inspecting" }),
      t.event(3, "assistant/message", { partId: "thought-1", text: "", reasoning: "Inspecting" }),
      t.event(4, "tool/call", { callId: "call-1", tool: "read", input: { path: "a.ts" } }),
      t.event(5, "tool/result", { callId: "call-1", output: "ok" }),
      t.event(6, "tool/call", { callId: "call-2", tool: "read", input: { path: "b.ts" } }),
      t.event(7, "tool/result", { callId: "call-2", output: "ok" }),
    ]);

    assert.equal(t.host.querySelectorAll(".activity-group").length, 0);
    assert.equal(t.host.querySelectorAll(".execution-row").length, 2);
    assert.equal(t.host.querySelectorAll(".reasoning-row .reasoning").length, 1);

    await act(async () => setUiSettings({ thinkingDisplayMode: "expanded" }));
    assert.equal(t.host.querySelectorAll(".reasoning-row .reasoning-flat").length, 1,
      "the existing ungrouped row responds to the Thinking selector");

    await act(async () => setUiSettings({ actionGrouping: "grouped" }));
    assert.equal(t.host.querySelectorAll(".activity-group").length, 1);
    await act(async () => t.host.querySelector<HTMLButtonElement>(".ui-run-summary")!.click());
    assert.equal(t.host.querySelectorAll(".activity-group-items .execution-row").length, 2);
  } finally {
    await act(async () => setUiSettings(previous));
    await t.cleanup();
  }
});

test("changing Thinking mode preserves unchanged message and action DOM instead of replaying their entrance", async () => {
  const previous = getUiSettings();
  const t = timelineHost();
  try {
    await act(async () => setUiSettings({ actionGrouping: "ungrouped", thinkingDisplayMode: "collapsed" }));
    await t.render([
      t.event(1, "user/message", { text: "Keep my reading position" }),
      t.event(2, "tool/call", { callId: "stable-tool", tool: "read", input: { path: "a.ts" } }),
      t.event(3, "tool/result", { callId: "stable-tool", output: "read result" }),
      t.event(4, "assistant/message", { partId: "stable-thought", text: "", reasoning: "First line\nSecond line\nThird line" }),
      t.event(5, "assistant/message", { partId: "stable-answer", text: "Done" }),
    ]);
    const prompt = t.host.querySelector(".msg.user");
    const toolRow = t.host.querySelector(".execution-row");
    await act(async () => t.host.querySelector<HTMLButtonElement>(".execution-summary")!.click());
    await act(async () => setUiSettings({ thinkingDisplayMode: "expanded" }));
    assert.ok(t.host.querySelector(".msg.user") === prompt, "the prompt keeps its geometry and motion identity");
    assert.ok(t.host.querySelector(".execution-row") === toolRow, "an unchanged action is not a new arrival");
    assert.equal(toolRow?.querySelector(".execution-summary")?.getAttribute("aria-expanded"), "true",
      "the reader's open action stays open");
    await act(async () => setUiSettings({ actionGrouping: "grouped" }));
    const group = t.host.querySelector(".activity-group");
    await act(async () => group!.querySelector<HTMLButtonElement>(".ui-run-summary")!.click());
    await act(async () => setUiSettings({ thinkingDisplayMode: "collapsed" }));
    assert.ok(t.host.querySelector(".msg.user") === prompt);
    assert.ok(t.host.querySelector(".activity-group") === group);
    assert.equal(group?.querySelector(".ui-run-summary")?.getAttribute("aria-expanded"), "true");
    await act(async () => setUiSettings({ thinkingDisplayMode: "activity" }));
    assert.ok(t.host.querySelector(".msg.user") === prompt);
    assert.ok(t.host.querySelector(".activity-group") === group);
    assert.ok(group?.querySelector(".reasoning"), "Hide in activity still updates the projection inside the open group");
  } finally {
    await act(async () => setUiSettings(previous));
    await t.cleanup();
  }
});

test("Expanded Thinking keeps its full text in the transcript, without a desktop or phone height cap", async () => {
  const previous = getUiSettings();
  const t = timelineHost();
  const style = document.createElement("style");
  style.textContent = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  document.head.append(style);
  const width = dom.innerWidth;
  const reasoning = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: long reasoning remains fully readable.`).join("\n\n");
  try {
    await act(async () => setUiSettings({ actionGrouping: "grouped", thinkingDisplayMode: "expanded" }));
    await t.render([
      t.event(1, "user/message", { text: "Inspect the full reasoning" }),
      t.event(2, "assistant/message", { partId: "full-thought", text: "", reasoning }),
    ]);
    for (const actionGrouping of ["grouped", "ungrouped"] as const) {
      await act(async () => setUiSettings({ actionGrouping }));
      for (const screenWidth of [1280, 390]) {
        dom.innerWidth = screenWidth;
        const body = t.host.querySelector<HTMLElement>(".reasoning-flat .reasoning-body")!;
        assert.ok(body, `${actionGrouping}: the expanded thought is a standalone row`);
        assert.match(body.textContent ?? "", /Step 1:/);
        assert.match(body.textContent ?? "", /Step 40:/, "the final line is rendered too");
        const computed = dom.getComputedStyle(body as unknown as InstanceType<typeof dom.HTMLElement>);
        assert.equal(computed.maxHeight, "none", `${actionGrouping} at ${screenWidth}px has no vertical cap`);
        assert.equal(computed.overflowY || computed.overflow, "visible", "the timeline owns vertical scrolling");
        assert.equal(t.host.querySelector(".reasoning-toggle"), null, "Expanded needs no extra disclosure");
      }
    }
    await act(async () => setUiSettings({ thinkingDisplayMode: "collapsed" }));
    await act(async () => t.host.querySelector<HTMLButtonElement>(".reasoning-toggle")!.click());
    const disclosure = t.host.querySelector<HTMLElement>(".reasoning-body")!;
    assert.equal(dom.getComputedStyle(disclosure as unknown as InstanceType<typeof dom.HTMLElement>).overflow, "auto",
      "a manually opened collapsed disclosure still has its own bounded well");
  } finally {
    dom.innerWidth = width;
    style.remove();
    await act(async () => setUiSettings(previous));
    await t.cleanup();
  }
});

test("a rewind marker and its replacement echo publish as one store snapshot", () => {
  const sessionId = "atomic-rewind-replacement";
  let notifications = 0;
  const off = subscribeStore(() => { notifications += 1; });
  const marker = {
    id: "atomic-marker",
    sessionId,
    seq: 1,
    time: 1,
    type: "session/rewound",
    data: { atSeq: 1 },
    v: 1 as const,
  };
  try {
    const echoId = applyEventWithPendingSend(marker, {
      sessionId,
      text: "replacement",
      attachments: [],
    });
    const state = getState();
    assert.equal(notifications, 1, "one listener pass owns both halves of the visual handover");
    assert.equal(state.events[sessionId]?.at(-1)?.seq, 1);
    assert.deepEqual(state.pendingSends.filter((send) => send.id === echoId).map((send) => send.text), ["replacement"]);
    endPendingSend(echoId);
  } finally {
    off();
  }
});

test("soft rewind stays out of flow and reveals live work only through the compact peek", async () => {
  const previous = getUiSettings();
  const t = timelineHost();
  try {
    await act(async () => setUiSettings({ actionGrouping: "ungrouped", thinkingDisplayMode: "collapsed" }));
    await t.render([
      t.event(1, "user/message", { text: "continue" }),
      t.event(2, "turn/started", { turnId: "turn-1" }),
      t.event(3, "session/rewound", { atSeq: 1 }),
      t.event(4, "tool/call", { callId: "call-live", tool: "read", input: { path: "a.ts" } }),
    ]);

    const marker = t.host.querySelector<HTMLElement>(".rewind-marker");
    assert.ok(marker, "the active cut has one compact marker");
    assert.equal(marker.querySelector(".rewind-marker-label")?.textContent, "Rewound");
    assert.doesNotMatch(marker.textContent ?? "", /Earlier reply still running|rewound timeline items/i);
    assert.equal(t.host.querySelectorAll(".execution-row").length, 0,
      "the still-running action belongs to the activity dock, not duplicated in the transcript");

    const peek = marker.querySelector<HTMLButtonElement>(".rewind-marker-peek")!;
    await act(async () => peek.click());
    assert.equal(peek.getAttribute("aria-expanded"), "true");
    assert.equal(marker.querySelectorAll(".execution-row").length, 1,
      "the hidden branch is available only after an explicit peek");
  } finally {
    await act(async () => setUiSettings(previous));
    await t.cleanup();
  }
});

test("execution rows stay folded by default while running and after settling", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({ status: "running", output: undefined, finishTime: undefined }),
    })));
    assert.equal(container.querySelector(".execution-summary")?.getAttribute("aria-expanded"), "false",
      "a running call is folded by default");
    assert.equal(container.querySelector(".execution-details"), null,
      "inline details stay hidden while folded");

    await act(async () => root.render(createElement(ExecutionRow, { message: tool() })));
    assert.equal(container.querySelector(".execution-summary")?.getAttribute("aria-expanded"), "false",
      "a settled call is folded by default too");

    await act(async () => container.querySelector<HTMLButtonElement>(".execution-summary")!.click());
    assert.equal(container.querySelector(".execution-summary")?.getAttribute("aria-expanded"), "true",
      "a hand toggle still expands the row");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a live block holds its own place in flow: later prose follows the block itself", async () => {
  const { viewport, timeline, host } = activityTimelineHost();
  const root = createRoot(host);
  const running = tool({ status: "running", output: undefined, finishTime: undefined, time: Date.now() });
  try {
    await act(async () => root.render(createElement(Fragment, null,
      createElement(ActivityGroupView, {
        g: activityGroup("activity-before-prose", [running]),
        subagents: null,
        ticking: true,
      }),
      createElement("article", { className: "msg assistant", "data-following-prose": true }, "Later assistant text"),
    )));
    const block = viewport.querySelector<HTMLElement>(".activity-group");
    const following = viewport.querySelector<HTMLElement>("[data-following-prose]");
    assert.ok(block && following);
    assert.equal(timeline.contains(block), true);
    assert.equal(block.nextElementSibling === following, true, "later prose follows the block, with no live row between them");
    assert.equal(block.querySelector(".activity-ticker")?.getAttribute("data-ticker-entry"), running.id,
      "the running step is named inside the block's own line");
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("a lone running action names itself, then settles into the summary in place", async () => {
  const { viewport } = activityTimelineHost();
  const root = createRoot(viewport.querySelector(".timeline")!.firstElementChild!);
  const running = tool({ status: "running", output: undefined, finishTime: undefined, time: Date.now() });
  const group = (message: ToolMsg) => activityGroup("activity-1", [message]);
  try {
    await act(async () => root.render(createElement(ActivityGroupView, { g: group(running), subagents: null, ticking: true })));
    const summary = viewport.querySelector<HTMLButtonElement>(".ui-run-summary")!;
    assert.ok(summary, "the summary mounts with the first action so later arrivals cannot shift it");
    const line = () => summary.querySelector<HTMLElement>(".activity-ticker")!;
    assert.equal(line().dataset.tickerEntry, running.id);
    assert.equal(line().querySelectorAll(".activity-ticker-line").length, 1);

    // The agent moved on: the block is no longer the live tail.
    await act(async () => root.render(createElement(ActivityGroupView, { g: group(tool()), subagents: null, ticking: false })));
    assert.equal(viewport.querySelector(".ui-run-summary") === summary, true, "the same summary element stays");
    assert.equal(line().dataset.tickerEntry, running.id, "the step keeps its dwell");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 950)); });
    assert.equal(line().dataset.tickerEntry, "summary", "then the line settles on the block's summary");
    const lines = [...line().querySelectorAll(".activity-ticker-line")];
    assert.equal(lines.length, 2, "for one beat the old words leave while the summary rises, in one line box");
    assert.equal(lines[0]?.classList.contains("leaving"), true);
    assert.equal(lines[0]?.getAttribute("aria-hidden"), "true", "the outgoing words are hidden from assistive technology");
    assert.equal(lines[1]?.classList.contains("entering"), true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
    assert.equal(line().querySelectorAll(".activity-ticker-line").length, 1, "the leaving words are gone after their exit");
    assert.equal(summary.getAttribute("aria-expanded"), "false", "the block stays folded");
    await act(async () => summary.click());
    assert.equal(summary.getAttribute("aria-expanded"), "true", "a hand toggle still opens it");
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("the live line shares one grid cell, so a step never changes the block's height", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  assert.match(rule(".activity-ticker"), /display:\s*grid;/);
  assert.match(rule(".activity-ticker-line"), /grid-area:\s*1 \/ 1;/, "entering and leaving words stack in one cell");
  assert.match(rule(".activity-ticker-line"), /pointer-events:\s*none;/, "a line that re-keys is never the touch target");
  assert.match(rule(".activity-ticker-line.leaving"), /position:\s*absolute;/, "only the words on screen size the line");
  assert.match(rule(".activity-ticker"), /overflow-x:\s*clip;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.activity-ticker-line \{ animation: none !important; \}\s*\.activity-ticker-line\.leaving \{ display: none; \}/,
    "reduced motion changes the words in place");
  assert.match(css, /html\[data-reduce-animations="true"\] \.activity-ticker-line,\s*body\[data-desktop-low-resource="true"\] \.activity-ticker-line \{ animation: none !important; \}/);
});

test("a task-only block never takes the live line", async () => {
  const { viewport } = activityTimelineHost();
  const root = createRoot(viewport.querySelector(".timeline")!.firstElementChild!);
  const started = {
    kind: "task" as const,
    id: "task-start",
    taskId: "task-1",
    eventSeq: 1,
    action: "started" as const,
    text: "Inspect the layout",
    time: Date.now(),
  };
  try {
    await act(async () => root.render(createElement(ActivityGroupView, {
      g: activityGroup("activity-task-start", [started]),
      subagents: null,
      ticking: true,
    })));
    assert.equal(viewport.querySelector(".activity-ticker")?.getAttribute("data-ticker-entry"), "summary",
      "task lifecycle belongs to the session title and overview, not the block's line");
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("a reopened session never replays unfinished history in the conversation", async () => {
  // A turn that ended mid-action leaves `running` tools and unfinalized
  // assistant parts in history forever. Opening that session must not replay
  // them as live rows: an hours-old action must not be replayed on every open.
  const { viewport } = activityTimelineHost();
  const root = createRoot(viewport.querySelector(".timeline")!.firstElementChild!);
  const stale = tool({ status: "running", output: undefined, finishTime: undefined });
  const unfinalized = {
    kind: "assistant" as const,
    id: "part-35",
    partId: "part-35",
    eventSeq: 4,
    text: "Now I understand the full flow.",
    reasoning: "",
    finalized: false,
    time: 1_000,
  };
  const group = {
    ...activityGroup("activity-stale", [stale]),
    items: [stale, unfinalized],
    thoughts: [unfinalized],
    settled: false,
  };
  try {
    await act(async () => root.render(createElement(ActivityGroupView, { g: group, subagents: null })));
    const entry = () => viewport.querySelector(".activity-ticker")?.getAttribute("data-ticker-entry");
    assert.equal(entry(), "summary", "stale in-flight history mounts folded inside the block");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    assert.equal(entry(), "summary", "and nothing reappears a beat later either");
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("a restored group with history never replays its current action", async () => {
  // Cached reopen of a turn the reader left mid-flight: the group already
  // contains settled work plus a still-open action. That is restore, not the
  // first action of a new group, even when the open action is recent.
  const { viewport } = activityTimelineHost();
  const root = createRoot(viewport.querySelector(".timeline")!.firstElementChild!);
  const settled = tool({ id: "call-settled", callId: "call-settled" });
  const running = tool({
    id: "call-running",
    callId: "call-running",
    eventSeq: 2,
    status: "running",
    output: undefined,
    finishTime: undefined,
    time: Date.now(),
  });
  try {
    await act(async () => root.render(createElement(ActivityGroupView, {
      g: activityGroup("activity-restore", [settled, running]),
      subagents: null,
    })));
    assert.equal(viewport.querySelector(".activity-ticker")?.getAttribute("data-ticker-entry"), "summary",
      "a block that is not the working tail shows its summary even if one action is still open");
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("opening a finished turn does not replay activity over the answer", async () => {
  // The reported reopen: the agent has already answered, the reader opens the
  // chat, and a completed action whose timestamp is still inside the show
  // window reappears after that answer before folding into the block. Recency
  // alone would treat that as live; a finished item at mount is history.
  const { viewport } = activityTimelineHost();
  const root = createRoot(viewport.querySelector(".timeline")!.firstElementChild!);
  const recent = tool({ time: Date.now(), finishTime: Date.now() });
  try {
    await act(async () => root.render(createElement(ActivityGroupView, {
      g: activityGroup("activity-finished", [recent]),
      subagents: null,
    })));
    const entry = () => viewport.querySelector(".activity-ticker")?.getAttribute("data-ticker-entry");
    assert.equal(entry(), "summary", "a just-finished action mounts folded inside the block");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    assert.equal(entry(), "summary", "and does not reappear after the first frame");
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("an idle session does not treat reconcile suffix history as live arrivals", async () => {
  // Revisited chats paint the cached group immediately, then the append-only
  // suffix lands as new ids on the already-mounted group. Those rows are
  // history, not a live burst, even when their timestamps are "now".
  const { viewport } = activityTimelineHost();
  const root = createRoot(viewport.querySelector(".timeline")!.firstElementChild!);
  const cached = tool({ id: "call-cached", callId: "call-cached" });
  const suffix = tool({
    id: "call-suffix",
    callId: "call-suffix",
    eventSeq: 2,
    time: Date.now(),
    finishTime: Date.now(),
  });
  try {
    await act(async () => root.render(createElement(ActivityGroupView, {
      g: activityGroup("activity-cached", [cached]),
      subagents: null,
      livePresentation: false,
    })));
    const entry = () => viewport.querySelector(".activity-ticker")?.getAttribute("data-ticker-entry");
    assert.equal(entry(), "summary", "cached history mounts folded");
    await act(async () => root.render(createElement(ActivityGroupView, {
      g: activityGroup("activity-cached", [cached, suffix]),
      subagents: null,
      livePresentation: false,
    })));
    assert.equal(entry(), "summary", "the idle suffix does not rise over the conversation");
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("an idle reopen never presents a recent cached running tool", async () => {
  const { viewport } = activityTimelineHost();
  const root = createRoot(viewport.querySelector(".timeline")!.firstElementChild!);
  const running = tool({ status: "running", output: undefined, finishTime: undefined, time: Date.now() });
  try {
    await act(async () => root.render(createElement(ActivityGroupView, {
      g: activityGroup("activity-idle", [running]),
      subagents: null,
      livePresentation: false,
    })));
    assert.equal(viewport.querySelector(".activity-ticker")?.getAttribute("data-ticker-entry"), "summary",
      "a finished session does not resurrect cached in-flight rows");
    assert.equal(viewport.querySelector(".ui-run-summary")?.getAttribute("data-state"), "completed");
    for (const [error, expected] of [["Command failed", "failed"], ["Interrupted", "cancelled"]]) {
      await act(async () => root.render(createElement(ActivityGroupView, {
        g: activityGroup("activity-idle", [tool({ status: "error", error })]),
        subagents: null,
        livePresentation: false,
      })));
      assert.equal(viewport.querySelector(".ui-run-summary")?.getAttribute("data-state"), expected,
        "historical headers retain recorded errors");
    }
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("a hidden tab commits activity directly and never replays it on return", async () => {
  const { viewport } = activityTimelineHost();
  const root = createRoot(viewport.querySelector(".timeline")!.firstElementChild!);
  const settled = tool({ id: "call-visible", callId: "call-visible" });
  const running = tool({ id: "call-hidden", callId: "call-hidden", status: "running", output: undefined, finishTime: undefined, time: Date.now() });
  const previous = Object.getOwnPropertyDescriptor(document, "hidden");
  try {
    await act(async () => root.render(createElement(ActivityGroupView, {
      g: activityGroup("activity-hidden", [settled]),
      subagents: null,
    })));

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event));
    await act(async () => root.render(createElement(ActivityGroupView, {
      g: activityGroup("activity-hidden", [settled, running]),
      subagents: null,
    })));
    const entry = () => viewport.querySelector(".activity-ticker")?.getAttribute("data-ticker-entry");
    assert.equal(entry(), "summary", "activity arriving while hidden is rendered in its final folded position");

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event));
    assert.equal(entry(), "summary", "returning to the tab does not replay missed flight");
  } finally {
    if (previous) Object.defineProperty(document, "hidden", previous);
    else delete (document as unknown as { hidden?: boolean }).hidden;
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("a burst of steps never queues: the line skips straight to the newest one", async () => {
  const { viewport } = activityTimelineHost();
  const root = createRoot(viewport.querySelector(".timeline")!.firstElementChild!);
  const settled = tool();
  // A fast tool can be called and answered inside one render batch, so it is
  // never observed running; the line still names it, for one dwell at most.
  const fast = tool({ id: "call-2", callId: "call-2" });
  const next = tool({ id: "call-3", callId: "call-3", input: { command: "npm test" } });
  const group = (items: ToolMsg[]) => activityGroup("activity-fast", items);
  const entry = () => viewport.querySelector(".activity-ticker")?.getAttribute("data-ticker-entry");
  try {
    await act(async () => root.render(createElement(ActivityGroupView, { g: group([settled]), subagents: null, ticking: true })));
    assert.equal(entry(), settled.id);
    await act(async () => root.render(createElement(ActivityGroupView, { g: group([settled, fast]), subagents: null, ticking: true })));
    await act(async () => root.render(createElement(ActivityGroupView, { g: group([settled, fast, next]), subagents: null, ticking: true })));
    assert.equal(entry(), settled.id, "the line on screen keeps its dwell");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 950)); });
    assert.equal(entry(), next.id, "a stale step is never narrated after the agent moved past it");
    assert.match(viewport.querySelector(".activity-ticker-line:not(.leaving)")?.textContent ?? "", /Run tests/);
    assert.equal(viewport.querySelector(".ui-run-summary")?.getAttribute("aria-expanded"), "false",
      "the block stays folded while its line names the steps");
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("an action batch stays closed by default and opens on hand toggle", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const message = tool();
  const group = activityGroup("activity-batch", [message]);
  try {
    await act(async () => root.render(createElement(ActivityGroupView, { g: group, subagents: null })));
    const toggle = container.querySelector<HTMLButtonElement>(".ui-run-summary")!;
    assert.equal(toggle.getAttribute("aria-expanded"), "false", "the batch is folded by default");
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "true", "hand toggle opens it");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("implementation groups show combined added and removed line counts", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const edit = tool({
    tool: "edit",
    input: { filePath: "src/a.ts", oldString: "x", newString: "y" },
  });
  const write = tool({
    id: "call-2",
    callId: "call-2",
    eventSeq: 2,
    tool: "write",
    input: { filePath: "src/b.ts", content: "hi" },
  });
  const group = activityGroup("activity-edits", [edit, write]);
  try {
    await act(async () => root.render(createElement(ActivityGroupView, { g: group, subagents: null })));
    assert.match(container.querySelector(".ui-run-summary-diff")?.textContent ?? "", /\+2/);
    assert.match(container.querySelector(".ui-run-summary-diff")?.textContent ?? "", /−1/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("MCP and subagent executions render normalized first-class details", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      setSessions("execution-ui-test", [
        {
          id: "parent-1",
          projectId: "execution-ui-test",
          title: "Root implementation",
          status: "idle",
          model: { providerID: "openai", modelID: "gpt-5" },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "child-1",
          projectId: "execution-ui-test",
          parentId: "parent-1",
          title: "Responsive UI reviewer",
          status: "idle",
          model: { providerID: "anthropic", modelID: "claude-sonnet" },
          createdAt: 2,
          updatedAt: 2,
        },
      ]);
      activateSession("parent-1");
    });
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({
        tool: "mcp__github__get_pull_request",
        input: { owner: "otto-assistant", repo: "polyth", number: 42 },
        output: JSON.stringify({ title: "Fix execution UI", status: "open", nested: { raw: true } }),
      }),
    })));
    const mcpSummary = container.querySelector<HTMLButtonElement>(".execution-summary")!;
    if (mcpSummary.getAttribute("aria-expanded") !== "true") {
      await act(async () => mcpSummary.click());
    }
    const result = container.querySelector(".execution-mcp");
    assert.match(result?.textContent ?? "", /Title.*Fix execution UI.*Status.*Open/s);
    assert.doesNotMatch(result?.textContent ?? "", /"nested"|"raw"/);
    assert.match(container.querySelector(".execution-metadata")?.textContent ?? "", /View raw result/);

    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({
        tool: "task",
        input: { description: "Review responsive UI", prompt: "Check mobile geometry" },
        output: "complete",
      }),
      subagent: {
        sessionId: "child-1",
        label: "Responsive UI reviewer",
        status: "done",
        currentTask: "Checked 390px and 1280px",
      },
    })));
    const subagentSummary = container.querySelector<HTMLButtonElement>(".execution-summary")!;
    if (subagentSummary.getAttribute("aria-expanded") !== "true") {
      await act(async () => subagentSummary.click());
    }
    assert.match(
      container.querySelector(".execution-subagent-detail")?.textContent ?? "",
      /Responsive UI reviewer.*Completed.*Checked 390px and 1280px.*Model.*(?:claude-sonnet|Claude Sonnet).*Parent.*Root implementation.*Open child session/s,
    );
  } finally {
    await act(async () => {
      activateSession(null);
      setSessions("execution-ui-test", []);
    });
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a wrapped todo call renders as a plan checklist, not as transport fields", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({
        tool: "call_mcp_tool",
        input: {
          ServerName: "polyth-agent-tools",
          ToolName: "polyth_todo",
          Arguments: { merge: true, todos: [{ id: "1", status: "completed" }] },
        },
        output: [
          "Todos (1/3 completed):",
          "[x] 1: Investigate session failure",
          "[>] 2: Inspect session debug data",
          "[ ] 3: Explain why the session failed",
        ].join("\n"),
        metadata: {},
      }),
    })));
    const summary = container.querySelector<HTMLButtonElement>(".execution-summary")!;
    assert.equal(summary.querySelector(".tool-name")?.textContent, "Plan updated");
    assert.equal(summary.querySelector(".tool-preview")?.textContent, "Done · Investigate session failure");
    if (summary.getAttribute("aria-expanded") !== "true") await act(async () => summary.click());
    const plan = container.querySelector(".execution-todo")!;
    assert.match(plan.querySelector(".execution-todo-count")?.textContent ?? "", /1 of 3 done/);
    assert.equal(plan.querySelector(".execution-todo-meter")?.getAttribute("aria-valuenow"), "1");
    const rows = [...plan.querySelectorAll(".execution-todo-list li")];
    assert.deepEqual(rows.map((row) => row.className), ["done changed", "active", "pending"]);
    assert.deepEqual(rows.map((row) => row.querySelector(".execution-todo-text")?.textContent), [
      "Investigate session failure",
      "Inspect session debug data",
      "Explain why the session failed",
    ]);
    const details = container.querySelector(".execution-details")?.textContent ?? "";
    assert.doesNotMatch(details, /ServerName|ToolName|Arguments|call_mcp_tool|polyth-agent-tools|\[x\]|\[>\]/);
    assert.match(container.querySelector(".execution-metadata")?.textContent ?? "", /View raw result/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a subagent action opens while its canonical projection is still syncing", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const child = {
    id: "canonical-child",
    projectId: "execution-child-open-test",
    parentId: "parent-child-open",
    backendSessionId: "backend-child",
    title: "Child session",
    status: "working" as const,
    createdAt: 2,
    updatedAt: 2,
  };
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/sessions/backend-child") {
        return new Response(JSON.stringify({ error: "not-found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/api/sessions" && url.searchParams.get("projectId") === child.projectId) {
        return new Response(JSON.stringify([child]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/api/sessions/canonical-child/events") {
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${url.pathname}${url.search}`);
    };
    activateProject(child.projectId);
    setSessions(child.projectId, []);
    activateSession("parent-child-open");
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({ tool: "task", status: "running", output: undefined }),
      subagent: {
        sessionId: child.backendSessionId,
        label: "Research helper",
        status: "running",
      },
    })));
    await act(async () => container.querySelector<HTMLButtonElement>(".execution-summary")!.click());

    const open = container.querySelector<HTMLButtonElement>(".execution-subagent-detail > button");
    assert.ok(open);
    assert.equal(open.disabled, false, "the unresolved child action remains clickable");
    await act(async () => {
      open!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(getState().activeSessionId, child.id);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => {
      activateSession(null);
      setSessions(child.projectId, []);
      activateProject(null);
    });
    await act(async () => root.unmount());
    container.remove();
  }
});

test("search results open the matching file and line from inline detail", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({
        tool: "grep",
        input: { pattern: "ExecutionRow" },
        output: "apps/web/src/components/ExecutionRow.tsx:42:function ExecutionIcon",
      }),
    })));
    await act(async () => container.querySelector<HTMLButtonElement>(".execution-summary")!.click());
    const result = container.querySelector<HTMLButtonElement>(".execution-search-list button");
    assert.ok(result);
    assert.match(result.textContent ?? "", /ExecutionRow\.tsx:42.*ExecutionIcon/s);
    await act(async () => result.click());
    assert.equal(getState().editorFile, "apps/web/src/components/ExecutionRow.tsx");
    assert.deepEqual(getState().editorLocation, {
      path: "apps/web/src/components/ExecutionRow.tsx",
      startLine: 42,
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("approval keeps the target and three decisions in one compact row without provider decoration", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [{
        sessionId: "session-1",
        requestId: "permission-1",
        permission: "edit",
        tool: "Shell",
        patterns: ["rm -rf apps/web/dist"],
        status: "pending",
        time: 1,
        preview: { title: "Edit", lines: ["apps/web/dist"], risk: "medium" },
      }],
    })));
    const banner = container.querySelector(".perm-banner");
    assert.ok(banner);
    assert.equal(banner.getAttribute("role"), "alert");
    assert.match(container.querySelector(".perm-title")?.textContent ?? "", /Permission requested/);
    assert.equal(container.querySelector(".permission-request-title"), null, "a generic Edit label does not get its own row");
    assert.equal(container.querySelector(".permission-request-tool"), null);
    assert.equal(container.querySelector(".permission-risk"), null);
    assert.match(container.querySelector(".permission-preview")?.textContent ?? "", /apps\/web\/dist/);
    const actions = container.querySelector(".perm-actions");
    assert.ok(actions);
    assert.match(actions.textContent ?? "", /Deny.*Allow.*Auto approve/s);
    assert.equal(actions.children.length, 3);
    const allow = container.querySelector<HTMLButtonElement>(".perm-actions .permission-allow");
    const deny = container.querySelector<HTMLButtonElement>(".perm-actions .permission-deny");
    assert.ok(allow && allow.textContent?.includes("Allow"));
    assert.ok(deny && deny.textContent?.includes("Deny"));
    assert.equal(container.querySelector(".permission-always"), null);
    assert.match(container.querySelector(".permission-session")?.getAttribute("aria-label") ?? "", /approve.*action/i);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a high-risk approval names why Auto-Approve held it and offers Deny, Allow, or Allow all", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [{
        sessionId: "session-1",
        requestId: "permission-risky",
        permission: "bash",
        patterns: ["git push --force origin main"],
        status: "pending",
        time: 1,
        preview: {
          title: "bash",
          lines: ["git push --force origin main"],
          risk: "high",
          // A code from a newer server is skipped, never shown raw.
          reasons: ["history-rewrite", "future-reason"],
        },
      }],
    })));
    const note = container.querySelector(".permission-risk");
    assert.ok(note, "the hold is explained on the card");
    assert.equal(note.getAttribute("role"), "note");
    assert.match(note.textContent ?? "", /High risk/);
    assert.deepEqual(
      [...note.querySelectorAll("li")].filter((item) => !item.closest(".permission-blast")).map((item) => item.textContent),
      ["Rewrites or deletes Git history on a remote"],
    );
    // The blast radius explains what the held request would touch.
    assert.deepEqual(
      [...note.querySelectorAll(".permission-blast li")].map((item) => item.textContent),
      ["Force-pushes main to origin, replacing its history"],
    );
    const actions = container.querySelector(".perm-actions");
    assert.equal(actions?.children.length, 3);
    assert.equal(container.querySelector(".permission-session"), null, "Auto approve cannot resolve a held request");
    assert.ok(container.querySelector(".permission-allow"));
    assert.ok(container.querySelector(".permission-deny"));
    assert.equal(container.querySelector(".permission-allow-all")?.textContent, "Allow all");
    // A peer on the same row, bounded like the others, but never the primary.
    const allowAll = container.querySelector(".permission-allow-all");
    assert.ok(allowAll?.classList.contains("ui-btn--quiet"));
    assert.ok(!allowAll?.classList.contains("ui-btn--primary"));
    assert.ok(container.querySelector(".permission-deny")?.classList.contains("ui-btn--danger"));
    assert.ok(container.querySelector(".permission-allow")?.classList.contains("ui-btn--primary"));
    assert.equal(actions?.children.length, 3, "all three decisions share one row");
    assert.equal(actions?.lastElementChild, allowAll);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a composer-shell confirmation offers only Deny and Allow because no policy answers it", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [{
        sessionId: "session-1",
        requestId: "permission-shell",
        permission: "shell",
        patterns: ["rm -rf ~/Downloads/old"],
        tool: "shell",
        manual: true,
        status: "pending",
        time: 1,
        preview: { title: "shell", lines: ["rm -rf ~/Downloads/old"], risk: "high", reasons: ["destructive-delete"] },
      }],
    })));
    assert.ok(container.querySelector(".permission-risk"), "the risk is still explained");
    assert.equal(container.querySelector(".perm-actions")?.children.length, 2);
    assert.ok(container.querySelector(".permission-deny"));
    assert.ok(container.querySelector(".permission-allow"));
    assert.equal(container.querySelector(".permission-session"), null);
    assert.equal(container.querySelector(".permission-allow-all"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the auto-approve control reflects the session's real level wherever it is placed", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; body: string }> = [];
  const project = { id: "approval-owner", path: "/workspace", name: "Approval owner", createdAt: 1 };
  const session = (flags: { autoAccept?: boolean; autoAcceptAll?: boolean }) => ({
    id: "approval-session", projectId: project.id, title: "Approvals", status: "idle" as const, createdAt: 1, updatedAt: 1, ...flags,
  });
  try {
    globalThis.fetch = async (_input, init) => {
      requests.push({ method: String(init?.method ?? "GET"), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ setting: "off", effective: false, level: "off" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    applyProjectUpsert(project);
    activateProject(project.id);
    // The session header supplies only the session id; the control must read
    // the canonical projection instead of always showing "Turn on".
    setSessions(project.id, [session({})]);
    const headerContext = {
      projectId: project.id, sessionId: "approval-session", editing: false, instanceId: "header-auto-approve",
      config: {}, updateConfig: () => {},
    };
    await act(async () => root.render(createElement(AutoApproveAction, { context: headerContext })));
    const button = () => container.querySelector<HTMLButtonElement>(".composer-auto-approve")!;
    const options = () => [...document.querySelectorAll<HTMLButtonElement>(".approval-level-option")];
    const pick = async (index: number) => {
      await act(async () => button().click());
      await act(async () => options()[index]!.click());
    };
    assert.equal(button().getAttribute("aria-label"), "Approval level: Ask for each action");
    assert.equal(button().getAttribute("aria-pressed"), "false");
    assert.equal(button().getAttribute("aria-expanded"), "false");
    // A click opens the level picker instead of stepping through levels.
    await act(async () => button().click());
    assert.equal(button().getAttribute("aria-expanded"), "true");
    assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["true", "false", "false"]);
    assert.equal(document.activeElement, options()[0], "focus lands on the current level");
    // Icon-only switch: names live in labels/tooltips, never as resizing copy.
    assert.equal(document.querySelector(".approval-level-pop")?.textContent, "");
    assert.deepEqual(options().map((option) => option.getAttribute("aria-label")), ["Ask for each action", "Auto-approve", "Full access"]);
    await act(async () => options()[2]!.focus());
    // Arrow keys move within the radio group; nothing is sent until a choice.
    let sent = requests.length;
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    assert.equal(document.activeElement, options()[0], "arrows wrap around");
    assert.equal(requests.length, sent);
    await act(async () => options()[1]!.click());
    assert.equal(options().length, 0, "choosing closes the picker");
    assert.deepEqual(requests.at(-1), { method: "PATCH", body: JSON.stringify({ setting: "on" }) });

    await act(async () => setSessions(project.id, [session({ autoAccept: true })]));
    assert.equal(button().getAttribute("aria-label"), "Approval level: Auto-approve");
    assert.equal(button().getAttribute("aria-pressed"), "true");
    assert.equal(button().classList.contains("full"), false);
    // Picking the current level again changes nothing.
    sent = requests.length;
    await pick(1);
    assert.equal(requests.length, sent);
    // Full access always asks first; cancelling changes nothing.
    await pick(2);
    await act(async () => { resolveAlert(false); });
    assert.equal(requests.length, sent);
    await pick(2);
    await act(async () => { resolveAlert(true); });
    assert.deepEqual(requests.at(-1), { method: "PATCH", body: JSON.stringify({ setting: "all" }) });

    // Full access reads as a warning; the picker jumps straight back to Ask.
    await act(async () => setSessions(project.id, [session({ autoAccept: true, autoAcceptAll: true })]));
    assert.equal(button().getAttribute("aria-label"), "Approval level: Full access");
    assert.equal(button().classList.contains("full"), true);
    await pick(0);
    assert.deepEqual(requests.at(-1), { method: "PATCH", body: JSON.stringify({ setting: "off" }) });

    // Escape dismisses the picker without a change.
    await act(async () => setSessions(project.id, [session({ autoAccept: false })]));
    sent = requests.length;
    await act(async () => button().click());
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    assert.equal(options().length, 0);
    assert.equal(requests.length, sent);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    container.remove();
    activateProject(null);
    setSessions(project.id, []);
  }
});

test("a new chat's auto-approve control picks the draft's level without a session", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const chosen: string[] = [];
  const render = (flags: { autoApproveOn: boolean; autoApproveAll: boolean }) => act(async () => root.render(
    createElement(AutoApproveAction, {
      context: {
        projectId: "draft-project", sessionId: null, editing: false, instanceId: "composer-auto-approve", config: {}, updateConfig: () => {},
        ...flags, setDraftAutoApprove: (setting: string) => chosen.push(setting),
      },
    }),
  ));
  const button = () => container.querySelector<HTMLButtonElement>(".composer-auto-approve")!;
  const pick = async (index: number) => {
    await act(async () => button().click());
    await act(async () => document.querySelectorAll<HTMLButtonElement>(".approval-level-option")[index]!.click());
  };
  try {
    globalThis.fetch = async (input) => { requests.push(String(input)); return new Response("{}", { status: 200 }); };
    await render({ autoApproveOn: false, autoApproveAll: false });
    await pick(1);
    await render({ autoApproveOn: true, autoApproveAll: false });
    await pick(2);
    await act(async () => { resolveAlert(true); });
    await render({ autoApproveOn: true, autoApproveAll: true });
    await pick(0);
    assert.deepEqual(chosen, ["on", "all", "off"]);
    assert.deepEqual(
      requests.filter((url) => url !== "/api/permissions/defaults"),
      [],
      "there is no session to patch before the chat is created",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a new chat follows the Space's Full access default until a level is picked", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ level: "all", projects: {}, canEdit: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await act(async () => { await loadApprovalDefaults(true); });
    const draft = (flags: Record<string, boolean>) => act(async () => root.render(createElement(AutoApproveAction, {
      context: {
        projectId: "draft-project", sessionId: null, editing: false, instanceId: "composer-auto-approve", config: {}, updateConfig: () => {},
        ...flags, setDraftAutoApprove: () => {},
      },
    })));
    const button = () => container.querySelector<HTMLButtonElement>(".composer-auto-approve")!;
    await draft({});
    assert.ok(button().classList.contains("full"), "no level picked: the Space default shows");
    await draft({ autoApproveOn: false, autoApproveAll: false });
    assert.ok(!button().classList.contains("on"), "a picked level wins over the default");
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => { await loadApprovalDefaults(true).catch(() => {}); });
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a mirrored card's session approval changes the subagent's policy, not the parent's", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalSet = api.autoAcceptSet;
  const targets: string[] = [];
  try {
    api.autoAcceptSet = async (sessionId, setting) => {
      targets.push(`${sessionId}:${setting}`);
      return { setting, effective: true, level: "routine" };
    };
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [{
        sessionId: "parent-chat",
        requestId: "node-request",
        permission: "bash",
        patterns: ["npm test"],
        status: "pending" as const,
        time: 1,
        sourceSessionId: "workflow-node",
        preview: { title: "bash", lines: ["npm test"], risk: "medium" as const },
      }],
    })));
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-session")!.click());
    assert.deepEqual(targets, ["workflow-node:on"]);
  } finally {
    api.autoAcceptSet = originalSet;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Allow all turns on Full access only after an explicit confirmation", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), method: String(init?.method ?? "GET"), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ setting: "all", effective: true, level: "all" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [{
        sessionId: "session-1",
        requestId: "permission-held",
        permission: "bash",
        patterns: ["rm -rf ~/Documents"],
        status: "pending" as const,
        time: 1,
        preview: { title: "bash", lines: ["rm -rf ~/Documents"], risk: "high" as const, reasons: ["destructive-delete"] },
      }],
    })));
    const allowAll = () => container.querySelector<HTMLButtonElement>(".permission-allow-all")!;
    // Cancelling the confirmation changes nothing.
    await act(async () => allowAll().click());
    await act(async () => { resolveAlert(false); });
    assert.deepEqual(requests, []);
    await act(async () => allowAll().click());
    await act(async () => { resolveAlert(true); });
    assert.deepEqual(requests, [{
      url: "/api/sessions/session-1/permissions/auto-accept",
      method: "PATCH",
      body: JSON.stringify({ setting: "all" }),
    }]);
    // Hidden at the click; a request the policy leaves open returns after
    // the settle grace (permissionReplyOptimistic.test.ts).
    assert.equal(container.querySelectorAll(".permission-request").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("matching approval requests share one row and a decision resolves every displayed request", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalReply = api.replyPermission;
  const replies: unknown[][] = [];
  const permission = {
    sessionId: "session-1", permission: "package-tool", tool: "polyth_peer",
    patterns: ["harness-runtime.peer-observations"], status: "pending" as const, time: 1,
    preview: { title: "package-tool via polyth_peer", lines: ["harness-runtime.peer-observations"] },
  };
  try {
    api.replyPermission = async (...args) => { replies.push(args); };
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [
        { ...permission, requestId: "permission-1" },
        { ...permission, requestId: "permission-2" },
      ],
    })));
    assert.equal(container.querySelectorAll(".permission-request").length, 1);
    assert.match(container.querySelector(".permission-request-count")?.textContent ?? "", /2/);
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-allow")!.click());
    assert.deepEqual(replies, [
      ["session-1", "permission-1", "once"],
      ["session-1", "permission-2", "once"],
    ]);
    assert.equal(container.querySelectorAll(".permission-request").length, 0);
  } finally {
    api.replyPermission = originalReply;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("matching approval groups apply deny and allow to every request", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalReply = api.replyPermission;
  const replies: unknown[][] = [];
  try {
    api.replyPermission = async (...args) => { replies.push(args); };
    for (const [selector, action] of [
      [".permission-deny", "reject"],
      [".permission-allow", "once"],
    ] as const) {
      const permissions = ["first", "last"].map((requestId) => ({
        sessionId: action, requestId, permission: "edit", patterns: ["src/app.ts"],
        status: "pending" as const, time: 1, allowedScopes: ["once", "project"] as Array<"once" | "project">,
      }));
      await act(async () => root.render(createElement(PermissionBanner, { permissions })));
      await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
      assert.deepEqual(replies.splice(0), [
        [action, "first", action], [action, "last", action],
      ]);
    }
  } finally {
    api.replyPermission = originalReply;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a partial approval failure retries only unconfirmed requests", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalReply = api.replyPermission;
  const replies: string[] = [];
  const permissions = ["first", "last"].map((requestId) => ({
    sessionId: "session-1", requestId, permission: "edit", patterns: ["src/app.ts"],
    status: "pending" as const, time: 1,
  }));
  let fail = true;
  try {
    api.replyPermission = async (_sessionId, requestId) => {
      replies.push(requestId);
      if (requestId === "last" && fail) throw new Error("Reply failed");
    };
    await act(async () => root.render(createElement(PermissionBanner, { permissions })));
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-allow")!.click());
    assert.match(container.querySelector(".permission-error")?.textContent ?? "", /Reply failed/);
    assert.equal(container.querySelector(".permission-request-count"), null, "only the unanswered request remains");
    assert.equal(container.querySelectorAll(".perm-actions button:disabled").length, 0);
    fail = false;
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-allow")!.click());
    assert.deepEqual(replies, ["first", "last", "last"]);
    assert.equal(container.querySelectorAll(".permission-request").length, 0);
  } finally {
    api.replyPermission = originalReply;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a reply in flight never blocks a later arrival, which needs its own click", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalReply = api.replyPermission;
  const replies: string[] = [];
  const permissions = ["first", "last", "new"].map((requestId) => ({
    sessionId: "session-1", requestId, permission: "edit", patterns: ["src/app.ts"],
    status: "pending" as const, time: 1,
  }));
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  try {
    api.replyPermission = async (_sessionId, requestId) => {
      replies.push(requestId);
      if (requestId === "last") await waiting;
    };
    await act(async () => root.render(createElement(PermissionBanner, { permissions: permissions.slice(0, 2) })));
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-allow")!.click());
    // The first canonical response disappears and a new matching request arrives
    // while the second response is still in flight.
    await act(async () => root.render(createElement(PermissionBanner, { permissions: permissions.slice(1) })));
    assert.deepEqual(replies, ["first", "last"]);
    assert.equal(container.querySelectorAll(".permission-request").length, 1);
    assert.equal(container.querySelector(".permission-request-count"), null, "only the new arrival shows");
    assert.equal(container.querySelectorAll(".perm-actions button:disabled").length, 0);
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-allow")!.click());
    assert.deepEqual(replies, ["first", "last", "new"]);
    await act(async () => release());
    assert.equal(container.querySelectorAll(".permission-request").length, 0);
  } finally {
    release();
    api.replyPermission = originalReply;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("all-session approval enables canonical auto-accept instead of remembering one pattern", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ setting: "on", effective: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: ["permission-1", "permission-2"].map((requestId) => ({
        sessionId: "session/all",
        requestId,
        permission: "edit",
        patterns: ["src/*"],
        status: "pending" as const,
        time: 1,
      })),
    })));
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-session")!.click());
    assert.deepEqual(requests, [{
      url: "/api/sessions/session%2Fall/permissions/auto-accept",
      method: "PATCH",
      body: JSON.stringify({ setting: "on" }),
    }]);
    assert.equal(container.querySelectorAll(".permission-request").length, 0, "the card hides before canonical request resolutions");
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a failed session-wide approval keeps every decision available and explains the failure", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "Could not update approval policy" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [{
        sessionId: "session-1",
        requestId: "permission-1",
        permission: "edit",
        patterns: ["src/*"],
        status: "pending",
        time: 1,
      }],
    })));
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-session")!.click());
    assert.match(container.querySelector(".permission-error")?.textContent ?? "", /Could not update approval policy/);
    assert.equal(container.querySelectorAll(".perm-actions button:disabled").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("browser approval names the browser and its bounded capabilities", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [{
        sessionId: "session-browser",
        requestId: "permission-browser",
        permission: "package-tool",
        tool: "polyth_browser",
        patterns: ["browser.polyth-browser"],
        status: "pending",
        time: 1,
      }],
    })));
    assert.match(container.querySelector(".permission-request-title")?.textContent ?? "", /Agent wants to use Browser/);
    assert.match(container.querySelector(".permission-browser-capabilities")?.textContent ?? "", /read visible content/i);
    assert.equal(container.querySelector(".permission-request-tool"), null);
    assert.match(container.querySelector(".perm-actions")?.textContent ?? "", /Deny.*Allow.*Auto approve/s);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("command permission requests render with terminal syntax highlighting", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [{
        sessionId: "session-cmd",
        requestId: "permission-cmd",
        permission: "bash",
        tool: "run_command",
        patterns: ["git status --short"],
        status: "pending",
        time: 1,
        preview: { title: "bash", lines: ["git status --short"] },
      }],
    })));
    const terminal = container.querySelector(".permission-terminal");
    assert.ok(terminal, "command preview should have permission-terminal class");
    assert.equal(container.querySelector(".permission-terminal-header"), null, "no decorative window chrome");
    assert.ok(container.querySelector(".permission-terminal-prompt"), "should show terminal prompt");
    const code = container.querySelector(".permission-terminal-code");
    assert.ok(code);
    assert.match(code.textContent ?? "", /git status --short/);
    assert.ok(code.innerHTML.includes("tok-"), "should contain syntax highlighting tokens");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("MCP permission requests render with human-readable server, tool, and parameters", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [{
        sessionId: "session-mcp",
        requestId: "permission-mcp",
        permission: "package-tool",
        tool: "mcp__github__create_pull_request",
        patterns: ['{"owner": "facebook", "repo": "react", "title": "fix: render bug"}'],
        status: "pending",
        time: 1,
        preview: {
          title: "package-tool via mcp__github__create_pull_request",
          lines: ['{"owner": "facebook", "repo": "react", "title": "fix: render bug"}'],
        },
      }],
    })));
    const mcp = container.querySelector(".permission-mcp");
    assert.ok(mcp, "MCP preview should have permission-mcp class");
    assert.equal(container.querySelector(".permission-mcp-server")?.textContent, "GitHub");
    assert.equal(container.querySelector(".permission-request-title"), null, "the raw provider title is not repeated above the MCP preview");
    assert.match(container.querySelector(".permission-mcp-tool")?.textContent ?? "", /Create Pull Request/);
    const text = mcp.textContent ?? "";
    assert.match(text, /Owner.*facebook/);
    assert.match(text, /Repository.*react/);
    assert.match(text, /Title.*fix: render bug/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("permission decisions remain a single row in narrow containers", async () => {
  const css = await readFile(new URL("../../../packages/permissions/widgets/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.perm-banner \.perm-actions\s*\{\s*display:\s*grid;\s*min-width:\s*0;\s*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/);
  const compact = css.slice(css.indexOf("@container permission-banner (max-width: 420px)"));
  assert.doesNotMatch(compact, /grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test("pending approval banners stay pinned while the conversation scrolls", async () => {
  const css = await readFile(new URL("../../../packages/permissions/widgets/styles.css", import.meta.url), "utf8");
  const toast = css.match(/\.perm-banner\.permission-toast\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(toast, /position:\s*sticky/);
  assert.match(toast, /inset-block-end:\s*0/);
});

// The card is pinned inside the transcript beside Chat bubbles and notices, so
// it takes their card radius instead of GlassDock's rounder dock/island role.
test("the pinned permission card matches the transcript card radius", async () => {
  const css = await readFile(new URL("../../../packages/permissions/widgets/styles.css", import.meta.url), "utf8");
  const toast = css.match(/\.perm-banner\.permission-toast\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(toast, /border-radius:\s*var\(--radius-card\)/);
  assert.doesNotMatch(toast, /--radius-dock/);
});

test("the permission decisions stay one row whatever the policy action", async () => {
  const css = await readFile(new URL("../../../packages/permissions/widgets/styles.css", import.meta.url), "utf8");
  // No rule may force the held card into two columns or throw Allow all onto
  // its own full-width line; the row stays one line of equal controls.
  assert.doesNotMatch(css, /perm-actions:has\(> \.permission-allow-all\)/);
  assert.doesNotMatch(css, /\.permission-allow-all[^}]*grid-column/);
});

test("native full-list todo tools read as a plan update, not a file write", () => {
  const todos = [{ content: "Collect changes", status: "completed" }, { content: "Group by area", status: "in_progress" }, { content: "Write notes", status: "pending" }];
  for (const name of ["todo_write", "TodoWrite", "todowrite", "update_plan"]) {
    const presentation = executionPresentation(tool({ tool: name, input: { todos } }));
    assert.equal(classifyTool(name, { todos }), "tool", name);
    assert.equal(presentation.label, "Plan", name);
    assert.equal(presentation.preview, "1/3 done · Group by area", name);
    assert.equal(presentation.files, undefined, name);
  }
  // An ordinary write tool keeps its file presentation.
  assert.equal(classifyTool("write", { file_path: "notes.md", content: "x" }), "write");
  assert.equal(executionPresentation(tool({ tool: "todo_write", input: {} })).preview, "todo_write");
});

test("with motion off the live line still keeps its dwell; it only changes in place", async () => {
  const { viewport } = activityTimelineHost();
  const root = createRoot(viewport.querySelector(".timeline")!.firstElementChild!);
  const first = tool({ id: "call-a", callId: "call-a", status: "running", output: undefined, finishTime: undefined, time: Date.now() });
  const next = tool({ id: "call-b", callId: "call-b", input: { command: "npm test" }, status: "running", output: undefined, finishTime: undefined, time: Date.now() });
  document.documentElement.dataset.reduceAnimations = "true";
  const entry = () => viewport.querySelector(".activity-ticker")?.getAttribute("data-ticker-entry");
  try {
    await act(async () => root.render(createElement(ActivityGroupView, { g: activityGroup("activity-reduced", [first]), subagents: null, ticking: true })));
    await act(async () => root.render(createElement(ActivityGroupView, { g: activityGroup("activity-reduced", [first, next]), subagents: null, ticking: true })));
    assert.equal(entry(), "call-a", "a burst never strobes through its steps");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 950)); });
    assert.equal(entry(), "call-b");
    assert.equal(viewport.querySelectorAll(".activity-ticker-line").length, 1, "nothing leaves: the words change in place");
  } finally {
    delete document.documentElement.dataset.reduceAnimations;
    await act(async () => root.unmount());
    viewport.remove();
  }
});
