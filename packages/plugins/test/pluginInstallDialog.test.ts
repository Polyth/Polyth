import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window, type HTMLButtonElement, type HTMLInputElement } from "happy-dom";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

test("a failed repository install preserves its source and blocks submissions while pending", async () => {
  const dom = new Window();
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { PluginInstallDialog } = await import("../widgets/PluginInstallDialog.tsx");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  let rejectInstall: (cause: Error) => void = () => {};
  let calls = 0;
  const source = "https://github.com/example-org/polyth-homeassistant";
  try {
    await act(async () => {
      root.render(createElement(PluginInstallDialog, {
        onClose: () => {},
        onInstallSource: async (value: string) => {
          assert.equal(value, source);
          calls++;
          if (calls === 1) await new Promise<void>((_resolve, reject) => { rejectInstall = reject; });
        },
        onInstallArchive: async () => { throw new Error("unexpected ZIP submission"); },
      }));
    });
    const doc = dom.document;
    const linkTab = [...doc.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "From a link")!;
    await act(async () => { (linkTab as unknown as HTMLButtonElement).click(); });
    const input = doc.querySelector<HTMLInputElement>(".plugin-install-link input")!;
    const install = () => [...doc.querySelectorAll<HTMLButtonElement>(".ui-dialog-foot button")].at(-1)!;
    assert.equal(install().disabled, true, "Install waits for a supported source");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, source);
      input.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    assert.match(doc.querySelector(".plugin-install-resolved")!.textContent!, /GitHub CLI.*SSH/);
    assert.match(install().textContent!, /Install from repository/);
    await act(async () => { install().click(); });
    assert.equal(input.disabled, true);
    assert.equal(install().disabled, true);
    await act(async () => { install().click(); });
    assert.equal(calls, 1);
    await act(async () => { rejectInstall(new Error("Repository archive not found (HTTP 404)")); });
    assert.equal(input.value, source);
    assert.equal(input.disabled, false);
    assert.match(doc.querySelector('[role="alert"]')!.textContent!, /HTTP 404/);
    await act(async () => { install().click(); });
    assert.equal(calls, 2);
    assert.equal(input.value, "");
    assert.equal(doc.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => { root.unmount(); });
    await dom.happyDOM.close();
  }
});

test("PluginInstallDialog does not install on composing Enter", async () => {
  const dom = new Window();
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { PluginInstallDialog } = await import("../widgets/PluginInstallDialog.tsx");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  let calls = 0;
  const source = "https://github.com/example-org/polyth-homeassistant";
  try {
    await act(async () => {
      root.render(createElement(PluginInstallDialog, {
        onClose: () => {},
        onInstallSource: async () => { calls++; },
        onInstallArchive: async () => {},
      }));
    });
    const doc = dom.document;
    const linkTab = [...doc.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "From a link")!;
    await act(async () => { (linkTab as unknown as HTMLButtonElement).click(); });
    const input = doc.querySelector<HTMLInputElement>(".plugin-install-link input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, source);
      input.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });

    // 1. Enter with isComposing: true does not install
    await act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
    });
    assert.equal(calls, 0, "composing Enter must not trigger install");

    // 2. Enter with keyCode: 229 does not install
    await act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, keyCode: 229 }));
    });
    assert.equal(calls, 0, "keyCode 229 Enter must not trigger install");

    // 3. Normal Enter installs
    await act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    assert.equal(calls, 1, "normal Enter triggers install");
  } finally {
    await act(async () => { root.unmount(); });
    await dom.happyDOM.close();
  }
});

