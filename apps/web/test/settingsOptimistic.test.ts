// Non-sensitive settings toggles and list removals reflect at once; a
// rejection restores the previous state, reports, and is not resent.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  location: dom.location,
  history: dom.history,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => new Response("{}", { status: 404 });

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const store = await import("../src/store.ts");
const { resolveAlert } = await import("../src/alerts.ts");
const { BehaviorPage, McpPage } = await import("../src/components/settings/pages.tsx");

type Server = Awaited<ReturnType<typeof api.mcpList>>[number];

function deferred(): { promise: Promise<never>; reject: (error: Error) => void } {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_ok, fail) => { reject = fail; });
  return { promise, reject };
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await flush();
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const server = (id: string, name: string): Server => ({
  id, name, enabled: true, status: "ready", revision: 1,
  transport: { kind: "stdio", command: name, args: [], envKeys: [] },
} as unknown as Server);

test("an MCP server toggle and removal show at once and come back when the server refuses", async () => {
  const originals = { mcpList: api.mcpList, mcpUpdate: api.mcpUpdate, mcpRemove: api.mcpRemove };
  const list = [server("a", "alpha"), server("b", "beta")];
  const update = deferred();
  const remove = deferred();
  let updates = 0;
  let removes = 0;
  api.mcpList = (async () => list) as typeof api.mcpList;
  api.mcpUpdate = (() => { updates += 1; return update.promise; }) as typeof api.mcpUpdate;
  api.mcpRemove = (() => { removes += 1; return remove.promise; }) as typeof api.mcpRemove;
  const view = await mount(createElement(McpPage));
  const names = () => [...view.container.querySelectorAll(".mcp-server-title > span:first-child")].map((item) => item.textContent);
  try {
    assert.deepEqual(names(), ["alpha", "beta"]);
    const switchControl = () => view.container.querySelector<HTMLElement>('.mcp-server-row [role="switch"]')!;
    const isOn = () => switchControl().getAttribute("aria-checked") === "true";
    assert.equal(isOn(), true);
    await act(async () => { switchControl().click(); });
    assert.equal(isOn(), false, "the toggle flips before the server answers");
    await act(async () => { update.reject(new Error("toggle refused")); });
    await flush();
    assert.equal(updates, 1);
    assert.equal(isOn(), true);
    assert.match(store.getState().uiError ?? "", /toggle refused/);

    const removeButton = [...view.container.querySelectorAll<HTMLButtonElement>(".mcp-server-row button")]
      .find((item) => /remove/i.test(item.getAttribute("aria-label") ?? "") && item.getAttribute("aria-label")?.includes("alpha"))!;
    await act(async () => { removeButton.click(); });
    await act(async () => { resolveAlert(true); });
    await flush();
    assert.deepEqual(names(), ["beta"], "the row leaves at once");
    await act(async () => { remove.reject(new Error("remove refused")); });
    await flush();
    assert.equal(removes, 1);
    assert.deepEqual(names(), ["alpha", "beta"], "the row returns to its place");
  } finally {
    await view.unmount();
    Object.assign(api, originals);
  }
});

test("a behavior policy toggle flips at once and restores its value when the server refuses", async () => {
  const originals = {
    subagentPolicyGet: api.subagentPolicyGet,
    subagentPolicyPut: api.subagentPolicyPut,
    workspaceInstructionsPolicyGet: api.workspaceInstructionsPolicyGet,
    behaviorGet: api.behaviorGet,
  };
  const put = deferred();
  let puts = 0;
  api.subagentPolicyGet = (async () => ({ enabled: true })) as unknown as typeof api.subagentPolicyGet;
  api.workspaceInstructionsPolicyGet = (async () => ({ enabled: false })) as unknown as typeof api.workspaceInstructionsPolicyGet;
  api.behaviorGet = (async () => ({ text: "", revision: "1", pathLabel: "AGENTS.md" })) as unknown as typeof api.behaviorGet;
  api.subagentPolicyPut = (() => { puts += 1; return put.promise; }) as typeof api.subagentPolicyPut;
  const view = await mount(createElement(BehaviorPage));
  const row = () => view.container.querySelector('[data-settings-item="behavior.favoriteSubagents"]')!;
  const control = () => row().querySelector<HTMLElement>('[role="switch"]')!;
  const isOn = () => control().getAttribute("aria-checked") === "true";
  try {
    assert.equal(isOn(), true);
    await act(async () => { control().click(); });
    assert.equal(isOn(), false, "the toggle flips before the server answers");
    await act(async () => { put.reject(new Error("policy refused")); });
    await flush();
    assert.equal(puts, 1);
    assert.equal(isOn(), true);
    assert.match(store.getState().uiError ?? "", /policy refused/);
  } finally {
    await view.unmount();
    Object.assign(api, originals);
  }
});
