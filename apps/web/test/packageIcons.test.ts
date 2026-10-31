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

    await paint("pi");
    assert.ok(container.querySelector('.provider-logo[data-provider="pi"] svg'), "Pi harness resolves its own mark");

    // Semantic package icons keep the neutral Lucide glyph, not a brand mark.
    await paint("files");
    assert.equal(container.querySelector(".provider-logo"), null);
    assert.ok(container.querySelector("svg"), "semantic package icons still render a glyph");
  } finally {
    await act(async () => { root.unmount(); });
    await dom.happyDOM.close();
  }
});

// Every in-repo package manifest names an icon key the Settings/catalog glyph
// map knows (or a provider mark), so no package tile shows the generic box.
test("package manifest icon keys never fall back to the generic package glyph", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const dom = new Window();
  Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { PackageGlyph } = await import("../src/components/settings/packageIcons.tsx");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  const paint = async (icon: string) => {
    await act(async () => { root.render(createElement(PackageGlyph, { icon })); });
    return container.innerHTML;
  };
  try {
    const generic = await paint("package");
    const packagesDir = new URL("../../../packages/", import.meta.url);
    for (const name of await readdir(packagesDir)) {
      let manifest: { polyth?: { descriptor?: { icon?: unknown } } };
      try {
        manifest = JSON.parse(await readFile(new URL(`${name}/package.json`, packagesDir), "utf8"));
      } catch { continue; }
      const icon = manifest.polyth?.descriptor?.icon;
      if (typeof icon !== "string") continue;
      assert.notEqual(await paint(icon), generic, `${name} icon "${icon}" resolves to a real glyph`);
    }
  } finally {
    await act(async () => { root.unmount(); });
    await dom.happyDOM.close();
  }
});
