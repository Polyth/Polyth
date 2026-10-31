import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { WebPackageHost } from "@polyth/web-sdk";

// Docker's surface/capability lifecycle and preview render are Docker-owned
// halves of the terminal project-tool contract; the terminal host test keeps
// only the shared dialog behaviour.
const dom = new Window({ url: "http://test/" });
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);
let fetcher: typeof fetch;
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => fetcher(...args);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: dockerEntry } = await import("../widgets/index.tsx");
const { default: DockerView } = await import("../widgets/DockerView.tsx");
test.after(() => { globalThis.fetch = originalFetch; });

function host() {
  const opened: string[] = [];
  return { opened, value: {
    ui: { icons: {}, components: { Button: ({ children, onClick, disabled, busy }: { children: unknown; onClick(): void; disabled?: boolean; busy?: boolean }) => createElement("button", { onClick, disabled: disabled || busy }, children as never) }, Dialog: ({ title, children }: { title: string; children: unknown }) => createElement("div", { role: "dialog" }, title, children as never) },
    navigation: { openWorkspacePane: (id: string) => { opened.push(id); } },
    errors: { friendly: (label: string) => `${label} failed.` },
  } as unknown as WebPackageHost };
}

test("Docker entry removes all registrations on disable and can re-enable", () => {
  const registered = new Set<string>();
  const h = host();
  const registration = (kind: string) => (definition: { id: string }) => {
    const id = `${kind}:${definition.id}`;
    assert.equal(registered.has(id), false);
    registered.add(id);
    return () => { registered.delete(id); };
  };
  h.value.surfaces = { register: registration("surface") };
  h.value.capabilities = { register: registration("capability"), notify: () => {} };
  const install = dockerEntry(h.value);
  const dispose = install();
  assert.equal(registered.size, 2);
  dispose();
  assert.equal(registered.size, 0);
  install()();
  assert.equal(registered.size, 0);
});

test("Docker preview shows an unknown environment instead of invented zero counters", async () => {
  const h = host();
  h.value.store = { subscribe: () => () => {}, getSnapshot: () => ({ activeProjectId: null, activeSessionId: null }) } as never;
  h.value.ui.components = { ...h.value.ui.components,
    Select: ({ value }: { value: string }) => createElement("button", null, value),
    EmptyState: ({ title, description }: { title: string; description: string }) => createElement("div", null, title, description),
  } as never;
  fetcher = async () => Response.json({ scope: { projectId: "p1", sessionId: null, repositoryId: "r1", root: "/repo", alias: "Demo", repositories: [{ id: "r1", alias: "Demo", available: true }] }, cli: { available: false, reason: "read-only-preview", message: "CLI inspection is disabled in this read-only preview." }, compose: { available: false }, composeFiles: ["compose.yaml"], dockerfiles: [], selectedCompose: "compose.yaml", services: [], containers: [], truncated: false });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(DockerView, { host: h.value, projectId: "p1", sessionId: null })));
    assert.match(container.textContent!, /Project environment/);
    assert.equal(container.textContent!.includes("0 running"), false);
    assert.equal(container.textContent!.includes("Install Docker"), false);
    assert.equal([...container.querySelectorAll("button")].find((button) => button.textContent === "Start")?.disabled, true);
  } finally { await act(async () => root.unmount()); }
});
