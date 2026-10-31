// Isolation card presence: returning a session from isolation never removes
// the card in one commit. It shows the merged state for a beat, collapses its
// whole share of the timeline, and only then unmounts. WAAPI is recorded by a
// fake `animate`; the real geometry is pinned by the Chromium harness.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionIsolation, SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  getComputedStyle: dom.getComputedStyle.bind(dom),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every animation finishes on the next task, like a very short real one.
const played: Array<{ keyframes: Keyframe[]; options: KeyframeAnimationOptions }> = [];
(dom.HTMLElement.prototype as unknown as { animate: unknown }).animate = function animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  played.push({ keyframes, options });
  let resolve!: () => void;
  const finished = new Promise<void>((done) => { resolve = done; });
  setTimeout(resolve, 0);
  return { finished, playState: "running", cancel() {} } as unknown as Animation;
};

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateSession, seedSessionCache, upsertSession } = await import("../../../apps/web/src/store.ts");
const { IsolationCard } = await import("../widgets/IsolationCard.tsx");
const { CARD_DONE_BEAT_MS } = await import("../widgets/isolationCardMotion.ts");
const { tr } = await import("../../../apps/web/src/i18n/index.ts");
const { api } = await import("@polyth/session/web-api");

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const base = {
  kind: "git-worktree" as const, worktreePath: "/repo-isolated", worktreeBranch: "polyth/isolate/test",
  targetBranch: "main", targetPath: "/repo", originPath: "/repo", baseCommit: "base", createdAt: "today",
};
const projection = (id: string, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id, projectId: "presence-test", title: id, status: "idle", createdAt: 1, updatedAt: Date.now(), ...extra,
});
const cleanup: SessionIsolation = { ...base, state: "cleanup-pending", resultCommit: "abc1234", rebound: true };

api.isolationStatus = async () => ({ isolation: cleanup, effectiveState: cleanup.state, suggestion: null });

async function mount(session: SessionProjection) {
  seedSessionCache(session);
  activateSession(session.id);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(IsolationCard)); await wait(); });
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}
const card = (container: ParentNode) => container.querySelector<HTMLElement>(".isolation-card");

test("a merged session shows its merged state, collapses, and only then unmounts", async () => {
  const mounted = await mount(projection("presence-merged", { isolation: cleanup }));
  try {
    assert.ok(card(mounted.container), "the recovering card is visible");
    assert.ok(played.length > 0, "the card grows in rather than appearing at once");
    const live = card(mounted.container);
    played.length = 0;
    await act(async () => {
      upsertSession(projection("presence-merged", { isolationMerge: { targetBranch: "main", commit: "abc1234", at: 1 } }));
      await wait();
    });
    const held = card(mounted.container);
    assert.equal(held, live, "the same card element carries the merged state (no remount)");
    assert.equal(held?.querySelector(".isolation-card-title")?.textContent, tr("isolation.mergedIntoBranch", { branch: "main" }));
    assert.ok(held?.hasAttribute("inert"), "a held card is never a control surface");
    assert.deepEqual(
      [...held!.querySelectorAll(".isolation-card-progress-mark")].map((mark) => mark.getAttribute("data-state")),
      ["done", "done", "done"],
    );
    await act(async () => { await wait(CARD_DONE_BEAT_MS + 50); });
    const exit = played.find((entry) => entry.options.easing === "cubic-bezier(0.65, 0, 0.35, 1)");
    assert.ok(exit, "the beat ends in a collapse");
    const last = exit!.keyframes.at(-1)!;
    assert.equal(last.paddingTop, "0px");
    assert.equal(last.paddingBottom, "0px");
    await act(async () => { await wait(); await wait(); });
    assert.equal(card(mounted.container), null, "the collapsed card unmounts");
  } finally {
    await mounted.close();
  }
});

test("switching sessions drops a held card at once", async () => {
  const mounted = await mount(projection("presence-switch", { isolation: cleanup }));
  try {
    await act(async () => {
      upsertSession(projection("presence-switch", { isolationMerge: { targetBranch: "main", commit: "abc1234", at: 1 } }));
      await wait();
    });
    assert.ok(card(mounted.container), "held while the merged beat plays");
    await act(async () => {
      seedSessionCache(projection("presence-other"));
      activateSession("presence-other");
      await wait();
    });
    assert.equal(card(mounted.container), null);
  } finally {
    await mounted.close();
  }
});

test("reduced motion removes the card with no held state", async () => {
  document.documentElement.dataset.reduceAnimations = "true";
  const mounted = await mount(projection("presence-reduced", { isolation: cleanup }));
  try {
    assert.ok(card(mounted.container));
    await act(async () => {
      upsertSession(projection("presence-reduced", { isolationMerge: { targetBranch: "main", commit: "abc1234", at: 1 } }));
      await wait();
    });
    assert.equal(card(mounted.container), null);
  } finally {
    delete document.documentElement.dataset.reduceAnimations;
    await mounted.close();
  }
});

test("an old merge receipt does not turn a discarded isolation into a merged beat", async () => {
  const ready: SessionIsolation = { ...base, state: "merge-ready" };
  const original = api.isolationStatus;
  api.isolationStatus = async () => ({
    isolation: ready,
    effectiveState: ready.state,
    suggestion: { eligible: true, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "rev" },
  });
  const receipt = { targetBranch: "main", commit: "old0001", at: 1 };
  const mounted = await mount(projection("presence-stale", { isolation: ready, isolationMerge: receipt }));
  try {
    assert.equal(card(mounted.container)?.querySelector(".isolation-card-title")?.textContent, tr("isolation.changesAreReady"));
    // The exit is held open until released: `act` itself crosses a task, so
    // an exit finishing on the next task raced the assertion below.
    const proto = dom.HTMLElement.prototype as unknown as { animate: unknown };
    const quick = proto.animate;
    const gates: Array<() => void> = [];
    proto.animate = function animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      played.push({ keyframes, options });
      const finished = new Promise<void>((done) => { gates.push(done); });
      return { finished, playState: "running", cancel() {} } as unknown as Animation;
    };
    try {
      await act(async () => {
        upsertSession(projection("presence-stale", { isolationMerge: receipt }));
        await wait();
      });
      const held = card(mounted.container);
      assert.ok(held, "the card collapses instead of vanishing");
      assert.notEqual(held?.querySelector(".isolation-card-title")?.textContent, tr("isolation.mergedIntoBranch", { branch: "main" }));
      await act(async () => { for (const open of gates.splice(0)) open(); await wait(); await wait(); });
      assert.equal(card(mounted.container), null);
    } finally {
      proto.animate = quick;
    }
  } finally {
    api.isolationStatus = original;
    await mounted.close();
  }
});

test("a status read that fails in transit is retried until the card can show", async () => {
  // A phone resumed from the background, or a busy repository, can fail the
  // first status reads; the card must still appear once the server answers.
  const ready: SessionIsolation = { ...base, state: "merge-ready" };
  const original = api.isolationStatus;
  let calls = 0;
  let unreachable = 2;
  api.isolationStatus = async () => {
    calls += 1;
    if (unreachable > 0) {
      unreachable -= 1;
      throw Object.assign(new Error("Bad Gateway"), { status: 502 });
    }
    return {
      isolation: ready,
      effectiveState: ready.state,
      suggestion: { eligible: true, hasChanges: true, targetBranch: "main", targetDirty: false, revision: "rev" },
      actions: { canReview: true, canMerge: true, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false },
    };
  };
  const mounted = await mount(projection("presence-retry", { isolation: ready }));
  try {
    assert.equal(calls, 1);
    // The merge-ready projection is the server's own verdict from the end of
    // the turn: the card says so at once while the reads keep trying.
    assert.equal(card(mounted.container)?.querySelector(".isolation-card-title")?.textContent, tr("isolation.changesAreReady"));
    await act(async () => { await wait(1_100); });
    assert.equal(calls, 2, "the backoff asks again");
    // Coming back online asks at once instead of waiting out the backoff.
    await act(async () => { window.dispatchEvent(new dom.Event("online") as unknown as Event); await wait(); });
    assert.equal(calls, 3);
    const shown = card(mounted.container);
    assert.ok(shown, "the card shows once the server answers");
    assert.ok(
      [...shown!.querySelectorAll("button")].some((button) => button.textContent?.includes(tr("isolation.integrateInto", { branch: "main" }))),
      "the integrate action is offered",
    );
    await act(async () => { await wait(1_100); });
    assert.equal(calls, 3, "a successful read stops the retries");
  } finally {
    api.isolationStatus = original;
    await mounted.close();
  }
});

test("a session the server refuses is not retried", async () => {
  const ready: SessionIsolation = { ...base, state: "merge-ready" };
  const original = api.isolationStatus;
  let calls = 0;
  api.isolationStatus = async () => {
    calls += 1;
    throw Object.assign(new Error("not found"), { status: 404 });
  };
  const mounted = await mount(projection("presence-refused", { isolation: ready }));
  try {
    await act(async () => { await wait(1_100); });
    assert.equal(calls, 1);
    assert.equal(card(mounted.container), null);
  } finally {
    api.isolationStatus = original;
    await mounted.close();
  }
});
