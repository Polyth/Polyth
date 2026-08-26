import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import {
  cleanShellCommand,
  compactUrl,
  executionGroupLabel,
  executionPresentation,
  middleTruncatePath,
  normalizedMcpResult,
  normalizedInputEntries,
  reasoningMilestones,
} from "../src/execution.ts";
import type { ToolMsg } from "../src/reduce.ts";

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

test("shell previews remove setup noise without losing the useful command", () => {
  assert.equal(cleanShellCommand("cd /workspace && git status --short"), "git status --short");
  assert.equal(
    cleanShellCommand("cd /workspace && export NODE_ENV=test && env CI=1 npm run test"),
    "npm run test",
  );
  assert.equal(
    cleanShellCommand("FOO=bar node /workspace/apps/web/src/components/a/very/long/directory/ExecutionRow.tsx"),
    "node /workspace…/ExecutionRow.tsx",
  );
  assert.equal(
    executionPresentation(tool()).preview,
    "git diff -- apps/web/src/components/Timeline.tsx",
  );
});

test("file, URL, edit, search, MCP, and subagent previews are semantic", () => {
  assert.equal(
    middleTruncatePath("apps/web/src/components/workspace/very/deep/Composer.tsx", 38),
    "apps…/Composer.tsx",
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
  assert.match(edit.preview, /Composer\.tsx · \+3 −2$/);

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
  assert.equal(mcp.label, "Github");
  assert.equal(mcp.preview, "Read pull request #2693");

  const subagent = executionPresentation(tool({
    tool: "task",
    input: { description: "Review mobile UX implementation", subagent_type: "general" },
  }));
  assert.equal(subagent.label, "Subagent");
  assert.equal(subagent.preview, "Review mobile UX implementation");
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
  ]);
});

test("groups and thinking expose useful milestones, not debug-prefixed chatter", () => {
  assert.equal(executionGroupLabel([
    tool({ tool: "read", input: { path: "a.ts" } }),
    tool({ tool: "grep", input: { pattern: "x" } }),
  ]), "Repository inspection");
  assert.deepEqual(
    reasoningMilestones("Thinking...\n\nFound the event reducer and timeline renderer.\n\nUpdating the compact execution rows now."),
    ["Found the event reducer and timeline renderer.", "Updating the compact execution rows now."],
  );
  const semantic = reasoningMilestones(
    "I need to inspect the event reducer before changing anything.\n\n"
      + "Maybe there is another approach.\n\n"
      + "Implemented distinct pending and running lifecycle states with bounded labels that remain readable on compact screens and do not expose internal diagnostic chatter to users.",
  );
  assert.equal(semantic[0], "Inspect the event reducer before changing anything.");
  assert.ok(semantic.every((item) => item.length <= 120));
  assert.ok(semantic.length <= 5);
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
const { WorkedGroup } = await import("../src/components/Timeline.tsx");
const { default: PermissionBanner } = await import("../src/components/PermissionBanner.tsx");
const { getState } = await import("../src/store.ts");

test("execution row renders collapsed value first, expands inline, and opens level three on demand", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const output = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");
  try {
    await act(async () => root.render(createElement(ExecutionRow, { message: tool({ output }) })));
    const disclosure = container.querySelector<HTMLButtonElement>(".execution-summary");
    assert.ok(disclosure);
    assert.equal(disclosure.getAttribute("aria-expanded"), "false");
    assert.match(disclosure.textContent ?? "", /Shell.*git diff.*420ms.*✓/s);
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
    await act(async () => full.click());
    const viewer = document.body.querySelector<HTMLElement>(".execution-viewer");
    assert.ok(viewer, "large output opens in the explicit level-three viewer");
    assert.ok(viewer.classList.contains("dialog-full"), "viewer uses the shared accessible Dialog primitive");
    assert.equal(document.body.style.overflow, "hidden", "modal locks page scrolling");
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
    await act(async () => close.click());
    assert.equal(document.body.querySelector(".execution-viewer"), null);
    assert.equal(document.body.style.overflow, "", "closing restores page scrolling");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("pending and running execution states stay visually and accessibly distinct", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({ status: "pending", output: undefined, finishTime: undefined }),
    })));
    assert.match(container.querySelector(".execution-status")?.getAttribute("aria-label") ?? "", /^Pending in /);
    assert.equal(container.querySelector(".execution-status-icon")?.textContent, "○");
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({ status: "running", output: undefined, finishTime: undefined }),
    })));
    assert.match(container.querySelector(".execution-status")?.getAttribute("aria-label") ?? "", /^Running in /);
    assert.equal(container.querySelector(".execution-status-icon")?.textContent, "◌");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("working groups collapse on success unless the user explicitly expanded them", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const running = tool({ status: "running", output: undefined, finishTime: undefined });
  const group = (message: ToolMsg) => ({
    kind: "work" as const,
    id: "work-1",
    items: [message],
    tools: [message],
    tasks: [],
    ms: 420,
  });
  try {
    await act(async () => root.render(createElement(WorkedGroup, { g: group(running), subagents: null })));
    const toggle = container.querySelector<HTMLButtonElement>(".execution-group-toggle")!;
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    await act(async () => root.render(createElement(WorkedGroup, {
      g: group(tool()),
      subagents: null,
    })));
    assert.equal(toggle.getAttribute("aria-expanded"), "false");

    await act(async () => root.render(createElement(WorkedGroup, { g: group(running), subagents: null })));
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    await act(async () => root.render(createElement(WorkedGroup, {
      g: group(tool()),
      subagents: null,
    })));
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
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
      /Responsive UI reviewer.*Completed.*Checked 390px and 1280px.*Open child session/s,
    );
  } finally {
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

test("approval starts as a compact execution row and reveals decisions inline", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [{
        requestId: "permission-1",
        permission: "bash",
        tool: "Shell",
        patterns: ["rm -rf apps/web/dist"],
        status: "pending",
        time: 1,
        preview: { title: "Delete build artifacts", lines: ["apps/web/dist"], risk: "medium" },
      }],
    })));
    const summary = container.querySelector<HTMLButtonElement>(".permission-execution-summary");
    assert.ok(summary);
    assert.equal(summary.getAttribute("aria-expanded"), "false");
    assert.match(summary.textContent ?? "", /Shell.*Delete build artifacts.*Approval required.*Review/s);
    assert.match(container.querySelector(".permission-execution-mobile-status")?.textContent ?? "", /Approval.*Review/s);
    assert.equal(container.querySelector(".perm-actions"), null);
    await act(async () => summary.click());
    assert.equal(summary.getAttribute("aria-expanded"), "true");
    assert.match(container.querySelector(".perm-actions")?.textContent ?? "", /Allow once.*Always.*Deny/s);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
