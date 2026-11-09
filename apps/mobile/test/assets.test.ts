import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPngInfo, readPngRgba, sha256File } from "../../../scripts/pngRead.ts";
import {
  ANDROID_ADAPTIVE_ICON_FILL,
  ANDROID_LEGACY_ICON_FILL,
  ANDROID_SPLASH_ICON_BOX,
  IOS_ICON_FILL,
  LAUNCH_BACKGROUND,
  LAUNCH_MARK_SIZE,
} from "../scripts/generate-assets.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));

test("the committed Android and iOS branding assets are complete and framed like the web veil", () => {
  const appRoot = resolve(testDirectory, "..");
  const sizeOf = (file: string) => readPngInfo(join(appRoot, file)).width;
  const generatedCount = (directory: string, pattern: RegExp) =>
    readdirSync(join(appRoot, directory), { recursive: true }).filter((name) => pattern.test(String(name))).length;
  // 6 densities x 4 mipmap PNGs, 5 launch densities x 2 drawables, 2 adaptive
  // XMLs (the generator reports these as 36 Android assets); 1 iOS icon + 6 splashes.
  assert.equal(generatedCount("android/app/src/main/res", /(mipmap-.*ic_launcher.*\.(png|xml)|polyth_launch_(mark|icon)\.png)$/), 36);
  assert.equal(generatedCount("ios/App/App/Assets.xcassets", /\.png$/), 7);

  assert.equal(sizeOf("android/app/src/main/res/mipmap-mdpi/ic_launcher.png"), 48);
  assert.equal(sizeOf("android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png"), 108);
  assert.equal(sizeOf("android/app/src/main/res/drawable-mdpi/polyth_launch_mark.png"), LAUNCH_MARK_SIZE);
  const androidIcon = readPngInfo(join(appRoot, "android/app/src/main/res/drawable-xxxhdpi/polyth_launch_icon.png"));
  assert.deepEqual({ width: androidIcon.width, height: androidIcon.height }, { width: ANDROID_SPLASH_ICON_BOX * 4, height: ANDROID_SPLASH_ICON_BOX * 4 });

  // App icons re-frame the mark larger than icon-only.png's own margin, and
  // the adaptive foreground keeps it inside the 66dp of 108dp safe circle.
  for (const [file, size, fill] of [
    ["android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png", 192, ANDROID_LEGACY_ICON_FILL],
    ["android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png", 432, ANDROID_ADAPTIVE_ICON_FILL],
    ["ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", 1024, IOS_ICON_FILL],
  ] as const) {
    const box = markBox(join(appRoot, file), file.includes("AppIcon") ? "#ffffff" : undefined);
    assert.equal(box.size, size);
    assert.ok(Math.abs(box.height - size * fill) <= 2, `${file}: mark height ${box.height} of ${size}`);
    assert.ok(Math.abs(box.centerX - size / 2) <= 1 && Math.abs(box.centerY - size / 2) <= 1, `${file}: mark centred`);
  }
  const foreground = markBox(join(appRoot, "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png"));
  assert.ok(foreground.radius <= 432 * 33 / 108, `adaptive mark reaches ${foreground.radius}px from the centre`);
  assert.doesNotMatch(readFileSync(join(appRoot, "android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml"), "utf8"), /inset/);

  const iconContents = JSON.parse(readFileSync(join(appRoot, "ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json"), "utf8"));
  assert.equal(iconContents.images[0].filename, "AppIcon-512@2x.png");
  const splashContents = JSON.parse(readFileSync(join(appRoot, "ios/App/App/Assets.xcassets/Splash.imageset/Contents.json"), "utf8"));
  assert.equal(splashContents.images.length, 6);
  assert.equal(splashContents.images[3].appearances[0].value, "dark");
  for (const [file, scale] of [["Default@1x~universal~anyany.png", 1], ["Default@3x~universal~anyany-dark.png", 3]] as const) {
    const box = markBox(join(appRoot, "ios/App/App/Assets.xcassets/Splash.imageset", file));
    assert.equal(box.size, LAUNCH_MARK_SIZE * scale);
    // The mark fills the box height and is centred in it, like the web veil.
    assert.ok(box.height >= box.size - scale * 2, `mark height ${box.height} of ${box.size}`);
    assert.ok(Math.abs(box.centerX - box.size / 2) <= scale, `mark centre ${box.centerX} of ${box.size}`);
  }
  const androidMark = markBox(join(appRoot, "android/app/src/main/res/drawable-xxhdpi/polyth_launch_icon.png"));
  assert.ok(Math.abs(androidMark.height - LAUNCH_MARK_SIZE * 3) <= 6, `android mark ${androidMark.height}`);
  assert.ok(Math.abs(androidMark.centerY - androidMark.size / 2) <= 3);
});

test("the committed branding assets were generated from the current sources", () => {
  const appRoot = resolve(testDirectory, "..");
  const stamp = JSON.parse(readFileSync(join(appRoot, "resources/assets.stamp.json"), "utf8")) as {
    sources: Record<string, string>;
  };
  assert.deepEqual(
    Object.keys(stamp.sources).sort(),
    ["resources/icon-background.svg", "resources/icon-only.png", "scripts/generate-assets.mjs"],
    "stamp lists the sources the generator reads",
  );
  for (const [file, hash] of Object.entries(stamp.sources)) {
    assert.equal(
      sha256File(join(appRoot, file)),
      hash,
      `${file} changed since the assets were generated: run \`npm run release-tools:install\` then \`npm --workspace @polyth/mobile run assets\` and commit the outputs`,
    );
  }
});

/** Bounding box of the mark inside a launch image or app icon: opaque pixels,
 * or on an opaque icon the pixels that differ from its `background`. */
function markBox(
  path: string,
  background?: string,
): { size: number; height: number; centerX: number; centerY: number; radius: number } {
  const { data, width, height } = readPngRgba(path);
  const bg = background ? [1, 3, 5].map((i) => Number.parseInt(background.slice(i, i + 2), 16)) : null;
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  let radius = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const inMark = bg
        ? Math.abs(data[i]! - bg[0]!) + Math.abs(data[i + 1]! - bg[1]!) + Math.abs(data[i + 2]! - bg[2]!) > 24
        : data[i + 3]! > 8;
      if (inMark) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        left = Math.min(left, x);
        right = Math.max(right, x);
        radius = Math.max(radius, Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2));
      }
    }
  }
  return { size: width, height: bottom - top + 1, centerX: (left + right + 1) / 2, centerY: (top + bottom + 1) / 2, radius };
}

test("native launch screens and the web launch veil draw the same mark on the same night", async () => {
  const [storyboard, styles, layers, colors, config, index] = await Promise.all([
    readFile(resolve(testDirectory, "../ios/App/App/Base.lproj/LaunchScreen.storyboard"), "utf8"),
    readFile(resolve(testDirectory, "../android/app/src/main/res/values/styles.xml"), "utf8"),
    readFile(resolve(testDirectory, "../android/app/src/main/res/drawable/polyth_launch.xml"), "utf8"),
    readFile(resolve(testDirectory, "../android/app/src/main/res/values/polyth_launch.xml"), "utf8"),
    readFile(resolve(testDirectory, "../capacitor.config.ts"), "utf8"),
    readFile(resolve(testDirectory, "../../web/src/index.html"), "utf8"),
  ]);
  // iOS: a fixed-size mark centred on the whole screen, not an aspect-filled
  // picture whose mark grows with the screen's long side.
  assert.match(storyboard, new RegExp(`image="Splash"[\\s\\S]*?firstAttribute="width" constant="${LAUNCH_MARK_SIZE}"`));
  assert.match(storyboard, /firstAttribute="centerX" secondItem="[^"]+" secondAttribute="centerX"/);
  assert.match(storyboard, /firstAttribute="centerY" secondItem="[^"]+" secondAttribute="centerY"/);
  assert.doesNotMatch(storyboard, /scaleAspectFill/);
  assert.match(storyboard, /red="0\.0274509\d*" green="0\.0352941\d*" blue="0\.1098039\d*"/);
  // Android: the 12+ splash and the window background carry the same picture.
  assert.match(styles, /windowSplashScreenBackground">@color\/polyth_launch_background/);
  assert.match(styles, /windowSplashScreenAnimatedIcon">@drawable\/polyth_launch_icon/);
  assert.match(styles, /postSplashScreenTheme">@style\/AppTheme\.NoActionBar/);
  assert.match(layers, new RegExp(`android:width="${LAUNCH_MARK_SIZE}dp"[\\s\\S]*android:gravity="center"`));
  assert.match(colors, new RegExp(LAUNCH_BACKGROUND, "i"));
  // The launch screen is held until the page's own veil is up, with a native
  // safety hide for a page that never gets that far.
  assert.match(config, /launchAutoHide:\s*true/);
  assert.match(config, /launchShowDuration:\s*10_?000/);
  assert.match(config, new RegExp(`backgroundColor:\\s*"${LAUNCH_BACKGROUND}"`));
  // Web: same night, same mark height (icon-512.png draws it 338px in 512).
  assert.match(index, new RegExp(`background: ${LAUNCH_BACKGROUND};`));
  assert.match(index, new RegExp(`width: calc\\(${LAUNCH_MARK_SIZE}px \\* 512 / 338\\)`));
});
