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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { activateProject, activateSession, applyEvents, applyProjectAdded, getState, seedSessionCache, setGitBranch, setModels } = await import("../../../apps/web/src/store.ts");
const { default: GitView, DiffContent } = await import("../widgets/GitView.tsx");
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

test("GitView keeps staged-file and disclosure taps available without a detail composer overlay", async () => {
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
    assert.equal(view.container.querySelector(".git-commit-composer"), null, "composer is removed while detail is open");

    const back = view.container.querySelector<HTMLButtonElement>(".git-mobile-detail-head button");
    assert.ok(back);
    await act(async () => { back.click(); });
    assert.ok(view.container.querySelector(".git-commit-composer"), "composer returns after navigating back");
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
    assert.match(agentStatus.textContent ?? "", /feature\/glass-ui/);
    assert.equal(agentStatus.textContent?.includes("Context"), false);
    assert.equal(agentStatus.textContent?.includes("Agent"), false);

    await act(async () => {
      applyEvents([ev("turn/stopped", { turnId: "turn-active", reason: "completed" })]);
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
