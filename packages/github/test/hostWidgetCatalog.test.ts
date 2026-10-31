// Moved from apps/web/test/widgetCatalog.test.ts: the github package's own
// widget declarations and registration.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { GITHUB_WIDGETS } = await import("../src/index.ts");
const { installGithubPlugin, GITHUB_WIDGET_PLUGIN } = await import("../widgets/githubPlugin.tsx");
const { listWidgets } = await import("../../../apps/web/src/widgets/catalog.ts");

test("GitHub plugin owns its package-declared current PR widget", () => {
  const client = GITHUB_WIDGET_PLUGIN.widgets ?? [];
  assert.deepEqual(
    client.map(({ render: _render, settingsRender: _settingsRender, ...widget }) => widget),
    GITHUB_WIDGETS.map(({ module: _module, ...widget }) => widget),
  );
  installGithubPlugin();
  const widget = listWidgets().find((item) => item.id === "github.pr-summary");
  assert.equal(widget?.pluginId, "github");
  assert.equal(widget?.defaultSlot, "session.composer.before");
  assert.ok(widget?.supportedSlots?.includes("workspace.right"));
  assert.equal(typeof widget?.render, "function");
  assert.equal(typeof widget?.settingsRender, "function");
  assert.ok(widget?.settingsSchema);
});
