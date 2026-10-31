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

const { acquireSandboxRuntime, clearSandboxToasts, disposePackageRuntimes, raiseSandboxToast, sandboxHandshakeCapabilityList, SANDBOX_TOASTS_LIVE } = await import(
  "../src/packages/sandbox/runtime.ts"
);
const { getNotifications, resetNotifications } = await import("../src/notify/store.ts");

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

test("ui.toast becomes a plain-text notification in the sandbox's id space, bounded and cleared on dispose", () => {
  resetNotifications();
  const toasts = { live: new Set<string>(), count: 0 };
  try {
    assert.equal(raiseSandboxToast(toasts, "com-example-demo", { kind: "success", message: "  Saved  " }), "sandbox.com-example-demo.1");
    const [first] = getNotifications().items;
    assert.equal(first?.kind, "success");
    assert.equal(first?.title, "Saved");
    assert.equal(first?.body, undefined, "no markup, no body");
    assert.equal(first?.actions, undefined);

    raiseSandboxToast(toasts, "com-example-demo", { kind: "<b>", message: "x".repeat(500) });
    const second = getNotifications().items.at(-1)!;
    assert.equal(second.kind, "info", "an unknown kind is info");
    assert.equal(second.title.length, 240, "long text is cut");
    assert.equal(raiseSandboxToast(toasts, "com-example-demo", { message: 42 }), null);
    assert.equal(raiseSandboxToast(toasts, "com-example-demo", null), null);

    for (let at = 0; at < 4; at++) raiseSandboxToast(toasts, "com-example-demo", { kind: "error", message: `E${at}` });
    assert.equal(toasts.live.size, SANDBOX_TOASTS_LIVE);
    assert.equal(getNotifications().items.length, SANDBOX_TOASTS_LIVE, "the oldest of the sandbox's toasts makes room");

    clearSandboxToasts(toasts);
    assert.equal(getNotifications().items.length, 0);
    assert.equal(toasts.live.size, 0);
  } finally {
    resetNotifications();
  }
});
