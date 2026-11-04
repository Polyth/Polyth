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
