#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultAppRoot = resolve(scriptDirectory, "..");

const androidDensities = [
  { name: "ldpi", icon: 36, adaptive: 81 },
  { name: "mdpi", icon: 48, adaptive: 108 },
  { name: "hdpi", icon: 72, adaptive: 162 },
  { name: "xhdpi", icon: 96, adaptive: 216 },
  { name: "xxhdpi", icon: 144, adaptive: 324 },
  { name: "xxxhdpi", icon: 192, adaptive: 432 },
];

// The launch screen is the web launch veil's twin
// (apps/web/src/index.html): brand night with the Polyth mark 112pt/dp tall
// at the centre of the screen, independent of screen size or orientation. The
// web veil, the Link bootstrap page and both native launch screens must keep
// these numbers together; the native splash hands over to the veil unseen.
export const LAUNCH_BACKGROUND = "#07091c";
export const LAUNCH_MARK_SIZE = 112;
/** Android 12+ draws the splash icon into a 288dp box (visible inside its
 * central 192dp circle); the mark sits in it at LAUNCH_MARK_SIZE. */
export const ANDROID_SPLASH_ICON_BOX = 288;

// App icons re-frame the trimmed mark: icon-only.png keeps the brand master's
// generous margin, which would leave the mark small on a home screen. Each
// fill is the mark's long side as a fraction of the finished canvas.
/** iOS masks the whole 1024px square to its rounded tile. */
export const IOS_ICON_FILL = 0.78;
/** Pre-8.0 Android draws the bitmap as is, transparent around the mark. */
export const ANDROID_LEGACY_ICON_FILL = 0.84;
/** Adaptive layers are 108dp; launchers show the central 72dp through their
 * mask and promise only a 66dp circle, which the mark's corners stay inside. */
export const ANDROID_ADAPTIVE_ICON_FILL = 0.56;

const androidLaunchDensities = [
  { name: "mdpi", scale: 1 },
  { name: "hdpi", scale: 1.5 },
  { name: "xhdpi", scale: 2 },
  { name: "xxhdpi", scale: 3 },
  { name: "xxxhdpi", scale: 4 },
];

const iosSplashes = [
  ["Default@1x~universal~anyany.png", "1x"],
  ["Default@2x~universal~anyany.png", "2x"],
  ["Default@3x~universal~anyany.png", "3x"],
];

const iosDarkSplashes = [
  ["Default@1x~universal~anyany-dark.png", "1x"],
  ["Default@2x~universal~anyany-dark.png", "2x"],
  ["Default@3x~universal~anyany-dark.png", "3x"],
];

function safePath(root, ...parts) {
  const rootPath = resolve(root);
  const target = resolve(rootPath, ...parts);
  if (target !== rootPath && !target.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Generated asset path escapes its root: ${target}`);
  }
  return target;
}

function pathsFor(appRoot) {
  const root = resolve(appRoot);
  return {
    root,
    resources: safePath(root, "resources"),
    androidRes: safePath(root, "android", "app", "src", "main", "res"),
    iosAssets: safePath(root, "ios", "App", "App", "Assets.xcassets"),
  };
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
}

async function requireSource(path) {
  try {
    await sharp(path).metadata();
  } catch (error) {
    throw new Error(`Unable to load mobile asset source ${path}: ${error.message}`);
  }
  return path;
}

async function writePng(input, output, width, height, options = {}) {
  await ensureDirectory(dirname(output));
  await sharp(input).resize(width, height, options).png().toFile(output);
}

/** The mark alone: transparent margins trimmed, then padded to a square whose
 * height is the mark's, centred — one launch-mark box at any pixel size. */
async function markSquare(icon) {
  const { data, info } = await sharp(icon).ensureAlpha().trim({ threshold: 0 }).png().toBuffer({ resolveWithObject: true });
  const side = Math.max(info.width, info.height);
  const padX = side - info.width;
  const padY = side - info.height;
  return await sharp(data)
    .extend({
      left: Math.floor(padX / 2),
      right: Math.ceil(padX / 2),
      top: Math.floor(padY / 2),
      bottom: Math.ceil(padY / 2),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

/** The mark centred on a square canvas, its long side at `fill` of `size`. */
async function framedMark(mark, size, fill) {
  const markSize = Math.round(size * fill);
  const before = Math.floor((size - markSize) / 2);
  const after = size - markSize - before;
  return await sharp(await sharp(mark).resize(markSize, markSize).png().toBuffer())
    .extend({ left: before, right: after, top: before, bottom: after, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function writeJson(path, value) {
  await ensureDirectory(dirname(path));
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function generateAndroid(appPaths, sources) {
  const generated = [];
  const add = (path) => {
    generated.push(relative(appPaths.root, path));
    return path;
  };

  const mark = await markSquare(sources.icon);
  for (const density of androidDensities) {
    const normal = add(safePath(appPaths.androidRes, `mipmap-${density.name}`, "ic_launcher.png"));
    await ensureDirectory(dirname(normal));
    const resized = await framedMark(mark, density.icon, ANDROID_LEGACY_ICON_FILL);
    await sharp(resized).png().toFile(normal);

    const round = add(safePath(appPaths.androidRes, `mipmap-${density.name}`, "ic_launcher_round.png"));
    const circleMask = Buffer.from(
      `<svg width="${density.icon}" height="${density.icon}"><circle cx="${density.icon / 2}" cy="${density.icon / 2}" r="${density.icon / 2}" fill="#ffffff"/></svg>`,
    );
    await sharp(resized)
      .composite([{ input: circleMask, blend: "dest-in" }])
      .png()
      .toFile(round);

    const foreground = add(
      safePath(appPaths.androidRes, `mipmap-${density.name}`, "ic_launcher_foreground.png"),
    );
    await ensureDirectory(dirname(foreground));
    await sharp(await framedMark(mark, density.adaptive, ANDROID_ADAPTIVE_ICON_FILL)).png().toFile(foreground);

    const background = add(
      safePath(appPaths.androidRes, `mipmap-${density.name}`, "ic_launcher_background.png"),
    );
    await writePng(sources.iconBackground, background, density.adaptive, density.adaptive);
  }

  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
  for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
    const path = safePath(appPaths.androidRes, "mipmap-anydpi-v26", name);
    await ensureDirectory(dirname(path));
    await writeFile(path, adaptiveXml, "utf8");
    add(path);
  }

  // Launch: res/drawable/polyth_launch.xml layers the mark over the brand
  // night for the window background; Android 12+ draws polyth_launch_icon in
  // its 288dp splash-icon box (res/values/styles.xml).
  for (const density of androidLaunchDensities) {
    const markSize = Math.round(LAUNCH_MARK_SIZE * density.scale);
    const box = Math.round(ANDROID_SPLASH_ICON_BOX * density.scale);
    const markPath = add(safePath(appPaths.androidRes, `drawable-${density.name}`, "polyth_launch_mark.png"));
    await writePng(mark, markPath, markSize, markSize);
    const iconPath = add(safePath(appPaths.androidRes, `drawable-${density.name}`, "polyth_launch_icon.png"));
    const inset = Math.floor((box - markSize) / 2);
    await sharp(await sharp(mark).resize(markSize, markSize).png().toBuffer())
      .extend({
        left: inset,
        right: box - markSize - inset,
        top: inset,
        bottom: box - markSize - inset,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(iconPath);
  }

  return generated;
}

async function generateIos(appPaths, sources) {
  const generated = [];
  const appIconDirectory = safePath(appPaths.iosAssets, "AppIcon.appiconset");
  const splashDirectory = safePath(appPaths.iosAssets, "Splash.imageset");
  await ensureDirectory(appIconDirectory);
  await ensureDirectory(splashDirectory);

  const mark = await markSquare(sources.icon);
  const iconPath = safePath(appIconDirectory, "AppIcon-512@2x.png");
  await sharp(await framedMark(mark, 1024, IOS_ICON_FILL))
    .flatten({ background: "#ffffff" })
    .png()
    .toFile(iconPath);
  generated.push(relative(appPaths.root, iconPath));

  // LaunchScreen.storyboard centres a LAUNCH_MARK_SIZE-point "Splash" image
  // on the brand night; the same storyboard is what SplashScreen.show() raises.
  for (const [filename, scale] of [...iosSplashes, ...iosDarkSplashes]) {
    const size = LAUNCH_MARK_SIZE * Number.parseInt(scale, 10);
    const path = safePath(splashDirectory, filename);
    await writePng(mark, path, size, size);
    generated.push(relative(appPaths.root, path));
  }

  await writeJson(safePath(appIconDirectory, "Contents.json"), {
    images: [
      {
        idiom: "universal",
        size: "1024x1024",
        filename: "AppIcon-512@2x.png",
        platform: "ios",
      },
    ],
    info: { author: "xcode", version: 1 },
  });
  await writeJson(safePath(splashDirectory, "Contents.json"), {
    images: [
      ...iosSplashes.map(([filename, scale]) => ({
        idiom: "universal",
        filename,
        scale,
      })),
      ...iosDarkSplashes.map(([filename, scale]) => ({
        appearances: [{ appearance: "luminosity", value: "dark" }],
        idiom: "universal",
        scale,
        filename,
      })),
    ],
    info: { version: 1, author: "xcode" },
  });

  return generated;
}

export async function generateAssets({ appRoot = defaultAppRoot } = {}) {
  const appPaths = pathsFor(appRoot);
  const sources = {
    icon: await requireSource(safePath(appPaths.resources, "icon-only.png")),
    iconBackground: await requireSource(safePath(appPaths.resources, "icon-background.svg")),
  };

  const [android, ios] = await Promise.all([
    generateAndroid(appPaths, sources),
    generateIos(appPaths, sources),
  ]);
  return { android, ios };
}

async function main() {
  const generated = await generateAssets();
  console.log(`Generated ${generated.android.length} Android and ${generated.ios.length} iOS assets.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
