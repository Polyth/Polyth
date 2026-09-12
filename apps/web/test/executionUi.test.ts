import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import {
  classifyTool,
  cleanShellCommand,
  compactUrl,
  executionGroupLabel,
  executionPathParts,
  executionPresentation,
  middleTruncatePath,
  normalizedMcpResult,
  normalizedInputEntries,
  reasoningHead,
  reasoningTail,
} from "../src/execution.ts";
import type { TaskActivityMsg, ToolMsg } from "../src/reduce.ts";

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
    compactUrl("https://github.com/otto-assistant/polyth/pull/2693?tab=files"),
    "github.com/otto-assistant/polyth/pull/2693",
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

  const packageTool = executionPresentation(tool({
    tool: "polyth-agent-tools_personal-coach_coach-propose-goal-af6bc22515351df5",
    input: { title: "Build strength" },
  }));
  assert.equal(packageTool.kind, "tool");
  assert.notEqual(packageTool.label, "Subagent");
  assert.equal(classifyTool(
    "mcp__polyth-agent-tools__personal-coach_coach-propose-goal-af6bc22515351df5",
    {},
  ), "tool");
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

test("MCP results expose human fields without rendering inline JSON", () => {
  assert.deepEqual(normalizedMcpResult(JSON.stringify({
    data: {
      title: "Fix execution UI",
      status: "open",
      number: 42,
      html_url: "https://github.com/otto-assistant/polyth/pull/42",
      author: { login: "octocat" },
      files: [{ filename: "ExecutionRow.tsx" }],
    },
  })), [
    { key: "Title", value: "Fix execution UI" },
    { key: "Status", value: "open" },
    { key: "Number", value: "42" },
    {
      key: "Html Url",
      value: "https://github.com/otto-assistant/polyth/pull/42",
      href: "https://github.com/otto-assistant/polyth/pull/42",
    },
    { key: "Author", value: "octocat" },
    { key: "Files", value: "1 item" },
    { key: "Files 1", value: "ExecutionRow.tsx" },
  ]);
  assert.deepEqual(normalizedMcpResult(JSON.stringify([
    { title: "Fix execution UI", html_url: "https://github.com/polyth/pull/42" },
    { name: "Responsive polish", url: "https://linear.app/polyth/issue/UX-7" },
  ])), [
    { key: "Items", value: "2 items" },
    {
      key: "Item 1",
      value: "Fix execution UI",
      href: "https://github.com/polyth/pull/42",
    },
    {
      key: "Item 2",
      value: "Responsive polish",
      href: "https://linear.app/polyth/issue/UX-7",
    },
  ]);
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
});

test("execution code surfaces override the global prose font preference", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const override = css.match(/html\[data-font\] body :is\([\s\S]*?execution-viewer > pre[\s\S]*?\)\s*\{\s*font-family:\s*var\(--mono\);\s*\}/);
  assert.ok(override, "commands, output, diffs, and the full viewer retain the monospace font");
  assert.match(css, /\.activity-group-expand-shell,\s*\.task-list-expand-shell\s*\{[\s\S]*?width:\s*100%;[\s\S]*?align-self:\s*stretch;/,
    "activity details stretch with the chat column instead of using content width");
  assert.match(css, /\.execution-group-items\s*\{[\s\S]*?width:\s*100%;[\s\S]*?justify-self:\s*stretch;/);
  assert.match(css, /\.execution-group-items > \*\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(css, /\.execution-details \.git-diff\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*auto;/);
  assert.match(css, /\.execution-diff-stat-slot\s*\{/);
  const rowSource = await readFile(new URL("../src/components/ExecutionRow.tsx", import.meta.url), "utf8");
  assert.match(rowSource, /reverted \? "Redo" : "Revert changes"/);
  assert.match(rowSource, /reverted \? RedoIcon : UndoIcon/);
  assert.match(rowSource, /applyUnifiedDiff\(current, file\.diff, direction\)/);
  assert.match(css, /grid-template-rows var\(--motion-normal\)[\s\S]*?opacity var\(--motion-normal\)/);
  assert.match(css, /\.reasoning-preview\s*\{[\s\S]*?-webkit-mask-image:\s*linear-gradient\(to right, #000 90%, transparent 100%\);[\s\S]*?mask-image:\s*linear-gradient\(to right, #000 90%, transparent 100%\);/);
});

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Event: dom.Event,
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
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ExecutionRow } = await import("../src/components/ExecutionRow.tsx");
const { ActivityGroupView } = await import("../src/components/Timeline.tsx");

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
const { default: PermissionBanner } = await import("../../../packages/permissions/widgets/PermissionBanner.tsx");
const { activateProject, activateSession, applyEvent, getState, setSessions } = await import("../src/store.ts");

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
    assert.match(container.querySelector(".execution-metadata")?.textContent ?? "", /Exit code 0.*420ms.*cwd \/workspace/s);

    const full = [...container.querySelectorAll<HTMLButtonElement>(".execution-output-actions button")]
      .find((button) => button.textContent === "Open full output");
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

test("the running action floats out of the folded block while settled rows stay inside it", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const first = tool({ id: "call-first", callId: "call-first", eventSeq: 1 });
  const latest = tool({
    id: "call-latest",
    callId: "call-latest",
    eventSeq: 2,
    input: { command: "npm test" },
    status: "running",
    output: undefined,
    finishTime: undefined,
  });
  try {
    await act(async () => root.render(createElement(ActivityGroupView, {
      g: activityGroup("activity-motion", [first, latest]),
      subagents: null,
      state: "active",
      entering: true,
    })));
    const live = [...container.querySelectorAll(".activity-live .execution-row")];
    assert.equal(live.length, 1, "only the running action floats above the block");
    assert.equal(live[0]?.querySelector(".tool-preview")?.textContent, "Run tests");
    assert.ok(live[0]?.classList.contains("open"), "a floating action shows its output while it runs");
    const toggle = container.querySelector<HTMLButtonElement>(".ui-run-summary")!;
    assert.equal(toggle.getAttribute("aria-expanded"), "false", "the block never opens itself while work runs");
    assert.equal(container.querySelectorAll(".execution-row").length, 1, "settled rows stay folded away");

    await act(async () => toggle.click());
    const folded = [...container.querySelectorAll(".activity-group-items .execution-row")];
    assert.equal(folded.length, 1, "the block holds only the settled rows");
    assert.notEqual(folded[0]?.querySelector(".tool-preview")?.textContent, "", "history never retypes from empty");
  } finally {
    await act(async () => root.unmount());
    container.remove();
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
  let abortRequest: { url: string; method: string } | undefined;
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
      abortRequest = { url: String(input), method: String(init?.method ?? "GET") };
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    await act(async () => { stop?.click(); });
    assert.deepEqual(abortRequest, {
      url: "/api/sessions/execution-status-session/abort",
      method: "POST",
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

test("a lone running action needs no block chrome and folds into the block when it settles", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const running = tool({ status: "running", output: undefined, finishTime: undefined });
  const group = (message: ToolMsg) => activityGroup("activity-1", [message]);
  try {
    await act(async () => root.render(createElement(ActivityGroupView, { g: group(running), subagents: null })));
    assert.equal(container.querySelector(".ui-run-summary"), null, "a first single action carries no block around it");
    assert.equal(container.querySelector(".activity-group"), null, "the block itself is not on screen yet");
    assert.equal(container.querySelector(".activity-live .activity-group"), null, "and the action is never nested inside it");
    assert.ok(container.querySelector(".activity-live .execution-row"), "the action itself is on screen");

    await act(async () => root.render(createElement(ActivityGroupView, { g: group(tool()), subagents: null })));
    const toggle = container.querySelector<HTMLButtonElement>(".ui-run-summary")!;
    assert.ok(toggle, "the block appears as soon as something has settled into it");
    assert.equal(toggle.getAttribute("aria-expanded"), "false", "the block stays folded");
    assert.ok(container.querySelector(".activity-live.leaving"), "the settled action folds up into the block");
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "true", "a hand toggle still opens it");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("an action that arrives already finished still appears outside the block first", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const settled = tool();
  // A fast tool can be called and answered inside one render batch, so it is
  // never observed running. Its own timestamp is old; what makes it an arrival
  // is that it was not there when the group mounted.
  const fast = tool({ id: "call-2", callId: "call-2" });
  const group = (items: ToolMsg[]) => activityGroup("activity-fast", items);
  try {
    await act(async () => root.render(createElement(ActivityGroupView, { g: group([settled]), subagents: null })));
    assert.equal(container.querySelector(".activity-live"), null, "replayed history mounts folded inside the block");

    await act(async () => root.render(createElement(ActivityGroupView, { g: group([settled, fast]), subagents: null })));
    const live = [...container.querySelectorAll(".activity-live:not(.leaving) .execution-row")];
    assert.equal(live.length, 1, "a finished action still gets its moment outside the block");
    assert.equal(
      container.querySelector(".ui-run-summary")?.getAttribute("aria-expanded"),
      "false",
      "the block stays folded while the action floats",
    );

    const next = tool({ id: "call-3", callId: "call-3" });
    await act(async () => root.render(createElement(ActivityGroupView, { g: group([settled, fast, next]), subagents: null })));
    const floating = [...container.querySelectorAll(".activity-live:not(.leaving)")];
    assert.equal(floating.length, 1, "the next arrival replaces it instead of stacking a second list");
    assert.ok(container.querySelector(".activity-live.leaving"), "the previous action folds into the block");
  } finally {
    await act(async () => root.unmount());
    container.remove();
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
    const result = container.querySelector(".execution-mcp-result");
    assert.match(result?.textContent ?? "", /Title.*Fix execution UI.*Status.*open/s);
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
      /Responsive UI reviewer.*Completed.*Checked 390px and 1280px.*Model.*claude-sonnet.*Parent.*Root implementation.*Open child session/s,
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
      defaultOpen: true,
    })));

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

test("approval is always action-required: intent, target, risk, and decisions visible without disclosure", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [{
        sessionId: "session-1",
        requestId: "permission-1",
        permission: "bash",
        tool: "Shell",
        patterns: ["rm -rf apps/web/dist"],
        status: "pending",
        time: 1,
        preview: { title: "Delete build artifacts", lines: ["apps/web/dist"], risk: "medium" },
      }],
    })));
    const banner = container.querySelector(".perm-banner");
    assert.ok(banner);
    assert.equal(banner.getAttribute("role"), "alert");
    // No expand step: intent, tool, target, and risk are readable immediately.
    assert.match(container.querySelector(".perm-title")?.textContent ?? "", /Permission requested/);
    assert.match(container.querySelector(".permission-request-title")?.textContent ?? "", /Delete build artifacts/);
    assert.match(container.querySelector(".permission-request-tool")?.textContent ?? "", /via Shell/);
    assert.match(container.querySelector(".permission-risk")?.textContent ?? "", /medium risk/);
    assert.match(container.querySelector(".permission-preview")?.textContent ?? "", /apps\/web\/dist/);
    // Decisions are rendered up front, in decision order.
    const actions = container.querySelector(".perm-actions");
    assert.ok(actions);
    assert.ok(actions.classList.contains("has-always"));
    assert.match(actions.textContent ?? "", /Allow once.*Always.*Deny/s);
    assert.ok(container.querySelector(".permission-request-copy"));
    const allow = container.querySelector<HTMLButtonElement>(".perm-actions .permission-allow");
    const deny = container.querySelector<HTMLButtonElement>(".perm-actions .permission-deny");
    assert.ok(allow && allow.textContent?.includes("Allow once"));
    assert.ok(deny && deny.textContent?.includes("Deny"));
    // Always scope stays an explicit choice, never a silent global.
    const scopeChip = container.querySelector(".perm-always .picker-chip-text");
    assert.ok(scopeChip);
    assert.match(scopeChip.textContent ?? "", /this session/i);
  } finally {
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
    assert.match(container.querySelector(".perm-actions")?.textContent ?? "", /Allow once.*Always.*Deny/s);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("compact permission actions override the wide decision rail", async () => {
  const css = await readFile(new URL("../../../packages/permissions/widgets/styles.css", import.meta.url), "utf8");
  const compact = css.slice(css.indexOf("@container permission-banner (max-width: 620px)"));
  assert.match(
    compact,
    /\.perm-banner \.perm-actions,\s*\.perm-banner \.perm-actions\.has-always\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/,
  );
});
