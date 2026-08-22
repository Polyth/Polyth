import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildUiBundle, createPluginRegistry } from "../src/index.ts";

const fixtureDir = resolve(import.meta.dirname, "fixtures/test-ui-plugin");

const copyFixture = (): { root: string; installDir: string } => {
  const root = mkdtempSync(join(tmpdir(), "polyth-ui-bundle-"));
  const installDir = join(root, "plugin");
  cpSync(fixtureDir, installDir, { recursive: true });
  return { root, installDir };
};

test("buildUiBundle emits a content-addressed ESM bundle with React external", async () => {
  const { installDir } = copyFixture();
  const outDir = join(installDir, ".polyth", "ui");
  const result = await buildUiBundle({
    installDir,
    entryPath: "./ui.tsx",
    outDir,
  });

  assert.equal(basename(result.file), `ui-${result.integrity}.mjs`);
  assert.match(result.integrity, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(result.file), true);
  const source = readFileSync(result.file, "utf8");
  assert.match(source, /from\s+"react\/jsx-runtime"/);
  assert.doesNotMatch(source, /react\.production\.js/);
});

test("buildUiBundle rejects lexical and symlink escapes", async () => {
  const { root, installDir } = copyFixture();
  const outside = join(root, "outside.tsx");
  writeFileSync(outside, "export const modules = {};\n");

  await assert.rejects(
    () => buildUiBundle({
      installDir,
      entryPath: "../outside.tsx",
      outDir: join(installDir, ".polyth", "ui"),
    }),
    /escapes the plugin install directory/,
  );

  symlinkSync(outside, join(installDir, "linked.tsx"));
  await assert.rejects(
    () => buildUiBundle({
      installDir,
      entryPath: "./linked.tsx",
      outDir: join(installDir, ".polyth", "ui"),
    }),
    /escapes the plugin install directory/,
  );
});

test("managed install and reload publish only browser-safe UI metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-ui-registry-"));
  const trusted = join(root, "trusted");
  const installed = join(root, "installed");
  mkdirSync(trusted);
  cpSync(fixtureDir, join(trusted, "test-ui-plugin"), { recursive: true });
  const registry = createPluginRegistry({ dir: installed, trustedDir: trusted });

  const first = await registry.install("file:test-ui-plugin");
  assert.ok(first.ui);
  assert.equal(
    first.ui.url,
    `/api/plugins/test.ui-plugin/ui/${first.ui.integrity}.mjs`,
  );
  assert.equal("file" in first.ui, false, "DTO must not expose an install path");
  const uiDir = join(installed, "test.ui-plugin", ".polyth", "ui");
  assert.deepEqual(readdirSync(uiDir), [`ui-${first.ui.integrity}.mjs`]);

  writeFileSync(
    join(installed, "test.ui-plugin", "ui.tsx"),
    'export const modules = { "test-ui-widget": () => "reloaded" };\n',
  );
  const reloaded = await registry.reload("test.ui-plugin");
  assert.ok(reloaded.ui);
  assert.notEqual(reloaded.ui.integrity, first.ui.integrity);
  assert.deepEqual(readdirSync(uiDir), [`ui-${reloaded.ui.integrity}.mjs`]);
  await registry.dispose();
});
