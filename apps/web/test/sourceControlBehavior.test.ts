import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
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
const { activateProject } = await import("../src/store.ts");
const { default: GitView, DiffContent } = await import("../src/components/GitView.tsx");
const { api } = await import("../src/api.ts");
const { pendingChangesMenuPosition } = await import("../src/components/PendingChangesBar.tsx");

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
      if (diffAttempts === 1) return response({ message: "temporary diff failure" }, 500);
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

test("pending-changes menu clamps its 320px placement to viewport gutters", () => {
  assert.deepEqual(
    pendingChangesMenuPosition({ right: 257, top: 500 }, { width: 320, height: 640 }),
    { left: 12, bottom: 148, width: 296 },
  );
});
