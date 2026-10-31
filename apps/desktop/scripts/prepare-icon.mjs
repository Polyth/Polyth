#!/usr/bin/env node

// Electron-builder build resources for the desktop app.
//
// Two app icons come out of the one brand master (apps/web/icon-512.png):
//   build/icon.png      every platform's own icon slot (Linux/macOS/builder default)
//   build/icon-win.png  the Windows .exe/taskbar icon
//
// The brand master deliberately draws the mark 338px tall inside its 512px
// canvas (apps/mobile/test/assets.test.ts pins that ratio, and the launch
// screens/veil size themselves from it). That generous margin is right for the
// in-app mark, but a dock, taskbar or launcher draws an app icon into its whole
// slot, so the same transparent margin makes Polyth read visibly smaller than
// the apps beside it. Both app icons therefore re-frame the same mark, at the
// same aspect ratio, onto a fuller canvas; only their pixel sizes differ.

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const defaultSource = resolve(here, "../../web/icon-512.png");
const defaultBuildDir = resolve(here, "../build");

/** Docks and taskbars draw app icons into a full square slot; neighboring
 * apps' art fills roughly 85-92% of it. Target the mark's *long* side at this
 * fraction of the canvas so a wide or tall mark lands inside the same visual
 * weight. */
export const APP_ICON_FILL = 0.88;
/** macOS builds its .icns from this and wants at least 512px. */
export const APP_ICON_SIZE = 512;
/** The largest frame a Windows .ico carries. */
export const WINDOWS_ICON_SIZE = 256;

/** Bounding box of the opaque mark inside a square RGBA image. */
export function markBox(data, info) {
  let top = info.height;
  let bottom = -1;
  let left = info.width;
  let right = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  if (bottom < top || right < left) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1, size: info.width };
}

/** Re-frame the brand master's mark onto a square app-icon canvas. */
export async function buildAppIcon(sourcePath, size = APP_ICON_SIZE, fill = APP_ICON_FILL) {
  const { data, info } = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const box = markBox(data, info);
  if (!box) throw new Error(`no opaque mark found in ${sourcePath}`);

  // Scale so the mark's long side occupies `fill` of the finished canvas, then
  // centre it: the icon is square, so both axes share one scale factor.
  const scale = (size * fill) / Math.max(box.width, box.height);
  const width = Math.max(1, Math.round(box.width * scale));
  const height = Math.max(1, Math.round(box.height * scale));
  const mark = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: mark, left: Math.round((size - width) / 2), top: Math.round((size - height) / 2) }])
    .png()
    .toBuffer();
}

/** Write both desktop app icons into the electron-builder build resources. */
export async function prepareAppIcons({
  source = defaultSource,
  buildDir = defaultBuildDir,
} = {}) {
  await mkdir(buildDir, { recursive: true });
  await sharp(await buildAppIcon(source, APP_ICON_SIZE)).toFile(resolve(buildDir, "icon.png"));
  await sharp(await buildAppIcon(source, WINDOWS_ICON_SIZE)).toFile(resolve(buildDir, "icon-win.png"));
}

// `npm run build` runs this file directly; build.ts calls prepareAppIcons().
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await prepareAppIcons();
}
