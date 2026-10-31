import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { IsolationMergeInput, IsolationStatusDto, SessionIsolation, SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
});
dom.document.documentElement.dataset.reduceAnimations = "true";
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The conflict preview and commit count are plain GETs; the transport
// captures fetch when it is created, so the stub is installed first.
const reads: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  reads.push(url);
  const body = url.includes("/conflicts")
    ? { target: "t", source: "s", mergeBase: "b", files: [], targetBranch: "devel", recorded: [] }
    : { base: "devel", baseSource: "isolation", head: "h", mergeBase: "b", ahead: 2, files: [] };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { seedSessionCache } = await import("../../../apps/web/src/store.ts");
const { tr } = await import("../../../apps/web/src/i18n/index.ts");
const { api } = await import("@polyth/session/web-api");
const { setGitPrefs } = await import("../widgets/gitPrefs.ts");
const { default: LandingBar } = await import("../widgets/LandingBar.tsx");
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

const isolation = (targetBranch: string): SessionIsolation => ({
  kind: "git-worktree", state: "merge-ready", worktreePath: "/wt", worktreeBranch: "polyth/isolate/landing",
  targetBranch, targetPath: "/repo", originPath: "/repo", baseCommit: "base", createdAt: "today",
});
const session = (id: string, targetBranch: string): SessionProjection => ({
  id, projectId: "landing", title: id, status: "idle", createdAt: 1, updatedAt: 1, isolation: isolation(targetBranch),
});
const targets = (current: string) => [
  { branch: "devel", path: "/repo", origin: true, current: current === "devel" },
  { branch: "feat/voice", path: "/repo-voice", origin: false, current: current === "feat/voice" },
];
const status = (targetBranch: string, extra: Partial<IsolationStatusDto> = {}): IsolationStatusDto => ({
  isolation: isolation(targetBranch),
  suggestion: { eligible: true, hasChanges: true, targetBranch, targetDirty: false, revision: "rev" },
  effectiveState: "merge-ready",
  targets: targets(targetBranch),
  actions: { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false, canChooseTarget: true },
  ...extra,
});

async function mount(projection: SessionProjection, read: () => IsolationStatusDto) {
  seedSessionCache(projection);
  const original = { status: api.isolationStatus, merge: api.isolationMerge, retarget: api.isolationRetarget };
  const merges: IsolationMergeInput[] = [];
  const retargets: unknown[] = [];
  api.isolationStatus = async () => read();
  api.isolationMerge = async (_id: string, input: IsolationMergeInput = {}) => {
    merges.push(input);
    return { ok: true, commit: "c", targetBranch: "devel", session: { ...projection, isolation: undefined }, finalized: true };
  };
  api.isolationRetarget = async (_id: string, input: unknown) => { retargets.push(input); return projection; };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(LandingBar, { projectId: "landing", sessionId: projection.id, uncommitted: 0 }));
    await wait(); await wait();
  });
  return {
    container, merges, retargets,
    primary: () => container.querySelector<HTMLButtonElement>(".git-landing-action button"),
    async close() {
      await act(async () => root.unmount());
      container.remove();
      Object.assign(api, { isolationStatus: original.status, isolationMerge: original.merge, isolationRetarget: original.retarget });
    },
  };
}

test("the landing integrates into the recorded target and pushes it by default", async () => {
  setGitPrefs({ pushAfterIntegrate: true }, "landing");
  const view = await mount(session("landing-ready", "devel"), () => status("devel"));
  try {
    const bar = view.container.querySelector(".git-landing");
    assert.ok(bar);
    assert.match(bar.textContent ?? "", new RegExp(tr("landing.noConflicts")));
    assert.match(bar.textContent ?? "", /2 commits/);
    assert.equal(view.primary()?.textContent, tr("landing.integrateAndPush", { branch: "devel" }));
    await act(async () => { view.primary()!.click(); await wait(); });
    assert.deepEqual(view.merges, [{ push: true }], "no target: the recorded one; push as shown");
  } finally { await view.close(); }
});

test("with Push off the landing only integrates", async () => {
  setGitPrefs({ pushAfterIntegrate: false }, "landing");
  const view = await mount(session("landing-nopush", "devel"), () => status("devel"));
  try {
    assert.equal(view.primary()?.textContent, tr("isolation.integrateInto", { branch: "devel" }));
    await act(async () => { view.primary()!.click(); await wait(); });
    assert.deepEqual(view.merges, [{}]);
  } finally { await view.close(); setGitPrefs({ pushAfterIntegrate: true }, "landing"); }
});

test("a switched origin checkout is proposed and integrating sends that target", async () => {
  const switched = status("feat/shared-chat", {
    suggestion: { eligible: false, hasChanges: true, targetBranch: "feat/shared-chat", targetDirty: false, revision: "rev", reason: "destination-unavailable" },
    targets: targets("none"),
    actions: { canReview: true, canMerge: false, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false, canChooseTarget: true },
  });
  const view = await mount(session("landing-switched", "feat/shared-chat"), () => switched);
  try {
    assert.equal(view.container.querySelector(".git-landing-target-name")?.textContent, "devel");
    assert.match(view.container.textContent ?? "", /is on devel now, not feat\/shared-chat/);
    await act(async () => { view.primary()!.click(); await wait(); });
    assert.deepEqual(view.merges, [{ target: { branch: "devel", path: "/repo" }, push: true }]);
  } finally { await view.close(); }
});

test("choosing another branch retargets without integrating", async () => {
  const view = await mount(session("landing-choose", "devel"), () => status("devel"));
  try {
    const chip = view.container.querySelector<HTMLButtonElement>(".git-landing-target");
    assert.ok(chip);
    await act(async () => { chip.click(); await wait(); });
    const row = [...document.querySelectorAll<HTMLButtonElement>("[data-menu-entry]")]
      .find((button) => button.getAttribute("data-menu-entry") === "target:/repo-voice");
    assert.ok(row, "every checked-out target is offered");
    assert.ok(document.querySelector('[data-menu-entry="push"]'), "Push after integrating lives beside the targets");
    await act(async () => { row.click(); await wait(); });
    assert.deepEqual(view.retargets, [{ branch: "feat/voice", path: "/repo-voice" }]);
    assert.deepEqual(view.merges, [], "choosing a target never integrates");
  } finally { await view.close(); }
});

test("with no default target the one action is choosing a branch", async () => {
  const stranded = status("gone", {
    suggestion: { eligible: false, hasChanges: true, targetBranch: "gone", targetDirty: false, revision: "rev", reason: "destination-unavailable" },
    targets: [{ branch: "feat/voice", path: "/repo-voice", origin: false, current: false }],
    actions: { canReview: true, canMerge: false, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false, canChooseTarget: true },
  });
  const view = await mount(session("landing-stranded", "gone"), () => stranded);
  try {
    assert.equal(view.primary()?.textContent, tr("landing.chooseBranchAction"));
    await act(async () => { view.primary()!.click(); await wait(); });
    assert.ok(document.querySelector('[data-menu-entry="target:/repo-voice"]'), "the primary opens the target list");
    assert.deepEqual(view.merges, []);
  } finally { await view.close(); }
});

test("the landing stays away without work to integrate", async () => {
  const empty = status("devel", { suggestion: { eligible: false, hasChanges: false, targetBranch: "devel", targetDirty: false, revision: "rev", reason: "no-changes" } });
  const view = await mount(session("landing-empty", "devel"), () => empty);
  try {
    assert.equal(view.container.querySelector(".git-landing"), null);
  } finally { await view.close(); }
});
