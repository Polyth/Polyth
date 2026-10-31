// Inline-AI settings save without blocking the fields, and a rejected save
// keeps the typed prompt as unsaved instead of discarding it.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => new Response("{}", { status: 404 });

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const { default: FilesSettings } = await import("../widgets/FilesSettings.tsx");

const typeInto = (control: HTMLTextAreaElement, value: string): void => {
  Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
};

test("saving shows Saved at once, keeps the fields editable and keeps the text when the server refuses", async () => {
  const originals = { get: api.filesInlineAiSettingsGet, put: api.filesInlineAiSettingsPut };
  const sent: unknown[] = [];
  let refuse!: (error: Error) => void;
  api.filesInlineAiSettingsGet = async () => ({ explainPrompt: "Explain {code}", fixPrompt: "Fix {code}" });
  api.filesInlineAiSettingsPut = ((settings: unknown) => {
    sent.push(settings);
    return new Promise((_resolve, reject) => { refuse = reject; });
  }) as typeof api.filesInlineAiSettingsPut;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const status = () => container.querySelector(".files-settings-status")?.textContent;
  try {
    await act(async () => { root.render(createElement(FilesSettings)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const explain = container.querySelector<HTMLTextAreaElement>("#files-settings-explain")!;
    await act(async () => { typeInto(explain, "Explain {code} briefly"); });
    const save = [...container.querySelectorAll("button")].find((item) => item.textContent === "Save")!;
    await act(async () => { save.click(); });
    assert.equal(status(), "Saved", "saved before the server answers");
    assert.equal(explain.disabled, false, "the field stays editable");

    await act(async () => { refuse(new Error("disk full")); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(sent.length, 1, "sent once");
    assert.equal(explain.value, "Explain {code} briefly", "the typed prompt is kept");
    assert.equal(status(), "Unsaved changes");
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /disk full/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    api.filesInlineAiSettingsGet = originals.get;
    api.filesInlineAiSettingsPut = originals.put;
  }
});
