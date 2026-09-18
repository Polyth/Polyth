import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { JsonObject, SessionEvent } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: (elt: Element) =>
    (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(elt),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: () => {},
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { activateProject, activateSession, applyEvents, applyProjectAdded, clearUiError, getState, seedSessionCache, setGitBranch, setGitDiffPath, setModels } = await import("../../../apps/web/src/store.ts");
const { default: GitView, DiffContent } = await import("../widgets/GitView.tsx");
const { default: RecentChangesWidget } = await import("../widgets/RecentChangesWidget.tsx");
const { api } = await import("@polyth/session/web-api");
const { refreshGitStatus } = await import("../widgets/gitStatusStore.ts");
const {
  addDiffStats,
  hiddenEditedCount,
  visibleEditedPaths,
  default: PendingChangesBar,
} = await import("../widgets/PendingChangesBar.tsx");
const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function mounted(component: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
    await delay(20);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const response = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("gitDiff rejects HTTP failures instead of returning an empty patch", async () => {
  globalThis.fetch = async () => response({ message: "diff exploded" }, 500);
  await assert.rejects(api.gitDiff("error-project", "src/app.ts"), /diff exploded/);
});

test("commit diffs highlight each file using its own language", () => {
  const diff = [
    "commit abc123",
    "Author: Test",
    "",
    "diff --git a/src/value.ts b/src/value.ts",
    "--- a/src/value.ts",
    "+++ b/src/value.ts",
    "@@ -0,0 +1 @@",
    "+const answer = 42;",
    "diff --git a/tools/run.py b/tools/run.py",
    "--- a/tools/run.py",
    "+++ b/tools/run.py",
    "@@ -0,0 +1 @@",
    "+def run():",
  ].join("\n");
  const html = renderToStaticMarkup(createElement(DiffContent, { diff, split: false, wrap: false }));

  assert.match(html, /data-diff-path="src\/value\.ts"[\s\S]*class="tok-kw">const<\/span>/);
  assert.match(html, /data-diff-path="tools\/run\.py"[\s\S]*class="tok-kw">def<\/span>/);
});

test("GitView exposes diff Retry and refreshes an open selection after staging", async () => {
  const projectId = "git-behavior-project";
  let staged = false;
  let diffAttempts = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/git/status")) {
      const file = { path: "src/app.ts", status: "modified", staged };
      return response({
        branch: "main", ahead: 0, behind: 0, conflicted: [], untracked: [],
        staged: staged ? [file] : [],
        unstaged: staged ? [] : [file],
        isRepo: true,
      });
    }
    if (url.startsWith("/api/git/branches")) return response({ current: "main", branches: [{ name: "main", current: true }] });
    if (url.startsWith("/api/worktrees")) return response([]);
    if (url.startsWith("/api/git/graph")) return response([]);
    if (url.startsWith("/api/git/stashes")) return response([]);
    if (url.startsWith("/api/git/diff")) {
      diffAttempts += 1;
      // Attempt 1 is GitView's own background line-stat prefetch for the
      // changed file; the explicit selection request below is attempt 2.
      if (diffAttempts === 2) return response({ message: "temporary diff failure" }, 500);
      const isStaged = url.includes("staged=true");
      return response({ path: "src/app.ts", diff: `@@ -1 +1 @@\n-old\n+${isStaged ? "staged-new" : "new"}` });
    }
    if (url === "/api/git/stage" && init?.method === "POST") {
      staged = true;
      return response({ ok: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  activateProject(projectId);
  const view = await mounted(createElement(GitView));
  try {
    const file = view.container.querySelector<HTMLButtonElement>(".git-file-main");
    assert.ok(file, "changed file is rendered");
    await act(async () => {
      file.click();
      await delay(20);
    });
    const alert = view.container.querySelector<HTMLElement>('[role="alert"]');
    assert.match(alert?.textContent ?? "", /temporary diff failure/);
    const retry = [...(alert?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((button) => button.textContent === "Retry");
    assert.ok(retry, "diff failure offers Retry");
    await act(async () => {
      retry.click();
      await delay(20);
    });
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.match(view.container.textContent ?? "", /\+new/);

    const stage = view.container.querySelector<HTMLButtonElement>('button[aria-label="Stage src/app.ts"]');
    assert.ok(stage, "stage action is available");
    await act(async () => {
      stage.click();
      await delay(30);
    });
    assert.match(view.container.textContent ?? "", /Staged changes/);
    assert.match(view.container.textContent ?? "", /\+staged-new/);
    assert.ok(diffAttempts >= 3, "selection change reloads the patch");
  } finally {
    await view.unmount();
    activateProject(null);
  }
});

test("GitView keeps the commit composer available while a file diff is open", async () => {
  const projectId = "git-composer-project";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("/api/git/status")) {
      return response({
        branch: "main", ahead: 0, behind: 0, conflicted: [], unstaged: [], untracked: [],
        staged: [{ path: "src/staged.ts", status: "modified", staged: true }],
        isRepo: true,
      });
    }
    if (url.startsWith("/api/git/branches")) return response({ current: "main", branches: [{ name: "main", current: true }] });
    if (url.startsWith("/api/worktrees") || url.startsWith("/api/git/graph") || url.startsWith("/api/git/stashes")) return response([]);
    if (url.startsWith("/api/git/diff")) return response({ path: "src/staged.ts", diff: "@@ -1 +1 @@\n-old\n+new" });
    throw new Error(`Unexpected request: ${url}`);
  };

  activateProject(projectId);
  const view = await mounted(createElement(GitView));
  try {
    assert.ok(view.container.querySelector(".git-commit-composer"), "composer is available on the change list");
    assert.ok(view.container.querySelector(".git-commit-composer .git-commit-msg, .git-commit-composer textarea"), "composer keeps a message field");
    assert.ok(view.container.querySelector(".git-commit-rail"), "composer uses the action rail");
    const disclosure = view.container.querySelector<HTMLButtonElement>(".git-change-group-head");
    assert.ok(disclosure);
    await act(async () => { disclosure.click(); });
    assert.equal(disclosure.getAttribute("aria-expanded"), "false", "composer does not block disclosure taps");
    await act(async () => { disclosure.click(); });

    const file = view.container.querySelector<HTMLButtonElement>(".git-file-main");
    assert.ok(file);
    await act(async () => {
      file.click();
      await delay(20);
    });
    assert.ok(view.container.querySelector(".git-master-detail.detail-open"), "file tap opens detail mode");
    assert.ok(view.container.querySelector(".git-commit-composer"), "composer stays visible while the diff is open");
    assert.match(view.container.textContent ?? "", /Commit 1 staged file/);

    const back = view.container.querySelector<HTMLButtonElement>(".git-mobile-detail-head button");
    assert.ok(back);
    await act(async () => { back.click(); });
    assert.ok(view.container.querySelector(".git-commit-composer"), "composer remains after navigating back");
  } finally {
    await view.unmount();
    activateProject(null);
  }
});

test("GitView does not reopen a file after returning to the change list", async () => {
  const projectId = "git-back-to-list-project";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("/api/git/status")) {
      return response({
        branch: "main", ahead: 0, behind: 0, conflicted: [], staged: [], untracked: [],
        unstaged: [{ path: "src/app.ts", status: "modified", staged: false }],
        isRepo: true,
      });
    }
    if (url.startsWith("/api/git/branches")) return response({ current: "main", branches: [{ name: "main", current: true }] });
    if (url.startsWith("/api/worktrees") || url.startsWith("/api/git/graph") || url.startsWith("/api/git/stashes")) return response([]);
    if (url.startsWith("/api/git/diff")) return response({ path: "src/app.ts", diff: "@@ -1 +1 @@\n-old\n+new" });
    throw new Error(`Unexpected request: ${url}`);
  };

  activateProject(projectId);
  const view = await mounted(createElement(GitView));
  try {
    const file = view.container.querySelector<HTMLButtonElement>(".git-file-main");
    assert.ok(file);
    await act(async () => { file.click(); await delay(20); });
    assert.ok(view.container.querySelector(".git-master-detail.detail-open"));

    const back = view.container.querySelector<HTMLButtonElement>(".git-mobile-detail-head button");
    assert.ok(back);
    await act(async () => { back.click(); });
    assert.equal(view.container.querySelector(".git-master-detail.detail-open"), null);

    await act(async () => { await refreshGitStatus(projectId); await delay(20); });
    assert.equal(view.container.querySelector(".git-master-detail.detail-open"), null);
    assert.equal(getState().gitDiffPath, null);
  } finally {
    await view.unmount();
    activateProject(null);
  }
});

test("GitView reports branch/graph/stash/worktree load failures with Retry", async () => {
  const projectId = "git-resource-error-project";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("/api/git/status")) {
      return response({
        branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [],
        untracked: [], conflicted: [], isRepo: true,
      });
    }
    if (url.startsWith("/api/git/branches")) return response({ message: "branches unavailable" }, 503);
    if (url.startsWith("/api/worktrees") || url.startsWith("/api/git/graph") || url.startsWith("/api/git/stashes")) return response([]);
    throw new Error(`Unexpected request: ${url}`);
  };

  activateProject(projectId);
  const view = await mounted(createElement(GitView));
  try {
    const alert = view.container.querySelector<HTMLElement>('[role="alert"]');
    assert.match(alert?.textContent ?? "", /OpenCode is reconnecting/);
    assert.ok([...(alert?.querySelectorAll("button") ?? [])].some((button) => button.textContent === "Retry"));
  } finally {
    await view.unmount();
    activateProject(null);
  }
});

test("edited-files preview shows three paths until expanded", () => {
  const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
  assert.deepEqual(visibleEditedPaths(paths, false), ["a.ts", "b.ts", "c.ts"]);
  assert.equal(hiddenEditedCount(paths.length), 2);
  assert.equal(hiddenEditedCount(4), 1);
  assert.deepEqual(visibleEditedPaths(paths, true), paths);
  assert.deepEqual(visibleEditedPaths(paths.slice(0, 3), false), ["a.ts", "b.ts", "c.ts"]);
  assert.equal(hiddenEditedCount(3), 0);
  assert.deepEqual(addDiffStats({ additions: 2, deletions: 1 }, { additions: 4, deletions: 3 }), {
    additions: 6,
    deletions: 4,
  });
});

function labeledButton(container: Element, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((button) =>
    (button.querySelector(".ui-btn-label")?.textContent
      ?? button.getAttribute("aria-label")
      ?? button.textContent) === label,
  );
}

test("edited-files bubble expands to a card, lists a preview, reviews a file, and undoes via gitDiscard", async () => {
  const projectId = "edited-files-card-project";
  const sessionId = "edited-files-card-session";
  const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
  const leftover = "src/leftover.ts";
  const repoRoot = "/tmp/polyth-demo-repo";
  let discarded: string[] | null = null;
  let clean = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/git/status")) {
      const entries = [
        { path: leftover, status: "modified", staged: false },
        ...files.map((path) => ({ path, status: "modified", staged: false })),
      ];
      return response({
        branch: "main", ahead: 0, behind: 0, conflicted: [], staged: [], untracked: [],
        unstaged: clean ? [] : entries,
        isRepo: true,
      });
    }
    if (url.startsWith("/api/git/diff")) {
      const encoded = url.split("path=")[1]?.split("&")[0] ?? "";
      const path = decodeURIComponent(encoded);
      const extra = files.indexOf(path) + 1;
      return response({
        path,
        diff: ["@@ -1 +1 @@", "-old", ...Array.from({ length: extra }, () => "+new")].join("\n"),
      });
    }
    if (url === "/api/git/discard" && init?.method === "POST") {
      discarded = (JSON.parse(String(init.body)) as { paths: string[] }).paths;
      clean = true;
      return response({ ok: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  activateProject(projectId);
  applyProjectAdded({
    id: projectId,
    path: repoRoot,
    name: "edited files",
    createdAt: 1,
  });
  seedSessionCache({
    id: sessionId,
    projectId,
    title: "edited files",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  let seq = 0;
  const ev = (type: string, data: JsonObject): SessionEvent => {
    seq += 1;
    return {
      id: `${sessionId}-e${seq}`,
      sessionId,
      seq,
      time: 1_700_000_000_000 + seq,
      type,
      data,
      v: 1,
    };
  };
  applyEvents([
    ev("user/message", { text: "edit a and b" }),
    ev("tool/call", { callId: "w1", tool: "write", input: { filePath: `${repoRoot}/${files[0]!}` } }),
    ev("tool/result", { callId: "w1", tool: "write", output: "ok" }),
    ev("tool/call", { callId: "w2", tool: "write", input: { filePath: `${repoRoot}/${files[1]!}` } }),
    ev("tool/result", { callId: "w2", tool: "write", output: "ok" }),
    ev("user/message", { text: "edit c and d" }),
    ev("tool/call", { callId: "w3", tool: "write", input: { filePath: `${repoRoot}/${files[2]!}` } }),
    ev("tool/result", { callId: "w3", tool: "write", output: "ok" }),
    ev("tool/call", { callId: "w4", tool: "write", input: { filePath: `${repoRoot}/${files[3]!}` } }),
    ev("tool/result", { callId: "w4", tool: "write", output: "ok" }),
  ]);
  activateSession(sessionId);
  const view = await mounted(createElement(PendingChangesBar));
  try {
    await act(async () => { await delay(40); });
    let bubble = view.container.querySelector<HTMLButtonElement>(".pending-changes-bar--collapsed .ui-run-summary");
    assert.ok(bubble, "collapsed run summary is the default");
    assert.equal(bubble.getAttribute("aria-expanded"), "false");
    assert.equal(bubble.getAttribute("aria-label"), "Edited 4 files");
    assert.match(view.container.textContent ?? "", /4 files/);
    assert.match(view.container.textContent ?? "", /\+10/);
    // Deleted-line counts use the typographic minus, matching GitView.
    assert.match(view.container.textContent ?? "", /−4/);
    assert.equal(view.container.querySelector(".pending-changes-file"), null);
    assert.equal(labeledButton(view.container, "Undo"), undefined);
    assert.equal(labeledButton(view.container, "Review"), undefined);
    assert.equal(view.container.textContent?.includes(leftover), false);

    await act(async () => {
      setModels([{ providerID: "openai", modelID: "luna", name: "Luna", providerName: "OpenAI" }]);
      setGitBranch("feature/glass-ui");
      applyEvents([
        ev("turn/started", { turnId: "turn-active", model: { providerID: "openai", modelID: "luna" } }),
        ev("task/snapshot", {
          listId: "work",
          revision: 1,
          items: [{ id: "verify", text: "Run focused checks and review the diff", status: "active" }],
        }),
      ]);
      await delay(20);
    });
    const agentStatus = view.container.querySelector(".agent-status-dock");
    assert.ok(agentStatus, "active work replaces the compact change summary");
    assert.match(agentStatus.textContent ?? "", /Luna/);
    assert.match(agentStatus.textContent ?? "", /Run focused checks and review the diff/);
    assert.match(agentStatus.textContent ?? "", /4 files.*\+10.*−4/s);
    assert.doesNotMatch(agentStatus.textContent ?? "", /feature\/glass-ui/);
    assert.equal(agentStatus.textContent?.includes("Context"), false);
    assert.equal(agentStatus.textContent?.includes("Agent"), false);

    await act(async () => {
      applyEvents([ev("turn/stopped", { turnId: "turn-active", reason: "completed" })]);
      await delay(20);
    });

    await act(async () => {
      setModels([{ providerID: "cursor", modelID: "auto", name: "Auto" }]);
      applyEvents([ev("turn/started", { turnId: "turn-cursor-auto" })]);
      await delay(20);
    });
    const cursorAutoStatus = view.container.querySelector(".agent-status-dock");
    assert.ok(cursorAutoStatus, "Cursor Auto work keeps the active status dock");
    assert.match(cursorAutoStatus.textContent ?? "", /Auto/);
    assert.doesNotMatch(cursorAutoStatus.textContent ?? "", /default|Polyth/i);

    await act(async () => {
      applyEvents([ev("turn/stopped", { turnId: "turn-cursor-auto", reason: "completed" })]);
      await delay(20);
    });
    bubble = view.container.querySelector<HTMLButtonElement>(".pending-changes-bar--collapsed .ui-run-summary");
    assert.ok(bubble, "the compact change summary returns when work settles");

    await act(async () => { bubble.click(); });
    assert.equal(view.container.querySelector(".pending-changes-bar--collapsed"), null);
    assert.match(view.container.textContent ?? "", /Edited 4 files/);
    assert.equal(
      view.container.querySelector(".pending-changes-bar")?.getAttribute("aria-label"),
      "Edited 4 files",
    );
    const listed = [...view.container.querySelectorAll(".pending-changes-file-name")].map((node) => node.textContent);
    assert.deepEqual(listed, ["src/a.ts", "src/b.ts", "src/c.ts"]);
    assert.ok(!listed.includes(leftover));
    assert.equal(view.container.textContent?.includes(leftover), false);
    const more = view.container.querySelector<HTMLButtonElement>(".pending-changes-more");
    assert.ok(more, "show-more control is available");
    assert.match(more.textContent ?? "", /Show 1 more file/);
    assert.equal(more.getAttribute("aria-expanded"), "false");
    await act(async () => { more.click(); });
    assert.deepEqual(
      [...view.container.querySelectorAll(".pending-changes-file-name")].map((node) => node.textContent),
      files,
    );
    assert.equal(more.getAttribute("aria-expanded"), "true");
    assert.match(more.textContent ?? "", /Show less/);
    await act(async () => { more.click(); });
    assert.deepEqual(
      [...view.container.querySelectorAll(".pending-changes-file-name")].map((node) => node.textContent),
      ["src/a.ts", "src/b.ts", "src/c.ts"],
    );
    assert.equal(more.getAttribute("aria-expanded"), "false");
    assert.match(more.textContent ?? "", /Show 1 more file/);

    const firstFile = view.container.querySelector<HTMLButtonElement>(".pending-changes-file");
    assert.ok(firstFile);
    await act(async () => { firstFile.click(); });
    assert.equal(getState().gitDiffPath, "src/a.ts");

    const review = labeledButton(view.container, "Review");
    assert.ok(review);
    await act(async () => { review.click(); });

    const collapse = view.container.querySelector<HTMLButtonElement>('button[aria-label="Collapse"]');
    assert.ok(collapse, "Collapse returns to the bubble");
    assert.equal(collapse.querySelector(".ui-btn-label"), null, "Collapse is icon-only");
    assert.ok(collapse.querySelector("svg"), "Collapse keeps a visible icon");
    const actions = [...view.container.querySelectorAll(".pending-changes-actions button")];
    assert.equal(actions.at(-1), collapse, "Collapse is the rightmost header action");
    await act(async () => { collapse.click(); });
    const collapsed = view.container.querySelector<HTMLButtonElement>(".pending-changes-bar--collapsed .ui-run-summary");
    assert.ok(collapsed);
    assert.equal(collapsed.getAttribute("aria-expanded"), "false");
    assert.equal(view.container.querySelector(".pending-changes-file"), null);
    assert.equal(labeledButton(view.container, "Undo"), undefined);
    assert.equal(labeledButton(view.container, "Review"), undefined);

    await act(async () => { collapsed.click(); });
    const undo = labeledButton(view.container, "Undo");
    assert.ok(undo, "Undo is present");
    assert.equal(undo.getAttribute("aria-label"), "Undo");
    assert.equal(undo.querySelector(".ui-btn-label")?.textContent, "Undo");
    assert.ok(undo.querySelector("svg"), "Undo keeps a visible icon");
    await act(async () => {
      undo.click();
      await delay(0);
      resolveAlert(false);
    });
    assert.equal(discarded, null);

    await act(async () => {
      undo.click();
      await delay(0);
      resolveAlert(true);
      await delay(30);
    });
    assert.deepEqual(discarded, files);
    assert.ok(view.container.querySelector(".pending-changes-bar"), "session files stay listed after discard");
    assert.equal(labeledButton(view.container, "Undo"), undefined, "Undo hides when nothing is dirty");
    assert.deepEqual(
      [...view.container.querySelectorAll(".pending-changes-file-name")].map((node) => node.textContent),
      ["src/a.ts", "src/b.ts", "src/c.ts"],
    );
  } finally {
    await view.unmount();
    setModels([]);
    setGitBranch("");
    activateSession(null);
    activateProject(null);
  }
});

test("edited-files card stays hidden when git is dirty but this session edited nothing", async () => {
  const projectId = "edited-files-leftover-only-project";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("/api/git/status")) {
      return response({
        branch: "main", ahead: 0, behind: 0, conflicted: [], staged: [], untracked: [],
        unstaged: [{ path: "src/leftover.ts", status: "modified", staged: false }],
        isRepo: true,
      });
    }
    if (url.startsWith("/api/git/diff")) {
      return response({ path: "src/leftover.ts", diff: "@@ -1 +1 @@\n-old\n+new" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  activateProject(projectId);
  const view = await mounted(createElement(PendingChangesBar));
  try {
    await act(async () => { await delay(40); });
    assert.equal(view.container.querySelector(".pending-changes-bar"), null);
    assert.equal(view.container.textContent?.includes("src/leftover.ts"), false);
  } finally {
    await view.unmount();
    activateProject(null);
  }
});

test("GitView surfaces worktree cleanup warnings without claiming removal failed", async () => {
  const projectId = "git-remove-cleanup-project";
  let removeCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = (init as { method?: string } | undefined)?.method ?? "GET";
    if (url.startsWith("/api/git/status")) {
      return response({
        branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [],
        untracked: [], conflicted: [], isRepo: true,
      });
    }
    if (url.startsWith("/api/git/branches")) {
      return response({ current: "main", branches: [{ name: "main", current: true }] });
    }
    if (url.startsWith("/api/git/graph") || url.startsWith("/api/git/stashes")) return response([]);
    if (method === "GET" && url.startsWith("/api/worktrees")) {
      return response([
        { path: "/repo", branch: "main", head: "aaa", isMain: true },
        { path: "/repo-worktrees/feat", branch: "feat", head: "bbb", isMain: false },
      ]);
    }
    if (method === "POST" && url.includes("/api/worktrees/remove")) {
      removeCalls++;
      return response({ ok: true, metadataCleanupFailed: true, branchCleanupFailed: true });
    }
    throw new Error(`Unexpected request: ${url} ${method}`);
  };

  clearUiError();
  activateProject(projectId);
  const view = await mounted(createElement(GitView));
  try {
    await act(async () => { await delay(40); });
    const branchesTab = [...view.container.querySelectorAll('[role="tab"]')]
      .find((tab) => (tab.textContent ?? "").includes("Branches"));
    assert.ok(branchesTab, "branches tab is present");
    await act(async () => { (branchesTab as HTMLElement).click(); await delay(20); });
    // Removal is a destructive ending, so it lives in the worktree row's
    // overflow rather than sitting exposed next to the everyday actions.
    const overflow = view.container.querySelector<HTMLButtonElement>("button[aria-label='Actions for feat']");
    assert.ok(overflow, "linked worktree overflow control is present");
    await act(async () => { overflow!.click(); await delay(20); });
    const remove = [...document.querySelectorAll('[role="menuitem"]')]
      .find((entry) => (entry.textContent ?? "") === "Remove worktree");
    assert.ok(remove, "linked worktree remove control is present");
    await act(async () => { (remove as HTMLButtonElement).click(); await delay(20); });
    const confirm = [...document.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "") === "Remove worktree" && button.className.includes("danger"));
    assert.ok(confirm, "confirm dialog opened");
    await act(async () => { confirm!.click(); await delay(40); });
    assert.equal(removeCalls, 1);
    assert.match(getState().uiError ?? "", /clean up sessions or the branch after removing the worktree/i);
    assert.doesNotMatch(getState().uiError ?? "", /Couldn.t update the repository/);
  } finally {
    await view.unmount();
    clearUiError();
    activateProject(null);
  }
});

test("GitView destructive confirmation focuses Cancel and restores the opener on Escape", async () => {
  const projectId = "git-confirm-focus-project";
  const mutations: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = (init as { method?: string } | undefined)?.method ?? "GET";
    if (url.startsWith("/api/git/status")) {
      return response({
        branch: "main", ahead: 0, behind: 0, conflicted: [], staged: [], untracked: [],
        unstaged: [{ path: "src/app.ts", status: "modified", staged: false }],
        isRepo: true,
      });
    }
    if (url.startsWith("/api/git/branches")) return response({ current: "main", branches: [{ name: "main", current: true }] });
    if (url.startsWith("/api/worktrees") || url.startsWith("/api/git/graph") || url.startsWith("/api/git/stashes")) return response([]);
    if (url.startsWith("/api/git/diff")) return response({ path: "src/app.ts", diff: "@@ -1 +1 @@\n-old\n+new" });
    if (method !== "GET") mutations.push(`${method} ${url}`);
    throw new Error(`Unexpected request: ${url}`);
  };

  activateProject(projectId);
  const view = await mounted(createElement(GitView));
  try {
    await act(async () => { await delay(40); });
    const revertAll = labeledButton(view.container, "Revert all");
    assert.ok(revertAll, "revert-all control is present");
    await act(async () => {
      revertAll.focus();
      revertAll.click();
      await delay(20);
    });

    const foot = document.querySelector<HTMLElement>(".ui-dialog-foot");
    assert.ok(foot, "confirmation footer uses the shared dialog chrome");
    const cancel = foot.querySelector<HTMLButtonElement>(".ui-btn:first-child");
    const danger = foot.querySelector<HTMLButtonElement>(".ui-btn--danger");
    assert.ok(cancel && danger, "cancel and danger actions render");
    assert.equal(cancel.textContent, "Cancel");
    assert.equal(document.activeElement, cancel, "initial focus lands on the safe Cancel action");
    assert.notEqual(document.activeElement, danger, "the destructive action never receives initial focus");
    assert.notEqual(
      document.activeElement,
      document.querySelector(".ui-dialog-head button"),
      "the header close button never receives initial focus",
    );
    assert.deepEqual(mutations, [], "opening the confirmation mutates nothing");

    const panel = document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(panel);
    await act(async () => {
      panel.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await delay(20);
    });
    assert.equal(document.querySelector(".ui-dialog-foot"), null, "Escape closes the confirmation");
    assert.equal(document.activeElement, revertAll, "focus returns to the destructive opener");
    assert.deepEqual(mutations, [], "Escape mutates nothing");
  } finally {
    await view.unmount();
    activateProject(null);
  }
});

test("GitView remote push failure shows the real reason and resolve-with-agent actions", async () => {
  const projectId = "git-push-error-project";
  const pushError = "Push was rejected because the remote has commits you do not have locally. Pull or rebase first, then push again.";
  const agentRoutes: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = (init as { method?: string } | undefined)?.method ?? "GET";
    if (url.startsWith("/api/git/status")) {
      return response({
        branch: "main", ahead: 1, behind: 1, conflicted: [], staged: [], untracked: [], unstaged: [], isRepo: true,
      });
    }
    if (url.startsWith("/api/git/branches")) return response({ current: "main", branches: [{ name: "main", current: true }] });
    if (url.startsWith("/api/worktrees") || url.startsWith("/api/git/graph") || url.startsWith("/api/git/stashes")) return response([]);
    if (url.startsWith("/api/git/push") && method === "POST") {
      return response({ error: "conflict", message: pushError }, 409);
    }
    if (url.startsWith("/api/git/conflict-prompt") && method === "POST") {
      agentRoutes.push(url);
      return response({ ok: true, data: { prompt: "Resolve the checked-out git conflict." } });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  activateProject(projectId);
  const view = await mounted(createElement(GitView));
  try {
    await act(async () => { await delay(40); });
    const trigger = view.container.querySelector<HTMLButtonElement>('.source-remote-actions [aria-haspopup="menu"]');
    assert.ok(trigger, "remote overflow trigger renders");
    await act(async () => { trigger.click(); await delay(20); });
    const pushItem = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
      .find((item) => /push/i.test(item.textContent ?? ""));
    assert.ok(pushItem, "push action is reachable");
    await act(async () => { pushItem.click(); await delay(40); });
    const status = view.container.querySelector(".source-inline-status.error");
    assert.ok(status, "remote failure status renders");
    assert.match(status!.textContent ?? "", /Push was rejected because the remote has commits/);
    assert.doesNotMatch(status!.textContent ?? "", /To github\.com/);
    const banner = view.container.querySelector(".conflict-agent-bar");
    assert.ok(banner, "resolve-with-agent banner renders for push failures");
    assert.ok(banner!.textContent?.includes("Resolve with an agent") || banner!.textContent?.includes("agent"));
    assert.ok(banner!.querySelectorAll("button").length >= 2, "both resolve actions remain available");
    const newSession = [...banner!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => /In a new session/i.test(button.textContent ?? ""));
    assert.ok(newSession, "new-session action is available");
    await act(async () => { newSession.click(); await delay(30); });
    assert.equal(agentRoutes.length, 1, "the prompt is requested without starting an agent turn");
    assert.match(getState().newSessionIntent?.draft ?? "", /Resolve the checked-out git conflict/);
  } finally {
    await view.unmount();
    activateProject(null);
  }
});

test("GitView offers automatic rebase before the conflict draft", async () => {
  const projectId = "git-auto-rebase-project";
  let rebased = false;
  let pushed = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = (init as { method?: string } | undefined)?.method ?? "GET";
    if (url.startsWith("/api/git/status")) {
      return response({
        branch: "main", ahead: rebased ? 0 : 1, behind: rebased ? 0 : 1,
        conflicted: [], staged: [], untracked: [], unstaged: [], isRepo: true,
      });
    }
    if (url.startsWith("/api/git/branches")) return response({ current: "main", branches: [{ name: "main", current: true }] });
    if (url.startsWith("/api/worktrees") || url.startsWith("/api/git/graph") || url.startsWith("/api/git/stashes")) return response([]);
    if (url.startsWith("/api/git/sync") && method === "POST") {
      return response({ error: "conflict", message: "Sync cannot continue because local and remote histories have diverged." }, 409);
    }
    if (url.startsWith("/api/git/rebase") && method === "POST") {
      rebased = true;
      return response({ ok: true });
    }
    if (url.startsWith("/api/git/push") && method === "POST") {
      pushed = true;
      return response({ ok: true });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  activateProject(projectId);
  const view = await mounted(createElement(GitView));
  try {
    await act(async () => { await delay(40); });
    const sync = view.container.querySelector<HTMLButtonElement>(".source-sync-btn");
    assert.ok(sync);
    await act(async () => { sync.click(); await delay(30); });
    const rebase = [...view.container.querySelectorAll<HTMLButtonElement>(".conflict-agent-bar button")]
      .find((button) => /Rebase and sync/i.test(button.textContent ?? ""));
    assert.ok(rebase, "diverged sync offers automatic rebase");
    await act(async () => { rebase.click(); await delay(50); });
    assert.equal(rebased, true);
    assert.equal(pushed, true);
    assert.match(view.container.querySelector(".source-inline-status.success")?.textContent ?? "", /Sync/i);
  } finally {
    await view.unmount();
    activateProject(null);
  }
});

test("GitView remote-actions menu keeps a distinct Sync glyph and restores focus on Escape", async () => {
  const projectId = "git-remote-menu-project";
  const mutations: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = (init as { method?: string } | undefined)?.method ?? "GET";
    if (url.startsWith("/api/git/status")) {
      return response({
        branch: "main", ahead: 0, behind: 0, conflicted: [], staged: [], untracked: [], unstaged: [], isRepo: true,
      });
    }
    if (url.startsWith("/api/git/branches")) return response({ current: "main", branches: [{ name: "main", current: true }] });
    if (url.startsWith("/api/worktrees") || url.startsWith("/api/git/graph") || url.startsWith("/api/git/stashes")) return response([]);
    if (method !== "GET") mutations.push(`${method} ${url}`);
    throw new Error(`Unexpected request: ${url}`);
  };

  activateProject(projectId);
  const view = await mounted(createElement(GitView));
  try {
    await act(async () => { await delay(40); });
    const sync = view.container.querySelector<HTMLButtonElement>(".source-sync-btn");
    const refresh = view.container.querySelector<HTMLButtonElement>(".source-refresh-btn");
    assert.ok(sync && refresh, "sync and read-only refresh controls both remain");
    assert.ok(sync.querySelector("svg")?.classList.contains("lucide-repeat"), "Sync uses the distinct bidirectional glyph");
    assert.equal(refresh.querySelector("svg")?.classList.contains("lucide-repeat"), false, "Refresh keeps its reload glyph");
    assert.notEqual(sync.querySelector("svg")?.outerHTML, refresh.querySelector("svg")?.outerHTML);

    const trigger = view.container.querySelector<HTMLButtonElement>('.source-remote-actions [aria-haspopup="menu"]');
    assert.ok(trigger, "remote overflow trigger renders");
    await act(async () => { trigger.click(); await delay(20); });
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    assert.ok(menu, "remote actions menu opens");
    const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    assert.equal(items.length, 3, "fetch, pull and push remain reachable");
    await act(async () => { await delay(20); });
    assert.ok(menu.contains(document.activeElement), "the menu moves focus onto an item");

    await act(async () => {
      menu.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    assert.equal(document.activeElement, items[1], "arrow keys move through remote actions");
    await act(async () => {
      document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await delay(20);
    });
    assert.equal(document.querySelector('[role="menu"]'), null, "Escape closes the menu");
    assert.equal(document.activeElement, trigger, "focus returns to the overflow trigger");
    assert.deepEqual(mutations, [], "opening and dismissing the menu never runs a remote action");
  } finally {
    await view.unmount();
    activateProject(null);
  }
});

test("compact git.recent widget covers each status and links files without mutating", async () => {
  let mutations = 0;
  const dirtyStatus = {
    branch: "feature/compact", ahead: 2, behind: 1, conflicted: [], staged: [], untracked: [],
    unstaged: [
      { path: "src/a.ts", status: "modified", staged: false },
      { path: "src/b.ts", status: "modified", staged: false },
    ],
    isRepo: true,
  };
  const only = (body: unknown) => async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("/api/git/status")) return response(body);
    if ((init?.method ?? "GET") !== "GET") mutations += 1;
    throw new Error(`Unexpected request: ${String(input)}`);
  };

  // Pending status renders the bounded skeleton, never a crash.
  let release: ((value: Response) => void) | undefined;
  globalThis.fetch = () => new Promise<Response>((resolve) => { release = resolve; });
  const loading = await mounted(createElement(RecentChangesWidget, { projectId: "git-recent-loading", sessionId: null }));
  try {
    assert.ok(loading.container.querySelector('[aria-busy="true"]'), "pending status shows a busy skeleton");
  } finally {
    await loading.unmount();
  }
  release?.(response(dirtyStatus));
  await delay(0);

  // A failed status fetch must stay in the bounded skeleton, never claim clean.
  globalThis.fetch = async () => { throw new Error("status exploded"); };
  const errored = await mounted(createElement(RecentChangesWidget, { projectId: "git-recent-error", sessionId: null }));
  try {
    await act(async () => { await delay(20); });
    assert.ok(errored.container.querySelector('[aria-busy="true"]'), "failed status keeps the bounded skeleton");
    assert.doesNotMatch(errored.container.textContent ?? "", /Working tree clean/, "a failed fetch is never reported as clean");
    assert.equal(errored.container.querySelectorAll(".git-recent-file").length, 0);
  } finally {
    await errored.unmount();
  }

  // No project.
  const noProject = await mounted(createElement(RecentChangesWidget, { projectId: null, sessionId: null }));
  try {
    assert.match(noProject.container.textContent ?? "", /No project selected/);
  } finally {
    await noProject.unmount();
  }

  // Not a repository.
  globalThis.fetch = only({ ...dirtyStatus, isRepo: false });
  const noRepo = await mounted(createElement(RecentChangesWidget, { projectId: "git-recent-norepo", sessionId: null }));
  try {
    await act(async () => { await delay(20); });
    assert.match(noRepo.container.textContent ?? "", /This folder isn/);
  } finally {
    await noRepo.unmount();
  }

  // Clean working tree.
  globalThis.fetch = only({ ...dirtyStatus, unstaged: [], ahead: 0, behind: 0 });
  const clean = await mounted(createElement(RecentChangesWidget, { projectId: "git-recent-clean", sessionId: null }));
  try {
    await act(async () => { await delay(20); });
    assert.match(clean.container.textContent ?? "", /Working tree clean/);
    assert.equal(clean.container.querySelectorAll(".git-recent-file").length, 0);
  } finally {
    await clean.unmount();
  }

  // Read-only summary plus a file target that routes into Source control.
  setGitDiffPath(null);
  globalThis.fetch = only(dirtyStatus);
  const dirty = await mounted(createElement(RecentChangesWidget, { projectId: "git-recent-dirty", sessionId: null }));
  try {
    await act(async () => { await delay(20); });
    assert.match(dirty.container.textContent ?? "", /2 changed files/);
    assert.match(dirty.container.textContent ?? "", /feature\/compact/);
    assert.match(dirty.container.textContent ?? "", /↑ 2/);
    assert.match(dirty.container.textContent ?? "", /↓ 1/);
    const files = [...dirty.container.querySelectorAll<HTMLButtonElement>(".git-recent-file")];
    assert.equal(files.length, 2, "both changed files are listed");
    await act(async () => { files[0]!.click(); });
    assert.equal(getState().gitDiffPath, "src/a.ts", "a file row targets its own diff in Source control");
    // The summary is read-only: no stage/revert/publish surface exists here.
    assert.equal(dirty.container.querySelector(".git-recent-more"), null, "no duplicate inline-expansion action");
    assert.equal(dirty.container.querySelectorAll(".git-recent-foot .git-recent-open").length, 1, "one destination action");
  } finally {
    await dirty.unmount();
    setGitDiffPath(null);
  }
  assert.equal(mutations, 0, "the compact summary never mutates the repository");
});

test("GitView follows the open session project when client project id is missing", async () => {
  const projectId = "git-session-project";
  const sessionId = "git-session-chat";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("/api/git/status")) {
      return response({
        branch: "main", ahead: 0, behind: 0, conflicted: [], untracked: [],
        staged: [], unstaged: [{ path: "src/app.ts", status: "modified", staged: false }],
        isRepo: true,
      });
    }
    if (url.startsWith("/api/git/branches")) return response({ current: "main", branches: [{ name: "main", current: true }] });
    if (url.startsWith("/api/worktrees")) return response([]);
    if (url.startsWith("/api/git/graph")) return response([]);
    if (url.startsWith("/api/git/stashes")) return response([]);
    if (url.startsWith("/api/git/diff")) return response({ path: "src/app.ts", diff: "@@ -1 +1 @@\n-old\n+new" });
    throw new Error(`Unexpected request: ${url}`);
  };

  seedSessionCache({
    id: sessionId,
    projectId,
    title: "Open chat",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });
  activateProject(null);
  activateSession(sessionId);
  assert.equal(getState().activeProjectId, projectId);
  assert.equal(getState().activeSessionId, sessionId);

  const view = await mounted(createElement(GitView));
  try {
    await act(async () => { await delay(40); });
    assert.doesNotMatch(view.container.textContent ?? "", /No project selected/);
    assert.ok(view.container.querySelector(".git-file-main"), "session project git status is shown");
  } finally {
    await view.unmount();
    activateSession(null);
    activateProject(null);
  }
});
