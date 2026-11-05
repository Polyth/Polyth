import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildUiBundle } from "../src/uiBundle.ts";
import { createPluginRegistry } from "../src/index.ts";

const fixtureDir = resolve(import.meta.dirname, "fixtures/test-ui-plugin");

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const copyFixture = (): { root: string; installDir: string } => {
  const root = tempRoot("polyth-ui-bundle-");
  const installDir = join(root, "plugin");
  cpSync(fixtureDir, installDir, { recursive: true });
  return { root, installDir };
};

/** An entry with a local helper module, a license notice and non-ASCII text,
 *  so minification, charset and legal-comment handling are all observable. */
const writeRichEntry = (installDir: string): void => {
  writeFileSync(join(installDir, "format.ts"), [
    "/*! @license Example Format (MIT) */",
    "export function describeTemperatureReading(reading: number): string {",
    "  const formattedTemperatureValue = reading.toFixed(1);",
    "  return `Wohnzimmer – ${formattedTemperatureValue} °C`;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(installDir, "rich.tsx"), [
    'import { describeTemperatureReading } from "./format.ts";',
    "",
    "function TemperatureReadingCard(props: { reading?: number }) {",
    "  return <p>{describeTemperatureReading(props.reading ?? 21)}</p>;",
    "}",
    "",
    'export const modules = { "rich-card": TemperatureReadingCard };',
    "",
  ].join("\n"));
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
  // Minified output drops the space before the specifier.
  assert.match(source, /from\s*"react\/jsx-runtime"/);
  assert.doesNotMatch(source, /react\.production\.js/);
});

test("buildUiBundle minifies to UTF-8 and keeps the export contract and license notices", async () => {
  const { installDir } = copyFixture();
  writeRichEntry(installDir);
  const result = await buildUiBundle({
    installDir,
    entryPath: "./rich.tsx",
    outDir: join(installDir, ".polyth", "ui"),
  });
  const source = readFileSync(result.file, "utf8");

  // The host reads only these export keys, and they survive minification.
  assert.match(source, /export\s*\{[^}]*\bas\s+modules\b[^}]*\}/);
  assert.match(source, /"rich-card"/);
  // Local identifiers are renamed (no keepNames) and whitespace is gone.
  assert.doesNotMatch(source, /formattedTemperatureValue|describeTemperatureReading|TemperatureReadingCard/);
  assert.doesNotMatch(source, /\n\s+\S/);
  // UTF-8 text stays as written instead of `\u2013`/`\xB0` escapes.
  assert.match(source, /Wohnzimmer – \$\{[^}]+\} °C/);
  assert.doesNotMatch(source, /\\u2013|\\xB0|\\u00b0/i);
  // A third-party license notice is kept once, at the end of the file.
  assert.equal(source.match(/@license Example Format \(MIT\)/g)?.length, 1);
  assert.match(source, /@license Example Format \(MIT\) \*\/\s*$/);
  // React stays external: the host's import map provides the shared instance.
  assert.match(source, /from\s*"react\/jsx-runtime"/);
});

test("buildUiBundle output does not depend on the staging directory", async () => {
  const first = copyFixture();
  const second = copyFixture();
  const build = (installDir: string) =>
    buildUiBundle({ installDir, entryPath: "./ui.tsx", outDir: join(installDir, ".polyth", "ui") });
  const [a, b] = [await build(first.installDir), await build(second.installDir)];
  assert.equal(a.integrity, b.integrity);
  assert.equal(readFileSync(a.file).equals(readFileSync(b.file)), true);
  assert.doesNotMatch(readFileSync(a.file, "utf8"), new RegExp(basename(first.root)));
});

test("a minified rebuild of the same tree is byte-identical and leaves one bundle", async () => {
  const { installDir } = copyFixture();
  writeRichEntry(installDir);
  const outDir = join(installDir, ".polyth", "ui");
  const build = () => buildUiBundle({ installDir, entryPath: "./rich.tsx", outDir });
  const first = await build();
  const bytes = readFileSync(first.file);
  const second = await build();
  assert.equal(second.integrity, first.integrity);
  assert.equal(second.file, first.file);
  assert.equal(readFileSync(second.file).equals(bytes), true);
  // Nothing but the integrity-addressed module is written next to it, so the
  // install tree (and its integrity) holds exactly what the bundle needs.
  assert.deepEqual(readdirSync(outDir), [basename(first.file)]);
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
  const root = tempRoot("polyth-ui-registry-");
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
  const uiDir = join(registry.installDir("test.ui-plugin"), ".polyth", "ui");
  assert.deepEqual(readdirSync(uiDir), [`ui-${first.ui.integrity}.mjs`]);

  writeFileSync(
    join(registry.installDir("test.ui-plugin"), "ui.tsx"),
    'export const modules = { "test-ui-widget": () => "reloaded" };\n',
  );
  const before = first.ui.integrity;
  await assert.rejects(() => registry.reload("test.ui-plugin"), /integrity/);
  assert.deepEqual(readdirSync(uiDir), [`ui-${before}.mjs`]);
  await registry.dispose();
});
