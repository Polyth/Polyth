// Allow hides the card before the server answers; a partial failure brings
// back only the requests that failed, so a retry never replays a decision.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const { default: PermissionBanner } = await import("../widgets/PermissionBanner.tsx");
const { setSessions } = await import("../../../apps/web/src/store.ts");

// A subagent's session, so its cards may be delegated to the parent.
setSessions("p1", [{ id: "s1", projectId: "p1", title: "Child", status: "running", createdAt: 1, updatedAt: 1, parentId: "s0" }] as never);

function deferred() {
  let settle!: { resolve(): void; reject(error: Error): void };
  const promise = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
  return { promise, ...settle };
}

async function mount(requests: unknown[]) {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(createElement(PermissionBanner, { permissions: requests } as never)));
  return {
    container,
    click: (selector: string) => act(async () => (container.querySelector(selector) as unknown as HTMLElement).click()),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

const request = (requestId: string) => ({
  sessionId: "s1",
  requestId,
  permission: "bash",
  patterns: ["npm test"],
  status: "pending",
  time: 1,
  preview: { title: "bash", lines: ["npm test"], risk: "low", reasons: [] },
});

test("Allow hides the card at once and a partial failure restores only the failed request", async () => {
  const calls: string[] = [];
  const pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const original = api.replyPermission;
  (api as { replyPermission: unknown }).replyPermission = (_sessionId: string, requestId: string) => {
    calls.push(requestId);
    return new Promise<void>((resolve, reject) => pending.set(requestId, { resolve, reject }));
  };
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  try {
    await act(async () => root.render(createElement(PermissionBanner, {
      permissions: [request("r1"), request("r2")],
    } as never)));
    const allow = () => container.querySelector(".permission-allow") as unknown as HTMLElement | null;
    await act(async () => allow()!.click());
    assert.deepEqual(calls, ["r1", "r2"], "both replies are sent together");
    assert.equal(container.querySelector(".permission-request"), null, "the card is gone before any reply lands");

    await act(async () => {
      pending.get("r1")!.resolve();
      pending.get("r2")!.reject(new Error("runtime unavailable"));
    });
    assert.equal(container.querySelector(".permission-error")?.textContent, "runtime unavailable");

    calls.length = 0;
    await act(async () => allow()!.click());
    assert.deepEqual(calls, ["r2"], "the confirmed reply is not replayed");
    await act(async () => pending.get("r2")!.resolve());
    assert.equal(container.querySelector(".permission-request"), null);
    assert.equal(container.querySelector(".permission-error"), null);
  } finally {
    (api as { replyPermission: unknown }).replyPermission = original;
    await act(async () => root.unmount());
    container.remove();
  }
});

test("All session hides the card at once and brings back what the policy left open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const call = deferred();
  const original = api.autoAcceptSet;
  const settings: string[] = [];
  (api as { autoAcceptSet: unknown }).autoAcceptSet = (_sessionId: string, setting: string) => {
    settings.push(setting);
    return call.promise;
  };
  const view = await mount([request("r1")]);
  try {
    await view.click(".permission-session");
    assert.deepEqual(settings, ["on"]);
    assert.equal(view.container.querySelector(".permission-request"), null, "hidden before the policy answers");
    await act(async () => call.resolve());
    assert.equal(view.container.querySelector(".permission-request"), null, "still hidden while events catch up");
    await act(async () => t.mock.timers.tick(1500));
    assert.ok(view.container.querySelector(".permission-request"), "a request the policy left open returns");
  } finally {
    (api as { autoAcceptSet: unknown }).autoAcceptSet = original;
    await view.unmount();
  }
});

test("a failed policy brings the card back with its error at once", async () => {
  const original = api.autoAcceptSet;
  (api as { autoAcceptSet: unknown }).autoAcceptSet = () => Promise.reject(new Error("policy refused"));
  const view = await mount([request("r1")]);
  try {
    await view.click(".permission-session");
    assert.equal(view.container.querySelector(".permission-error")?.textContent, "policy refused");
  } finally {
    (api as { autoAcceptSet: unknown }).autoAcceptSet = original;
    await view.unmount();
  }
});

test("Delegate shows the handed-over state at once and keeps Allow available", async () => {
  const call = deferred();
  const original = api.delegatePermission;
  (api as { delegatePermission: unknown }).delegatePermission = () => call.promise;
  const view = await mount([request("r1")]);
  try {
    await view.click(".permission-delegate");
    assert.ok(view.container.querySelector(".permission-delegated"), "delegated before the server answers");
    assert.equal(view.container.querySelector(".permission-delegate"), null);
    assert.equal((view.container.querySelector(".permission-allow") as unknown as HTMLButtonElement).disabled, false);
    await act(async () => call.reject(new Error("wake failed")));
    assert.equal(view.container.querySelector(".permission-delegated"), null);
    assert.ok(view.container.querySelector(".permission-delegate"), "a failed hand-over can be retried");
    assert.equal(view.container.querySelector(".permission-error")?.textContent, "wake failed");
  } finally {
    (api as { delegatePermission: unknown }).delegatePermission = original;
    await view.unmount();
  }
});
