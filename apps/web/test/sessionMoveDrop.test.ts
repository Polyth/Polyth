// The navigator's drop zones: what lights up, and what a drop asks the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createElement, act } from "react";
import type { Project, SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const asked: string[] = [];
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  asked.push(`${String(url)} ${init?.body ?? ""}`);
  return new Response(JSON.stringify({ sessionId: "s1", fromProjectId: "one", toProjectId: "two", sessionIds: ["s1"], restartsAgent: false, gains: [], loses: [], blocked: { reason: "busy", message: "busy" } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { createRoot } = await import("react-dom/client");
const { SESSION_MOVE_MIME } = await import("../src/dnd.ts");
const { beginSessionMoveDrag, endSessionMoveDrag, useSessionMoveDropZones } = await import("../src/sessionMove.ts");
const store = await import("../src/store.ts");

const project = (id: string): Project => ({ id, path: `/work/${id}`, name: id, createdAt: 1 });
const session: SessionProjection = { id: "s1", projectId: "one", title: "Chat", status: "idle", createdAt: 1, updatedAt: 1 };
store.applyProjectAdded(project("one"));
store.applyProjectAdded(project("two"));
store.applyProjectAdded({ ...project("room"), parentProjectId: "one" });

let zones!: ReturnType<typeof useSessionMoveDropZones>;
function Harness() {
  zones = useSessionMoveDropZones();
  return null;
}
const host = dom.document.createElement("div");
const root = createRoot(host as unknown as Element);
await act(async () => { root.render(createElement(Harness)); });

const zone = (projectId: string): Element => {
  const element = dom.document.createElement("div");
  element.setAttribute("data-session-drop-project", projectId);
  return element as unknown as Element;
};
const drag = (target: Element, types: string[], payload = "s1") => {
  let prevented = false;
  const event = {
    target,
    currentTarget: { contains: () => false },
    relatedTarget: null,
    dataTransfer: { types, dropEffect: "none", getData: (type: string) => type === SESSION_MOVE_MIME ? payload : "", setData() {} },
    preventDefault: () => { prevented = true; },
  };
  return { event: event as never, prevented: () => prevented };
};
const begin = () => act(async () => {
  beginSessionMoveDrag({ setData() {}, getData: () => "" } as unknown as DataTransfer, session);
});

test("only another project on this machine accepts a chat", async () => {
  await begin();
  const other = drag(zone("two"), [SESSION_MOVE_MIME]);
  await act(async () => { zones.handlers.onDragOver(other.event); });
  assert.equal(other.prevented(), true);
  assert.equal(zones.overProjectId, "two");

  for (const id of ["one", "room", "unknown"]) {
    const refused = drag(zone(id), [SESSION_MOVE_MIME]);
    await act(async () => { zones.handlers.onDragOver(refused.event); });
    assert.equal(refused.prevented(), false, id);
    assert.equal(zones.overProjectId, null, id);
  }
  await act(async () => { endSessionMoveDrag(); });
});

test("a row gone mid-drag leaves nothing for the next, unrelated drag to trip on", async () => {
  await begin(); // No dragend reaches us from a row that unmounted.
  const file = drag(zone("two"), ["Files"]);
  await act(async () => { zones.handlers.onDragOver(file.event); });
  assert.equal(file.prevented(), false);
  assert.equal(zones.overProjectId, null);
  await act(async () => { endSessionMoveDrag(); });
});

test("nothing lights up with no drag under way", async () => {
  const stray = drag(zone("two"), [SESSION_MOVE_MIME]);
  await act(async () => { zones.handlers.onDragOver(stray.event); });
  assert.equal(stray.prevented(), false);
});

test("a drop asks the server first, and only for the chat this drag started with", async () => {
  await begin();
  asked.length = 0;
  const forged = drag(zone("two"), [SESSION_MOVE_MIME], "someone-elses-chat");
  await act(async () => { zones.handlers.onDrop(forged.event); await Promise.resolve(); });
  assert.deepEqual(asked, [], "a payload naming another chat does nothing");

  await begin();
  const real = drag(zone("two"), [SESSION_MOVE_MIME]);
  await act(async () => { zones.handlers.onDrop(real.event); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(real.prevented(), true);
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /\/api\/sessions\/s1\/move/);
  assert.match(asked[0]!, /"dryRun":true/, "the move itself waits for the confirmation");
  assert.match(asked[0]!, /"expectedProjectId":"one"/);
});

// ---- another checkout of the chat's own project ----
const { closePendingCheckoutMove, usePendingCheckoutMove, useCheckoutDropOver } = await import("../src/sessionMove.ts");
let pending: ReturnType<typeof usePendingCheckoutMove> = null;
let overInOne: string | null = null;
function CheckoutHarness() {
  pending = usePendingCheckoutMove();
  overInOne = useCheckoutDropOver("one");
  return null;
}
const checkoutHost = dom.document.createElement("div");
await act(async () => { createRoot(checkoutHost as unknown as Element).render(createElement(CheckoutHarness)); });

/** A checkout row nested inside its project's row, as in the navigator tree. */
const checkoutZone = (projectId: string, key: string): Element => {
  const projectRow = dom.document.createElement("div");
  projectRow.setAttribute("data-session-drop-project", projectId);
  const head = dom.document.createElement("div");
  head.setAttribute("data-session-drop-checkout", key);
  head.setAttribute("data-session-drop-checkout-project", projectId);
  const label = dom.document.createElement("span");
  head.appendChild(label);
  projectRow.appendChild(head);
  return label as unknown as Element;
};
const beginWith = (carried: SessionProjection) => act(async () => {
  beginSessionMoveDrag({ setData() {}, getData: () => "" } as unknown as DataTransfer, carried);
});

test("another checkout of the chat's own project accepts it, never the one it works in", async () => {
  const inWorktree = { ...session, worktreePath: "/work/one-wt-a" };
  await beginWith(inWorktree);
  const toMain = drag(checkoutZone("one", "main"), [SESSION_MOVE_MIME]);
  await act(async () => { zones.handlers.onDragOver(toMain.event); });
  assert.equal(toMain.prevented(), true);
  assert.equal(overInOne, "main");
  assert.equal(zones.overProjectId, null, "the project row under it does not light up");

  const toOther = drag(checkoutZone("one", "/work/one-wt-b"), [SESSION_MOVE_MIME]);
  await act(async () => { zones.handlers.onDragOver(toOther.event); });
  assert.equal(toOther.prevented(), true);
  assert.equal(overInOne, "/work/one-wt-b");

  const here = drag(checkoutZone("one", "/work/one-wt-a"), [SESSION_MOVE_MIME]);
  await act(async () => { zones.handlers.onDragOver(here.event); });
  assert.equal(here.prevented(), false, "the checkout it already works in");
  assert.equal(overInOne, null);

  // Another project's checkout is that project: a project move, as before.
  for (const key of ["main", "/work/two-wt"]) {
    const elsewhere = drag(checkoutZone("two", key), [SESSION_MOVE_MIME]);
    await act(async () => { zones.handlers.onDragOver(elsewhere.event); });
    assert.equal(zones.overProjectId, "two", key);
    assert.equal(overInOne, null, key);
  }
  await act(async () => { endSessionMoveDrag(); });

  // A chat on the main checkout can't be dropped on the main checkout.
  await beginWith(session);
  const same = drag(checkoutZone("one", "main"), [SESSION_MOVE_MIME]);
  await act(async () => { zones.handlers.onDragOver(same.event); });
  assert.equal(same.prevented(), false);
  await act(async () => { endSessionMoveDrag(); });
});

test("a checkout drop asks nothing itself: it hands the confirmation to the Git package", async () => {
  await beginWith({ ...session, worktreePath: "/work/one-wt-a" });
  asked.length = 0;
  const forged = drag(checkoutZone("one", "main"), [SESSION_MOVE_MIME], "someone-elses-chat");
  await act(async () => { zones.handlers.onDrop(forged.event); });
  assert.equal(pending, null, "a payload naming another chat does nothing");

  await beginWith({ ...session, worktreePath: "/work/one-wt-a" });
  const real = drag(checkoutZone("one", "main"), [SESSION_MOVE_MIME]);
  await act(async () => { zones.handlers.onDrop(real.event); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(real.prevented(), true);
  assert.deepEqual(pending, { sessionId: "s1", projectId: "one", target: { main: true } });
  assert.deepEqual(asked, [], "the slot's dialog asks the server, not the drop");
  assert.equal(overInOne, null);
  await act(async () => { closePendingCheckoutMove(); });
  assert.equal(pending, null);
});
