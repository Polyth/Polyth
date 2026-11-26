import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionCheckoutPreview } from "../src/sessionCheckoutMove.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
});
dom.document.documentElement.dataset.reduceAnimations = "true";
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (cb: FrameRequestCallback) => { cb(0); return 1; } });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: MoveToCheckoutDialog } = await import("../widgets/MoveToCheckoutDialog.tsx");
const { tr } = await import("../../../apps/web/src/i18n/index.ts");
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

const preview = (extra: Partial<SessionCheckoutPreview> = {}): SessionCheckoutPreview => ({
  from: { path: "/r-wt", branch: "feat/x", isMain: false, label: "wt-x" },
  to: { path: "/r", branch: "main", isMain: true, label: "main", dirtyCount: 0 },
  restartsAgent: false, lastSessionInSource: false, sourceDirtyCount: 0,
  sourceBranchOwned: false, sourceBranchMerged: false,
  branches: [{ name: "main" }, { name: "dev" }], expectedWorkspaceRevision: 7,
  ...extra,
});

interface Calls { previews: number; moves: Array<Record<string, unknown>> }
function stubFetch(previews: SessionCheckoutPreview[], moveResponse: () => Response): Calls {
  const calls: Calls = { previews: 0, moves: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/session-checkout/preview")) {
      const next = previews[Math.min(calls.previews, previews.length - 1)]!;
      calls.previews += 1;
      return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/session-checkout")) {
      calls.moves.push(JSON.parse(String(init?.body)));
      return moveResponse();
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return calls;
}
const ok = () => new Response(JSON.stringify({ session: { id: "s1", projectId: "p", title: "t", status: "idle", createdAt: 1, updatedAt: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const closed = { n: 0 };
  await act(async () => {
    root.render(createElement(MoveToCheckoutDialog, { sessionId: "s1", projectId: "p", target: { main: true }, onClose: () => { closed.n += 1; } }));
    await wait(); await wait();
  });
  return { closed, async unmount() { await act(async () => root.unmount()); container.remove(); } };
}
const buttons = () => [...document.querySelectorAll("button")];
const radio = (value: string) => document.querySelector<HTMLInputElement>(`input[type=radio][value=${value}]`)!;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); await wait(); await wait(); }); };
const primary = () => buttons().find((b) => b.textContent === tr("gitmove.confirm") || b.textContent === tr("gitmove.confirmRemove"));

test("a blocked preview shows its message and only Cancel", async () => {
  stubFetch([preview({ blocked: { reason: "busy", message: "This chat is working." } })], ok);
  const view = await mount();
  assert.match(document.body.textContent ?? "", /This chat is working\./);
  assert.ok(buttons().some((b) => b.textContent === tr("gitmove.cancel")));
  assert.equal(primary(), undefined);
  assert.equal(document.querySelectorAll("input[type=radio]").length, 0);
  await view.unmount();
});

test("a dirty target disables every switch row", async () => {
  stubFetch([preview({ to: { ...preview().to, dirtyCount: 3 } })], ok);
  const view = await mount();
  assert.equal(radio("keep").disabled, false);
  for (const v of ["switch", "other", "create"]) assert.equal(radio(v).disabled, true, v);
  assert.match(document.body.textContent ?? "", /3 uncommitted changes/);
  await view.unmount();
});

test("the removal checkbox is disabled while the source worktree is dirty", async () => {
  stubFetch([preview({ lastSessionInSource: true, sourceDirtyCount: 2 })], ok);
  const view = await mount();
  const box = [...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")][0]!;
  assert.equal(box.disabled, true);
  assert.match(document.body.textContent ?? "", /2 uncommitted changes/);
  await view.unmount();
});

test("submit sends the chosen branch and removal payload", async () => {
  const calls = stubFetch([preview({ lastSessionInSource: true, sourceBranchOwned: true, sourceBranchMerged: true, branches: [{ name: "main" }, { name: "feat/x", inUseBy: "wt-x" }] })], ok);
  const view = await mount();
  await click(document.querySelector<HTMLInputElement>("input[type=checkbox]")!);
  assert.equal(radio("switch").disabled, false, "switching to the chat's branch is allowed once the worktree is removed");
  await click(radio("switch"));
  const boxes = [...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
  assert.equal(boxes.length, 2);
  await click(boxes[1]!);
  await click(primary()!);
  assert.deepEqual(calls.moves, [{
    sessionId: "s1", target: { main: true }, expectedWorkspaceRevision: 7,
    branch: { kind: "switch", name: "feat/x" }, removeSource: { deleteBranch: true },
  }]);
  assert.equal(view.closed.n, 1);
  await view.unmount();
});

test("a conflict re-runs the preview and asks for another review", async () => {
  const calls = stubFetch([preview(), preview({ expectedWorkspaceRevision: 8 })],
    () => new Response(JSON.stringify({ error: "conflict", message: "stale" }), { status: 409, headers: { "Content-Type": "application/json" } }));
  const view = await mount();
  assert.equal(calls.previews, 1);
  await click(primary()!);
  assert.equal(calls.previews, 2);
  assert.match(document.querySelector("[role=alert]")?.textContent ?? "", /review again/);
  assert.equal(view.closed.n, 0);
  await view.unmount();
});
