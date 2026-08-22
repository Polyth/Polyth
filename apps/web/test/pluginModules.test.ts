import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadPluginModule,
  resolveModule,
  unloadPluginModule,
} from "../src/pluginModules.ts";

const moduleUrl = (source: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-plugin-module-"));
  const file = join(dir, "ui.mjs");
  writeFileSync(file, source);
  return pathToFileURL(file).href;
};

test("plugin modules load, resolve by key, and unload", async () => {
  const url = moduleUrl(`
    const Widget = (props) => "widget:" + String(props.value);
    export const modules = { widget: Widget };
  `);

  const loaded = await loadPluginModule("test.modules", url, "abc123");
  assert.equal(
    (loaded.modules.widget as (props: Record<string, unknown>) => unknown)({ value: 4 }),
    "widget:4",
  );
  assert.equal(resolveModule("test.modules", "widget"), loaded.modules.widget);
  assert.equal(resolveModule("test.modules", "missing"), null);

  unloadPluginModule("test.modules");
  assert.equal(resolveModule("test.modules", "widget"), null);
});

test("plugin module export contract is validated", async () => {
  await assert.rejects(
    () => loadPluginModule(
      "test.invalid-modules",
      moduleUrl("export const modules = { broken: 42 };"),
      "bad",
    ),
    /must export a modules component map/,
  );
  assert.equal(resolveModule("test.invalid-modules", "broken"), null);
});

test("unload wins when a slow dynamic import completes later", async () => {
  const loading = loadPluginModule(
    "test.slow-modules",
    moduleUrl(`
      await new Promise((resolve) => setTimeout(resolve, 25));
      export const modules = { widget: () => "late" };
    `),
    "slow",
  );
  unloadPluginModule("test.slow-modules");
  await loading;
  assert.equal(resolveModule("test.slow-modules", "widget"), null);
});
