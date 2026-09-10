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
const { activateSession, seedSessionCache } = await import("../../../apps/web/src/store.ts");
const { IsolationBadge, IsolationCard, IsolationListBadge } = await import("../widgets/IsolationCard.tsx");
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
  await act(async () => { root.render(createElement(IsolationBadge)); await wait(); });
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}
function buttons(container: ParentNode) {
  return [...container.querySelectorAll("button")];
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
    assert.equal(badge?.textContent, tr("isolation.isolated"));

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

test("header badge is passive status only with no mutation controls", async () => {
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  const mounted = await mountBadge(projection("badge-passive", isolation));
  try {
    const badge = mounted.container.querySelector(".isolation-badge");
    assert.ok(badge);
    assert.equal(badge?.tagName, "SPAN");
    assert.equal(badge?.textContent, tr("isolation.isolatedBranch", { branch: base.targetBranch }));
    assert.equal(mounted.container.querySelector('[role="menu"]'), null);
    assert.equal(mounted.container.querySelector("button"), null);
    for (const label of [
      tr("isolation.integrateInto", { branch: base.targetBranch }),
      tr("isolation.continueWorking"),
      tr("isolation.discard"),
      tr("isolation.resolveWithAgent"),
      tr("isolation.discardWorkspace"),
    ]) {
      assert.equal(mounted.container.textContent?.includes(label), false);
    }
  } finally {
    await mounted.close();
  }
});

test("changes-ready shows integrate, review, continue and delete in overflow", async () => {
  const originalStatus = api.isolationStatus;
  const originalDiscard = api.isolationDiscard;
  const isolation: SessionIsolation = { ...base, state: "merge-ready" };
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state, suggestion: readySuggestion,
    actions: { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false },
  });
  let discarded = 0;
  api.isolationDiscard = async (id) => { discarded++; return projection(id, isolation); };
  const mounted = await mount(projection("ready-ui", isolation));
  try {
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes(tr("isolation.changesAreReady")));
    assert.ok(text.includes(tr("isolation.basedOn", { branch: base.targetBranch })));
    const integrate = buttons(mounted.container).find((b) => b.textContent === tr("isolation.integrateInto", { branch: base.targetBranch }));
    const review = buttons(mounted.container).find((b) => b.textContent === tr("isolation.reviewChanges"));
    const keep = buttons(mounted.container).find((b) => b.textContent === tr("isolation.continueWorking"));
    const more = buttons(mounted.container).find((b) => b.textContent === tr("common.more"));
    assert.ok(integrate && !integrate.disabled);
    assert.ok(review && !review.disabled);
    assert.ok(keep && !keep.disabled);
    assert.ok(more);
    await act(async () => { more!.click(); await wait(); });
    const deleteEntry = [...document.querySelectorAll('[role="menuitem"]')]
      .find((entry) => entry.textContent === tr("isolation.discardWorkspace"));
    assert.ok(deleteEntry);
    await act(async () => { deleteEntry!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true })); await wait(); });
    assert.ok(document.body.textContent?.includes(tr("isolation.discardTitle")));
    const confirm = buttons(document.body).find((b) => b.textContent === tr("isolation.discard"));
    assert.ok(confirm);
    await act(async () => { confirm!.click(); await wait(); });
    assert.equal(discarded, 1);
  } finally {
    await act(async () => { document.querySelectorAll(".dialog-backdrop, [role=dialog]").forEach((node) => node.remove()); });
    await mounted.close();
    api.isolationStatus = originalStatus;
    api.isolationDiscard = originalDiscard;
  }
});

test("continue working calls isolationKeep and hides dismissed card", async () => {
  const originalStatus = api.isolationStatus;
  const originalKeep = api.isolationKeep;
  let isolation: SessionIsolation = { ...base, state: "merge-ready" };
  let suggestion: IsolationStatusDto["suggestion"] = readySuggestion;
  api.isolationStatus = async () => ({
    isolation, effectiveState: isolation.state, suggestion,
    actions: {
      canReview: suggestion?.eligible === true,
      canMerge: suggestion?.eligible === true,
      canKeep: suggestion?.eligible === true,
      canResolve: false,
      canDiscard: true,
      canRecover: false,
      canAbandon: false,
    },
  });
  let kept = 0;
  api.isolationKeep = async (id) => {
    kept++;
    isolation = { ...base, state: "active", dismissedRevision: 1 };
    suggestion = { eligible: false, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "rev", reason: "dismissed" };
    return projection(id, isolation);
  };
  const mounted = await mount(projection("keep-ui", isolation));
  try {
    const keep = buttons(mounted.container).find((b) => b.textContent === tr("isolation.continueWorking"));
    assert.ok(keep);
    await act(async () => { keep!.click(); await wait(); });
    assert.equal(kept, 1);
    assert.equal(mounted.container.querySelector(".isolation-card"), null);
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
    assert.ok(buttons(mounted.container).some((b) => b.textContent === tr("isolation.continueWorking") && !b.disabled));
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
    assert.ok(buttons(mounted.container).some((b) => b.textContent === tr("isolation.resolveWithAgent") && !b.disabled));
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
    await mounted.close();
    for (const state of ["unowned", "corrupt"] as const) {
      isolation = { ...base, state };
      mounted = await mount(projection(state, isolation));
      assert.ok(mounted.container.textContent?.includes(tr("isolation.ownershipUnverified")));
      assert.ok(mounted.container.textContent?.includes(base.worktreePath));
      for (const label of ["isolation.continueWorking", "isolation.resolveWithAgent"] as const) {
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
      "isolation.resolveWithAgent",
      "isolation.discard",
      "isolation.reviewConflicts",
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

test("publication repair shows integrating copy without restoreOrigin; cleanup keeps path visible", async () => {
  const originalStatus = api.isolationStatus;
  let isolation: SessionIsolation = { ...base, state: "publishing", resultCommit: "published", publish: {
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
        assert.ok(text.includes("●"));
        assert.ok(text.includes("○") || text.includes("✓"));
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
    assert.ok(text.includes("✓"));
    assert.ok(text.includes("●"));
    assert.ok(text.includes(base.worktreePath), "stuck recovery still exposes the worktree path");
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});

test("in-flight recovery hides the worktree path", async () => {
  const originalStatus = api.isolationStatus;
  const originalRecover = api.isolationRecover;
  const isolation: SessionIsolation = { ...base, state: "rebind-pending", resultCommit: "published" };
  api.isolationStatus = async () => ({ isolation, effectiveState: isolation.state, suggestion: null });
  let finish!: (session: SessionProjection) => void;
  api.isolationRecover = () => new Promise((resolve) => { finish = resolve; });
  const mounted = await mount(projection("path-progress", isolation));
  try {
    assert.ok(mounted.container.textContent?.includes(base.worktreePath));
    const retry = buttons(mounted.container).find((button) => button.textContent === tr("isolation.retryRecovery"));
    assert.ok(retry && !retry.disabled);
    await act(async () => { retry.click(); await wait(); });
    assert.equal(mounted.container.textContent?.includes(base.worktreePath), false);
    await act(async () => { finish(projection("path-progress", isolation)); await wait(); });
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
    const more = buttons(mounted.container).find((button) => button.textContent === tr("common.more"));
    assert.ok(more);
    await act(async () => { more!.click(); await wait(); });
    const deleteEntry = [...document.querySelectorAll('[role="menuitem"]')]
      .find((entry) => entry.textContent === tr("isolation.discardWorkspace"));
    assert.ok(deleteEntry);
    await act(async () => { deleteEntry!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true })); await wait(); });
    assert.ok(document.body.textContent?.includes(tr("isolation.discardTitle")));
    await act(async () => {
      seedSessionCache(projection("discard-session-b", isolation));
      activateSession("discard-session-b");
      await wait();
    });
    assert.equal(document.body.textContent?.includes(tr("isolation.discardTitle")), false);
  } finally {
    await act(async () => { document.querySelectorAll(".dialog-backdrop, [role=dialog]").forEach((node) => node.remove()); });
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});
