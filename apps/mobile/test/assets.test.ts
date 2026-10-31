import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  ANDROID_ADAPTIVE_ICON_FILL,
  ANDROID_LEGACY_ICON_FILL,
  ANDROID_SPLASH_ICON_BOX,
  generateAssets,
  IOS_ICON_FILL,
  LAUNCH_BACKGROUND,
  LAUNCH_MARK_SIZE,
} from "../scripts/generate-assets.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = resolve(testDirectory, "../resources");

test("generates complete Android and iOS branding assets from the checked-in sources", async () => {
  const appRoot = await mkdtemp(join("/tmp", "polyth-mobile-assets-"));
  try {
    await Promise.all([
      mkdir(join(appRoot, "android", "app", "src", "main", "res"), { recursive: true }),
      mkdir(join(appRoot, "ios", "App", "App", "Assets.xcassets"), { recursive: true }),
      mkdir(join(appRoot, "resources"), { recursive: true }),
    ]);
    for (const filename of ["icon-only.png", "icon-background.svg"]) {
      await copyFile(join(sourceDirectory, filename), join(appRoot, "resources", filename));
    }

    const generated = await generateAssets({ appRoot });
    assert.equal(generated.android.length, 36);
    assert.equal(generated.ios.length, 7);

    assert.deepEqual(
      (await sharp(join(appRoot, "android/app/src/main/res/mipmap-mdpi/ic_launcher.png")).metadata()).width,
      48,
    );
    assert.deepEqual(
      (await sharp(join(appRoot, "android/app/src/main/res/mipmap-mdpi/ic_launcher_foreground.png")).metadata()).width,
      108,
    );
    assert.equal(
      (await sharp(join(appRoot, "android/app/src/main/res/drawable-mdpi/polyth_launch_mark.png")).metadata()).width,
      LAUNCH_MARK_SIZE,
    );
    const androidIcon = await sharp(join(appRoot, "android/app/src/main/res/drawable-xxxhdpi/polyth_launch_icon.png")).metadata();
    assert.deepEqual({ width: androidIcon.width, height: androidIcon.height }, { width: ANDROID_SPLASH_ICON_BOX * 4, height: ANDROID_SPLASH_ICON_BOX * 4 });

    // App icons re-frame the mark larger than icon-only.png's own margin, and
    // the adaptive foreground keeps it inside the 66dp of 108dp safe circle.
    for (const [file, size, fill] of [
      ["android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png", 192, ANDROID_LEGACY_ICON_FILL],
      ["android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png", 432, ANDROID_ADAPTIVE_ICON_FILL],
      ["ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", 1024, IOS_ICON_FILL],
    ] as const) {
      const box = await markBox(join(appRoot, file), file.includes("AppIcon") ? "#ffffff" : undefined);
      assert.equal(box.size, size);
      assert.ok(Math.abs(box.height - size * fill) <= 2, `${file}: mark height ${box.height} of ${size}`);
      assert.ok(Math.abs(box.centerX - size / 2) <= 1 && Math.abs(box.centerY - size / 2) <= 1, `${file}: mark centred`);
    }
    const foreground = await markBox(join(appRoot, "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png"));
    assert.ok(foreground.radius <= 432 * 33 / 108, `adaptive mark reaches ${foreground.radius}px from the centre`);
    assert.doesNotMatch(
      await readFile(join(appRoot, "android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml"), "utf8"),
      /inset/,
    );

    const iconContents = JSON.parse(
      await readFile(
        join(appRoot, "ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json"),
        "utf8",
      ),
    );
    assert.equal(iconContents.images[0].filename, "AppIcon-512@2x.png");
    const splashContents = JSON.parse(
      await readFile(
        join(appRoot, "ios/App/App/Assets.xcassets/Splash.imageset/Contents.json"),
        "utf8",
      ),
    );
    assert.equal(splashContents.images.length, 6);
    assert.equal(splashContents.images[3].appearances[0].value, "dark");
    for (const [file, scale] of [["Default@1x~universal~anyany.png", 1], ["Default@3x~universal~anyany-dark.png", 3]] as const) {
      const box = await markBox(join(appRoot, "ios/App/App/Assets.xcassets/Splash.imageset", file));
      assert.equal(box.size, LAUNCH_MARK_SIZE * scale);
      // The mark fills the box height and is centred in it, like the web veil.
      assert.ok(box.height >= box.size - scale * 2, `mark height ${box.height} of ${box.size}`);
      assert.ok(Math.abs(box.centerX - box.size / 2) <= scale, `mark centre ${box.centerX} of ${box.size}`);
    }
    const androidMark = await markBox(join(appRoot, "android/app/src/main/res/drawable-xxhdpi/polyth_launch_icon.png"));
    assert.ok(Math.abs(androidMark.height - LAUNCH_MARK_SIZE * 3) <= 6, `android mark ${androidMark.height}`);
    assert.ok(Math.abs(androidMark.centerY - androidMark.size / 2) <= 3);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});

/** Bounding box of the mark inside a launch image or app icon: opaque pixels,
 * or on an opaque icon the pixels that differ from its `background`. */
async function markBox(
  path: string,
  background?: string,
): Promise<{ size: number; height: number; centerX: number; centerY: number; radius: number }> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bg = background ? [1, 3, 5].map((i) => Number.parseInt(background.slice(i, i + 2), 16)) : null;
  let top = info.height;
  let bottom = -1;
  let left = info.width;
  let right = -1;
  let radius = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * 4;
      const inMark = bg
        ? Math.abs(data[i]! - bg[0]!) + Math.abs(data[i + 1]! - bg[1]!) + Math.abs(data[i + 2]! - bg[2]!) > 24
        : data[i + 3]! > 8;
      if (inMark) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        left = Math.min(left, x);
        right = Math.max(right, x);
        radius = Math.max(radius, Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2));
      }
    }
  }
  return { size: info.width, height: bottom - top + 1, centerX: (left + right + 1) / 2, centerY: (top + bottom + 1) / 2, radius };
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
