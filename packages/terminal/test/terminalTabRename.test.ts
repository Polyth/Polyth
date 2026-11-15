// The terminal tab could only be renamed by double-click — impossible on a
// touch screen. Each tab now carries a rename button whose tap swaps the tab
// into an inline rename field. This mounts the real TerminalView over a
// pre-existing terminal and proves a plain tap opens the rename input.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { TerminalInfo } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(dom as unknown as { confirm: () => boolean }).confirm = () => true;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() { this.readyState = 3; this.onclose?.(); }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;

let listResponse: TerminalInfo[] = [];
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  const method = init?.method ?? "GET";
  const body =
    method === "POST" && String(url).endsWith("/api/terminals")
      ? { terminalId: "t-1" }
      : method === "GET" && String(url).includes("/api/terminals?")
        ? listResponse
        : { ok: true };
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateProject } = await import("../../../apps/web/src/store.ts");
const { PaneVisibilityContext } = await import("../../../apps/web/src/workspace/paneVisibility.ts");
const { default: TerminalView } = await import("../widgets/TerminalView.tsx");

test("tapping the active tab's rename button opens the inline rename field", async () => {
  listResponse = [
    { id: "t-1", title: "shell · 1", cwd: "/data/projects/polyth", projectId: "p-term", createdAt: 1, running: true },
    { id: "t-2", title: "shell · 2", cwd: "/data/projects/polyth", projectId: "p-term", createdAt: 2, running: true },
  ];
  activateProject("p-term");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(
        PaneVisibilityContext.Provider,
        { value: true },
        createElement(TerminalView, {}),
      ));
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    const renameButtons = container.querySelectorAll<HTMLButtonElement>(".term-tab-rename-btn");
    assert.equal(renameButtons.length, 1, "only the active tab carries a rename button");
    const renameBtn = renameButtons[0]!;
    assert.ok(renameBtn.closest(".term-tab-group.active"), "the rename button sits on the active tab");
    assert.ok((renameBtn.getAttribute("aria-label") ?? "").includes("shell · 1"),
      "the rename button names the tab it renames");

    // Before the tap the tab is a plain tab, no rename input.
    assert.equal(container.querySelector(".term-tab-rename"), null, "no rename input yet");

    await act(async () => renameBtn.click());
    await act(async () => { await Promise.resolve(); });

    const input = container.querySelector<HTMLInputElement>(".term-tab-rename");
    assert.ok(input !== null, "tapping the rename button opens the inline rename field");
    assert.equal(input.value, "shell · 1", "the field is prefilled with the tab's title");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
