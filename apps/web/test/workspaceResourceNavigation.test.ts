import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { register } from "node:module";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  localStorage: dom.localStorage,
  location: dom.location,
  getComputedStyle: (element: Element) => dom.getComputedStyle(
    element as unknown as Parameters<Window["getComputedStyle"]>[0],
  ),
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const store = await import("../src/store.ts");
const { default: CommandPalette } = await import("../src/components/CommandPalette.tsx");
const { webPackageHost } = await import("../src/packages/webHost.ts");
const { registerSurface } = await import("../src/surfaces.ts");
registerSurface({ id: "files", title: "Files", order: 1, component: () => null, presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "close" } });

const { registerCommand } = await import("../src/commands.ts");
const project = { id: "palette-repos", name: "Product", path: "/web", createdAt: 1,
  primaryRepositoryId: "primary", repositories: [
    { id: "primary", alias: "web", path: "/web" }, { id: "api", alias: "api", path: "/api" },
  ] };

async function tick(ms = 0) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
}

test("palette groups commands once, ranks label hits, keeps selection across late results, and Escape clears first", async () => {
  store.activateProject(null);
  store.activateSession(null);
  store.openPalette("all");
  const disposers = [
    registerCommand({ id: "t.shell.one", label: "Toggle sidebar", group: "Shell", checked: () => false, run: () => {} }),
    registerCommand({ id: "t.panels.one", label: "Notifications", group: "Panels", keywords: ["sidebar alerts"], run: () => {} }),
    registerCommand({ id: "t.shell.two", label: "Sidebar density", group: "Shell", run: () => {} }),
  ];
  const original = api.searchWorkspaces;
  api.searchWorkspaces = async () => [{ kind: "session", id: "s-late", projectId: "p", title: "Sidebar notes", updatedAt: 1 }];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(CommandPalette)); });
    const input = document.querySelector<HTMLInputElement>(".palette-input")!;
    const groups = () => [...document.querySelectorAll(".palette-group")].map((node) => node.textContent);
    assert.equal(new Set(groups()).size, groups().length, "each group header renders once");
    assert.doesNotMatch(document.querySelector(".palette-list")!.textContent!, /\\u00a0/);

    await act(async () => { type(input, "sidebar"); });
    const labels = () => [...document.querySelectorAll('[role="option"] .palette-label')].map((node) => node.textContent);
    assert.deepEqual(labels().slice(0, 3), ["Sidebar density", "Toggle sidebar", "Notifications"],
      "prefix hits lead, then word hits, then keyword hits");
    assert.equal(document.querySelector('[role="option"] mark')?.textContent, "Sidebar");

    const key = (init: Record<string, unknown>) => act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, ...init }) as unknown as Event);
    });
    await key({ key: "ArrowDown" });
    const selected = () => document.querySelector('[role="option"][aria-selected="true"] .palette-label')?.textContent;
    assert.equal(selected(), "Toggle sidebar");
    await tick(190);
    assert.match(document.querySelector(".palette-list")!.textContent!, /Sidebar notes/, "late session results arrive");
    assert.equal(selected(), "Toggle sidebar", "selection stays on the same entry");

    await key({ key: "Escape" });
    assert.equal(input.value, "", "first Escape clears the query");
    assert.equal(store.getState().overlay, "palette", "and keeps the palette open");
  } finally {
    api.searchWorkspaces = original;
    for (const dispose of disposers) dispose();
    store.setOverlay(null);
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Quick Open separates equal paths by repository and supports preview and pinned Enter", async () => {
  store.applyProjectUpsert(project);
  store.activateProject(project.id);
  store.activateSession(null);
  store.openPalette("files");
  const original = api.filesSearchScored;
  const calls: string[] = [];
  api.filesSearchScored = async (_pid, _query, _limit, _dirs, _sid, repositoryId) => {
    calls.push(repositoryId!);
    return [{ path: "src/index.ts", kind: "file", matches: [], score: repositoryId === "api" ? 20 : 10 }];
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(CommandPalette)); });
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
    assert.ok(input);
    await act(async () => { type(input, "index"); });
    await tick(190);
    assert.deepEqual(calls.sort(), ["api", "primary"]);
    assert.equal(document.querySelectorAll('[role="option"]').length, 2);
    assert.match(document.querySelector(".palette-list")!.textContent!, /api/);
    assert.match(document.querySelector(".palette-list")!.textContent!, /web/);
    await act(async () => { input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event); });
    assert.equal(store.getState().editorOpenRequest?.repositoryId, "api");
    assert.equal(store.getState().editorOpenRequest?.preview, true);
    await act(async () => { input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }) as unknown as Event); });
    assert.equal(store.getState().editorOpenRequest?.preview, false);
  } finally {
    api.filesSearchScored = original;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("canonical project resource navigation clears the old session and preserves repository identity", () => {
  store.applyProjectUpsert(project);
  store.activateProject(project.id);
  store.upsertSession({ id: "resource-session", projectId: project.id, title: "Session", status: "idle", createdAt: 1, updatedAt: 1 });
  store.activateSession("resource-session");
  webPackageHost.navigation.openResource({ scheme: "file", locator: "src/index.ts", projectId: project.id, sessionId: null, repositoryId: "api" }, { preview: false });
  assert.equal(store.getState().activeSessionId, null);
  assert.equal(store.getState().editorOpenRequest?.sessionId, null);
  assert.equal(store.getState().editorOpenRequest?.repositoryId, "api");
  assert.equal(store.getState().editorOpenRequest?.preview, false);
});

test("clearing editor selection does not reuse a consumed open request identity", () => {
  store.openEditorFile("first.ts");
  const first = store.getState().editorOpenRequest!.id;
  store.openEditorFile(null);
  store.openEditorFile("second.ts");
  assert.ok(store.getState().editorOpenRequest!.id > first);
});

test("delayed resource lookup does not steal navigation or open in a different workspace", async () => {
  store.activateProject(project.id);
  store.activateSession(null);
  const beforeRequest = store.getState().editorOpenRequest;
  const original = api.getSession;
  let resolve!: (value: Awaited<ReturnType<typeof original>>) => void;
  api.getSession = async () => new Promise((done) => { resolve = done; });
  try {
    webPackageHost.navigation.openResource({ scheme: "file", locator: "late.ts", projectId: project.id, sessionId: "unloaded-resource" });
    store.activateProject("elsewhere");
    resolve({ id: "unloaded-resource", projectId: project.id, title: "Delayed", status: "idle", createdAt: 1, updatedAt: 1 });
    await tick();
    assert.equal(store.getState().activeProjectId, "elsewhere");
    assert.equal(store.getState().editorOpenRequest, beforeRequest);
  } finally { api.getSession = original; }
});

test("resource navigation rejects a session from another project before switching", async () => {
  store.activateProject(project.id);
  store.activateSession(null);
  store.upsertSession({ id: "foreign-resource", projectId: "elsewhere", title: "Other", status: "idle", createdAt: 1, updatedAt: 1 });
  webPackageHost.navigation.openResource({ scheme: "file", locator: "secret.ts", projectId: project.id, sessionId: "foreign-resource" });
  await tick();
  assert.equal(store.getState().activeProjectId, project.id);
  assert.equal(store.getState().activeSessionId, null);
  assert.match(store.getState().uiError ?? "", /does not belong/);
});

test("resource drag payloads retain repository identity and reject traversal or malformed scope", async () => {
  const { getDragResource, setDragResource, resourceShellPath, RESOURCE_MIME } = await import("../src/dnd.ts");
  const values = new Map<string, string>();
  const data = { setData: (key: string, value: string) => { values.set(key, value); }, getData: (key: string) => values.get(key) ?? "" };
  const ref = { scheme: "file", projectId: project.id, sessionId: null, repositoryId: "api", locator: "src/it's.ts" };
  setDragResource(data, ref);
  assert.deepEqual(getDragResource(data), ref);
  assert.equal(resourceShellPath(getDragResource(data)!), "'/api/src/it'\\''s.ts'");
  setDragResource(data, ref, { startLine: 3, endLine: 7, column: 2 });
  assert.deepEqual(getDragResource(data)?.selection, { startLine: 3, endLine: 7, column: 2 });
  values.set(RESOURCE_MIME, JSON.stringify({ ...ref, selection: { startLine: 7, endLine: 3 } }));
  assert.equal(getDragResource(data), null);
  values.set(RESOURCE_MIME, JSON.stringify({ ...ref, locator: "../escape.ts" }));
  assert.equal(getDragResource(data), null);
  values.set(RESOURCE_MIME, JSON.stringify({ ...ref, sessionId: {} }));
  assert.equal(getDragResource(data), null);
});

test("a multi-repository new chat picks repositories before the checkout as a draft preference", async () => {
  const { default: SessionContextBar } = await import("../src/components/mobile/SessionContextBar.tsx");
  store.applyProjectUpsert(project);
  store.activateProject(project.id);
  store.startNewSession(project.id, { draft: "keep my draft" });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const picks: Array<string[] | undefined> = [];
  const bar = (extra: Record<string, unknown> = {}) => createElement(SessionContextBar, {
    projectName: project.name,
    projectId: project.id,
    projects: [],
    onPickProject: () => {},
    repositories: project.repositories,
    primaryRepositoryId: "primary",
    onPickRepositories: (ids: string[] | undefined) => {
      picks.push(ids);
      store.setNewSessionRepositories(project.id, ids);
    },
    checkoutRepositoryAlias: "web",
    branchName: "main",
    branches: [],
    onPickBranch: () => {},
    ...extra,
  });
  try {
    await act(async () => root.render(bar()));
    const order = [...container.querySelectorAll<HTMLElement>(".context-selector")]
      .map((element) => /context-selector-(\w+)/.exec(element.className)?.[1]);
    assert.deepEqual(order, ["project", "repos", "branch"], "repositories sit between project and checkout");
    const repos = container.querySelector<HTMLButtonElement>(".context-selector-repos .picker-chip")!;
    assert.match(repos.textContent ?? "", /All 2 repos/);
    assert.match(container.querySelector(".context-selector-branch .picker-chip")!.textContent ?? "", /web\/main/,
      "the checkout names the repository it belongs to");
    assert.equal(document.querySelector('[role="dialog"]'), null);

    await act(async () => { repos.click(); });
    const option = (alias: string) => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((row) => row.querySelector(".palette-label")?.textContent === alias)!;
    assert.match(option("web").textContent ?? "", /Agent starts here/, "the primary explains why it matters");
    await act(async () => { option("web").click(); });
    assert.deepEqual(picks, [["api"]]);
    assert.deepEqual(store.getState().newSessionIntent?.repositoryIds, ["api"]);
    assert.equal(store.getState().newSessionIntent?.draft, "keep my draft");
    assert.equal(store.getState().activeSessionId, null, "choosing repositories never creates a session");
    await act(async () => { repos.click(); });
    assert.equal(document.querySelectorAll('[role="option"]').length, 0, "the scope picker closes from its chip");

    await act(async () => root.render(bar({
      repositoryIds: ["api"], checkoutRepositoryAlias: "api", branchName: "develop", branchId: "main",
      branches: [{ id: "main", label: "main" }], branchLockedReason: "Worktrees apply to web.",
    })));
    assert.ok(container.querySelector(".context-selector-repos.is-subset"), "a narrowed scope is visibly non-default");
    const branch = container.querySelector<HTMLButtonElement>(".context-selector-branch.is-locked .picker-chip")!;
    assert.ok(branch, "a non-primary execution repository locks the checkout");
    assert.match(branch.textContent ?? "", /api\/develop/, "the locked chip names the execution repository's own branch");
    assert.match(branch.getAttribute("aria-label") ?? "", /Worktrees apply to web\./);
    await act(async () => { branch.click(); });
    assert.equal(document.querySelectorAll('[role="option"]').length, 0, "no primary checkout can be picked");
    assert.match(document.querySelector(".context-picker-note")?.textContent ?? "", /Worktrees apply to web\./,
      "opening the locked chip explains why, including on touch");
    await act(async () => { branch.click(); });

    store.activateProject("elsewhere");
    store.startNewSession(project.id);
    assert.deepEqual(store.getState().newSessionIntent?.repositoryIds, ["api"], "membership restores with its scoped unsent draft");

    await act(async () => root.render(bar({ repositories: [project.repositories[0]] })));
    assert.equal(container.querySelector(".context-selector-repos"), null, "a single repository needs no scope control");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("isolated session headers hide the Files workspace indicator", async () => {
  const { default: SessionWorkspace } = await import("../../../packages/files/widgets/SessionWorkspace.tsx");
  const session = {
    id: "isolated-files-session", projectId: project.id, title: "Isolated", status: "idle" as const,
    createdAt: 1, updatedAt: 1, worktreePath: "/web/.worktrees/isolated",
  };
  store.applyProjectUpsert(project);
  store.activateProject(project.id);
  store.upsertSession(session);
  store.activateSession(session.id);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(SessionWorkspace, { placement: "header" })));
    assert.equal(container.querySelector(".files-workspace-indicator"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    store.activateSession(null);
  }
});

test("session workspace updates use the opened revision and canonical session ID", async () => {
  const { default: SessionWorkspace } = await import("../../../packages/files/widgets/SessionWorkspace.tsx");
  store.activateProject(project.id);
  const session = { id: "membership-session", projectId: project.id, title: "Session", status: "idle" as const, createdAt: 1, updatedAt: 1,
    workspace: { mode: "subset" as const, revision: 4, repositories: [{ repositoryId: "primary", path: project.path }] } };
  store.upsertSession(session);
  store.activateSession(session.id);
  const original = api.updateSessionWorkspace;
  const calls: unknown[] = [];
  api.updateSessionWorkspace = async (sessionId, selection) => { calls.push([sessionId, selection]); return session; };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(SessionWorkspace, { placement: "header" })));
    await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
    const choices = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => { choices[1]!.click(); });
    const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Update workspace")!;
    await act(async () => { save.click(); });
    assert.deepEqual(calls, [[session.id, { expectedRevision: 4, repositoryIds: ["primary", "api"] }]]);
  } finally {
    api.updateSessionWorkspace = original;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("bare file references preserve ambiguity, deleted diffs, and excluded membership", async () => {
  const { resolveFileReference } = await import("../src/resources/resolveFile.ts");
  store.applyProjectUpsert(project);
  const stat = api.filesStat;
  const diff = api.gitDiff;
  const seen: string[] = [];
  api.filesStat = async (_pid, path, _sid, repo) => {
    seen.push(repo!);
    if (path === "gone.ts" || path === "missing.ts") throw new Error("not found");
    return { path, kind: "file", size: 5 } as Awaited<ReturnType<typeof stat>>;
  };
  api.gitDiff = async (_pid, path) => ({ path, diff: path === "gone.ts" ? "--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n" : "" });
  try {
    const ref = { scheme: "file", projectId: project.id, locator: "src/index.ts", sessionId: null };
    assert.deepEqual((await resolveFileReference(ref)).map((row) => row.ref.repositoryId), ["primary", "api"]);
    assert.equal((await resolveFileReference({ ...ref, repositoryId: "api" })).length, 1);
    assert.equal((await resolveFileReference({ ...ref, locator: "gone.ts", repositoryId: "api" }))[0]?.deletedDiff?.includes("/dev/null"), true);
    assert.deepEqual(await resolveFileReference({ ...ref, locator: "missing.ts" }), []);
    assert.deepEqual(await resolveFileReference({ ...ref, locator: "../secret.ts" }), []);
    store.upsertSession({ id: "refs-subset", projectId: project.id, title: "Subset", status: "idle", createdAt: 1, updatedAt: 1,
      workspace: { repositories: [{ repositoryId: "api", path: "/api" }] } });
    seen.length = 0;
    assert.deepEqual(await resolveFileReference({ ...ref, sessionId: "refs-subset", repositoryId: "primary" }), []);
    assert.deepEqual(seen, []);
  } finally { api.filesStat = stat; api.gitDiff = diff; }
});

test("Git context drops attach a repository-scoped hunk and reject stale snapshots", async () => {
  const { dropIntoSession, setDragResource } = await import("../src/dnd.ts");
  const { pendingAttachments, clearAttachments } = await import("../src/attachments.ts");
  const { hunkDigest, splitHunks } = await import("../src/review/anchors.ts");
  store.applyProjectUpsert(project);
  store.activateProject(project.id);
  store.activateSession(null);
  clearAttachments(null);
  const values = new Map<string, string>();
  const transfer = { setData: (key: string, value: string) => { values.set(key, value); }, getData: (key: string) => values.get(key) ?? "", files: [] } as unknown as DataTransfer;
  const patch = "diff --git a/src/file.ts b/src/file.ts\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const digest = "a".repeat(64);
  const oldDiff = api.gitDiff;
  const oldUpload = api.filesUpload;
  const oldStat = api.filesStat;
  let uploaded = "";
  api.gitDiff = async (_pid, _path, _staged, _ws, _sid, repositoryId) => {
    assert.equal(repositoryId, "api");
    return { path: _path, diff: patch, snapshotDigest: digest };
  };
  api.filesUpload = async (_pid, _path, bytes) => { uploaded = new TextDecoder().decode(bytes); return { ok: true }; };
  api.filesStat = async (_pid, path) => ({ path, kind: "file", size: uploaded.length, mime: "text/plain" });
  const ref = { scheme: "file", projectId: project.id, sessionId: null, repositoryId: "api", locator: "src/file.ts" };
  const errors: string[] = [];
  try {
    setDragResource(transfer, ref, undefined, { kind: "working-changes", snapshotDigest: digest, hunkDigest: hunkDigest(splitHunks(patch)[0]!) });
    await dropIntoSession(transfer, project.id, null, (message) => errors.push(message));
    assert.equal(errors.length, 0);
    assert.match(uploaded, /Repository: api \(api\)/);
    assert.match(uploaded, /File: src\/file.ts/);
    assert.match(uploaded, /\+new/);
    assert.match(pendingAttachments(null)[0]?.name ?? "", /working changes/);
    setDragResource(transfer, ref, undefined, { kind: "working-changes", snapshotDigest: "b".repeat(64) });
    await dropIntoSession(transfer, project.id, null, (message) => errors.push(message));
    assert.match(errors[0] ?? "", /Changes moved/);
    assert.equal(pendingAttachments(null).length, 1);
  } finally {
    api.gitDiff = oldDiff; api.filesUpload = oldUpload; api.filesStat = oldStat;
    clearAttachments(null);
  }
});

test("directory drops attach a scoped reference without reading directory contents", async () => {
  const { dropIntoSession, setDragResource } = await import("../src/dnd.ts");
  const { clearAttachments } = await import("../src/attachments.ts");
  store.applyProjectUpsert(project); store.activateProject(project.id); store.activateSession(null);
  const values = new Map<string, string>();
  const transfer = { setData: (key: string, value: string) => { values.set(key, value); }, getData: (key: string) => values.get(key) ?? "", files: [] } as unknown as DataTransfer;
  const oldUpload = api.filesUpload;
  const oldStat = api.filesStat;
  let uploaded = "";
  const calls: string[] = [];
  api.filesUpload = async (_pid, _path, bytes) => { uploaded = new TextDecoder().decode(bytes); return { ok: true }; };
  api.filesStat = async (_pid, path, _sid, repositoryId) => {
    calls.push(path);
    if (path === "src") { assert.equal(repositoryId, "api"); return { path, kind: "dir", size: 0 }; }
    return { path, kind: "file", size: uploaded.length, mime: "text/plain" };
  };
  try {
    setDragResource(transfer, { scheme: "file", projectId: project.id, sessionId: null, repositoryId: "api", locator: "src" }, undefined, { kind: "directory" });
    const errors: string[] = [];
    await dropIntoSession(transfer, project.id, null, (message) => errors.push(message));
    assert.equal(errors.length, 0);
    assert.match(uploaded, /Directory reference\nRepository: api \(api\)\nPath: src\//);
    assert.equal(calls.filter((path) => !path.startsWith("_inbox/")).length, 1);
  } finally { api.filesUpload = oldUpload; api.filesStat = oldStat; clearAttachments(null); }
});
