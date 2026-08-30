import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import {
  cleanShellCommand,
  compactUrl,
  executionGroupLabel,
  executionPresentation,
  middleTruncatePath,
  normalizedMcpResult,
  normalizedInputEntries,
  reasoningHead,
  reasoningTail,
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
    "node /workspace/apps/web/src/…/ExecutionRow.tsx",
  );
  assert.equal(
    executionPresentation(tool()).preview,
    "git diff -- apps/web/src/components/Timeline.tsx",
  );
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
  assert.match(edit.preview, /Composer\.tsx · \+3 −2$/);
  const create = executionPresentation(tool({
    tool: "create",
    input: { filePath: "apps/web/src/new.ts", content: "one\ntwo" },
  }));
  assert.equal(create.preview, "apps/web/src/new.ts · +2 −0");
  const write = executionPresentation(tool({
    tool: "write",
    input: { filePath: "apps/web/src/new.ts", newString: "one\ntwo" },
  }));
  assert.equal(write.preview, "apps/web/src/new.ts · +2 −0");

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
  assert.match(css, /\.execution-group-items\s*\{[\s\S]*?width:\s*100%;[\s\S]*?justify-self:\s*stretch;/);
  assert.match(css, /grid-template-rows var\(--motion-normal\)[\s\S]*?opacity var\(--motion-normal\)/);
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
const { WorkedGroup } = await import("../src/components/Timeline.tsx");
const { default: PermissionBanner } = await import("../../../packages/permissions/widgets/PermissionBanner.tsx");
const { activateSession, getState, setSessions } = await import("../src/store.ts");

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
  } finally {
    await act(async () => root.unmount());
    timeline.remove();
  }
});

test("long edit previews provide a full diff viewer", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const content = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");
  try {
    await act(async () => root.render(createElement(ExecutionRow, {
      message: tool({
        tool: "create",
        input: { filePath: "apps/web/src/generated.ts", content },
      }),
    })));
    await act(async () => container.querySelector<HTMLButtonElement>(".execution-summary")!.click());
    assert.equal(container.querySelectorAll(".execution-diff-line").length, 14);
    const fullDiff = [...container.querySelectorAll<HTMLButtonElement>(".execution-output-actions button")]
      .find((button) => button.textContent === "View full diff");
    assert.ok(fullDiff);
    await act(async () => fullDiff.click());
    const viewer = document.body.querySelector<HTMLElement>(".execution-viewer");
    assert.match(viewer?.textContent ?? "", /Create full diff.*18 lines.*line 18/s);
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
    assert.ok(container.querySelector(".execution-status-icon .ui-spinner"), "running status uses an animated spinner");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a completed call remains open during its active turn", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ExecutionRow, { message: tool(), activeTurn: true })));
    assert.equal(container.querySelector(".execution-summary")?.getAttribute("aria-expanded"), "true");
    assert.match(container.querySelector(".execution-details")?.textContent ?? "", /git diff/);
    await act(async () => root.render(createElement(ExecutionRow, { message: tool(), activeTurn: false })));
    assert.equal(container.querySelector(".execution-summary")?.getAttribute("aria-expanded"), "false");
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

test("a completed action batch stays open while its turn is active", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const message = tool();
  const group = { kind: "work" as const, id: "work-batch", items: [message], tools: [message], tasks: [], ms: 420 };
  try {
    await act(async () => root.render(createElement(WorkedGroup, { g: group, subagents: null, activeTurn: true })));
    const toggle = container.querySelector<HTMLButtonElement>(".execution-group-toggle")!;
    assert.equal(toggle.getAttribute("aria-expanded"), "true", "the call/result batch is inspectable immediately");
    await act(async () => root.render(createElement(WorkedGroup, { g: group, subagents: null, activeTurn: false })));
    assert.equal(toggle.getAttribute("aria-expanded"), "false", "settled history returns to its compact form after the turn");
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
    assert.match(actions.textContent ?? "", /Allow once.*Always.*Deny/s);
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
