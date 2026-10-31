import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import type { SurfaceComponentProps } from "@polyth/web-sdk";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  ResizeObserver: dom.ResizeObserver,
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
const { default: RepoStackPanel } = await import("../widgets/RepoStackPanel.tsx");
const { default: SourceControlAuthGuide } = await import("../widgets/SourceControlAuthGuide.tsx");
const { default: SourceControlProfilesSettings } = await import("../widgets/SourceControlProfilesSettings.tsx");
const { getGitPrefs, setGitPrefs } = await import("../widgets/gitPrefs.ts");
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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }) as unknown as Event);
}

test("GitView commit log preferences stay in the selected repository scope", async () => {
  const projectId = "git-log-preferences-project";
  const scope = `${projectId}\0\0primary`;
  const globalPrefs = { ...getGitPrefs() };
  const originalFetch = globalThis.fetch;
  setGitPrefs({ layout: "unified" }, scope);
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("/api/git/status")) return response({
      branch: "main", ahead: 0, behind: 0, conflicted: [], staged: [],
      unstaged: [], untracked: [], isRepo: true,
    });
    if (url.startsWith("/api/git/branches")) return response({ current: "main", branches: [{ name: "main", current: true }] });
    if (url.startsWith("/api/git/graph")) return response([{
      sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "Scoped preferences",
      author: "Test", date: "2026-01-01T00:00:00.000Z", parents: [], refs: ["HEAD -> main"],
    }]);
    if (url.startsWith("/api/git/show")) return response({ diff: "@@ -1 +1 @@\n-old\n+new" });
    if (url.startsWith("/api/worktrees") || url.startsWith("/api/git/stashes")) return response([]);
    throw new Error(`Unexpected request: ${url}`);
  };
  activateProject(projectId);
  activateSession(null);
  const view = await mounted(createElement<SurfaceComponentProps>(GitView, { projectId, sessionId: null }));
  try {
    const log = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent?.trim() === "Log");
    assert.ok(log);
    await act(async () => { log.click(); await delay(20); });
    const commit = view.container.querySelector<HTMLButtonElement>(".git-graph-row");
    assert.ok(commit);
    await act(async () => { commit.click(); await delay(20); });
    const split = [...view.container.querySelectorAll<HTMLButtonElement>(".diff-layout-toggle button")]
      .find((button) => button.textContent?.trim() === "Split");
    assert.ok(split);
    await act(async () => { split.click(); });
    assert.equal(getGitPrefs(scope).layout, "split", "commit-log controls update the selected scope");
    assert.ok(view.container.querySelector(".split-diff"), "the displayed commit uses the updated preference");
    assert.deepEqual(getGitPrefs(), globalPrefs, "repository controls preserve account defaults");
  } finally {
    await view.unmount();
    setGitPrefs(globalPrefs);
    activateProject(null);
    globalThis.fetch = originalFetch;
  }
});

test("RepoStackPanel manages branch entries and preserves provider status", async () => {
  const projectId = "stack-ui-project";
  const repositoryId = "repo-a";
  const requests: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  let stack = {
    id: "release",
    projectId,
    repositoryId,
    baseBranch: "main",
    entries: [
      { branch: "feature/db", baseBranch: "main", headSha: "db-head", baseSha: "main-sha", prNumber: 12, title: "Database", checks: { passed: 3, total: 3, state: "success" as const }, review: "approved" as const },
      { branch: "feature/api", baseBranch: "feature/db", headSha: "api-head", baseSha: "db-head", checks: { passed: 1, total: 2, state: "pending" as const }, review: "pending" as const },
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ method, url, body });
    if (method === "GET" && url.startsWith("/api/git/stacks")) return response({ stacks: [stack] });
    if (method === "PATCH" && url.includes("/api/git/stacks/release")) {
      stack = { ...stack, entries: (body?.entries as typeof stack.entries) ?? stack.entries };
      return response(stack);
    }
    throw new Error(`Unexpected stack request: ${method} ${url}`);
  };

  const view = await mounted(createElement(RepoStackPanel, { projectId, repositoryId }));
  try {
    assert.match(view.container.textContent ?? "", /feature\/db/);
    assert.match(view.container.textContent ?? "", /#12/);
    assert.match(view.container.textContent ?? "", /checks 3\/3/);
    assert.match(view.container.textContent ?? "", /approved/);

    const edit = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Edit branches"));
    assert.ok(edit);
    await act(async () => { edit.click(); });
    const add = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Add branch"));
    assert.ok(add);
    await act(async () => { add.click(); });
    const branch = view.container.querySelector<HTMLInputElement>('input[aria-label="Branch 3"]');
    const basedOn = view.container.querySelector<HTMLInputElement>('input[aria-label="Base branch 3"]');
    const title = view.container.querySelector<HTMLInputElement>('input[aria-label="Pull request title 3"]');
    const pr = view.container.querySelector<HTMLInputElement>('input[aria-label="Pull request number 3"]');
    assert.ok(branch && basedOn && title && pr);
    await act(async () => {
      setInputValue(branch, "feature/ui");
      setInputValue(basedOn, "feature/api");
      setInputValue(title, "UI polish");
      setInputValue(pr, "34");
    });
    const down = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("↓"));
    assert.ok(down);
    await act(async () => { down.click(); });
    const save = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Save branches"));
    assert.ok(save && !save.disabled);
    await act(async () => { save.click(); await delay(10); });
    const update = requests.find((item) => item.method === "PATCH");
    assert.ok(update, "branch edits are persisted through the stack client");
    const entries = update.body?.entries as Array<Record<string, unknown>>;
    assert.deepEqual(entries.map((entry) => entry.branch), ["feature/api", "feature/db", "feature/ui"]);
    assert.equal(entries[2]?.title, "UI polish");
    assert.equal(entries[2]?.prNumber, 34);
    assert.equal("headSha" in entries[2]!, false, "new branches let the server capture trusted immutable SHAs");
    assert.match(view.container.textContent ?? "", /feature\/ui/);
  } finally {
    await view.unmount();
    globalThis.fetch = originalFetch;
  }
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
    // An untyped 503 reports what the server said; only a typed harness
    // transport recovery may blame OpenCode.
    assert.match(alert?.textContent ?? "", /branches unavailable/);
    assert.doesNotMatch(alert?.textContent ?? "", /OpenCode is reconnecting/);
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

test("source-control auth guide makes SSH and HTTPS setup actionable without a credential editor", async () => {
  const view = await mounted(createElement(SourceControlAuthGuide, {
    remote: {
      url: "git@github.com:acme/repo.git",
      hostname: "github.com",
      fullPath: "acme/repo",
      protocol: "ssh",
    },
  }));
  try {
    const text = view.container.textContent ?? "";
    assert.match(text, /Git access/);
    assert.match(text, /How to set up access/);
    assert.match(text, /connect over SSH/);
    assert.match(text, /github\.com\/acme\/repo/, "the remote reads as host and path");
    assert.match(text, /commit identity is not a credential vault/);
    assert.match(text, /ssh-keygen -t ed25519/);
    assert.match(text, /gh auth login/);
    assert.match(text, /multiple accounts/i);
    assert.match(text, /Open Terminal/);
    assert.match(text, /Open GitHub SSH keys/);
    assert.equal(view.container.querySelector("select"), null, "credentials are explained, not edited as a profile mode");
    assert.ok([...view.container.querySelectorAll(".source-control-auth-card--recommended code")]
      .some((code) => code.textContent?.includes("ssh -T git@github.com")));
  } finally {
    await view.unmount();
  }
});

test("new identity editor offers only the sign-in methods Polyth carries out", async () => {
  const previousFetch = globalThis.fetch;
  const previousProfiles = localStorage.getItem("polyth.sourceControlProfiles.v1");
  localStorage.removeItem("polyth.sourceControlProfiles.v1");
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("/api/git/remotes")) {
      return response({
        remotes: [{ remoteName: "origin", direction: "fetch", url: "git@github.com:acme/repo.git" }],
        rejected: [],
      });
    }
    if (url.startsWith("/api/git/identity")) return response({ name: "System User", email: "system@example.com" });
    if (url.startsWith("/api/git/ssh-keys")) return response({ keys: [{ path: "/home/me/.ssh/id_work", name: "id_work" }] });
    if (url.startsWith("/api/git/accounts")) return response({ accounts: [], unavailable: [] });
    throw new Error(`Unexpected request: ${url}`);
  };

  const view = await mounted(createElement(SourceControlProfilesSettings));
  try {
    const add = [...view.container.querySelectorAll("button")].find((button) => button.textContent?.includes("New identity"));
    assert.ok(add);
    await act(async () => { add.click(); await delay(20); });
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const methods = [...dialog.querySelectorAll('.git-identity-auth [aria-pressed]')].map((button) => button.textContent?.trim());
    assert.deepEqual(methods, ["This machine", "Account", "SSH", "Anonymous"]);
    assert.equal([...dialog.querySelectorAll("option")].some((option) => /SSH agent|Credential helper|Provider CLI/.test(option.textContent ?? "")), false);
    const create = () => [...document.querySelectorAll<HTMLButtonElement>(".ui-dialog-foot button")].find((button) => button.textContent === "Create");
    assert.equal(create()?.disabled, true, "nothing to create yet");

    const label = dialog.querySelector<HTMLInputElement>(".git-identity-label-input");
    const name = dialog.querySelector<HTMLInputElement>("#git-identity-name");
    const email = dialog.querySelector<HTMLInputElement>("#git-identity-email");
    assert.ok(label && name && email);
    await act(async () => {
      setInputValue(label, "Work");
      setInputValue(name, "Ada");
      setInputValue(email, "ada@example.com");
      await delay(20);
    });
    assert.equal(dialog.querySelector("h2")?.textContent, "New identity", "naming a new identity does not turn it into an edit");
    assert.equal(create()?.disabled, false);

    const ssh = [...dialog.querySelectorAll<HTMLButtonElement>('.git-identity-auth [aria-pressed]')].find((button) => button.textContent?.trim() === "SSH");
    await act(async () => { ssh!.click(); await delay(20); });
    assert.equal(create()?.disabled, true, "SSH sign-in needs a key");
    const account = [...dialog.querySelectorAll<HTMLButtonElement>('.git-identity-auth [aria-pressed]')].find((button) => button.textContent?.trim() === "Account");
    await act(async () => { account!.click(); await delay(20); });
    assert.equal(create()?.disabled, true, "account sign-in needs an account");
    assert.match(dialog.textContent ?? "", /Choose a source control account first/);
  } finally {
    await view.unmount();
    globalThis.fetch = previousFetch;
    if (previousProfiles === null) localStorage.removeItem("polyth.sourceControlProfiles.v1");
    else localStorage.setItem("polyth.sourceControlProfiles.v1", previousProfiles);
  }
});

test("projection working state shows live activity before turn-start hydration", async () => {
  const projectId = "projection-working-activity-project";
  const sessionId = "projection-working-activity-session";
  const repoRoot = "/tmp/projection-working-activity";

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("/api/git/status")) {
      return response({
        branch: "main", ahead: 0, behind: 0, conflicted: [], staged: [],
        unstaged: [], untracked: [], isRepo: true,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  activateProject(projectId);
  applyProjectAdded({
    id: projectId,
    path: repoRoot,
    name: "projection activity",
    createdAt: 1,
  });
  setModels([{ providerID: "openai", modelID: "luna", name: "Luna", providerName: "OpenAI" }]);
  seedSessionCache({
    id: sessionId,
    projectId,
    title: "projection activity",
    status: "working",
    model: { providerID: "openai", modelID: "luna" },
    createdAt: 1,
    updatedAt: 2,
  });
  activateSession(sessionId);

  const view = await mounted(createElement(PendingChangesBar));
  try {
    await act(async () => { await delay(40); });
    const activity = view.container.querySelector(".agent-status-dock");
    assert.ok(activity, "projection working status keeps agent activity visible before turn/started arrives");
    assert.match(activity.textContent ?? "", /Luna/);
    assert.equal(view.container.querySelector(".pending-changes-bar"), null);
  } finally {
    await view.unmount();
    setModels([]);
    activateSession(null);
    activateProject(null);
  }
});

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
    if (url.startsWith("/api/git/remotes")) return response({
      remotes: [{ remoteName: "origin", direction: "fetch", url: "https://github.com/acme/repo.git" }],
      rejected: [],
    });
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
    if (url.startsWith("/api/git/remotes")) return response({
      remotes: [{ remoteName: "origin", direction: "fetch", url: "https://github.com/acme/repo.git" }],
      rejected: [],
    });
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

test("GitView chooses a named remote for sync actions", async () => {
  const projectId = "git-remote-picker-project";
  let pushedRemote = "";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = (init as { method?: string } | undefined)?.method ?? "GET";
    if (url.startsWith("/api/git/remotes")) return response({
      remotes: [
        { remoteName: "origin", direction: "fetch", url: "https://github.com/acme/repo.git" },
        { remoteName: "personal", direction: "push", url: "git@github.com:acme/repo.git" },
      ],
      rejected: [],
    });
    if (url.startsWith("/api/git/status")) return response({
      branch: "main", ahead: 1, behind: 0, upstream: "origin/main", conflicted: [], staged: [], untracked: [], unstaged: [], isRepo: true,
    });
    if (url.startsWith("/api/git/branches")) return response({ current: "main", branches: [{ name: "main", current: true }] });
    if (url.startsWith("/api/worktrees") || url.startsWith("/api/git/graph") || url.startsWith("/api/git/stashes")) return response([]);
    if (url.startsWith("/api/git/push") && method === "POST") {
      pushedRemote = String((JSON.parse(String(init?.body)) as { remote?: string }).remote ?? "");
      return response({ ok: true });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  activateProject(projectId);
  const view = await mounted(createElement(GitView));
  try {
    await act(async () => { await delay(40); });
    const picker = view.container.querySelector<HTMLButtonElement>(".git-remote-picker .picker-chip");
    assert.ok(picker, "multiple remotes expose the compact remote picker");
    await act(async () => { picker.click(); await delay(20); });
    const personal = [...document.querySelectorAll<HTMLElement>(".picker-item")]
      .find((item) => item.textContent?.includes("personal"));
    assert.ok(personal, "the second remote is reachable");
    await act(async () => { personal.click(); await delay(20); });
    assert.equal(view.container.querySelector(".git-ahead-behind"), null, "origin-only status counts are not shown for another selected remote");

    const trigger = view.container.querySelector<HTMLButtonElement>('.source-remote-actions [aria-haspopup="menu"]');
    assert.ok(trigger);
    await act(async () => { trigger.click(); await delay(20); });
    const push = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
      .find((item) => /push/i.test(item.textContent ?? ""));
    assert.ok(push);
    await act(async () => { push.click(); await delay(30); });
    assert.equal(pushedRemote, "personal");
  } finally {
    await view.unmount();
    activateProject(null);
  }
});

test("GitView disables remote actions when remote inspection is unsafe", async () => {
  const projectId = "git-unsafe-remote-project";
  let mutations = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = (init as { method?: string } | undefined)?.method ?? "GET";
    if (url.startsWith("/api/git/remotes")) return response({
      remotes: [],
      rejected: [{ remoteName: "origin", direction: "fetch" }],
    });
    if (url.startsWith("/api/git/status")) return response({
      branch: "main", ahead: 0, behind: 0, conflicted: [], staged: [], untracked: [], unstaged: [], isRepo: true,
    });
    if (url.startsWith("/api/git/branches")) return response({ current: "main", branches: [{ name: "main", current: true }] });
    if (url.startsWith("/api/worktrees") || url.startsWith("/api/git/graph") || url.startsWith("/api/git/stashes")) return response([]);
    if (method !== "GET") mutations += 1;
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  activateProject(projectId);
  const view = await mounted(createElement(GitView));
  try {
    await act(async () => { await delay(40); });
    const sync = view.container.querySelector<HTMLButtonElement>(".source-sync-btn");
    const menu = view.container.querySelector<HTMLButtonElement>('.source-remote-actions [aria-haspopup="menu"]');
    assert.equal(sync?.disabled, true);
    assert.equal(menu?.disabled, true);
    assert.equal(mutations, 0);
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
    if (url.startsWith("/api/git/remotes")) return response({
      remotes: [{ remoteName: "origin", direction: "fetch", url: "https://github.com/acme/repo.git" }],
      rejected: [],
    });
    if (url.startsWith("/api/git/status")) {
      return response({
        branch: "main", ahead: 1, behind: 1, conflicted: [{ path: "conflict.ts", status: "conflicted", staged: false }], staged: [], untracked: [], unstaged: [], isRepo: true,
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
    assert.equal(view.container.querySelectorAll(".conflict-agent-bar").length, 1, "remote failure and merge conflicts share one recovery section");
    assert.match(banner.textContent ?? "", /1 unresolved merge conflict/);
    assert.equal(status?.parentElement, banner.parentElement, "error and recovery actions stay together");
    assert.equal(view.container.querySelector(".git-feedback-remote")?.textContent, "origin");
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
    if (url.startsWith("/api/git/remotes")) return response({
      remotes: [{ remoteName: "origin", direction: "fetch", url: "https://github.com/acme/repo.git" }],
      rejected: [],
    });
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
    if (url.startsWith("/api/git/remotes")) return response({
      remotes: [{ remoteName: "origin", direction: "fetch", url: "https://github.com/acme/repo.git" }],
      rejected: [],
    });
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

test("GitView all-repositories overview keeps independent status counts and no mutations", async () => {
  const projectId = "git-all-repositories-project";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://127.0.0.1:4400");
    if (url.pathname === "/api/git/status") {
      const repositoryId = url.searchParams.get("repositoryId");
      if (repositoryId === "repo-b") return response({ message: "repo-b unavailable" }, 503);
      return response({
        branch: "main", ahead: 2, behind: 1, conflicted: [],
        staged: [{ path: "a.ts", status: "modified", staged: true }],
        unstaged: [{ path: "b.ts", status: "modified", staged: false }],
        untracked: [], isRepo: true,
      });
    }
    if (url.pathname === "/api/git/branches" || url.pathname === "/api/worktrees" || url.pathname === "/api/git/graph" || url.pathname === "/api/git/stashes") {
      return response(url.pathname === "/api/git/branches" ? { current: "main", branches: [{ name: "main", current: true }] } : []);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  applyProjectAdded({
    id: projectId,
    name: "Multi-repo",
    path: "/repo-a",
    repositories: [
      { id: "repo-a", alias: "App", path: "/repo-a" },
      { id: "repo-b", alias: "API", path: "/repo-b" },
    ],
    primaryRepositoryId: "repo-a",
    createdAt: 1,
  });
  const view = await mounted(createElement(GitView));
  try {
    const picker = view.container.querySelector<HTMLButtonElement>(".picker-chip");
    assert.ok(picker, "repository scope picker is visible");
    await act(async () => { picker.click(); });
    const all = [...document.querySelectorAll<HTMLElement>(".picker-item")]
      .find((item) => item.textContent?.includes("All repositories"));
    assert.ok(all, "all repositories scope is available");
    await act(async () => { all!.click(); await delay(30); });
    assert.match(view.container.textContent ?? "", /All repositories/);
    assert.match(view.container.textContent ?? "", /App/);
    assert.match(view.container.textContent ?? "", /2 changed/);
    assert.match(view.container.textContent ?? "", /2 ahead/);
    assert.match(view.container.textContent ?? "", /API/);
    assert.match(view.container.textContent ?? "", /repo-b unavailable|OpenCode is reconnecting/);
    assert.equal(view.container.querySelector(".git-commit-composer"), null, "overview has no commit composer");
    assert.equal(view.container.querySelector('[aria-label="Stage a.ts"]'), null, "overview has no stage action");
  } finally {
    await view.unmount();
    activateProject(null);
  }
});

test("isolated GitView defaults to Branch scope and loads file patches lazily without mutation controls", async () => {
  const originalFetch = globalThis.fetch;
  const projectId = "branch-review-default-project";
  const sessionId = "branch-review-default-session";
  const reads: string[] = [];
  const identity = { base: "main", baseSource: "isolation", head: "a".repeat(40), headRef: "topic", mergeBase: "b".repeat(40) };
  globalThis.fetch = async (input) => {
    const url = String(input); reads.push(url);
    if (url.startsWith("/api/git/branch-diff")) return response(url.includes("path=") ? { ...identity, path: "file.ts", diff: "@@ -1 +1 @@\n-old\n+new\n" } : { ...identity, ahead: 1, files: [{ path: "file.ts", status: "modified", additions: 1, deletions: 1 }] });
    if (url.startsWith("/api/git/status")) return response({ isRepo: true, branch: "topic", ahead: 1, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] });
    if (url.startsWith("/api/git/branches")) return response({ current: "topic", branches: [{ name: "main", current: false }, { name: "topic", current: true }] });
    if (url.startsWith("/api/git/remotes")) return response({ remotes: [], rejected: [] });
    if (url.startsWith("/api/git/graph") || url.startsWith("/api/git/stashes") || url.startsWith("/api/worktrees")) return response([]);
    throw new Error(`Unexpected request ${url}`);
  };
  applyProjectAdded({ id: projectId, name: "Branch review", path: "/review", createdAt: 1 });
  seedSessionCache({ id: sessionId, projectId, title: "Review", status: "idle", createdAt: 1, updatedAt: 1, worktreePath: "/review-isolated", worktreeState: "ready", isolation: {
    kind: "git-worktree", state: "active", worktreePath: "/review-isolated", worktreeBranch: "topic", targetBranch: "main", targetPath: "/review", baseCommit: identity.mergeBase, createdAt: "today",
  } });
  const view = await mounted(createElement<import("@polyth/web-sdk").SurfaceComponentProps>(GitView, { projectId, sessionId }));
  try {
    const switchButton = labeledButton(view.container, "Branch vs base");
    assert.equal(switchButton?.getAttribute("aria-pressed"), "true");
    const panel = view.container.querySelector(".git-branch-review"); assert.ok(panel);
    assert.equal(reads.filter((url) => url.startsWith("/api/git/branch-diff") && url.includes("path=")).length, 0);
    const file = panel.querySelector<HTMLButtonElement>(".git-branch-review-files button"); assert.ok(file);
    await act(async () => { file.click(); await delay(20); });
    assert.equal(reads.filter((url) => url.startsWith("/api/git/branch-diff") && url.includes("path=")).length, 1);
    assert.match(panel.textContent ?? "", /new/);
    assert.ok(!panel.querySelector('[aria-label="Stage hunk"]'));
    assert.ok(!panel.querySelector('[aria-label="Discard hunk"]'));
    assert.ok(!panel.querySelector(".hunk-actions"));
  } finally { await view.unmount(); globalThis.fetch = originalFetch; }
});

test("Branch review insertion validates notes and calls conversation.insert once; no-session action stays disabled", async () => {
  const { BranchReviewPanel } = await import("../widgets/GitView.tsx");
  const { reviewNoteKey } = await import("../widgets/branchReview.ts");
  const { workspacePresentationKey } = await import("../../../apps/web/src/store.ts");
  const { saveComments, hunkDigest, splitHunks } = await import("../../../apps/web/src/review/anchors.ts");
  const { GIT_PREFS_DEFAULTS } = await import("../widgets/gitPrefs.ts");
  const originalFetch = globalThis.fetch;
  const projectId = "branch-review-insert-project";
  const sessionId = "branch-review-insert-session";
  const identity = { base: "main", baseSource: "default", head: "a".repeat(40), headRef: "topic", mergeBase: "b".repeat(40) };
  const diff = "@@ -1 +1 @@\n-old\n+new\n";
  const note = { id: "note", path: "file.ts", text: "Please verify this change", excerpt: "-old\n+new", digest: hunkDigest(splitHunks(diff)[0]!), line: 1, mergeBase: identity.mergeBase, head: identity.head, createdAt: 1 };
  const inserted: string[] = [];
  let sends = 0;
  const host = { conversation: { insert: (text: string) => inserted.push(text), send: () => { sends++; } } } as unknown as import("@polyth/web-sdk").WebPackageHost;
  const seed = (session: string | null) => {
    const key = workspacePresentationKey(reviewNoteKey({ project: projectId, repository: "primary", workspace: "/review", base: "main", head: "topic" }), projectId, session);
    saveComments(key, [note]);
  };
  globalThis.fetch = async (input) => response(String(input).includes("path=") ? { ...identity, path: "file.ts", diff } : { ...identity, ahead: 1, files: [{ path: "file.ts", status: "modified", additions: 1, deletions: 1 }] });
  seed(sessionId);
  seedSessionCache({ id: sessionId, projectId, title: "Review", status: "idle", createdAt: 1, updatedAt: 1 });
  activateSession(sessionId);
  let view = await mounted(createElement(BranchReviewPanel, { target: { projectId, sessionId }, host, prefs: GIT_PREFS_DEFAULTS, prefsScope: projectId, workspace: "/review", missing: false }));
  try {
    const button = labeledButton(view.container, "Insert 1 review notes into chat"); assert.ok(button && !button.disabled);
    await act(async () => { button.click(); button.click(); await delay(20); });
    assert.equal(inserted.length, 1); assert.equal(sends, 0);
    assert.equal(inserted[0], "Review notes: topic vs main (bbbbbbbb)\n\n1. `file.ts:1` — Please verify this change\n\n```diff\n-old\n+new\n```");
    assert.match(view.container.querySelector('[role="status"]')?.textContent ?? "", /inserted/);
    await view.unmount(); seed(null);
    view = await mounted(createElement(BranchReviewPanel, { target: { projectId }, host, prefs: GIT_PREFS_DEFAULTS, prefsScope: projectId, workspace: "/review", missing: false }));
    assert.ok(labeledButton(view.container, "Insert 1 review notes into chat")?.disabled);
    assert.match(view.container.textContent ?? "", /Select a session/);
  } finally { await view.unmount(); globalThis.fetch = originalFetch; }
});

test("Branch review insertion aborts when the active session changes during delayed file revalidation", async () => {
  const { BranchReviewPanel } = await import("../widgets/GitView.tsx");
  const { reviewNoteKey } = await import("../widgets/branchReview.ts");
  const { workspacePresentationKey } = await import("../../../apps/web/src/store.ts");
  const { saveComments, hunkDigest, splitHunks } = await import("../../../apps/web/src/review/anchors.ts");
  const { GIT_PREFS_DEFAULTS } = await import("../widgets/gitPrefs.ts");
  const originalFetch = globalThis.fetch;
  const projectId = "branch-review-race-project";
  const sessionId = "branch-review-race-session";
  const otherSessionId = "branch-review-race-other-session";
  const identity = { base: "main", baseSource: "default", head: "a".repeat(40), headRef: "topic", mergeBase: "b".repeat(40) };
  const diff = "@@ -1 +1 @@\n-old\n+new\n";
  const note = { id: "note", path: "file.ts", text: "Please verify this change", excerpt: "-old\n+new", digest: hunkDigest(splitHunks(diff)[0]!), line: 1, mergeBase: identity.mergeBase, head: identity.head, createdAt: 1 };
  const inserted: string[] = [];
  let sends = 0;
  const host = { conversation: { insert: (text: string) => inserted.push(text), send: () => { sends++; } } } as unknown as import("@polyth/web-sdk").WebPackageHost;
  const key = workspacePresentationKey(reviewNoteKey({ project: projectId, repository: "primary", workspace: "/review", base: "main", head: "topic" }), projectId, sessionId);
  saveComments(key, [note]);
  let releaseFile!: () => void;
  const fileGate = new Promise<void>((resolve) => { releaseFile = resolve; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("path=")) { await fileGate; return response({ ...identity, path: "file.ts", diff }); }
    return response({ ...identity, ahead: 1, files: [{ path: "file.ts", status: "modified", additions: 1, deletions: 1 }] });
  };
  seedSessionCache({ id: sessionId, projectId, title: "Review", status: "idle", createdAt: 1, updatedAt: 1 });
  seedSessionCache({ id: otherSessionId, projectId, title: "Other", status: "idle", createdAt: 1, updatedAt: 1 });
  activateSession(sessionId);
  const view = await mounted(createElement(BranchReviewPanel, { target: { projectId, sessionId }, host, prefs: GIT_PREFS_DEFAULTS, prefsScope: projectId, workspace: "/review", missing: false }));
  try {
    const button = labeledButton(view.container, "Insert 1 review notes into chat");
    assert.ok(button && !button.disabled);
    await act(async () => { button.click(); await delay(5); });
    assert.equal(inserted.length, 0, "insertion is still awaiting the gated file revalidation");
    await act(async () => { activateSession(otherSessionId); releaseFile(); await delay(20); });
    assert.equal(inserted.length, 0, "changing the active session during revalidation must not insert");
    assert.equal(sends, 0);
    assert.doesNotMatch(view.container.textContent ?? "", /inserted/);
  } finally { await view.unmount(); globalThis.fetch = originalFetch; activateSession(null); }
});

test("Branch review insertion aborts when the review scope changes during delayed file revalidation", async () => {
  const { BranchReviewPanel } = await import("../widgets/GitView.tsx");
  const { reviewNoteKey } = await import("../widgets/branchReview.ts");
  const { workspacePresentationKey } = await import("../../../apps/web/src/store.ts");
  const { saveComments, hunkDigest, splitHunks } = await import("../../../apps/web/src/review/anchors.ts");
  const { GIT_PREFS_DEFAULTS } = await import("../widgets/gitPrefs.ts");
  const originalFetch = globalThis.fetch;
  const projectId = "branch-review-scope-race-project";
  const sessionId = "branch-review-scope-race-session";
  const identity = { base: "main", baseSource: "default", head: "a".repeat(40), headRef: "topic", mergeBase: "b".repeat(40) };
  const diff = "@@ -1 +1 @@\n-old\n+new\n";
  const note = { id: "note", path: "file.ts", text: "Please verify this change", excerpt: "-old\n+new", digest: hunkDigest(splitHunks(diff)[0]!), line: 1, mergeBase: identity.mergeBase, head: identity.head, createdAt: 1 };
  const inserted: string[] = [];
  const host = { conversation: { insert: (text: string) => inserted.push(text), send: () => {} } } as unknown as import("@polyth/web-sdk").WebPackageHost;
  const key = workspacePresentationKey(reviewNoteKey({ project: projectId, repository: "primary", workspace: "/review", base: "main", head: "topic" }), projectId, sessionId);
  saveComments(key, [note]);
  let releaseFile!: () => void;
  const fileGate = new Promise<void>((resolve) => { releaseFile = resolve; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("path=")) { await fileGate; return response({ ...identity, path: "file.ts", diff }); }
    return response({ ...identity, ahead: 1, files: [{ path: "file.ts", status: "modified", additions: 1, deletions: 1 }] });
  };
  seedSessionCache({ id: sessionId, projectId, title: "Review", status: "idle", createdAt: 1, updatedAt: 1 });
  activateSession(sessionId);
  const view = await mounted(createElement(BranchReviewPanel, { target: { projectId, sessionId }, host, prefs: GIT_PREFS_DEFAULTS, prefsScope: projectId, workspace: "/review", missing: false }));
  try {
    const button = labeledButton(view.container, "Insert 1 review notes into chat");
    assert.ok(button && !button.disabled);
    await act(async () => { button.click(); await delay(5); });
    assert.equal(inserted.length, 0, "insertion is still awaiting the gated file revalidation");
    const baseInput = view.container.querySelector<HTMLInputElement>("input[list]");
    assert.ok(baseInput, "base picker is present");
    await act(async () => { setInputValue(baseInput!, "develop"); await delay(0); });
    const compare = labeledButton(view.container, "Compare");
    assert.ok(compare);
    await act(async () => { compare!.click(); await delay(10); });
    await act(async () => { releaseFile(); await delay(20); });
    assert.equal(inserted.length, 0, "changing the review base during revalidation must not insert");
    assert.doesNotMatch(view.container.textContent ?? "", /inserted/);
  } finally { await view.unmount(); globalThis.fetch = originalFetch; }
});

test("Branch review note keys follow the resolved workspace path, not the session id", async () => {
  const { BranchReviewPanel } = await import("../widgets/GitView.tsx");
  const { reviewNoteKey } = await import("../widgets/branchReview.ts");
  const { workspacePresentationKey } = await import("../../../apps/web/src/store.ts");
  const { saveComments } = await import("../../../apps/web/src/review/anchors.ts");
  const { GIT_PREFS_DEFAULTS } = await import("../widgets/gitPrefs.ts");
  const originalFetch = globalThis.fetch;
  const projectId = "branch-review-note-key-project";
  const sessionId = "branch-review-note-key-session";
  const worktreeA = "/worktrees/alpha";
  const worktreeB = "/worktrees/beta";
  const identity = { base: "main", baseSource: "default", head: "a".repeat(40), headRef: "topic", mergeBase: "b".repeat(40) };
  const note = (text: string) => ({ id: text, path: "file.ts", text, excerpt: "-old\n+new", digest: "d", line: 1, mergeBase: identity.mergeBase, head: identity.head, createdAt: 1 });
  const keyFor = (workspace: string) => workspacePresentationKey(reviewNoteKey({ project: projectId, repository: "primary", workspace, base: "main", head: "topic" }), projectId, sessionId);
  saveComments(keyFor(worktreeA), [note("note-in-alpha")]);
  saveComments(keyFor(worktreeB), [note("note-in-beta")]);
  saveComments(keyFor(sessionId), [note("note-under-session-id")]);
  globalThis.fetch = async (input) => response(String(input).includes("path=")
    ? { ...identity, path: "file.ts", diff: "@@ -1 +1 @@\n-old\n+new\n" }
    : { ...identity, ahead: 1, files: [{ path: "file.ts", status: "modified", additions: 1, deletions: 1 }] });
  seedSessionCache({ id: sessionId, projectId, title: "Review", status: "idle", createdAt: 1, updatedAt: 1 });
  activateSession(sessionId);
  try {
    const alpha = await mounted(createElement(BranchReviewPanel, { target: { projectId, sessionId }, prefs: GIT_PREFS_DEFAULTS, prefsScope: projectId, workspace: worktreeA, missing: false }));
    try {
      assert.match(alpha.container.textContent ?? "", /note-in-alpha/);
      assert.doesNotMatch(alpha.container.textContent ?? "", /note-in-beta/);
      assert.doesNotMatch(alpha.container.textContent ?? "", /note-under-session-id/, "the note key must not substitute the session id for the resolved workspace path");
    } finally { await alpha.unmount(); }
    const beta = await mounted(createElement(BranchReviewPanel, { target: { projectId, sessionId }, prefs: GIT_PREFS_DEFAULTS, prefsScope: projectId, workspace: worktreeB, missing: false }));
    try {
      assert.match(beta.container.textContent ?? "", /note-in-beta/);
      assert.doesNotMatch(beta.container.textContent ?? "", /note-in-alpha/);
      assert.doesNotMatch(beta.container.textContent ?? "", /note-under-session-id/);
    } finally { await beta.unmount(); }
  } finally { globalThis.fetch = originalFetch; activateSession(null); }
});

test("Branch review refetches and discards the stale list when the resolved workspace changes", async () => {
  const { BranchReviewPanel } = await import("../widgets/GitView.tsx");
  const { reviewNoteKey } = await import("../widgets/branchReview.ts");
  const { workspacePresentationKey } = await import("../../../apps/web/src/store.ts");
  const { saveComments } = await import("../../../apps/web/src/review/anchors.ts");
  const { GIT_PREFS_DEFAULTS } = await import("../widgets/gitPrefs.ts");
  const originalFetch = globalThis.fetch;
  const projectId = "branch-review-workspace-switch-project";
  const sessionId = "branch-review-workspace-switch-session";
  const worktreeA = "/worktrees/alpha";
  const worktreeB = "/worktrees/beta";
  const identity = { base: "main", baseSource: "default", head: "a".repeat(40), headRef: "topic", mergeBase: "b".repeat(40) };
  const note = (text: string) => ({ id: text, path: text, text, excerpt: "-old\n+new", digest: "d", line: 1, mergeBase: identity.mergeBase, head: identity.head, createdAt: 1 });
  const keyFor = (workspace: string) => workspacePresentationKey(reviewNoteKey({ project: projectId, repository: "primary", workspace, base: "main", head: "topic" }), projectId, sessionId);
  saveComments(keyFor(worktreeA), [note("note-in-alpha")]);
  saveComments(keyFor(worktreeB), [note("note-in-beta")]);
  let listCalls = 0;
  let releaseAlpha!: () => void;
  const alphaGate = new Promise<void>((resolve) => { releaseAlpha = resolve; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("path=")) return response({ ...identity, path: "file.ts", diff: "@@ -1 +1 @@\n-old\n+new\n" });
    listCalls += 1;
    if (listCalls === 1) {
      await alphaGate;
      return response({ ...identity, ahead: 1, files: [{ path: "alpha.ts", status: "modified", additions: 1, deletions: 1 }] });
    }
    return response({ ...identity, ahead: 1, files: [{ path: "beta.ts", status: "modified", additions: 1, deletions: 1 }] });
  };
  seedSessionCache({ id: sessionId, projectId, title: "Review", status: "idle", createdAt: 1, updatedAt: 1 });
  activateSession(sessionId);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (workspace: string) => createElement(BranchReviewPanel, { target: { projectId, sessionId }, prefs: GIT_PREFS_DEFAULTS, prefsScope: projectId, workspace, missing: false });
  try {
    await act(async () => { root.render(render(worktreeA)); await delay(20); });
    assert.equal(listCalls, 1, "the initial workspace issues exactly one list request");
    assert.equal(container.querySelector(".git-branch-review-files"), null, "the gated alpha list has not resolved yet");
    await act(async () => { root.render(render(worktreeB)); await delay(20); });
    assert.equal(listCalls, 2, "changing the resolved workspace must issue a new list request");
    assert.match(container.textContent ?? "", /beta\.ts/);
    assert.match(container.textContent ?? "", /note-in-beta/);
    assert.doesNotMatch(container.textContent ?? "", /alpha\.ts/);
    assert.doesNotMatch(container.textContent ?? "", /note-in-alpha/);
    await act(async () => { releaseAlpha(); await delay(20); });
    assert.match(container.textContent ?? "", /beta\.ts/);
    assert.doesNotMatch(container.textContent ?? "", /alpha\.ts/, "the late alpha response must be discarded");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    globalThis.fetch = originalFetch;
    activateSession(null);
  }
});

test("Branch review clears pending file loading when a base comparison cancels the selection", async () => {
  const { BranchReviewPanel } = await import("../widgets/GitView.tsx");
  const { GIT_PREFS_DEFAULTS } = await import("../widgets/gitPrefs.ts");
  const originalFetch = globalThis.fetch;
  const identity = { base: "main", baseSource: "default", head: "a".repeat(40), headRef: "topic", mergeBase: "b".repeat(40) };
  let listCalls = 0;
  let releaseFile!: () => void;
  const fileGate = new Promise<void>((resolve) => { releaseFile = resolve; });
  globalThis.fetch = async (input) => {
    if (String(input).includes("path=")) {
      await fileGate;
      return response({ ...identity, path: "file.ts", diff: "@@ -1 +1 @@\n-old\n+obsolete-patch\n" });
    }
    listCalls += 1;
    return response({ ...identity, ahead: 1, files: [{ path: "file.ts", status: "modified", additions: 1, deletions: 1 }] });
  };
  const view = await mounted(createElement(BranchReviewPanel, {
    target: { projectId: "branch-review-base-reset" }, prefs: GIT_PREFS_DEFAULTS,
    prefsScope: "branch-review-base-reset", workspace: "/review", missing: false,
  }));
  try {
    const file = view.container.querySelector<HTMLButtonElement>(".git-branch-review-files button");
    assert.ok(file);
    await act(async () => { file.click(); await delay(20); });
    assert.match(view.container.textContent ?? "", /Loading branch changes/);
    const baseInput = view.container.querySelector<HTMLInputElement>(".git-branch-review-toolbar input");
    assert.ok(baseInput);
    await act(async () => { setInputValue(baseInput, "main"); });
    const compare = labeledButton(view.container, "Compare");
    assert.ok(compare && !compare.disabled);
    await act(async () => { compare.click(); await delay(20); });
    assert.equal(listCalls, 2);
    assert.match(view.container.textContent ?? "", /Choose a file from the change list/);
    assert.doesNotMatch(view.container.textContent ?? "", /Loading branch changes/);
    await act(async () => { releaseFile(); await delay(20); });
    assert.doesNotMatch(view.container.textContent ?? "", /obsolete-patch/, "late file responses must not restore the cancelled selection");
  } finally {
    await act(async () => { releaseFile(); await delay(20); });
    await view.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("GitView Conflicts view shows each overlapping edit and opens the file the card asked for", async () => {
  const { handoffReviewScope } = await import("../widgets/reviewScopeHandoff.ts");
  const { workspacePresentationKey } = await import("../../../apps/web/src/store.ts");
  const projectId = "git-conflicts-project";
  const sessionId = "git-conflicts-session";
  const originalFetch = globalThis.fetch;
  const previews: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith(`/api/isolation/${sessionId}/conflicts`)) {
      previews.push(url);
      return response({
        targetBranch: "main", recorded: ["src/gone.ts", "src/view.tsx"], target: "t".repeat(40), source: "s".repeat(40), mergeBase: "b".repeat(40),
        files: [
          { path: "src/gone.ts", kind: "deleted-in-target", regions: [] },
          { path: "src/view.tsx", kind: "content", regions: [{
            line: 12, before: ["const a = 1;"], target: ["const label = main();"], source: ["const label = session();"], after: ["return label;"],
          }] },
        ],
      });
    }
    if (url.startsWith("/api/git/status")) return response({
      branch: "polyth/isolate/x", ahead: 0, behind: 0, conflicted: [], staged: [], unstaged: [], untracked: [], isRepo: true,
    });
    if (url.startsWith("/api/git/branches")) return response({ current: "polyth/isolate/x", branches: [] });
    return response([]);
  };
  seedSessionCache({
    id: sessionId, projectId, title: "Conflicted", status: "idle", createdAt: 1, updatedAt: 1,
    isolation: {
      kind: "git-worktree", state: "conflict", conflict: { message: "main changed in conflicting areas.", files: ["src/gone.ts", "src/view.tsx"], at: 7 },
      worktreePath: "/repo-x", worktreeBranch: "polyth/isolate/x", targetBranch: "main", targetPath: "/repo", originPath: "/repo",
      baseCommit: "b".repeat(40), createdAt: "today",
    },
  });
  activateProject(projectId);
  activateSession(sessionId);
  handoffReviewScope(workspacePresentationKey("git-review-handoff", projectId, sessionId), "conflicts", "src/view.tsx");
  const view = await mounted(createElement<SurfaceComponentProps>(GitView, { projectId, sessionId }));
  try {
    await act(async () => { await delay(20); });
    const scope = [...view.container.querySelectorAll<HTMLButtonElement>(".git-review-scope button")];
    assert.deepEqual(scope.map((button) => [button.textContent, button.getAttribute("aria-pressed")]), [
      ["Working tree", "false"], ["Branch vs base", "false"], ["Conflicts", "true"],
    ]);
    assert.equal(previews.length, 1);
    const files = [...view.container.querySelectorAll<HTMLButtonElement>(".git-conflict-review .git-branch-review-file")];
    assert.deepEqual(files.map((file) => [file.title, file.getAttribute("aria-pressed")]), [["src/gone.ts", "false"], ["src/view.tsx", "true"]]);
    const region = view.container.querySelector('.git-conflict-region[aria-label="Line 12"]');
    assert.ok(region);
    assert.deepEqual([...region.querySelectorAll(".diff-conflict-target")].map((row) => row.textContent), ["const label = main();"]);
    assert.deepEqual([...region.querySelectorAll(".diff-conflict-source")].map((row) => row.textContent), ["12const label = session();"]);
    assert.deepEqual([...region.querySelectorAll(".git-conflict-side-label")].map((label) => label.textContent), ["main", "This session"]);
    await act(async () => { files[0]!.click(); await delay(0); });
    assert.match(view.container.querySelector(".git-conflict-review .source-inline-status")?.textContent ?? "", /main no longer has this file/);
    assert.equal(view.container.querySelector(".git-conflict-region"), null);
  } finally {
    await view.unmount();
    activateSession(null);
    activateProject(null);
    globalThis.fetch = originalFetch;
  }
});
