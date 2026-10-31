// "Changes ready" latency: the card answers from what the client already
// knows (the merge-ready projection, a recent answer for the same state)
// instead of waiting for a status read, never shows one session's answer for
// another, and does not re-ask the server for every projection update while
// the agent works.
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
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateSession, seedSessionCache, upsertSession } = await import("../../../apps/web/src/store.ts");
const { IsolationCard } = await import("../widgets/IsolationCard.tsx");
const { tr } = await import("../../../apps/web/src/i18n/index.ts");
const { api } = await import("@polyth/session/web-api");

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const base = {
  kind: "git-worktree" as const, worktreeBranch: "polyth/isolate/test",
  targetBranch: "main", targetPath: "/repo", originPath: "/repo", baseCommit: "base", createdAt: "today",
};
const isolationAt = (path: string, state: SessionIsolation["state"]): SessionIsolation =>
  ({ ...base, worktreePath: path, state } as SessionIsolation);
const projection = (id: string, isolation: SessionIsolation | undefined, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id, projectId: "latency-test", title: id, status: "idle", createdAt: 1, updatedAt: 1,
  ...(isolation ? { isolation } : {}), ...extra,
});
const never = () => new Promise<IsolationStatusDto>(() => {});
const title = (container: ParentNode) => container.querySelector(".isolation-card .isolation-card-title")?.textContent ?? null;
const hasButton = (container: ParentNode, label: string) =>
  [...container.querySelectorAll("button")].some((button) => button.textContent?.includes(label) && !button.disabled);

async function mount(session: SessionProjection) {
  seedSessionCache(session);
  activateSession(session.id);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(IsolationCard)); await wait(); });
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}

test("a merge-ready session shows Changes ready before its status read returns", async () => {
  const original = api.isolationStatus;
  api.isolationStatus = never;
  const mounted = await mount(projection("latency-ready", isolationAt("/wt-ready", "merge-ready")));
  try {
    assert.equal(title(mounted.container), tr("isolation.changesAreReady"));
    assert.ok(hasButton(mounted.container, tr("isolation.integrateInto", { branch: "main" })), "Merge is offered at once");
  } finally {
    api.isolationStatus = original;
    await mounted.close();
  }
});

test("the turn's end shows the card in the same commit as the projection, not after a read", async () => {
  const original = api.isolationStatus;
  const working: IsolationStatusDto = {
    isolation: isolationAt("/wt-turn", "active"),
    effectiveState: "active",
    suggestion: { eligible: false, hasChanges: false, targetBranch: "main", targetDirty: false, revision: "", reason: "working" },
  };
  api.isolationStatus = async () => working;
  const mounted = await mount(projection("latency-turn", isolationAt("/wt-turn", "active"), { status: "working" }));
  try {
    assert.equal(title(mounted.container), null, "nothing to integrate while the agent works");
    api.isolationStatus = never;
    await act(async () => {
      upsertSession(projection("latency-turn", isolationAt("/wt-turn", "merge-ready"), { status: "idle", updatedAt: 2 }));
    });
    assert.equal(title(mounted.container), tr("isolation.changesAreReady"),
      "the working-time answer does not hide the ready card");
  } finally {
    api.isolationStatus = original;
    await mounted.close();
  }
});

test("projection updates during a turn do not re-read status", async () => {
  const original = api.isolationStatus;
  let calls = 0;
  api.isolationStatus = async () => {
    calls += 1;
    return { isolation: isolationAt("/wt-busy", "active"), effectiveState: "active", suggestion: null };
  };
  const mounted = await mount(projection("latency-busy", isolationAt("/wt-busy", "active"), { status: "working" }));
  try {
    assert.equal(calls, 1);
    for (let update = 2; update < 8; update += 1) {
      await act(async () => {
        upsertSession(projection("latency-busy", isolationAt("/wt-busy", "active"), { status: "working", updatedAt: update }));
        await wait();
      });
    }
    assert.equal(calls, 1, "the answer while working is fixed; the turn's churn is not a reason to ask");
    await act(async () => {
      upsertSession(projection("latency-busy", isolationAt("/wt-busy", "active"), { status: "idle", updatedAt: 9 }));
      await wait();
    });
    assert.equal(calls, 2, "the turn ending asks once");
  } finally {
    api.isolationStatus = original;
    await mounted.close();
  }
});

test("returning to a session shows its last answer at once, and never another session's", async () => {
  const original = api.isolationStatus;
  const missing: IsolationStatusDto = {
    isolation: isolationAt("/wt-gone", "active"),
    effectiveState: "missing",
    suggestion: { eligible: false, hasChanges: false, targetBranch: "main", targetDirty: false, revision: "", reason: "missing" },
  };
  api.isolationStatus = async (id) => id === "latency-gone" ? missing : never();
  const mounted = await mount(projection("latency-gone", isolationAt("/wt-gone", "active")));
  try {
    assert.equal(title(mounted.container), tr("isolation.missingWorkspace"));
    await act(async () => {
      seedSessionCache(projection("latency-other", isolationAt("/wt-other", "active")));
      activateSession("latency-other");
      await wait();
    });
    assert.equal(title(mounted.container), null, "another session's answer is never shown");
    api.isolationStatus = never;
    await act(async () => { activateSession("latency-gone"); await wait(); });
    assert.equal(title(mounted.container), tr("isolation.missingWorkspace"), "the remembered answer shows while a read confirms it");
  } finally {
    api.isolationStatus = original;
    await mounted.close();
  }
});

test("a refused session and a delegating parent wait for the server instead of a provisional card", async () => {
  const original = api.isolationStatus;
  api.isolationStatus = async () => { throw Object.assign(new Error("not found"), { status: 404 }); };
  const refused = await mount(projection("latency-refused", isolationAt("/wt-refused", "merge-ready")));
  try {
    assert.equal(title(refused.container), null, "a 4xx verdict is not overridden by the projection");
  } finally {
    await refused.close();
  }
  api.isolationStatus = never;
  seedSessionCache(projection("latency-child", isolationAt("/wt-child", "active"), {
    isolation: { ...isolationAt("/wt-child", "active"), originPath: "/wt-parent" },
  }));
  const parent = await mount(projection("latency-parent", isolationAt("/wt-parent", "merge-ready")));
  try {
    assert.equal(title(parent.container), null, "delegated children may block Merge; only the server can say");
  } finally {
    api.isolationStatus = original;
    await parent.close();
  }
});

test("pressing Integrate shows the integration steps at once, before the server's first phase", async () => {
  const originalStatus = api.isolationStatus;
  const originalMerge = api.isolationMerge;
  api.isolationStatus = never;
  let refuse: (cause: unknown) => void = () => {};
  api.isolationMerge = () => new Promise((_resolve, reject) => { refuse = reject; });
  const mounted = await mount(projection("latency-merge", isolationAt("/wt-merge", "merge-ready")));
  try {
    const integrate = tr("isolation.integrateInto", { branch: "main" });
    const button = [...mounted.container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(integrate));
    assert.ok(button, "Merge is offered");
    await act(async () => { button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); await wait(); });
    assert.equal(title(mounted.container), tr("isolation.integratingInto", { branch: "main" }),
      "the press is the integration; no wait for the server to persist a phase");
    const current = mounted.container.querySelector(".isolation-card-progress [aria-current='step']");
    assert.equal(current?.textContent, tr("isolation.integratingChanges"));
    assert.ok(!hasButton(mounted.container, integrate), "Merge is not offered twice");
    api.isolationStatus = async () => ({
      isolation: isolationAt("/wt-merge", "merge-ready"),
      effectiveState: "merge-ready",
      suggestion: { eligible: true, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "r" },
    });
    await act(async () => { refuse(Object.assign(new Error("target moved"), { status: 409 })); await wait(); await wait(); });
    assert.equal(title(mounted.container), tr("isolation.changesAreReady"), "a refused merge returns to the ready card");
  } finally {
    api.isolationStatus = originalStatus;
    api.isolationMerge = originalMerge;
    await mounted.close();
  }
});

test("a merge in flight for one session never shows as integrating on another", async () => {
  const originalStatus = api.isolationStatus;
  const originalMerge = api.isolationMerge;
  api.isolationStatus = never;
  let finish: (cause: unknown) => void = () => {};
  api.isolationMerge = () => new Promise((_resolve, reject) => { finish = reject; });
  const integrating = tr("isolation.integratingInto", { branch: "main" });
  const integrate = tr("isolation.integrateInto", { branch: "main" });
  seedSessionCache(projection("switch-other", isolationAt("/wt-switch-other", "merge-ready")));
  seedSessionCache(projection("switch-plain-isolated", isolationAt("/wt-switch-plain", "active")));
  const mounted = await mount(projection("switch-merging", isolationAt("/wt-switch-merging", "merge-ready")));
  try {
    const button = [...mounted.container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(integrate));
    assert.ok(button, "Merge is offered");
    await act(async () => { button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); await wait(); });
    assert.equal(title(mounted.container), integrating);

    await act(async () => { activateSession("switch-other"); await wait(); });
    assert.equal(title(mounted.container), tr("isolation.changesAreReady"), "the other session keeps its own card");
    assert.ok(hasButton(mounted.container, integrate), "the other session can still be merged");
    assert.equal(mounted.container.querySelector(".isolation-card")?.getAttribute("aria-busy"), "false");

    await act(async () => { activateSession("switch-plain-isolated"); await wait(); });
    assert.equal(title(mounted.container), null, "an active isolated session shows no integration card");

    await act(async () => { activateSession("switch-merging"); await wait(); });
    assert.equal(title(mounted.container), integrating, "returning shows the merge still running");

    await act(async () => { activateSession("switch-other"); await wait(); });
    api.isolationStatus = async (id) => ({
      isolation: isolationAt(`/wt-${id}`, "merge-ready"),
      effectiveState: "merge-ready",
      suggestion: { eligible: true, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "r" },
    });
    await act(async () => { finish(Object.assign(new Error("target moved"), { status: 409 })); await wait(); await wait(); });
    await act(async () => { activateSession("switch-merging"); await wait(); });
    assert.equal(title(mounted.container), tr("isolation.changesAreReady"), "a merge that ended off-screen leaves its session idle");
  } finally {
    api.isolationStatus = originalStatus;
    api.isolationMerge = originalMerge;
    await mounted.close();
  }
});
