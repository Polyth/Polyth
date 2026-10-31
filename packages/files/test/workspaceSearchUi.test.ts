import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { register } from "node:module";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  localStorage: dom.localStorage,
  location: dom.location,
  getComputedStyle: (element: Element) => dom.getComputedStyle(
    element as unknown as Parameters<Window["getComputedStyle"]>[0],
  ),
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const { applyProjectUpsert, activateProject, getState, setSessions } = await import("../../../apps/web/src/store.ts");
const { default: WorkspaceSearch } = await import("../widgets/WorkspaceSearch.tsx");

const project = {
  id: "workspace-search-ui",
  name: "Search UI",
  path: "/repo/first",
  createdAt: Date.now(),
  repositories: [
    { id: "first", alias: "first", path: "/repo/first" },
    { id: "second", alias: "second", path: "/repo/second" },
  ],
  primaryRepositoryId: "first",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function sessionProjection(id: string) {
  return {
    id,
    projectId: project.id,
    title: id,
    status: "idle",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as const;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
}

async function mount(sessionId: string | null = null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(WorkspaceSearch, { projectId: project.id, sessionId })); });
  return {
    container,
    rerender: async (sessionId: string | null) => act(async () => {
      root.render(createElement(WorkspaceSearch, { projectId: project.id, sessionId }));
    }),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("workspace search shows loading, preserves per-repository errors, and fences stale replies", async () => {
  applyProjectUpsert(project);
  activateProject(project.id);
  const original = api.filesSearchContent;
  type SearchResult = Awaited<ReturnType<typeof original>>;
  const pending = new Map<string, ReturnType<typeof deferred<SearchResult>>>();
  api.filesSearchContent = async (_projectId, q, _limit, _sessionId, repositoryId) => {
    const wait = deferred<SearchResult>();
    pending.set(`${q}:${repositoryId}`, wait);
    return wait.promise;
  };
  const view = await mount();
  try {
    const input = view.container.querySelector<HTMLInputElement>(".ui-input");
    assert.ok(input);
    await act(async () => { setInputValue(input!, "old"); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 210)); });
    assert.match(view.container.textContent ?? "", /Searching/);

    await act(async () => { setInputValue(input!, "new"); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 210)); });
    pending.get("new:first")!.resolve({ hits: [{ path: "src/new.ts", line: 4, column: 2, preview: "needle" }], truncated: false });
    pending.get("new:second")!.reject(new Error("second repository unavailable"));
    await settle();
    assert.match(view.container.textContent ?? "", /src\/new\.ts/);
    assert.match(view.container.textContent ?? "", /second repository unavailable/);
    assert.doesNotMatch(view.container.textContent ?? "", /old/);
  } finally {
    api.filesSearchContent = original;
    await view.unmount();
  }
});

test("workspace search opens a result at its repository location and pins on double click or Cmd/Ctrl click", async () => {
  applyProjectUpsert(project);
  activateProject(project.id);
  const original = api.filesSearchContent;
  api.filesSearchContent = async (_projectId, _q, _limit, _sessionId, repositoryId) => ({
    hits: [{ path: `${repositoryId}/app.ts`, line: 7, column: 3, preview: "const needle = true;" }],
    truncated: false,
  });
  const view = await mount();
  try {
    const input = view.container.querySelector<HTMLInputElement>(".ui-input");
    assert.ok(input);
    await act(async () => { setInputValue(input!, "needle"); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    const result = view.container.querySelector<HTMLButtonElement>(".workspace-search-result");
    assert.ok(result);
    await act(async () => { result!.click(); });
    assert.equal(getState().editorOpenRequest?.repositoryId, "first");
    assert.equal(getState().editorOpenRequest?.preview, true);
    assert.equal(getState().editorLocation?.path, "first/app.ts");
    assert.equal(getState().editorLocation?.startLine, 7);
    assert.equal(getState().editorLocation?.column, 3);

    await act(async () => {
      result!.dispatchEvent(new dom.MouseEvent("dblclick", { bubbles: true }) as unknown as Event);
    });
    assert.equal(getState().editorOpenRequest?.preview, false);

    await act(async () => {
      result!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, ctrlKey: true }) as unknown as Event);
    });
    assert.equal(getState().editorOpenRequest?.preview, false);
    assert.equal(getState().editorOpenRequest?.repositoryId, "first");
  } finally {
    api.filesSearchContent = original;
    await view.unmount();
  }
});

test("workspace search fences a pending session response after a session switch", async () => {
  applyProjectUpsert(project);
  activateProject(project.id);
  setSessions(project.id, [sessionProjection("s1"), sessionProjection("s2")]);
  const original = api.filesSearchContent;
  const first = deferred<Awaited<ReturnType<typeof original>>>();
  api.filesSearchContent = async (_projectId, _q, _limit, sessionId) => sessionId === "s1"
    ? first.promise
    : { hits: [{ path: "new-session.ts", line: 1, column: 1, preview: "new" }], truncated: false };
  const view = await mount("s1");
  try {
    const input = view.container.querySelector<HTMLInputElement>(".ui-input")!;
    await act(async () => { setInputValue(input, "needle"); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 210)); });
    await view.rerender("s2");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 210)); });
    await settle();
    assert.match(view.container.textContent ?? "", /new-session\.ts/);
    first.resolve({ hits: [{ path: "stale.ts", line: 1, column: 1, preview: "stale" }], truncated: false });
    await settle();
    assert.doesNotMatch(view.container.textContent ?? "", /stale\.ts/);
  } finally {
    api.filesSearchContent = original;
    await view.unmount();
  }
});

test("workspace search does not fall back to project repositories while a session is loading", async () => {
  applyProjectUpsert(project);
  activateProject(project.id);
  const original = api.filesSearchContent;
  let calls = 0;
  api.filesSearchContent = async () => {
    calls++;
    return { hits: [], truncated: false };
  };
  const view = await mount();
  try {
    const input = view.container.querySelector<HTMLInputElement>(".ui-input")!;
    await act(async () => { setInputValue(input, "needle"); });
    await view.rerender("session-not-loaded");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.equal(calls, 0);
    assert.match(view.container.textContent ?? "", /Loading workspace/);
  } finally {
    api.filesSearchContent = original;
    await view.unmount();
  }
});

test("workspace search keeps a missing projected repository visible as unavailable", async () => {
  applyProjectUpsert(project);
  activateProject(project.id);
  setSessions(project.id, [{
    ...sessionProjection("s-missing"),
    workspace: {
      repositories: [
        { repositoryId: "first", path: "/repo/first", state: "ready" },
        { repositoryId: "second", path: "/repo/second", state: "missing" },
      ],
    },
  }]);
  const original = api.filesSearchContent;
  api.filesSearchContent = async (_projectId, _q, _limit, _sessionId, repositoryId) => repositoryId === "second"
    ? Promise.reject(new Error("repository checkout is missing"))
    : { hits: [], truncated: false };
  const view = await mount("s-missing");
  try {
    const input = view.container.querySelector<HTMLInputElement>(".ui-input")!;
    await act(async () => { setInputValue(input, "needle"); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.match(view.container.textContent ?? "", /second/);
    assert.match(view.container.textContent ?? "", /repository checkout is missing/);
  } finally {
    api.filesSearchContent = original;
    await view.unmount();
  }
});

test("workspace search labels a bounded empty result instead of claiming no matches", async () => {
  applyProjectUpsert(project);
  activateProject(project.id);
  const original = api.filesSearchContent;
  api.filesSearchContent = async () => ({ hits: [], truncated: true });
  const view = await mount();
  try {
    const input = view.container.querySelector<HTMLInputElement>(".ui-input")!;
    await act(async () => { setInputValue(input, "needle"); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    assert.match(view.container.textContent ?? "", /Search was limited; narrow your query/);
    assert.doesNotMatch(view.container.textContent ?? "", /No matching content/);
  } finally {
    api.filesSearchContent = original;
    await view.unmount();
  }
});
