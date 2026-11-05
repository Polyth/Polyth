import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { GitFileEntry, GitStatus } from "@polyth/session/web-api";
import type { SurfaceComponentProps } from "@polyth/web-sdk";
import {
  commitStagePlan,
  includedChanges,
  phoneChangeEntry,
  phoneChanges,
  phoneOverviewState,
} from "../widgets/phoneOverview.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
// The shell's one breakpoint seam reads these; everything here is a phone.
const matchMedia = (query: string) => ({
  matches: /max-width/.test(query),
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
Object.defineProperty(dom, "matchMedia", { configurable: true, value: matchMedia });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  ResizeObserver: dom.ResizeObserver,
  getComputedStyle: (element: Element) =>
    (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(element),
});
dom.document.documentElement.dataset.reduceAnimations = "true";
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateProject, activateSession, applyProjectAdded, seedSessionCache } = await import("../../../apps/web/src/store.ts");
const { tr } = await import("../../../apps/web/src/i18n/index.ts");
const { default: GitView } = await import("../widgets/GitView.tsx");
const { PaneVisibilityContext } = await import("../../../apps/web/src/workspace/paneVisibility.ts");
const { parseGitPrefs, setGitViewState } = await import("../widgets/gitPrefs.ts");
const { api } = await import("@polyth/session/web-api");

const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const entry = (path: string, status = "modified", staged = false): GitFileEntry => ({ path, status, staged });
const status = (patch: Partial<GitStatus> = {}): GitStatus => ({
  branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], isRepo: true, ...patch,
});

// ── The decisions ────────────────────────────────────────────────────────────

test("a partly staged file is one row whose numbers sum both entries", () => {
  const changes = phoneChanges(status({
    staged: [entry("a.ts", "modified", true)],
    unstaged: [entry("a.ts"), entry("b.ts")],
    untracked: [entry("c.ts", "untracked")],
    conflicted: [entry("z.ts", "conflicted")],
  }), (file) => ({ additions: file.staged ? 1 : 2, deletions: 3 }));
  assert.deepEqual(changes.map((change) => change.path), ["z.ts", "a.ts", "b.ts", "c.ts"], "conflicts lead, then by path");
  const partly = changes.find((change) => change.path === "a.ts")!;
  assert.deepEqual(partly.stats, { additions: 3, deletions: 6 });
  assert.equal(phoneChangeEntry(partly).staged, false, "a tap opens what is not staged yet");
  assert.equal(phoneChanges(status({ isRepo: false, unstaged: [entry("a.ts")] }), () => undefined).length, 0);
});

test("an untouched index commits everything; a chosen index commits only what it holds", () => {
  const nothingChosen = phoneChanges(status({ unstaged: [entry("a.ts")], untracked: [entry("b.ts", "untracked")] }), () => undefined);
  assert.deepEqual(includedChanges(nothingChosen, new Map()).map((change) => change.path), ["a.ts", "b.ts"]);
  assert.deepEqual(commitStagePlan(nothingChosen, new Map()), { stage: ["a.ts", "b.ts"], unstage: [] });

  const chosen = phoneChanges(status({ staged: [entry("a.ts", "modified", true)], unstaged: [entry("a.ts"), entry("b.ts")] }), () => undefined);
  assert.deepEqual(includedChanges(chosen, new Map()).map((change) => change.path), ["a.ts"]);
  assert.deepEqual(commitStagePlan(chosen, new Map()), { stage: [], unstage: [] }, "the staged hunks of a.ts stay the selection");
  assert.deepEqual(commitStagePlan(chosen, new Map([["a.ts", false], ["b.ts", true]])), { stage: ["b.ts"], unstage: ["a.ts"] });

  const conflicted = phoneChanges(status({ conflicted: [entry("c.ts", "conflicted")] }), () => undefined);
  assert.deepEqual(includedChanges(conflicted, new Map([["c.ts", true]])), [], "a conflict can never be committed");
  assert.deepEqual(commitStagePlan(conflicted, new Map([["c.ts", true]])), { stage: [], unstage: [] });
});

test("the overview reports the most urgent state", () => {
  const base = { status: { ahead: 0, behind: 0 }, isolated: false, isolationConflict: null, branchDiff: null, branchDiffPending: false };
  const changes = phoneChanges(status({ unstaged: [entry("a.ts")] }), () => ({ additions: 2, deletions: 1 }));
  const conflicted = phoneChanges(status({ unstaged: [entry("a.ts")], conflicted: [entry("b.ts", "conflicted")] }), () => undefined);
  assert.equal(phoneOverviewState({ ...base, changes: [] }).kind, "clean");
  assert.deepEqual(phoneOverviewState({ ...base, changes }), { kind: "changes", files: 1, additions: 2, deletions: 1 });
  assert.deepEqual(phoneOverviewState({ ...base, changes: conflicted, isolationConflict: 3 }), { kind: "conflict", source: "merge", count: 1 });
  assert.deepEqual(phoneOverviewState({ ...base, changes, isolationConflict: 3 }), { kind: "conflict", source: "isolation", count: 3 });
  assert.deepEqual(phoneOverviewState({ ...base, changes: [], status: { ahead: 2, behind: 1 } }), { kind: "remote", ahead: 2, behind: 1 });
  const branchDiff = { ahead: 3, files: [{ additions: 4, deletions: 1 }, { additions: 1, deletions: 0 }] };
  assert.deepEqual(phoneOverviewState({ ...base, changes: [], isolated: true, branchDiff }), { kind: "ready", commits: 3, files: 2, additions: 5, deletions: 1 });
  assert.equal(phoneOverviewState({ ...base, changes, isolated: true, branchDiff }).kind, "changes", "uncommitted work comes before landing");
  assert.equal(phoneOverviewState({ ...base, changes: [], isolated: true, branchDiffPending: true }).kind, "checking", "no false all-clear while it reads");
  assert.equal(phoneOverviewState({ ...base, changes: [], isolated: true, branchDiff: { ahead: 0, files: [] } }).kind, "clean");
});

test("phones keep their own wrap choice, on by default", () => {
  assert.equal(parseGitPrefs(null).phoneWrap, true);
  assert.equal(parseGitPrefs(null).wrap, false, "wider windows keep theirs");
  assert.equal(parseGitPrefs(JSON.stringify({ phoneWrap: false })).phoneWrap, false);
  assert.equal(parseGitPrefs(JSON.stringify({ phoneWrap: "no" })).phoneWrap, true);
});

// ── The screen ───────────────────────────────────────────────────────────────

const json = (body: unknown, code = 200): Response =>
  new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

interface Fixture {
  status: () => GitStatus;
  branchDiff?: { ahead: number; files: Array<{ path: string; status: string; additions?: number; deletions?: number }> };
  remote?: boolean;
  onPost?: (path: string, body: Record<string, unknown>) => void;
}

const diffOf = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

async function mountPhone(projectId: string, fixture: Fixture, sessionId: string | null = null) {
  const surface = (visible: boolean) => createElement(
    PaneVisibilityContext.Provider,
    { value: visible },
    createElement<SurfaceComponentProps>(GitView, { projectId, sessionId }),
  );
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1:4400");
    const path = url.pathname;
    if (init?.method && init.method !== "GET") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      posts.push({ path, body });
      fixture.onPost?.(path, body);
      return json({ ok: true, sha: "abc", message: "Generated subject" });
    }
    if (path === "/api/git/status") return json(fixture.status());
    if (path === "/api/git/branches") return json({ current: "main", branches: [{ name: "main", current: true }, { name: "devel", current: false }] });
    if (path === "/api/git/graph") return json([{ sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "First", author: "Test", date: "2026-01-01T00:00:00.000Z", parents: [], refs: [] }]);
    if (path === "/api/git/stashes" || path === "/api/worktrees") return json([]);
    if (path === "/api/git/remotes") {
      return json(fixture.remote === false ? { remotes: [], rejected: [] } : {
        remotes: [{ remoteName: "origin", direction: "push", url: "https://github.com/acme/repo.git" }],
        rejected: [],
      });
    }
    if (path === "/api/git/diff") return json({ path: url.searchParams.get("path"), diff: diffOf(url.searchParams.get("path") ?? ""), snapshotDigest: "d" });
    if (path === "/api/git/branch-diff") {
      const list = fixture.branchDiff ?? { ahead: 0, files: [] };
      return json({ base: "devel", baseSource: "isolation", head: "h", headRef: "main", mergeBase: "b", ...list });
    }
    return json({ message: "not mocked" }, 404);
  }) as typeof fetch;
  applyProjectAdded({ id: projectId, path: `/repo/${projectId}`, name: projectId, createdAt: 1 } as never);
  activateProject(projectId);
  activateSession(sessionId);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(surface(true));
    await delay(40);
  });
  const click = async (element: Element | null | undefined, label = "element") => {
    assert.ok(element !== null && element !== undefined, `${label} must exist`);
    await act(async () => { (element as HTMLElement).click(); await delay(); });
  };
  const byText = (selector: string, text: string) => [...document.querySelectorAll<HTMLElement>(selector)]
    .find((node) => node.textContent?.includes(text)) ?? null;
  return {
    container, posts, click, byText,
    title: () => container.querySelector(".git-phone-title")?.textContent ?? null,
    primary: () => container.querySelector<HTMLButtonElement>(".git-phone-primary"),
    layer: () => document.querySelector(".git-phone-layer"),
    async setVisible(visible: boolean) {
      await act(async () => { root.render(surface(visible)); await delay(); });
    },
    async close() {
      await act(async () => { root.unmount(); });
      container.remove();
      globalThis.fetch = originalFetch;
    },
  };
}

function typeInto(field: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
}

const postedPaths = (posts: readonly { path: string }[]) => posts.map((post) => post.path);

test("the first screen says what changed and offers one action, with no tabs or scopes", async () => {
  const view = await mountPhone("phone-overview", {
    status: () => status({ unstaged: [entry("src/a.ts")], untracked: [entry("src/b.ts", "untracked")] }),
  });
  try {
    assert.equal(view.title(), tr("gitphone.filesChanged", { count: 2 }));
    assert.equal(view.primary()?.textContent, tr("gitphone.commitFiles", { count: 2 }));
    assert.equal(view.container.querySelectorAll('[role="tab"], .git-review-scope, .source-control-head').length, 0, "the old controls are gone");
    assert.equal(view.container.querySelectorAll(".git-phone-file").length, 2);
    assert.equal(view.container.querySelectorAll(".git-file-stage, .git-file-discard, .diff-prefs").length, 0, "no row-level stage or revert on the first screen");
    assert.deepEqual([...view.container.querySelectorAll(".git-phone-nav .git-phone-row-label")].map((row) => row.textContent), [tr("gitphone.history"), tr("gitview.tabBranches"), tr("gitview.tabStashes")]);
  } finally { await view.close(); }
});

test("committing stages exactly the included files, then commits and clears the message", async () => {
  let current = status({ unstaged: [entry("a.ts"), entry("b.ts")], untracked: [entry("c.ts", "untracked")] });
  const view = await mountPhone("phone-commit", {
    status: () => current,
    onPost: (path) => { if (path === "/api/git/commit") current = status(); },
  });
  try {
    await view.click(view.byText(".git-phone-file", "b.ts"), "row");
    assert.ok(view.layer() !== null, "a file opens its own layer");
    assert.equal(document.querySelector(".git-phone-layer .sheet-title")?.textContent, "b.ts");
    assert.ok(view.byText(".git-phone-layer .git-diff-line", "new") !== null, "and shows its diff");
    await view.click(view.byText(".git-phone-file-action button", tr("gitphone.included")), "include toggle");
    await view.click(document.querySelector(".git-phone-layer .sheet-back"), "back");
    assert.equal(view.layer() === null, true, "Back returns to the overview");
    assert.equal(view.primary()?.textContent, tr("gitphone.commitFiles", { count: 2 }), "the action counts what will go in");
    assert.ok(view.byText(".git-phone-file", tr("gitphone.notIncluded"))?.textContent?.includes("b.ts"));

    await view.click(view.primary(), "commit");
    const message = document.querySelector<HTMLTextAreaElement>(".git-phone-commit textarea");
    assert.ok(message !== null);
    assert.equal(document.activeElement === message, false, "opening the sheet must not raise the keyboard");
    const commit = view.byText(".git-phone-commit-actions button", tr("gitview.commit"));
    assert.equal((commit as HTMLButtonElement).disabled, true, "no message, no commit");
    await act(async () => { typeInto(message!, "Subject"); await delay(); });
    await view.click(view.byText(".git-phone-commit-actions button", tr("gitview.commit")), "submit");
    assert.deepEqual(view.posts.map((post) => [post.path, post.body.paths ?? post.body.message]), [
      ["/api/git/stage", ["a.ts", "c.ts"]],
      ["/api/git/commit", "Subject"],
    ]);
    assert.equal(document.querySelector(".git-phone-commit") === null, true, "the sheet closes on success");
    assert.equal(view.title(), tr("gitphone.nothingToReview"));
    assert.equal(view.primary() === null, true, "nothing to do, no button");
  } finally { await view.close(); }
});

test("a failed commit keeps the sheet and the message", async () => {
  const originalCommit = api.gitCommit;
  api.gitCommit = async () => { throw new Error("hook said no"); };
  const view = await mountPhone("phone-commit-fail", { status: () => status({ unstaged: [entry("a.ts")] }) });
  try {
    await view.click(view.primary(), "commit");
    await act(async () => { typeInto(document.querySelector<HTMLTextAreaElement>(".git-phone-commit textarea")!, "Subject"); await delay(); });
    await view.click(view.byText(".git-phone-commit-actions button", tr("gitview.commit")), "submit");
    assert.equal(document.querySelector(".git-phone-commit") !== null, true);
    assert.equal(document.querySelector<HTMLTextAreaElement>(".git-phone-commit textarea")?.value, "Subject");
  } finally { api.gitCommit = originalCommit; await view.close(); }
});

test("a partly staged file keeps its hunk selection; commit and sync commits once", async () => {
  let current = status({ staged: [entry("a.ts", "modified", true)], unstaged: [entry("a.ts"), entry("b.ts")] });
  const view = await mountPhone("phone-partial", {
    status: () => current,
    onPost: (path) => { if (path === "/api/git/commit") current = status({ unstaged: [entry("a.ts"), entry("b.ts")] }); },
  });
  try {
    assert.equal(view.primary()?.textContent, tr("gitphone.commitOneFile"), "only what the index holds");
    await view.click(view.primary(), "commit");
    await view.click(document.querySelector(".git-phone-sheet > .git-phone-row"), "file list");
    assert.ok(view.byText(".git-phone-commit-file", tr("gitphone.stagedPartOnly"))?.textContent?.includes("a.ts"), "the row says what goes in");
    await act(async () => { typeInto(document.querySelector<HTMLTextAreaElement>(".git-phone-commit textarea")!, "Subject"); await delay(); });
    await view.click(view.byText(".git-phone-commit-actions button", tr("gitphone.commitAndSync")), "submit");
    await act(async () => { await delay(40); });
    assert.deepEqual(postedPaths(view.posts), ["/api/git/commit", "/api/git/sync"], "no staging, one commit, then the sync");
  } finally { await view.close(); }
});

test("generating a message stages the same files first, so it describes them", async () => {
  const view = await mountPhone("phone-generate", { status: () => status({ unstaged: [entry("a.ts")], untracked: [entry("b.ts", "untracked")] }) });
  try {
    await view.click(view.primary(), "commit");
    await view.click(view.byText(".git-phone-commit-field-foot button", tr("gitview.generate")), "generate");
    await act(async () => { await delay(40); });
    assert.deepEqual(postedPaths(view.posts), ["/api/git/stage", "/api/git/commit-message"]);
    assert.equal(document.querySelector<HTMLTextAreaElement>(".git-phone-commit textarea")?.value, "Generated subject");
  } finally { await view.close(); }
});

test("a cold open lands on the overview, not on the last file", async () => {
  const projectId = "phone-restore";
  setGitViewState(`${projectId}\0\0primary`, { selected: { path: "a.ts", staged: false }, closedGroups: [] });
  const view = await mountPhone(projectId, { status: () => status({ unstaged: [entry("a.ts")] }) });
  try {
    assert.equal(view.layer() === null, true);
    assert.equal(view.title(), tr("gitphone.oneFileChanged"));
  } finally { await view.close(); }
});

test("a merge conflict offers the agent first and marking resolved inside the file", async () => {
  const originalDraft = api.gitConflictPrompt;
  const drafts: unknown[] = [];
  api.gitConflictPrompt = (async (input: unknown) => { drafts.push(input); return { ok: true, data: { prompt: "fix it" } }; }) as typeof api.gitConflictPrompt;
  const view = await mountPhone("phone-conflict", { status: () => status({ conflicted: [entry("a.ts", "conflicted")] }) });
  try {
    assert.equal(view.title(), tr("gitphone.oneConflict"));
    assert.equal(view.primary()?.textContent, tr("gitphone.resolveWithAgent"));
    assert.equal(view.container.querySelectorAll(".conflict-agent-bar").length, 0, "the action replaces the banner");
    await view.click(view.container.querySelector(".git-phone-file"), "row");
    await view.click(view.byText(".git-phone-file-action button", tr("gitview.markResolved")), "resolve");
    assert.deepEqual(view.posts.map((post) => [post.path, post.body.paths]), [["/api/git/stage", ["a.ts"]]]);
    await view.click(document.querySelector(".git-phone-layer .sheet-back"), "back");
    await view.click(view.primary(), "agent");
    assert.equal(drafts.length, 1);
  } finally { api.gitConflictPrompt = originalDraft; await view.close(); }
});

test("an ordinary branch out of step offers exactly the step it needs", async () => {
  let current = status({ upstream: "origin/main", ahead: 2 });
  const view = await mountPhone("phone-remote", { status: () => current });
  try {
    assert.equal(view.title(), tr("gitphone.commitsToPush", { count: 2 }));
    assert.equal(view.primary()?.textContent, tr("gitphone.pushCommits", { count: 2 }));
    await view.click(view.primary(), "push");
    await act(async () => { await delay(40); });
    assert.deepEqual(postedPaths(view.posts), ["/api/git/push"]);
    current = status({ upstream: "origin/main", ahead: 1, behind: 1 });
  } finally { await view.close(); }
});

test("the branch sheet holds the remote steps and leads to Compare", async () => {
  const view = await mountPhone("phone-branch", { status: () => status({ upstream: "origin/main" }) });
  try {
    assert.equal(view.primary() === null, true);
    await view.click(view.container.querySelector(".git-phone-branch"), "branch row");
    const labels = [...document.querySelectorAll(".ui-menu-sheet .ui-menu-item-label")].map((label) => label.textContent);
    for (const expected of [tr("gitview.syncRepository"), tr("gitview.fetch"), tr("gitview.pull"), tr("gitview.push"), tr("gitphone.compareWith"), tr("gitphone.refresh")]) {
      assert.ok(labels.includes(expected), `${expected} is in the sheet`);
    }
    await view.click(view.byText(".ui-menu-sheet-item", tr("gitphone.compareWith")), "compare");
    assert.equal(document.querySelector(".git-phone-layer .sheet-title")?.textContent, tr("gitphone.compare"));
    assert.equal(document.querySelectorAll(".git-phone-layer .git-branch-review-toolbar, .git-phone-layer .git-branch-review-identity").length, 0, "no base form, toggles or merge-base line");
    assert.ok(document.querySelector(".git-phone-base") !== null, "the base is a row");
  } finally { await view.close(); }
});

test("an isolated chat with committed work integrates from the first screen", async () => {
  const projectId = "phone-isolated";
  const sessionId = "phone-isolated-session";
  const isolation = {
    kind: "git-worktree", state: "merge-ready", worktreePath: "/wt", worktreeBranch: "polyth/isolate/x",
    targetBranch: "devel", targetPath: "/repo", originPath: "/repo", baseCommit: "base", createdAt: "today",
  };
  seedSessionCache({ id: sessionId, projectId, title: "t", status: "idle", createdAt: 1, updatedAt: 1, isolation } as never);
  const originalStatus = api.isolationStatus;
  const originalMerge = api.isolationMerge;
  const merges: unknown[] = [];
  api.isolationStatus = (async () => ({
    isolation,
    suggestion: { eligible: true, hasChanges: true, targetBranch: "devel", targetDirty: false, revision: "rev" },
    effectiveState: "merge-ready",
    targets: [{ branch: "devel", path: "/repo", origin: true, current: true }],
    actions: { canMerge: true, canChooseTarget: true },
  })) as unknown as typeof api.isolationStatus;
  api.isolationMerge = (async (_id: string, input: unknown) => {
    merges.push(input);
    return { ok: true, commit: "c", targetBranch: "devel", session: { id: sessionId, projectId, title: "t", status: "idle", createdAt: 1, updatedAt: 2 }, finalized: true };
  }) as unknown as typeof api.isolationMerge;
  const view = await mountPhone(projectId, {
    status: () => status({ branch: "polyth/isolate/x" }),
    branchDiff: { ahead: 3, files: [{ path: "src/a.ts", status: "modified", additions: 9, deletions: 2 }] },
  }, sessionId);
  try {
    await act(async () => { await delay(40); });
    assert.equal(view.title(), tr("gitphone.commitsReady", { count: 3 }));
    assert.ok(view.container.querySelector(".git-phone-branch")?.textContent?.includes(tr("gitphone.isolatedBasedOn", { base: "devel" })), "plain words, not the branch hash");
    assert.equal(view.primary()?.textContent, tr("landing.integrateAndPush", { branch: "devel" }));
    await view.click(view.primary(), "integrate");
    assert.equal(merges.length, 1);
  } finally {
    api.isolationStatus = originalStatus;
    api.isolationMerge = originalMerge;
    await view.close();
  }
});

test("closing the kept-alive window takes its layers and sheets along, and keeps what was left out", async () => {
  const view = await mountPhone("phone-close", { status: () => status({ unstaged: [entry("a.ts"), entry("b.ts")] }) });
  try {
    await view.click(view.byText(".git-phone-file", "b.ts"), "row");
    await view.click(view.byText(".git-phone-file-action button", tr("gitphone.included")), "exclude");
    assert.equal(view.layer() !== null, true);
    await view.setVisible(false);
    assert.equal(view.layer() === null, true, "a portalled layer must not outlive its window");
    await view.setVisible(true);
    assert.equal(view.layer() === null, true, "it reopens on the overview");
    assert.equal(view.primary()?.textContent, tr("gitphone.commitOneFile"), "the choice survives");

    await view.click(view.primary(), "commit");
    assert.equal(document.querySelector(".git-phone-commit") !== null, true);
    await view.setVisible(false);
    assert.equal(document.querySelector(".git-phone-commit") === null, true, "so does an open sheet");
  } finally { await view.close(); }
});
