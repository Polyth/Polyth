import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

// Harness packages declare a canonical provider mark key so their Settings →
// Packages tile matches the harness picker instead of showing a generic glyph.
test("harness package icons render the shared provider brand mark", async () => {
  const dom = new Window();
  Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { PackageGlyph } = await import("../src/components/settings/packageIcons.tsx");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  const paint = async (icon: string | undefined) => act(async () => {
    root.render(createElement(PackageGlyph, { icon }));
  });
  try {
    await paint("cursor");
    assert.ok(container.querySelector('.provider-logo[data-provider="cursor"] svg'), "Cursor harness uses the Cursor mark");

    await paint("antigravity");
    assert.ok(container.querySelector('.provider-logo[data-provider="antigravity"] svg'), "Antigravity harness resolves its own mark");

    // Semantic package icons keep the neutral Lucide glyph, not a brand mark.
    await paint("files");
    assert.equal(container.querySelector(".provider-logo"), null);
    assert.ok(container.querySelector("svg"), "semantic package icons still render a glyph");
  } finally {
    await act(async () => { root.unmount(); });
    await dom.happyDOM.close();
  }
});
