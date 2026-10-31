import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { api } from "@polyth/session/web-api";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { default: PlaygroundView } = await import("../widgets/PlaygroundView.tsx");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("preview ignores a late A response after A→B→A and resets network consent", async () => {
  const dom = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  const originalStat = api.filesStatOptional;
  const originalUrl = api.filesRawUrl;
  const originalFetch = globalThis.fetch;
  const pending: Array<(value: Response) => void> = [];
  api.filesStatOptional = async () => ({ revision: "current" }) as never;
  api.filesRawUrl = (_project, _path, session) => `http://localhost/${session}`;
  globalThis.fetch = () => new Promise<Response>((resolve) => pending.push(resolve));
  const snapshot = { activeProjectId: "p", activeSessionId: A };
  const host = {
    store: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    sessions: { get: () => ({ status: "idle" }) },
    workbench: { getSnapshot: () => ({ activeProfile: "playground" }) },
    errors: { friendly: (message: string) => message },
    ui: { components: {
      Button: ({ children, busy: _busy, variant: _variant, ...props }: Record<string, unknown>) => createElement("button", props, children as never),
      EmptyState: ({ title }: { title: string }) => createElement("div", null, title),
    } },
  };
  const mount = dom.document.createElement("div");
  dom.document.body.append(mount);
  const root = createRoot(mount as unknown as Element);
  const render = async (sessionId: string) => {
    await act(async () => {
      root.render(createElement(PlaygroundView, { host: host as never, projectId: "p", sessionId, active: true }));
    });
  };
  try {
    await render(A);
    assert.equal(pending.length, 1);
    await render(B);
    await render(A);
    assert.equal(pending.length, 3);
    await act(async () => { pending[2]!(new Response("<h1>new A</h1>")); });
    assert.match(mount.querySelector("iframe")!.getAttribute("srcdoc")!, /new A/);
    await act(async () => {
      pending[0]!(new Response("<h1>stale A</h1>"));
      pending[1]!(new Response("<h1>stale B</h1>"));
    });
    assert.doesNotMatch(mount.querySelector("iframe")!.getAttribute("srcdoc")!, /stale/);
    const network = [...mount.querySelectorAll("button")].find((button) => button.textContent?.includes("Network"))!;
    await act(async () => { network.click(); });
    assert.equal(network.getAttribute("aria-pressed"), "true");
    await render(B);
    assert.equal(network.getAttribute("aria-pressed"), "false");
  } finally {
    await act(async () => { root.unmount(); });
    api.filesStatOptional = originalStat;
    api.filesRawUrl = originalUrl;
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
  }
});
