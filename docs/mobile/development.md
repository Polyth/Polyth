# Polyth mobile development

## Prerequisites

- Node 22.18 or newer (the repository uses Node type stripping).
- A reachable Polyth server for interactive testing.
- Android Studio plus an Android SDK/JDK for Android builds.
- macOS with Xcode for iOS builds.

Install workspace dependencies from the repository root:

```sh
npm install
```

## Build and synchronize

The mobile shell always consumes the canonical web output:

```sh
npm run build:mobile
```

This runs `build:web`, then `cap sync` for Android and iOS, then
`scripts/bundle-package-assets.mjs`, which copies every package web bundle listed
in the bundled `packages-manifest.json` into the native `public/packages/<id>/`
directories (generated, gitignored; the build fails if a listed file is missing —
build the packages first). Without it the app has no package widgets. Use the same command
after changing the web app, mobile bridge, Capacitor config, or plugins.

Open the native projects:

```sh
npm run mobile:open:android
npm run mobile:open:ios
```

Build Android from the command line:

```sh
npm run mobile:build:android
```

`mobile:open:ios` and iOS compilation require macOS. Do not hand-edit copied
files under native `public` asset directories; `cap sync` replaces them.

## Branded assets

Source artwork is centralized in `apps/mobile/resources/`:

- `icon-only.png`: the mark. Launcher icons and the launch screens are cut
  from it. The launch screens draw it 112 pt/dp tall, centred on `#07091c`,
  to match the web launch veil (see "Launch and reveal" in
  `platform-behavior.md`).
- `icon-background.svg`

Regenerate both native asset catalogs with:

```sh
npm --workspace @polyth/mobile run assets
```

The generated PNGs are not committed (see `.gitignore`); `sync`, `copy` and the
platform build scripts regenerate them. Git holds only the hand-written native
pieces: `LaunchScreen.storyboard`, the `Contents.json` files, and on Android
`res/values/polyth_launch.xml`, `res/drawable/polyth_launch.xml` and
`styles.xml`. If the mark changes, also regenerate the Link bootstrap page's
copy, `crates/polyth-link-core/assets/launch-mark.webp` (the 336 px iOS @3x
launch image as WebP).

## Connecting during development

Start Polyth on the host:

```sh
POLYTH_UI_PASSWORD='choose-a-password' npm start
```

The server currently binds all interfaces by default. Enter a host address the
device can reach, such as `http://192.168.1.20:4400`; `127.0.0.1` on a phone is
the phone itself. Prefer HTTPS whenever traffic leaves a trusted local network.

On Android Emulator, `10.0.2.2` reaches the development machine. Physical
devices require LAN reachability and firewall access. iOS prompts for local
network access the first time a local host is used.

First launch validates the host, remembers it, then shows the existing Polyth
lock screen when a password is configured. Remove a recent host from the
connection gate to prevent automatic restoration to it.

## Validation commands

```sh
node --test apps/mobile/test/*.test.ts apps/web/test/nativeMobile.test.ts
npx tsc --noEmit  # from apps/mobile
npx tsc --noEmit  # from apps/web
npm run build:mobile
```

Android Gradle validation needs `ANDROID_HOME` or
`apps/mobile/android/local.properties` with a valid `sdk.dir`. The local
properties file is intentionally ignored. iOS validation must run through
Xcode on macOS.

## Adding a native capability

Keep configuration and plugin dependencies in `apps/mobile`. Expose a bounded
function from `apps/mobile/src/nativeBridge.ts`, then call it from the shared
web UI only after checking `isNativeMobile()`. Browser and Electron must retain
their existing paths.

Do not add a second store, router, sync client, attachment format, or React
pipeline. Model-visible data still goes through the server and append-only event
log before display.

## Android native library packaging

`PolythLinkRust` loads `libpolyth_link_jni.so`, which links
`libpolyth_link_uniffi.so` from `app/src/main/jniLibs`. Cargo emits no `SONAME`
for a `cdylib`, so `crates/polyth-link-uniffi/build.rs` stamps
`libpolyth_link_uniffi.so`, and `app/src/main/cpp/CMakeLists.txt` declares the
same `IMPORTED_SONAME`. Do not drop either: without a resolvable `SONAME` the
linker records the absolute build-host path in `DT_NEEDED`, the on-device
`loadLibrary` fails, and the app crashes when the Connection Hub lists trusted
connections. `PolythLinkRust` also fails closed when the library is unavailable
so a packaging regression degrades to the explicit unavailable state rather
than killing the process.
