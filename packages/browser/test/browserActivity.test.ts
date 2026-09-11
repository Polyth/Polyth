import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.defineProperty(globalThis, "window", { value: dom, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.document, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: BrowserActivity } = await import("../widgets/BrowserActivity.tsx");
const visibility = await import("../widgets/browserVisibility.ts");

test("browser visibility defaults to background and persists the selected mode", () => {
  localStorage.clear();
  visibility.setBrowserVisibility("background");
  assert.equal(visibility.getBrowserVisibility(), "background");
  visibility.setBrowserVisibility("auto-show");
  assert.equal(localStorage.getItem("polyth.browser.visibility.v1"), "auto-show");
  assert.equal(visibility.getBrowserVisibility(), "auto-show");
  visibility.setBrowserVisibility("background");
});

test("browser activity renders the exact active session and opens its existing surface", async () => {
  const opened: string[] = [];
  const session = {
    activeProjectId: "project-a",
    activeSessionId: "session-a",
  };
  const host = {
    store: {
      getSnapshot: () => session,
      subscribe: () => () => {},
    },
    sessions: { subscribeEvents: () => () => {} },
    navigation: { openWorkspacePane: (id: string) => { opened.push(id); } },
    ui: {
      components: { Button: (props: Record<string, unknown>) => createElement("button", props, props.children as never) },
      icons: { globe: () => createElement("span", { "aria-hidden": "true" }) },
      locale: { translate: (key: string) => key === "previewview.browser" ? "Browser" : key },
    },
  } as never;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify([{
    id: "browser-other",
    projectId: "project-a",
    sessionId: "session-other",
    status: "open",
    url: "https://other.test/",
    title: "Other",
    viewport: { width: 1000, height: 700 },
    revision: 2,
  }, {
    id: "browser-a",
    projectId: "project-a",
    sessionId: "session-a",
    status: "open",
    url: "https://example.test/path",
    title: "Example",
    viewport: { width: 1000, height: 700 },
    revision: 4,
  }]), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(BrowserActivity, { host }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = container.querySelector("button");
    assert.ok(button);
    assert.match(button.textContent ?? "", /Browser.*example\.test.*Idle/);
    await act(async () => { button!.click(); });
    assert.deepEqual(opened, ["browser"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});

test("browser activity fences session races, ignores token noise, and clears denied pending work", async () => {
  const session = { activeProjectId: "project-a", activeSessionId: "session-a" };
  let storeChanged = () => {};
  let emitEvent = (_event: unknown) => {};
  const responses: Array<(response: Response) => void> = [];
  let calls = 0;
  const host = {
    store: {
      getSnapshot: () => session,
      subscribe: (listener: () => void) => { storeChanged = listener; return () => {}; },
    },
    sessions: { subscribeEvents: (listener: (event: unknown) => void) => { emitEvent = listener; return () => {}; } },
    navigation: { openWorkspacePane: () => {} },
    ui: {
      components: { Button: (props: Record<string, unknown>) => createElement("button", props, props.children as never) },
      icons: { globe: () => createElement("span", { "aria-hidden": "true" }) },
      locale: { translate: (key: string) => key === "previewview.browser" ? "Browser" : key },
    },
  } as never;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return await new Promise<Response>((resolve) => responses.push(resolve));
  }) as typeof fetch;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(BrowserActivity, { host })));
    assert.equal(calls, 1);
    session.activeSessionId = "session-b";
    await act(async () => { storeChanged(); });
    await act(async () => responses.shift()!(new Response(JSON.stringify([{
      id: "browser-a", projectId: "project-a", sessionId: "session-a", status: "open",
      url: "https://stale.test/", title: "Stale", viewport: { width: 800, height: 600 }, revision: 1,
    }]), { status: 200, headers: { "content-type": "application/json" } })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(calls, 2);
    assert.equal(container.querySelector("button"), null);
    await act(async () => responses.shift()!(new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const afterSessionSwitch = calls;
    await act(async () => emitEvent({ id: "token", sessionId: "session-b", seq: 3, time: 1, type: "assistant/chunk", data: {}, v: 1 }));
    assert.equal(calls, afterSessionSwitch);

    await act(async () => emitEvent({ id: "request", sessionId: "session-b", seq: 4, time: 1, type: "package-tool/requested", data: { toolId: "browser.polyth-browser", owner: "browser" }, v: 1 }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(container.querySelector("button"));
    await act(async () => emitEvent({ id: "expired", sessionId: "session-b", seq: 5, time: 1, type: "permission/expired", data: {}, v: 1 }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(container.querySelector("button"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});
