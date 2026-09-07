import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection } from "@polyth/contracts";

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
const mediaQueryList = {
  matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  dispatchEvent: () => true,
};
Object.defineProperty(dom, "matchMedia", { configurable: true, value: () => mediaQueryList });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchCalls: Array<{ url: string; method: string }> = [];
let removePayload: unknown = { ok: true };
let deleteFailures = new Set<string>();
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string }) => {
  const method = init?.method ?? "GET";
  const href = String(url);
  fetchCalls.push({ url: href, method });
  if (method === "GET" && href.startsWith("/api/worktrees")) {
    return ok([
      { path: "/repo", branch: "main", head: "aaa", isMain: true },
      { path: "/repo-worktrees/feat", branch: "feat", head: "bbb", isMain: false },
    ]);
  }
  if (method === "POST" && href.includes("/api/worktrees/remove")) {
    if ((removePayload as { error?: string }).error === "worktree-dirty") {
      return fail(409, removePayload);
    }
    if ((removePayload as { error?: string }).error) return fail(500, removePayload);
    return ok(removePayload);
  }
  const deleted = href.match(/^\/api\/sessions\/([^/?]+)$/);
  if (method === "DELETE" && deleted) {
    const id = decodeURIComponent(deleted[1]!);
    if (deleteFailures.has(id)) return fail(500, { error: "internal", message: `cannot delete ${id}` });
    return ok({ ok: true });
  }
  return ok([]);
};

function ok(payload: unknown) {
  return {
    ok: true, status: 200, statusText: "OK",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}
function fail(status: number, payload: unknown) {
  return {
    ok: false, status, statusText: "Error",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateProject, clearUiError, getState, setSessions } = await import("../src/store.ts");
const { default: SessionList } = await import("../src/components/sidebar/SessionList.tsx");

const session = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s", projectId: "p1", title: "session", status: "idle",
  createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000,
  worktreePath: "/repo-worktrees/feat",
  ...over,
});

async function mount(extra: SessionProjection[] = []) {
  activateProject("p1");
  clearUiError();
  setSessions("p1", [
    session({ id: "s-ok", title: "Keep me" }),
    session({ id: "s-fail", title: "Cleanup fail" }),
    ...extra,
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SessionList, { projectId: "p1" }));
  });
  await act(async () => { await Promise.resolve(); });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

async function confirmRemove(container: HTMLElement) {
  const trash = container.querySelector<HTMLButtonElement>("button.danger");
  assert.ok(trash, "worktree delete control is present");
  await act(async () => { trash!.click(); });
  const confirm = [...document.querySelectorAll("button")]
    .find((button) => (button.textContent ?? "").includes("Delete worktree"));
  assert.ok(confirm, "confirm dialog opened");
  await act(async () => { confirm!.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

test("session cleanup failure after Git success is reported as cleanup, not removal", async () => {
  fetchCalls.length = 0;
  removePayload = { ok: true };
  deleteFailures = new Set(["s-ok", "s-fail"]);
  const { container, unmount } = await mount();
  try {
    await confirmRemove(container);
    assert.match(getState().uiError ?? "", /clean up sessions after removing the worktree/i);
    assert.doesNotMatch(getState().uiError ?? "", /Couldn.t remove the worktree/);
    assert.equal(fetchCalls.filter((call) => call.url.includes("/api/worktrees/remove")).length, 1);
    assert.equal(document.querySelector("[role='dialog']"), null, "dialog closes after Git success");
  } finally {
    await unmount();
  }
});

test("partial session deletion still closes the dialog and does not retry Git", async () => {
  fetchCalls.length = 0;
  removePayload = { ok: true };
  deleteFailures = new Set(["s-fail"]);
  const { container, unmount } = await mount();
  try {
    await confirmRemove(container);
    assert.match(getState().uiError ?? "", /clean up sessions after removing the worktree/i);
    const deletes = fetchCalls.filter((call) => call.method === "DELETE");
    assert.equal(deletes.length, 2);
    assert.equal(fetchCalls.filter((call) => call.url.includes("/api/worktrees/remove")).length, 1);
    assert.equal(document.querySelector("[role='dialog']"), null);
  } finally {
    await unmount();
  }
});

test("metadata cleanup warning after Git success is not a worktree-removal failure", async () => {
  fetchCalls.length = 0;
  removePayload = { ok: true, metadataCleanupFailed: true };
  deleteFailures = new Set();
  const { container, unmount } = await mount();
  try {
    await confirmRemove(container);
    assert.match(getState().uiError ?? "", /clean up sessions after removing the worktree/i);
    assert.equal(fetchCalls.filter((call) => call.url.includes("/api/worktrees/remove")).length, 1);
  } finally {
    await unmount();
  }
});

test("branch cleanup warning after Git success is not a worktree-removal failure", async () => {
  fetchCalls.length = 0;
  removePayload = { ok: true, branchCleanupFailed: true };
  deleteFailures = new Set();
  const { container, unmount } = await mount();
  try {
    await confirmRemove(container);
    assert.match(getState().uiError ?? "", /clean up sessions after removing the worktree/i);
    assert.doesNotMatch(getState().uiError ?? "", /Couldn.t remove the worktree/);
    assert.equal(document.querySelector("[role='dialog']"), null);
  } finally {
    await unmount();
  }
});

test("Git-level worktree removal failure still uses the removal error", async () => {
  fetchCalls.length = 0;
  removePayload = { error: "git-failed", message: "not a working tree" };
  deleteFailures = new Set();
  const { container, unmount } = await mount();
  try {
    await confirmRemove(container);
    assert.match(getState().uiError ?? "", /Couldn.t remove the worktree/);
    assert.doesNotMatch(getState().uiError ?? "", /clean up sessions after removing the worktree/i);
    assert.ok(document.querySelector("[role='dialog']"), "dialog stays open so the user can cancel");
    assert.equal(fetchCalls.filter((call) => call.method === "DELETE").length, 0);
  } finally {
    await unmount();
  }
});

test("archived and child sessions on the worktree are included in cleanup deletes", async () => {
  fetchCalls.length = 0;
  removePayload = { ok: true };
  deleteFailures = new Set();
  const { container, unmount } = await mount([
    session({ id: "s-arch", title: "Old", status: "archived" }),
    session({ id: "s-child", title: "Child", parentId: "s-ok" }),
  ]);
  try {
    await confirmRemove(container);
    const deleted = fetchCalls
      .filter((call) => call.method === "DELETE")
      .map((call) => decodeURIComponent(call.url.replace(/^\/api\/sessions\//, "")));
    assert.equal(new Set(deleted).size, 4);
    assert.ok(deleted.includes("s-arch"));
    assert.ok(deleted.includes("s-child"));
    assert.equal(document.querySelector("[role='dialog']"), null);
  } finally {
    await unmount();
  }
});

