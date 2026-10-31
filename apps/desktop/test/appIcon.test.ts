import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import sharp from "sharp";
import { APP_ICON_FILL, APP_ICON_SIZE, buildAppIcon, markBox, prepareAppIcons, WINDOWS_ICON_SIZE } from "../scripts/prepare-icon.mjs";

const desktopDir = resolve(import.meta.dirname, "..");
const brandMaster = resolve(desktopDir, "../web/icon-512.png");

/** Bounding box of the opaque mark in a PNG, in pixels. */
async function pngMarkBox(path: string) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const box = markBox(data, info);
  assert.ok(box, `no opaque mark found in ${path}`);
  return box;
}

for (const [platform, file, size] of [
  ["macOS/Linux", "icon.png", APP_ICON_SIZE],
  ["Windows", "icon-win.png", WINDOWS_ICON_SIZE],
] as const) {
  test(`the ${platform} app icon fills its slot like a native app icon`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "polyth-app-icon-"));
    try {
      await prepareAppIcons({ source: brandMaster, buildDir: directory });

      const box = await pngMarkBox(join(directory, file));
      assert.equal(box.size, size);
      // The icon is square and the mark keeps its aspect ratio, so the *long*
      // side carries the fill and the mark stays centred on both axes.
      assert.ok(
        Math.abs(box.height - size * APP_ICON_FILL) <= 1,
        `mark height ${box.height} of ${size} (fill target ${size * APP_ICON_FILL})`,
      );
      assert.ok(box.width <= size * APP_ICON_FILL, `mark width ${box.width}`);
      assert.ok(Math.abs((box.left + box.width / 2) - size / 2) <= 1, "mark centred horizontally");
      assert.ok(Math.abs((box.top + box.height / 2) - size / 2) <= 1, "mark centred vertically");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("the app icon re-frames the brand mark without distorting it", async () => {
  const brand = await pngMarkBox(brandMaster);
  const { data, info } = await sharp(await buildAppIcon(brandMaster))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const icon = markBox(data, info);
  assert.ok(icon);

  // Same mark, same proportions: only the framing changes.
  const brandAspect = brand.width / brand.height;
  const iconAspect = icon.width / icon.height;
  assert.ok(
    Math.abs(brandAspect - iconAspect) <= 0.01,
    `aspect drifted from ${brandAspect.toFixed(3)} to ${iconAspect.toFixed(3)}`,
  );
  // It is genuinely bigger in its slot than the brand master's own margin.
  const brandFill = Math.max(brand.width, brand.height) / brand.size;
  const iconFill = Math.max(icon.width, icon.height) / icon.size;
  assert.ok(
    iconFill > brandFill + 0.15,
    `app icon fill ${iconFill.toFixed(3)} must clearly exceed the brand fill ${brandFill.toFixed(3)}`,
  );
});

test("Windows packaging and runtime use the Windows-sized icon, other platforms the large one", async () => {
  const pkg = JSON.parse(await readFile(join(desktopDir, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
    build: {
      files: string[];
      win: { icon: string };
      linux: { icon: string };
      mac: { icon: string };
      extraResources: Array<{ from: string; to: string }>;
    };
  };
  assert.equal(pkg.build.win.icon, "build/icon-win.png");
  assert.equal(pkg.build.linux.icon, "build/icon.png");
  assert.equal(pkg.build.mac.icon, "build/icon.png");
  assert.ok(pkg.build.extraResources.some(({ to }) => to === "icon-win.png"), "packaged app needs the Windows icon");
  assert.equal(typeof pkg.devDependencies.sharp, "string", "the icon step rasterizes with sharp");

  const mainSource = await readFile(join(desktopDir, "src", "main.ts"), "utf8");
  assert.match(mainSource, /win32"\s*\?\s*"icon-win\.png"\s*:\s*"icon\.png"/);
});

test("the generated app icons are valid square PNGs", async () => {
  // build/ is produced by scripts/prepare-icon.mjs during the desktop build.
  for (const file of ["icon.png", "icon-win.png"]) {
    const target = join(desktopDir, "build", file);
    if (!existsSync(target)) continue;
    const metadata = await sharp(target).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, metadata.height);
    assert.ok(metadata.hasAlpha, `${file} is transparent outside the mark`);
  }
});
