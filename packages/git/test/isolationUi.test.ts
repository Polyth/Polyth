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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateSession, seedSessionCache } = await import("../../../apps/web/src/store.ts");
const { IsolationCard } = await import("../widgets/IsolationCard.tsx");
const { tr } = await import("../../../apps/web/src/i18n/index.ts");
const { api } = await import("@polyth/session/web-api");
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));
const base = {
  kind: "git-worktree" as const, worktreePath: "/repo-isolated", worktreeBranch: "polyth/isolate/test",
  targetBranch: "main", targetPath: "/repo", originPath: "/repo", baseCommit: "base", createdAt: "today",
};
const projection = (id: string, isolation: SessionIsolation): SessionProjection => ({
  id, projectId: "ui-test", title: id, status: "idle", createdAt: 1, updatedAt: 1, isolation,
});
async function mount(session: SessionProjection) {
  seedSessionCache(session);
  activateSession(session.id);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(IsolationCard)); await wait(); });
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}

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
    assert.equal([...mounted.container.querySelectorAll("button")].some((button) => button.textContent === tr("isolation.keepIsolated") && !button.disabled), false);
    await mounted.close();
    for (const state of ["unowned", "corrupt"] as const) {
      isolation = { ...base, state };
      mounted = await mount(projection(state, isolation));
      assert.ok(mounted.container.textContent?.includes(tr("isolation.ownershipUnverified")));
      assert.ok(mounted.container.textContent?.includes(base.worktreePath));
      for (const label of ["isolation.keepIsolated", "isolation.merge", "isolation.resolveWithAgent"] as const) {
        assert.equal([...mounted.container.querySelectorAll("button")].some((button) => button.textContent === tr(label) && !button.disabled), false);
      }
      await mounted.close();
    }
    isolation = { ...base, state: "rebind-pending", resultCommit: "published" };
    let recovered = 0;
    api.isolationRecover = async (id) => { recovered++; return projection(id, isolation); };
    mounted = await mount(projection("published", isolation));
    assert.ok(mounted.container.textContent?.includes("/repo"));
    const retry = [...mounted.container.querySelectorAll("button")].find((button) => button.textContent === tr("isolation.retryRecovery"));
    assert.ok(retry && !retry.disabled, "published session needs an enabled recovery action");
    await act(async () => { retry.click(); await wait(); });
    assert.equal(recovered, 1);
    assert.equal([...mounted.container.querySelectorAll("button")].some((button) => button.textContent === tr("isolation.merge")), false);
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
    assert.equal([...mounted.container.querySelectorAll("button")].some((button) => button.textContent === tr("isolation.merge")), false);
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
      [...mounted.container.querySelectorAll("button")]
        .filter((button) => !button.disabled)
        .map((button) => button.textContent),
    );
    for (const label of [
      "isolation.keepIsolated",
      "isolation.merge",
      "isolation.resolveWithAgent",
      "isolation.discard",
      "isolation.reviewConflicts",
    ] as const) {
      assert.equal(enabledLabels.has(tr(label)), false);
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
    assert.ok(mounted.container.textContent?.includes("/repo"));
    assert.equal([...mounted.container.querySelectorAll("button")].some((button) => button.textContent === tr("isolation.merge") && !button.disabled), false);
    await mounted.close();
    const pending: SessionIsolation = { ...base, state: "rebind-pending", resultCommit: "published" };
    api.isolationStatus = async () => ({ isolation: pending, effectiveState: pending.state, suggestion: null });
    mounted = await mount({ ...projection("busy-recovery", pending), status: "working" });
    const retry = [...mounted.container.querySelectorAll("button")].find((button) => button.textContent === tr("isolation.retryRecovery"));
    assert.ok(!retry || retry.disabled, "a running session cannot retry recovery");
  } finally {
    await mounted.close();
    api.isolationStatus = originalStatus;
  }
});


test("publication repair explains the return checkout and cleanup exposes preserved source work", async () => {
  const originalStatus = api.isolationStatus;
  let isolation: SessionIsolation = { ...base, state: "publishing", publish: {
    expectedTargetSha: "old", resultCommit: "published", snapshotSha: "snapshot", targetRef: "refs/heads/main",
    receiptRef: "refs/polyth/isolation/ui", checkoutPath: base.originPath, sourceRevision: "source",
  } };
  api.isolationStatus = async () => ({ isolation, effectiveState: isolation.state, suggestion: null });
  let mounted = await mount(projection("repair-published-checkout", isolation));
  try {
    assert.ok(mounted.container.textContent?.includes(tr("isolation.restoreOrigin", { path: base.originPath, branch: base.targetBranch })));
    assert.ok(mounted.container.textContent?.includes(base.worktreePath));
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
