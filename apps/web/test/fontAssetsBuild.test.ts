// The web build emits fonts twice: under their plain source names (a page from
// before the rebuild still references them) and under content-addressed names
// matching the server's HASHED_ASSET rule. The stylesheet in dist must point at
// the content-addressed copies and every URL it names must exist.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  contentAddressedName,
  emitContentAddressedCopy,
  emitFontAssets,
  FONT_ASSET_PREFIX,
} from "../buildConfig.ts";

const webDir = resolve(import.meta.dirname, "..");
const fontsDir = join(webDir, "src", "assets", "fonts");
const fontCss = readFileSync(join(webDir, "src", "fonts.css"), "utf8");

const tempDir = (): string => mkdtempSync(join(tmpdir(), "polyth-font-assets-"));

test("the built font stylesheet names content-addressed files that exist", async () => {
  const target = tempDir();
  try {
    const css = await emitFontAssets({ sourceDir: fontsDir, targetDir: target, css: fontCss });
    const urls = [...css.matchAll(/url\("([^"]+\.woff2)"\)/g)].map((match) => match[1]!);
    assert.ok(urls.length >= 30, "every bundled family is still declared");
    for (const url of urls) {
      assert.ok(url.startsWith(FONT_ASSET_PREFIX), `${url} stays a root-absolute font URL`);
      const name = basename(url);
      assert.match(name, /-[A-Z0-9]{8,}\.woff2$/, `${name} is content-addressed`);
      assert.ok(existsSync(join(target, name)), `${url} exists in the built fonts directory`);
    }
    // A pre-rebuild page still resolves its plain-name URLs.
    assert.ok(existsSync(join(target, "inter-normal.woff2")));
    assert.equal(css.includes('url("/assets/fonts/inter-normal.woff2")'), false);

    const again = await emitFontAssets({ sourceDir: fontsDir, targetDir: target, css: fontCss });
    assert.equal(again, css, "unchanged font bytes keep the exact same URLs");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

// The Latin files have no Cyrillic; without these faces terminal and code text
// in Ukrainian falls back to a system font with its own look and cell width.
test("JetBrains Mono declares Cyrillic faces for both styles, loaded only by Cyrillic text", () => {
  const faces = [...fontCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]!)
    .filter((body) => body.includes('font-family: "JetBrains Mono"') && body.includes("jetbrains-mono-cyrillic-"));
  for (const style of ["normal", "italic"]) {
    const face = faces.find((body) => body.includes(`font-style: ${style};`));
    assert.ok(face, `a Cyrillic ${style} face is declared`);
    assert.match(face!, /font-weight: 100 800;/, "the same weight axis as the Latin face");
    const file = `jetbrains-mono-cyrillic-${style}.woff2`;
    assert.ok(face!.includes(`url("${FONT_ASSET_PREFIX}${file}")`), `the ${style} face names ${file}`);
    assert.ok(existsSync(join(fontsDir, file)), `${file} is bundled`);
    const range = /unicode-range:\s*([^;]+);/.exec(face!)?.[1] ?? "";
    // Basic Cyrillic (Ukrainian і ї є included) and Ґ ґ; never Latin letters.
    assert.match(range, /U\+0400-045F/);
    assert.match(range, /U\+0490-0491/);
    assert.doesNotMatch(range, /U\+00[0-7][0-9A-F]/, "Latin text never downloads the Cyrillic file");
  }
});

// tmux panes, tree output and prompt frames join only when every line glyph
// comes from one face; the Latin files carry none of them.
test("JetBrains Mono declares its box drawing for both styles from one file", () => {
  const file = "jetbrains-mono-box.woff2";
  const faces = [...fontCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]!)
    .filter((body) => body.includes('font-family: "JetBrains Mono"') && body.includes(`url("${FONT_ASSET_PREFIX}${file}")`));
  assert.ok(existsSync(join(fontsDir, file)), `${file} is bundled`);
  for (const style of ["normal", "italic"]) {
    const face = faces.find((body) => body.includes(`font-style: ${style};`));
    assert.ok(face, `a box-drawing ${style} face is declared`);
    assert.match(face!, /font-weight: 100 800;/, "the same weight axis as the Latin face");
    assert.match(face!, /unicode-range: U\+2500-259F;/, "box drawing and block elements only");
  }
});

test("changed font bytes move to a new URL", async () => {
  const source = tempDir();
  const target = tempDir();
  try {
    const css = `${FONT_ASSET_PREFIX}probe.woff2`;
    writeFileSync(join(source, "probe.woff2"), "wOF2-first");
    const first = await emitFontAssets({ sourceDir: source, targetDir: target, css });
    writeFileSync(join(source, "probe.woff2"), "wOF2-second");
    const second = await emitFontAssets({ sourceDir: source, targetDir: target, css });
    assert.notEqual(first, second);
    assert.notEqual(contentAddressedName("probe.woff2", Buffer.from("a")), contentAddressedName("probe.woff2", Buffer.from("b")));
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("the launch mark is copied under a content-addressed name", async () => {
  const target = tempDir();
  try {
    const source = join(webDir, "icon-512.png");
    const name = await emitContentAddressedCopy(source, target);
    assert.match(name, /^icon-512-[A-Z0-9]{8,}\.png$/);
    assert.deepEqual(readFileSync(join(target, name)), readFileSync(source));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
