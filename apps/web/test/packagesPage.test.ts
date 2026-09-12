import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

test("package search matches names and descriptions without changing enabled state", async () => {
  const dom = new Window();
  Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.ok(!init?.method || init.method === "GET", "search is local and must not mutate packages");
    return new Response(JSON.stringify({ packages: [
      { id: "git", name: "Git", description: "Source control", core: false, enabled: true },
      { id: "dictation", name: "Voice & Dictation", description: "Speech input", core: false, enabled: false },
      { id: "files", name: "Files", description: "Workspace files", core: true, enabled: true },
    ] }));
  };
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: PackagesPage } = await import("../src/components/settings/PackagesPage.tsx");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  try {
    await act(async () => { root.render(createElement(PackagesPage)); });
    assert.equal(container.querySelectorAll(".package-tile").length, 3);
    const input = container.querySelector("input[type=search]")!;
    const search = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await search("speech");
    assert.equal(container.querySelectorAll(".package-tile").length, 1);
    assert.match(container.querySelector(".package-copy")!.textContent, /Voice/);
    assert.equal(container.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "false");
    await search("no-such-package");
    assert.equal(container.querySelectorAll(".package-tile").length, 0);
    assert.match(container.textContent, /No matches/);
    await search("");
    assert.equal(container.querySelectorAll(".package-tile").length, 3);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
  }
});
