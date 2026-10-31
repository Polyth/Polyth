import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { IsolationStatusDto, SessionIsolation, SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
});
// These cases cover logic, not motion (the motion modules have their own
// tests). happy-dom implements Element.animate, so run them with the
// product's reduce-animations setting, as before it did.
dom.document.documentElement.dataset.reduceAnimations = "true";
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: () => {},
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateSession, getState, seedSessionCache, upsertSession } = await import("../../../apps/web/src/store.ts");
const { IsolationLock, IsolationCard, IsolationListBadge } = await import("../widgets/IsolationCard.tsx");
const { tr } = await import("../../../apps/web/src/i18n/index.ts");
const { api } = await import("@polyth/session/web-api");
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));
const base = {
  kind: "git-worktree" as const, worktreePath: "/repo-isolated", worktreeBranch: "polyth/isolate/test",
  targetBranch: "main", targetPath: "/repo", originPath: "/repo", baseCommit: "base", createdAt: "today",
};
const projection = (id: string, isolation: SessionIsolation, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id, projectId: "ui-test", title: id, status: "idle", createdAt: 1, updatedAt: 1, isolation, ...extra,
});
const readySuggestion = {
  eligible: true, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "rev",
};
async function mount(session: SessionProjection) {
  seedSessionCache(session);
  activateSession(session.id);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(IsolationCard)); await wait(); });
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}
async function mountBadge(session: SessionProjection) {
  seedSessionCache(session);
  activateSession(session.id);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(IsolationLock)); await wait(); });
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}
/** Progress marks are drawn elements; their state is the contract. */
function markStates(container: ParentNode): string[] {
  return [...container.querySelectorAll(".isolation-card-progress-mark")].map((mark) => mark.getAttribute("data-state") ?? "");
}
function buttons(container: ParentNode) {
  return [...container.querySelectorAll("button")];
}
// The overflow trigger is an icon button, so its name lives in aria-label
// rather than in text. Match on the accessible name either way.
function named(container: ParentNode, name: string) {
  return buttons(container).find((button) =>
    button.textContent === name || button.getAttribute("aria-label") === name);
}

test("IsolationListBadge names Isolated when isolation is present and is absent otherwise", async () => {
  const isolated = projection("list-badge", { ...base, state: "active" });
  seedSessionCache(isolated);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(IsolationListBadge, { sessionId: isolated.id }));
      await wait();
    });
    const badge = container.querySelector(".isolation-list-badge");
    assert.ok(badge);
    assert.equal(badge?.getAttribute("aria-label"), tr("isolation.isolated"));
    assert.equal(badge?.getAttribute("title"), tr("isolation.isolated"));
    // The navigator shows a lock glyph instead of the word "isolated"; the
    // accessible name still carries the full state for screen readers.
    assert.equal(badge?.textContent, "");
    assert.ok(badge?.querySelector("svg"));

    await act(async () => {
      seedSessionCache({
        id: "list-badge-plain", projectId: "ui-test", title: "plain", status: "idle", createdAt: 1, updatedAt: 1,
      });
      root.render(createElement(IsolationListBadge, { sessionId: "list-badge-plain" }));
      await wait();
    });
    assert.equal(container.querySelector(".isolation-list-badge"), null);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("IsolationListBadge marks a merged session with the branch it merged into", async () => {
  const merged: SessionProjection = {
    id: "list-badge-merged", projectId: "ui-test", title: "merged", status: "idle", createdAt: 1, updatedAt: 1,
    branch: "main", isolationMerge: { targetBranch: "main", commit: "abc1234", at: 2 },
  };
  // Publication proven, cleanup still pending: merged outranks isolated.
  const cleanupPending = projection("list-badge-cleanup", {
    ...base, state: "cleanup-pending", resultCommit: "abc1234",
  }, { isolationMerge: { targetBranch: "main", commit: "abc1234", at: 2 } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const session of [merged, cleanupPending]) {
      await act(async () => {
        seedSessionCache(session);
        root.render(createElement(IsolationListBadge, { sessionId: session.id }));
        await wait();
      });
      const badge = container.querySelector(".isolation-list-badge");
      assert.ok(badge, session.id);
      assert.ok(badge?.classList.contains("is-merged"), session.id);
      assert.equal(badge?.getAttribute("aria-label"), tr("isolation.mergedIntoBranch", { branch: "main" }));
      assert.ok(badge?.querySelector("svg"));
    }
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("header isolation lock is passive status only with no mutation controls", async () => {
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  const mounted = await mountBadge(projection("badge-passive", isolation));
  try {
    const lock = mounted.container.querySelector(".isolation-lock");
    assert.ok(lock);
    assert.equal(lock?.tagName, "SPAN");
    assert.equal(lock?.textContent, "");
    assert.equal(lock?.getAttribute("aria-label"), `${tr("isolation.isolatedBranch", { branch: base.targetBranch })}. ${base.targetBranch} · ${base.worktreeBranch} · ${base.worktreePath} · ${base.createdAt}`);
    assert.equal(mounted.container.querySelector('[role="menu"]'), null);
    assert.equal(mounted.container.querySelector("button"), null);
    for (const label of [
      tr("isolation.integrateInto", { branch: base.targetBranch }),
      tr("isolation.continueWorking"),
      tr("isolation.discard"),
      tr("isolation.resolveAndProceed"),
      tr("sidebar.sessionlist.deleteSession"),
    ]) {
      assert.equal(mounted.container.textContent?.includes(label), false);
    }
  } finally {
    await mounted.close();
  }
});

test("changes-ready deletes the isolated session without invoking discard/rebind", async () => {
  const originalStatus = api.isolationStatus;
  const originalDelete = api.deleteSession;
  const originalDiscard = api.isolationDiscard;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state, suggestion: readySuggestion,
    actions: { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false },
  });
  let deleted = 0;
  let discarded = 0;
  api.deleteSession = async () => { deleted++; return { ok: true as const }; };
  api.isolationDiscard = async (id) => { discarded++; return projection(id, isolation); };
  const mounted = await mount(projection("ready-ui", isolation));
  try {
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes(tr("isolation.changesAreReady")));
    assert.ok(text.includes(tr("isolation.basedOn", { branch: base.targetBranch })));
    const integrate = buttons(mounted.container).find((b) => b.textContent === tr("isolation.integrateInto", { branch: base.targetBranch }));
    const review = buttons(mounted.container).find((b) => b.textContent === tr("isolation.reviewChanges"));
    const more = named(mounted.container, tr("common.more"));
    assert.ok(integrate && !integrate.disabled);
    assert.ok(review && !review.disabled);
    assert.ok(more);
    await act(async () => { more!.click(); await wait(); });
    const deleteEntry = [...document.querySelectorAll('[role="menuitem"]')]
      .find((entry) => entry.textContent === tr("sidebar.sessionlist.deleteSession"));
    assert.ok(deleteEntry);
    await act(async () => { (deleteEntry as HTMLButtonElement).click(); await wait(); });
    assert.ok(document.body.textContent?.includes(tr("sidebar.sessionlist.deleteSession")));
    const confirm = buttons(document.body).find((b) => b.textContent === tr("common.delete"));
    assert.ok(confirm);
    await act(async () => { confirm!.click(); await wait(); });
    assert.equal(deleted, 1);
    assert.equal(discarded, 0);
    assert.equal(mounted.container.querySelector(".isolation-card"), null);
  } finally {
    await act(async () => { document.querySelectorAll(".dialog-backdrop, [role=dialog]").forEach((node) => node.remove()); });
    await mounted.close();
    api.isolationStatus = originalStatus;
    api.deleteSession = originalDelete;
    api.isolationDiscard = originalDiscard;
  }
});

test("changes-ready hides until the session's next turn", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state, suggestion: readySuggestion,
    actions: { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false },
  });
  const mounted = await mount(projection("hidden-card", isolation, { lastTurnAt: 10 }));
  try {
    const more = named(mounted.container, tr("common.more"));
    assert.ok(more);
    await act(async () => { more!.click(); await wait(); });
    const hide = [...document.querySelectorAll('[role="menuitem"]')]
      .find((entry) => entry.textContent === tr("isolation.hideUntilNextTurn"));
    assert.ok(hide);
    await act(async () => { (hide as HTMLButtonElement).click(); await wait(); });
    assert.equal(mounted.container.querySelector(".isolation-card"), null);

    // The next admitted turn stamps a new `lastTurnAt` and brings it back.
    await act(async () => {
      seedSessionCache(projection("hidden-card", isolation, { lastTurnAt: 20 }));
      await wait();
    });
    assert.ok(mounted.container.querySelector(".isolation-card"));
  } finally {
    await act(async () => { document.querySelectorAll(".dialog-backdrop, [role=dialog]").forEach((node) => node.remove()); });
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("changes-ready never exposes the isolation keep mutation as Continue working", async () => {
  const originalStatus = api.isolationStatus;
  const originalKeep = api.isolationKeep;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state, suggestion: readySuggestion,
    actions: { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false },
  });
  let kept = 0;
  api.isolationKeep = async (id) => { kept++; return projection(id, isolation); };
  const mounted = await mount(projection("keep-ui", isolation));
  try {
    assert.equal(buttons(mounted.container).some((b) => b.textContent === tr("isolation.continueWorking")), false);
    assert.equal(kept, 0);
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
    api.isolationKeep = originalKeep;
  }
});

test("dirty target explains blocked integration without review changes", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state,
    suggestion: { eligible: false, hasChanges: true, targetBranch: "main", targetDirty: true, revision: "rev", reason: "dirty-target" },
    actions: { canReview: true, canMerge: false, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false },
  });
  const mounted = await mount(projection("dirty-ui", isolation));
  try {
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes(tr("isolation.cantIntegrateYet", { branch: base.targetBranch })));
    assert.ok(text.includes(tr("isolation.dirtyTargetDetail", { branch: base.targetBranch })));
    assert.equal(buttons(mounted.container).some((b) => b.textContent === tr("isolation.integrateInto", { branch: base.targetBranch }) && !b.disabled), false);
    assert.equal(buttons(mounted.container).some((b) => b.textContent === tr("isolation.reviewChanges")), false);
    assert.ok(buttons(mounted.container).some((b) => b.textContent === tr("gitview.checkAgain")));
    assert.equal(buttons(mounted.container).some((b) => b.textContent === tr("isolation.continueWorking")), false);
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("a chat whose runtime is still recovering keeps a blocked card instead of vanishing", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = { ...base, state: "active" };
  const blocked = { canReview: true, canMerge: false, canKeep: false, canResolve: false, canDiscard: false, canRecover: false, canAbandon: false };
  let hasChanges = true;
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state,
    suggestion: { eligible: false, hasChanges, targetBranch: "main", targetDirty: false, revision: "rev", reason: "runtime-recovering" },
    actions: blocked,
  });
  const mounted = await mount(projection("runtime-recovering-ui", isolation, { status: "epoch-pending" }));
  try {
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes(tr("isolation.runtimeRecovering")));
    assert.ok(text.includes(tr("isolation.runtimeRecoveringDetail")));
    assert.ok(mounted.container.querySelector(".isolation-card--warn"));
    assert.equal(buttons(mounted.container).some((b) => b.textContent === tr("isolation.integrateInto", { branch: base.targetBranch })), false);
    assert.ok(buttons(mounted.container).some((b) => b.textContent === tr("isolation.reviewChanges") && !b.disabled));
  } finally {
    await mounted.close();
  }
  // Nothing to integrate: a recovering chat with no changes stays quiet.
  hasChanges = false;
  const quiet = await mount(projection("runtime-recovering-empty-ui", isolation, { status: "epoch-pending" }));
  try {
    assert.equal(quiet.container.querySelector(".isolation-card"), null);
  } finally {
    await quiet.close();
    api.isolationStatus = originalStatus;
  }
});

test("compatible dirty target stays mergeable and explains that parent work is preserved", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state,
    suggestion: { eligible: true, hasChanges: true, targetBranch: "main", targetDirty: true, revision: "rev" },
    actions: { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false },
  });
  const mounted = await mount(projection("dirty-mergeable-ui", isolation));
  try {
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes(tr("isolation.changesAreReady")));
    assert.ok(text.includes(tr("isolation.dirtyTargetDetail", { branch: base.targetBranch })));
    assert.ok(buttons(mounted.container).some((button) =>
      button.textContent === tr("isolation.integrateInto", { branch: base.targetBranch }) && !button.disabled));
    assert.ok(buttons(mounted.container).some((button) =>
      button.textContent === tr("isolation.reviewChanges") && !button.disabled));
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("conflict offers review and resolve without integrate", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = {
    ...base, state: "conflict", conflict: { message: "boom", files: ["x.ts"] },
  };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state,
    suggestion: { eligible: false, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "rev" },
    actions: { canReview: true, canMerge: false, canKeep: true, canResolve: true, canDiscard: true, canRecover: false, canAbandon: false },
  });
  const mounted = await mount(projection("conflict-ui", isolation));
  try {
    assert.ok(mounted.container.textContent?.includes(tr("isolation.mergeNeedsAttention")));
    assert.ok(buttons(mounted.container).some((b) => b.textContent === tr("isolation.reviewConflicts") && !b.disabled));
    assert.ok(buttons(mounted.container).some((b) => b.textContent === tr("isolation.resolveAndProceed") && !b.disabled));
    assert.equal(buttons(mounted.container).some((b) => b.textContent === tr("isolation.integrateInto", { branch: base.targetBranch })), false);
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("resolve with AI is one action; the card steps aside while the agent resolves, then merges", async () => {
  const originalStatus = api.isolationStatus;
  const originalResolve = api.isolationResolve;
  const originalMerge = api.isolationMerge;
  const isolation: SessionIsolation = {
    ...base, state: "conflict", conflict: { message: "boom", files: ["x.ts"] },
  };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state,
    suggestion: { eligible: false, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "rev" },
    actions: { canReview: true, canMerge: false, canKeep: true, canResolve: true, canDiscard: true, canRecover: false, canAbandon: false },
  });
  let resolved = 0;
  let merged = 0;
  api.isolationResolve = async (id) => { resolved++; return { sessionId: id }; };
  api.isolationMerge = (async (id: string) => {
    merged++;
    return { session: projection(id, isolation) };
  }) as typeof api.isolationMerge;
  const mounted = await mount(projection("resolve-ui", isolation));
  try {
    const resolveButtons = buttons(mounted.container).filter((b) => /resolve/iu.test(b.textContent ?? ""));
    assert.deepEqual(resolveButtons.map((b) => b.textContent), [tr("isolation.resolveAndProceed")]);
    await act(async () => { resolveButtons[0]!.click(); await wait(); });
    assert.equal(resolved, 1);
    assert.equal(mounted.container.querySelector(".isolation-card"), null, "conflict card hides once resolving starts");
    await act(async () => { upsertSession(projection("resolve-ui", isolation, { status: "working", updatedAt: 2 })); await wait(); });
    assert.equal(mounted.container.querySelector(".isolation-card"), null, "card stays hidden while the agent works");
    assert.equal(merged, 0);
    await act(async () => { upsertSession(projection("resolve-ui", isolation, { status: "idle", updatedAt: 3 })); await wait(); });
    assert.equal(merged, 1, "the merge proceeds once the resolve turn ends");
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
    api.isolationResolve = originalResolve;
    api.isolationMerge = originalMerge;
  }
});

test("Review conflicts opens Source Control's Conflicts view at the chosen file", async () => {
  const { consumeReviewScope } = await import("../widgets/reviewScopeHandoff.ts");
  const { workspacePresentationKey } = await import("../../../apps/web/src/store.ts");
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = {
    ...base, state: "conflict", conflict: { message: "main changed in conflicting areas.", files: ["src/a.ts", "src/b.ts"], at: 5 },
  };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state,
    suggestion: { eligible: false, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "rev", reason: "conflict" },
    actions: { canReview: true, canMerge: false, canKeep: true, canResolve: true, canDiscard: true, canRecover: false, canAbandon: false },
  });
  const key = workspacePresentationKey("git-review-handoff", "ui-test", "review-conflicts-handoff");
  const mounted = await mount(projection("review-conflicts-handoff", isolation));
  const diffPathBefore = getState().gitDiffPath;
  try {
    const review = named(mounted.container, tr("isolation.reviewConflicts"));
    assert.ok(review && !review.disabled);
    await act(async () => { review.click(); await wait(); });
    assert.deepEqual(consumeReviewScope(key), { scope: "conflicts", path: "src/a.ts" });
    const file = named(mounted.container, "src/b.ts");
    assert.ok(file);
    await act(async () => { file.click(); await wait(); });
    assert.deepEqual(consumeReviewScope(key), { scope: "conflicts", path: "src/b.ts" });
    assert.equal(getState().gitDiffPath, diffPathBefore, "the working-tree diff path is not repurposed for conflicts");
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("a conflict recorded elsewhere replaces Changes ready at once; its actions wait for the read", async () => {
  const { upsertSession } = await import("../../../apps/web/src/store.ts");
  const originalStatus = api.isolationStatus;
  const ready: SessionIsolation = { ...base, state: "merge-ready" };
  const conflicted: SessionIsolation = {
    ...base, state: "conflict", conflict: { message: "main changed in conflicting areas.", files: ["src/a.ts"], at: 9 },
  };
  let answer!: (value: IsolationStatusDto) => void;
  api.isolationStatus = async () => ({ isolation: ready, effectiveState: "merge-ready", suggestion: readySuggestion,
    actions: { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false } });
  const mounted = await mount(projection("conflict-elsewhere", ready));
  try {
    assert.ok(mounted.container.textContent?.includes(tr("isolation.changesAreReady")));
    api.isolationStatus = () => new Promise<IsolationStatusDto>((resolve) => { answer = resolve; });
    // Another client (or a judge) pressed Merge; only the projection moved yet.
    await act(async () => { upsertSession({ ...projection("conflict-elsewhere", conflicted), updatedAt: 2 }); await wait(); });
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes(tr("isolation.mergeNeedsAttention")));
    assert.ok(text.includes("src/a.ts"));
    assert.equal(text.includes(tr("isolation.changesAreReady")), false);
    assert.equal(buttons(mounted.container).some((b) => b.textContent === tr("isolation.integrateInto", { branch: base.targetBranch })), false);
    assert.equal(buttons(mounted.container).some((b) => b.textContent === tr("isolation.resolveAndProceed") && !b.disabled), false);
    await act(async () => {
      answer({ isolation: conflicted, effectiveState: "conflict",
        suggestion: { eligible: false, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "rev", reason: "conflict" },
        actions: { canReview: true, canMerge: false, canKeep: true, canResolve: true, canDiscard: true, canRecover: false, canAbandon: false } });
      await wait();
    });
    assert.ok(buttons(mounted.container).some((b) => b.textContent === tr("isolation.resolveAndProceed") && !b.disabled));
    assert.ok(buttons(mounted.container).some((b) => b.textContent === tr("isolation.reviewConflicts") && !b.disabled));
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("pending delegated work keeps the parent's card visible and points at each child instead of integrating", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state,
    suggestion: { eligible: true, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "rev" },
    delegated: [{
      sessionId: "delegated-child", title: "Fix the parser", status: "idle", state: "active", hasChanges: true,
      revision: "child-rev", worktreePath: "/repo-child", worktreeBranch: "polyth/isolate/child", targetBranch: base.worktreeBranch,
    }],
    actions: { canReview: true, canMerge: false, canKeep: true, canResolve: false, canDiscard: false, canRecover: false, canAbandon: false },
  });
  seedSessionCache(projection("delegated-child", { ...base, state: "active", worktreePath: "/repo-child", worktreeBranch: "polyth/isolate/child", targetBranch: base.worktreeBranch }, { parentId: "delegating-parent-ui" }));
  const mounted = await mount(projection("delegating-parent-ui", isolation));
  try {
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes(tr("isolation.delegatedPending")));
    assert.ok(text.includes(tr("isolation.delegatedPendingDetail", { count: "1" })));
    assert.equal(buttons(mounted.container).some((b) => b.textContent === tr("isolation.integrateInto", { branch: base.targetBranch })), false);
    const child = named(mounted.container, "Fix the parser");
    assert.ok(child, "each pending child is reachable from the parent's card");
    await act(async () => { child!.click(); await wait(); });
    assert.equal(getState().activeSessionId, "delegated-child");
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("a running delegator keeps integrating its children without a pending-work card", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = { ...base, state: "active" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state,
    suggestion: { eligible: false, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "", reason: "working" },
    delegated: [{
      sessionId: "busy-child", title: "Still delegating", status: "working", state: "active", hasChanges: false,
      revision: "", worktreePath: "/repo-busy", worktreeBranch: "polyth/isolate/busy", targetBranch: base.worktreeBranch,
    }],
    actions: { canReview: true, canMerge: false, canKeep: false, canResolve: false, canDiscard: false, canRecover: false, canAbandon: false },
  });
  const mounted = await mount(projection("working-delegator-ui", isolation, { status: "working" }));
  try {
    assert.equal((mounted.container.textContent ?? "").includes(tr("isolation.delegatedPending")), false);
    assert.equal(named(mounted.container, "Still delegating"), undefined);
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("a delegated child's card names its parent workspace instead of the managed branch", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = { ...base, state: "merge-ready", targetBranch: "polyth/isolate/parent123456", originPath: "/repo-parent" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state,
    suggestion: { ...readySuggestion, targetBranch: isolation.targetBranch },
    actions: { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false },
  });
  const mounted = await mount(projection("nested-child-ui", isolation, { parentId: "some-parent" }));
  try {
    const text = mounted.container.textContent ?? "";
    assert.ok(buttons(mounted.container).some((b) =>
      b.textContent === tr("isolation.integrateInto", { branch: tr("isolation.parentWorkspace") }) && !b.disabled));
    assert.equal(text.includes("polyth/isolate/parent123456"), false);
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("target-local overlap exposes the one-click AI repair action", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = {
    ...base,
    state: "conflict",
    conflict: { message: "Local target work is backed up and needs reconciliation.", files: ["README.md"] },
    targetRepair: {
      kind: "target-overlap",
      targetHead: "a".repeat(40),
      targetFingerprint: "0123456789abcdef",
      snapshotSha: "b".repeat(40),
      files: ["README.md"],
      applied: false,
    },
  };
  api.isolationStatus = async () => ({
    isolation,
    effectiveState: isolation.state,
    suggestion: { eligible: false, hasChanges: true, targetBranch: "main", targetDirty: true, revision: "rev", reason: "target-overlap" },
    actions: { canReview: true, canMerge: false, canKeep: true, canResolve: true, canDiscard: true, canRecover: false, canAbandon: false },
  });
  const mounted = await mount(projection("target-overlap-ui", isolation));
  try {
    assert.ok(mounted.container.textContent?.includes("backed up"));
    assert.ok(buttons(mounted.container).some((b) => b.textContent === tr("isolation.resolveAndProceed") && !b.disabled));
    assert.equal(buttons(mounted.container).some((b) => b.textContent === tr("isolation.integrateInto", { branch: base.targetBranch })), false);
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("missing source offers no Keep action; published recovery stays visible and retries explicitly", async () => {
  const originalStatus = api.isolationStatus;
  const originalRecover = api.isolationRecover;
  let mounted: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    let isolation: SessionIsolation = { ...base, state: "missing" };
    api.isolationStatus = async () => ({ isolation, suggestion: null, effectiveState: isolation.state });
    mounted = await mount(projection("missing", isolation));
    assert.match(mounted.container.textContent ?? "", new RegExp(tr("isolation.missingWorkspace"), "u"));
    assert.ok(mounted.container.textContent?.includes(base.worktreePath));
    assert.equal(buttons(mounted.container).some((button) => button.textContent === tr("isolation.continueWorking") && !button.disabled), false);
    assert.ok(buttons(mounted.container).some((button) =>
      button.textContent === tr("sidebar.sessionlist.deleteSession") && !button.disabled));
    await mounted.close();
    for (const state of ["unowned", "corrupt"] as const) {
      isolation = { ...base, state };
      mounted = await mount(projection(state, isolation));
      assert.ok(mounted.container.textContent?.includes(tr("isolation.ownershipUnverified")));
      assert.ok(mounted.container.textContent?.includes(base.worktreePath));
      for (const label of ["isolation.continueWorking", "isolation.resolveAndProceed", "sidebar.sessionlist.deleteSession"] as const) {
        assert.equal(buttons(mounted.container).some((button) => button.textContent === tr(label) && !button.disabled), false);
      }
      assert.equal(buttons(mounted.container).some((button) => button.textContent === tr("isolation.integrateInto", { branch: base.targetBranch }) && !button.disabled), false);
      await mounted.close();
    }
    isolation = { ...base, state: "rebind-pending", resultCommit: "published" };
    let recovered = 0;
    api.isolationRecover = async (id) => { recovered++; return projection(id, isolation); };
    mounted = await mount(projection("published", isolation));
    assert.ok(mounted.container.textContent?.includes("/repo"));
    const retry = buttons(mounted.container).find((button) => button.textContent === tr("isolation.retryRecovery"));
    assert.ok(retry && !retry.disabled, "published session needs an enabled recovery action");
    await act(async () => { retry.click(); await wait(); });
    assert.equal(recovered, 1);
    assert.equal(buttons(mounted.container).some((button) => button.textContent === tr("isolation.integrateInto", { branch: base.targetBranch })), false);
  } finally {
    await mounted?.close();
    api.isolationStatus = originalStatus;
    api.isolationRecover = originalRecover;
  }
});

test("a late status response cannot enable actions or show another session's branch", async () => {
  const originalStatus = api.isolationStatus;
  let finishOld!: (status: IsolationStatusDto) => void;
  const oldIsolation: SessionIsolation = { ...base, targetBranch: "old-session-branch", state: "merge-ready" };
  const newIsolation: SessionIsolation = { ...base, state: "missing" };
  api.isolationStatus = (id) => id === "old-session"
    ? new Promise((resolve) => { finishOld = resolve; })
    : Promise.resolve({ isolation: newIsolation, suggestion: null, effectiveState: "missing" });
  const mounted = await mount(projection("old-session", oldIsolation));
  try {
    await act(async () => {
      seedSessionCache(projection("new-session", newIsolation));
      activateSession("new-session");
      await wait();
    });
    await act(async () => {
      finishOld({ isolation: oldIsolation, suggestion: { eligible: true, hasChanges: true, targetBranch: oldIsolation.targetBranch, targetDirty: false, revision: "old" } });
      await wait();
    });
    assert.equal(mounted.container.textContent?.includes("old-session-branch"), false);
    assert.equal(buttons(mounted.container).some((button) => button.textContent === tr("isolation.integrateInto", { branch: base.targetBranch })), false);
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("a failed authoritative status request never enables stale conflict actions", async () => {
  const originalStatus = api.isolationStatus;
  api.isolationStatus = async () => { throw new Error("status unavailable"); };
  const stale: SessionIsolation = {
    ...base,
    state: "conflict",
    conflict: { message: "stale conflict", files: ["stale.ts"] },
  };
  const mounted = await mount(projection("failed-status", stale));
  try {
    const enabledLabels = new Set(
      buttons(mounted.container).filter((button) => !button.disabled).map((button) => button.textContent),
    );
    for (const label of [
      "isolation.continueWorking",
      "isolation.integrateInto",
      "isolation.resolveAndProceed",
      "isolation.discard",
      "isolation.reviewConflicts",
      "sidebar.sessionlist.deleteSession",
    ] as const) {
      assert.equal(enabledLabels.has(tr(label, label === "isolation.integrateInto" ? { branch: base.targetBranch } : undefined)), false);
    }
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("unavailable return checkout is explained before publication; running sessions cannot recover", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({ isolation, effectiveState: isolation.state, suggestion: {
    eligible: false, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "changed",
    reason: "destination-unavailable",
  } });
  let mounted = await mount(projection("destination", isolation));
  try {
    assert.ok(mounted.container.textContent?.includes(tr("isolation.cantReturnYet", { branch: base.targetBranch })));
    assert.ok(mounted.container.textContent?.includes("/repo"));
    assert.equal(buttons(mounted.container).some((button) => button.textContent === tr("isolation.integrateInto", { branch: base.targetBranch }) && !button.disabled), false);
    await mounted.close();
    const pending: SessionIsolation = { ...base, state: "rebind-pending", resultCommit: "published" };
    api.isolationStatus = async () => ({ isolation: pending, effectiveState: pending.state, suggestion: null });
    mounted = await mount({ ...projection("busy-recovery", pending), status: "working" });
    const retry = buttons(mounted.container).find((button) => button.textContent === tr("isolation.retryRecovery"));
    assert.ok(!retry || retry.disabled, "a running session cannot retry recovery");
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

/** Rows of the open menu by their visible label (a row's text also carries
 *  its detail line). */
function menuRow(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((row) => row.querySelector(".ui-menu-item-label")?.textContent === label);
}
const switchedSuggestion = {
  eligible: false, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "changed",
  reason: "destination-unavailable" as const,
};
const chooseActions = {
  canReview: true, canMerge: false, canKeep: true, canResolve: false, canDiscard: false,
  canRecover: false, canAbandon: false, canChooseTarget: true,
};

test("a switched origin checkout stays the calm ready card and integrates into its new branch", async () => {
  const originalStatus = api.isolationStatus;
  const originalMerge = api.isolationMerge;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state, suggestion: switchedSuggestion,
    targets: [
      { branch: "devel", path: "/repo", origin: true, current: false },
      { branch: "feature", path: "/repo-feature", origin: false, current: false },
    ],
    actions: chooseActions,
  });
  const calls: unknown[] = [];
  api.isolationMerge = (async (id: string, input?: unknown) => {
    calls.push(input);
    return { ok: true, commit: "c", targetBranch: "devel", finalized: true, session: projection(id, isolation) };
  }) as typeof api.isolationMerge;
  const mounted = await mount(projection("origin-switched", isolation));
  try {
    const card = mounted.container.querySelector(".isolation-card");
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes(tr("isolation.changesAreReady")));
    assert.ok(text.includes(tr("isolation.basedOn", { branch: "main" })));
    assert.ok(text.includes(tr("isolation.originSwitchedDetail", { path: "/repo", current: "devel", branch: "main" })));
    assert.equal(text.includes(tr("isolation.cantReturnYet", { branch: "main" })), false);
    assert.equal(card?.classList.contains("isolation-card--warn"), false, "a way forward is not a warning");
    // Same two-plus-one shape as a ready card: no Check again, no extra row.
    assert.deepEqual(
      [...mounted.container.querySelectorAll(".isolation-card-actions > button")].map((button) => button.textContent),
      [tr("isolation.reviewChanges"), tr("isolation.commitAndPush"), tr("isolation.integrateInto", { branch: "devel" })],
    );
    const integrate = named(mounted.container, tr("isolation.integrateInto", { branch: "devel" }));
    assert.ok(integrate && !integrate.disabled);
    await act(async () => { integrate.click(); await wait(); });
    assert.deepEqual(calls, [{ target: { branch: "devel", path: "/repo" } }]);
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
    api.isolationMerge = originalMerge;
  }
});

test("other checked-out branches wait one level down in the overflow, not on the card", async () => {
  const originalStatus = api.isolationStatus;
  const originalMerge = api.isolationMerge;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state, suggestion: readySuggestion,
    targets: [
      { branch: "main", path: "/repo", origin: true, current: true },
      { branch: "feature", path: "/repo-feature", origin: false, current: false },
    ],
    actions: { ...chooseActions, canMerge: true },
  });
  const calls: unknown[] = [];
  api.isolationMerge = (async (id: string, input?: unknown) => {
    calls.push(input);
    return { ok: true, commit: "c", targetBranch: "feature", finalized: true, session: projection(id, isolation) };
  }) as typeof api.isolationMerge;
  const mounted = await mount(projection("choose-target", isolation));
  try {
    assert.deepEqual(
      [...mounted.container.querySelectorAll(".isolation-card-actions > button")].map((button) => button.textContent),
      [tr("isolation.reviewChanges"), tr("isolation.commitAndPush"), tr("isolation.integrateInto", { branch: "main" })],
    );
    const more = named(mounted.container, tr("common.more"));
    assert.ok(more);
    await act(async () => { more.click(); await wait(); });
    const elsewhere = menuRow(tr("isolation.integrateElsewhere"));
    assert.ok(elsewhere, "the overflow leads to the other branches");
    assert.equal(menuRow("main"), undefined, "the recorded target is the card's own button");
    await act(async () => { elsewhere.click(); await wait(); });
    const feature = menuRow("feature");
    assert.ok(feature && !feature.disabled);
    assert.ok(feature.textContent?.includes("/repo-feature"), "each branch names the checkout it is open in");
    await act(async () => { feature.click(); await wait(); });
    assert.deepEqual(calls, [{ target: { branch: "feature", path: "/repo-feature" } }]);
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
    api.isolationMerge = originalMerge;
  }
});

test("with no default target left, choosing a branch is the card's own primary action", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state, suggestion: switchedSuggestion,
    targets: [{ branch: "feature", path: "/repo-feature", origin: false, current: false }],
    actions: chooseActions,
  });
  const mounted = await mount(projection("stranded-choose", isolation));
  try {
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes(tr("isolation.cantReturnYet", { branch: "main" })));
    assert.ok(text.includes(tr("isolation.restoreOriginOrChoose", { path: "/repo", branch: "main" })));
    const choose = named(mounted.container, tr("isolation.integrateElsewhere"));
    assert.ok(choose && !choose.disabled);
    assert.ok(choose.classList.contains("isolation-card-primary"));
    await act(async () => { choose.click(); await wait(); });
    assert.ok(menuRow("feature"));
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("publication repair shows integrating copy without restoreOrigin; cleanup keeps path visible", async () => {
  const originalStatus = api.isolationStatus;
  let isolation: SessionIsolation = { ...base, state: "publishing", publish: {
    expectedTargetSha: "old", resultCommit: "published", snapshotSha: "snapshot", targetRef: "refs/heads/main",
    receiptRef: "refs/polyth/isolation/ui", checkoutPath: base.originPath, sourceRevision: "source",
  } };
  api.isolationStatus = async () => ({ isolation, effectiveState: isolation.state, suggestion: null });
  let mounted = await mount(projection("repair-published-checkout", isolation));
  try {
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes(tr("isolation.integratingInto", { branch: base.targetBranch })));
    assert.equal(text.includes(tr("isolation.restoreOrigin", { path: base.originPath, branch: base.targetBranch })), false);
    assert.equal(text.includes(tr("isolation.merging")), false);
    assert.ok(text.includes(base.worktreePath));
    await mounted.close();
    isolation = { ...base, state: "cleanup-pending", resultCommit: "published", sourceRevision: "before-late-edits", rebound: true };
    mounted = await mount(projection("preserved-late-edits", isolation));
    assert.ok(mounted.container.textContent?.includes(tr("isolation.cleanupPendingDetail")));
    assert.ok(mounted.container.textContent?.includes(base.worktreePath), "the user must be able to locate preserved source edits");
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("discard recovery never shows merging or integrating copy", async () => {
  const originalStatus = api.isolationStatus;
  try {
    for (const state of ["rebind-pending", "cleanup-pending"] as const) {
      const isolation: SessionIsolation = { ...base, state };
      api.isolationStatus = async () => ({ isolation, effectiveState: isolation.state, suggestion: null });
      const mounted = await mount(projection(`discard-${state}`, isolation));
      try {
        const text = mounted.container.textContent ?? "";
        assert.equal(text.includes(tr("isolation.merging")), false);
        assert.equal(text.includes("Merging"), false);
        assert.equal(text.includes(tr("isolation.integratingInto", { branch: base.targetBranch })), false);
        const marks = markStates(mounted.container);
        assert.ok(marks.includes("current"));
        assert.ok(marks.includes("pending") || marks.includes("done"));
        if (state === "rebind-pending") {
          assert.ok(text.includes(tr("isolation.returningWorkspace")));
          assert.ok(text.includes(tr("isolation.cleaningWorkspace")));
          assert.equal(text.includes(tr("isolation.returnedWorkspace")), false);
        }
        if (state === "cleanup-pending") {
          assert.ok(text.includes(tr("isolation.returnedWorkspace")));
          assert.ok(text.includes(tr("isolation.cleaningWorkspace")));
        }
      } finally {
        await mounted.close();
      }
    }
  } finally {
    api.isolationStatus = originalStatus;
  }
});

test("integration recovery uses integrating and returning copy with resultCommit", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = { ...base, state: "rebind-pending", resultCommit: "published" };
  api.isolationStatus = async () => ({ isolation, effectiveState: isolation.state, suggestion: null });
  const mounted = await mount(projection("integrate-rebind", isolation));
  try {
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes(tr("isolation.returningWorkspace")));
    assert.ok(text.includes(tr("isolation.integratingChanges")));
    assert.deepEqual(markStates(mounted.container), ["done", "current", "pending"]);
    assert.ok(text.includes(base.worktreePath), "stuck recovery still exposes the worktree path");
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("idle recovery has no spinner and in-flight recovery shows activity while hiding the path", async () => {
  const originalStatus = api.isolationStatus;
  const originalRecover = api.isolationRecover;
  const isolation: SessionIsolation = { ...base, state: "rebind-pending", resultCommit: "published" };
  api.isolationStatus = async () => ({ isolation, effectiveState: isolation.state, suggestion: null });
  let finish!: (session: SessionProjection) => void;
  api.isolationRecover = () => new Promise((resolve) => { finish = resolve; });
  const mounted = await mount(projection("path-progress", isolation));
  try {
    assert.ok(mounted.container.textContent?.includes(base.worktreePath));
    assert.equal(mounted.container.querySelector('.isolation-card-glyph .ui-spinner'), null);
    assert.equal(mounted.container.querySelector('.isolation-card')?.getAttribute('aria-busy'), 'false');
    assert.equal(mounted.container.querySelector('.isolation-card-title')?.textContent, tr('isolation.recoveryNeeded'));
    const retry = buttons(mounted.container).find((button) => button.textContent === tr("isolation.retryRecovery"));
    assert.ok(retry && !retry.disabled);
    await act(async () => { retry.click(); await wait(); });
    assert.equal(mounted.container.textContent?.includes(base.worktreePath), false);
    assert.ok(mounted.container.querySelector('.isolation-card-glyph .ui-spinner'));
    assert.equal(mounted.container.querySelector('.isolation-card')?.getAttribute('aria-busy'), 'true');
    await act(async () => { finish(projection("path-progress", isolation)); await wait(); });
    assert.equal(mounted.container.querySelector('.isolation-card-glyph .ui-spinner'), null);
    assert.equal(mounted.container.querySelector('.isolation-card')?.getAttribute('aria-busy'), 'false');
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
    api.isolationRecover = originalRecover;
  }
});

test("retry recovery stays hidden while an integration or recovery is still moving", async () => {
  const originalStatus = api.isolationStatus;
  const originalRecover = api.isolationRecover;
  let isolation: SessionIsolation = {
    ...base,
    state: "merging",
    publish: { expectedTargetSha: "target", resultCommit: "result", snapshotSha: "snapshot", targetRef: "refs/heads/main" },
  };
  api.isolationStatus = async () => ({ isolation, effectiveState: isolation.state, suggestion: null });
  let mounted = await mount(projection("merging-live", isolation));
  try {
    const hasRetry = () => buttons(mounted.container).some((button) => button.textContent === tr("isolation.retryRecovery"));
    assert.equal(hasRetry(), false, "a fresh merging phase is in flight, not stuck");
    assert.ok(mounted.container.querySelector(".isolation-card-glyph .ui-spinner"));
    await mounted.close();
    isolation = { ...base, state: "rebind-pending", resultCommit: "published" };
    let finish!: (session: SessionProjection) => void;
    api.isolationRecover = () => new Promise((resolve) => { finish = resolve; });
    mounted = await mount(projection("recover-in-flight", isolation));
    const retry = buttons(mounted.container).find((button) => button.textContent === tr("isolation.retryRecovery"));
    assert.ok(retry);
    await act(async () => { retry.click(); await wait(); });
    assert.equal(hasRetry(), false, "retry hides while its own request runs");
    await act(async () => { finish(projection("recover-in-flight", isolation)); await wait(); });
    assert.equal(hasRetry(), true, "an unfinished phase offers retry again once idle");
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
    api.isolationRecover = originalRecover;
  }
});

test("discard confirmation closes when the session changes", async () => {
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state, suggestion: readySuggestion,
    actions: { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false },
  });
  const mounted = await mount(projection("discard-session-a", isolation));
  try {
    const more = named(mounted.container, tr("common.more"));
    assert.ok(more);
    await act(async () => { more!.click(); await wait(); });
    const deleteEntry = [...document.querySelectorAll('[role="menuitem"]')]
      .find((entry) => entry.textContent === tr("sidebar.sessionlist.deleteSession"));
    assert.ok(deleteEntry);
    await act(async () => { (deleteEntry as HTMLButtonElement).click(); await wait(); });
    assert.ok(document.body.textContent?.includes(tr("sidebar.sessionlist.deleteSession")));
    await act(async () => {
      seedSessionCache(projection("discard-session-b", isolation));
      activateSession("discard-session-b");
      await wait();
    });
    assert.equal(document.body.textContent?.includes(tr("sidebar.sessionlist.deleteSession")), false);
  } finally {
    await act(async () => { document.querySelectorAll(".dialog-backdrop, [role=dialog]").forEach((node) => node.remove()); });
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("changes-ready opens a commit-and-push dialog and calls the push endpoint", async () => {
  const originalStatus = api.isolationStatus;
  const originalPush = api.isolationPush;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state, suggestion: readySuggestion,
    actions: { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false },
  });
  let pushed: { branch?: string; message?: string } | undefined;
  api.isolationPush = async (_id, input) => {
    pushed = input;
    return { ok: true as const, branch: input?.branch ?? "", remote: "origin", commit: "abc" };
  };
  const mounted = await mount(projection("push-ui", isolation));
  try {
    const push = buttons(mounted.container).find((button) => button.textContent === tr("isolation.commitAndPush"));
    assert.ok(push && !push.disabled);
    await act(async () => { push!.click(); await wait(); });
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const inputs = [...(dialog as Element).querySelectorAll<HTMLInputElement>(".isolation-push-field input")];
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0]!.value, base.worktreeBranch);
    const confirm = [...(dialog as Element).querySelectorAll("button")]
      .find((button) => button.textContent === tr("isolation.commitAndPush"));
    assert.ok(confirm);
    await act(async () => { (confirm as HTMLButtonElement).click(); await wait(); });
    assert.ok(pushed);
    assert.equal(pushed!.branch, base.worktreeBranch);
  } finally {
    await act(async () => { document.querySelectorAll(".dialog-backdrop, [role=dialog]").forEach((node) => node.remove()); });
    await mounted.close();
    api.isolationStatus = originalStatus;
    api.isolationPush = originalPush;
  }
});

test("Review changes hands Branch scope to the matching session", async () => {
  const { consumeReviewScope } = await import("../widgets/reviewScopeHandoff.ts");
  const { workspacePresentationKey } = await import("../../../apps/web/src/store.ts");
  const originalStatus = api.isolationStatus;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({ isolation, effectiveState: isolation.state, suggestion: readySuggestion,
    actions: { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false } });
  const view = await mount(projection("review-branch-handoff", isolation));
  try {
    const button = named(view.container, tr("isolation.reviewChanges"));
    assert.ok(button && !button.disabled);
    await act(async () => { button.click(); await wait(); });
    assert.equal(consumeReviewScope(workspacePresentationKey("git-review-handoff", "ui-test", "another-session")), undefined);
    assert.deepEqual(consumeReviewScope(workspacePresentationKey("git-review-handoff", "ui-test", "review-branch-handoff")), { scope: "branch" });
  } finally { await view.close(); api.isolationStatus = originalStatus; }
});

async function mountMenuAction(session: SessionProjection, closeMenu: () => void = () => {}) {
  const { IsolationMenuAction } = await import("../widgets/IsolationMenuAction.tsx");
  seedSessionCache(session);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(IsolationMenuAction, { sessionId: session.id, status: session.status, closeMenu }));
    await wait();
  });
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}

const allowAll = { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false };

test("session menu returns an isolation with nothing to integrate", async () => {
  const originalStatus = api.isolationStatus;
  const originalReturn = api.isolationReturn;
  const originalMerge = api.isolationMerge;
  const isolation: SessionIsolation = { ...base, state: "active" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: "active",
    suggestion: { eligible: false, hasChanges: false, targetBranch: "main", targetDirty: false, revision: "", reason: "no-changes" },
    actions: { ...allowAll, canMerge: false },
  });
  const calls: string[] = [];
  api.isolationReturn = async (id) => { calls.push(`return:${id}`); return projection(id, isolation, { isolation: undefined }); };
  api.isolationMerge = async () => { calls.push("merge"); throw new Error("unexpected"); };
  let closed = 0;
  const view = await mountMenuAction(projection("menu-return", isolation), () => { closed++; });
  try {
    const entry = buttons(view.container).find((b) => b.textContent === tr("isolation.returnTo", { branch: "main" }));
    assert.ok(entry);
    await act(async () => { entry!.click(); await wait(); });
    assert.deepEqual(calls, ["return:menu-return"]);
    assert.equal(closed, 1);
  } finally {
    await view.close();
    api.isolationStatus = originalStatus;
    api.isolationReturn = originalReturn;
    api.isolationMerge = originalMerge;
  }
});

test("session menu integrates committed work after confirmation and never offers return", async () => {
  const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");
  const originalStatus = api.isolationStatus;
  const originalReturn = api.isolationReturn;
  const originalMerge = api.isolationMerge;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({ isolation, effectiveState: "merge-ready", suggestion: readySuggestion, actions: allowAll });
  const calls: string[] = [];
  api.isolationReturn = async () => { calls.push("return"); throw new Error("unexpected"); };
  api.isolationMerge = async (id) => {
    calls.push(`merge:${id}`);
    return { ok: true as const, commit: "abc", targetBranch: "main", finalized: true, session: projection(id, isolation, { isolation: undefined }) };
  };
  const view = await mountMenuAction(projection("menu-merge", isolation));
  try {
    assert.equal(buttons(view.container).some((b) => b.textContent === tr("isolation.returnTo", { branch: "main" })), false);
    const entry = buttons(view.container).find((b) => b.textContent === tr("isolation.integrateInto", { branch: "main" }));
    assert.ok(entry);
    await act(async () => { entry!.click(); await wait(); });
    assert.deepEqual(calls, []);
    await act(async () => { resolveAlert(true); await wait(); await wait(); });
    assert.deepEqual(calls, ["merge:menu-merge"]);
  } finally {
    await view.close();
    api.isolationStatus = originalStatus;
    api.isolationReturn = originalReturn;
    api.isolationMerge = originalMerge;
  }
});

test("session menu sends blocked or busy isolations to the card instead of integrating", async () => {
  const { isolationMenuChoice } = await import("../widgets/IsolationMenuAction.tsx");
  const conflict: SessionIsolation = { ...base, state: "conflict", conflict: { files: ["a.ts"], message: "" } } as SessionIsolation;
  const status = (isolation: SessionIsolation, actions = allowAll): IsolationStatusDto => ({
    isolation, effectiveState: isolation.state, suggestion: readySuggestion, actions,
  });
  assert.equal(isolationMenuChoice(status(conflict), "idle")?.kind, "open");
  assert.equal(isolationMenuChoice(status({ ...base, state: "merge-ready" }, { ...allowAll, canMerge: false }), "idle")?.kind, "open");
  assert.equal(isolationMenuChoice(status({ ...base, state: "merge-ready" }), "working"), null);
  assert.equal(isolationMenuChoice(status({ ...base, state: "cleanup-pending" } as SessionIsolation), "idle"), null);
  assert.equal(isolationMenuChoice({ isolation: null, suggestion: null }, "idle"), null);
});

test("an ordinary chat in a project with isolation is offered the move into an isolated workspace", async () => {
  const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");
  const { beginProjectListRequest, publishProjectList } = await import("../../../apps/web/src/store.ts");
  const { canIsolateSession } = await import("../widgets/IsolationMenuAction.tsx");
  const enabled = { defaults: { isolation: "workspace" as const } };
  assert.equal(canIsolateSession(enabled, "idle"), true);
  assert.equal(canIsolateSession(enabled, "working"), false);
  assert.equal(canIsolateSession(enabled, "archived"), false);
  assert.equal(canIsolateSession({ defaults: {} }, "idle"), false, "isolation is opt-in per project");
  assert.equal(canIsolateSession({ ...enabled, remote: { kind: "ssh", connectionId: "c1" } }, "idle"), false);
  assert.equal(canIsolateSession(undefined, "idle"), false);

  publishProjectList(beginProjectListRequest(), [{ id: "ui-test", name: "UI", path: "/repo", createdAt: 1, defaults: { isolation: "workspace" } }]);
  const originalStatus = api.isolationStatus;
  const originalIsolate = api.isolationIsolate;
  const calls: string[] = [];
  api.isolationStatus = async () => { calls.push("status"); return { isolation: null, suggestion: null }; };
  api.isolationIsolate = async (id) => {
    calls.push(`isolate:${id}`);
    return { ok: true as const, targetBranch: "main", originUncommitted: 0, session: projection(id, { ...base, state: "active" }) };
  };
  const plain = { ...projection("menu-plain", { ...base, state: "active" }), isolation: undefined };
  const view = await mountMenuAction(plain);
  try {
    const entry = buttons(view.container).find((b) => b.textContent === tr("isolation.moveToIsolation"));
    assert.ok(entry);
    await act(async () => { entry!.click(); await wait(); });
    assert.deepEqual(calls, [], "an ordinary chat needs no status read, and nothing moves before the confirmation");
    await act(async () => { resolveAlert(true); await wait(); await wait(); });
    // The now-isolated chat reads its isolation status like any other.
    assert.deepEqual(calls, ["isolate:menu-plain", "status"]);
  } finally {
    await view.close();
    api.isolationStatus = originalStatus;
    api.isolationIsolate = originalIsolate;
  }
});
