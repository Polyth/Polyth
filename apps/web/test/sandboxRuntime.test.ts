import { register } from "node:module";
register("./tsxHooks.mjs", import.meta.url);

import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { InstalledPluginDto } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
});

const { acquireSandboxRuntime, disposePackageRuntimes, sandboxHandshakeCapabilityList } = await import(
  "../src/packages/sandbox/runtime.ts"
);

function plugin(over: Partial<InstalledPluginDto> = {}): InstalledPluginDto {
  return {
    id: "com-example-demo",
    name: "Demo",
    version: "1.0.0",
    source: "https://example.com/demo.zip",
    trust: "ui-only",
    enabled: true,
    status: "ready",
    contributions: [{
      slot: "workspace.right.tabs",
      id: "com-example-demo.surface.main",
      module: "sandbox-surface:main",
    }],
    widgets: [],
    runtimeKind: "sandboxed",
    permissions: {
      requested: [{ name: "ui.render" }],
      effective: ["ui.render"],
    },
    sandbox: {
      url: "/api/plugins/com-example-demo/sandbox/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/entry.js",
      integrity: "a".repeat(64),
    },
    ...over,
  };
}

test("sandbox handshake capabilities come from effective active grants only", () => {
  const dto = plugin({
    permissions: {
      requested: [{ name: "ui.render" }],
      effective: ["ui.render"],
      review: { capabilities: [{ name: "clipboard.write" }], connections: [] },
    },
  });
  assert.deepEqual(sandboxHandshakeCapabilityList(dto), ["ui.render"]);
  assert.equal(sandboxHandshakeCapabilityList(dto).includes("clipboard.write"), false);
});

test("force dispose tears down a shared runtime regardless of refcount", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("export {}", { status: 200 })) as typeof fetch;
  try {
    const dto = plugin();
    const first = await acquireSandboxRuntime(dto, "main");
    const second = await acquireSandboxRuntime(dto, "main");
    assert.equal(first.instanceId, second.instanceId);
    assert.equal(document.querySelectorAll("iframe.polyth-sandbox-frame").length, 1);
    disposePackageRuntimes(dto.id);
    assert.equal(document.querySelectorAll("iframe.polyth-sandbox-frame").length, 0);
    assert.doesNotThrow(() => first.dispose());
    assert.doesNotThrow(() => second.dispose());
    assert.equal(document.querySelectorAll("iframe.polyth-sandbox-frame").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
