# Polyth Desktop

`apps/desktop` wraps the existing server and web client in Electron. The main process
boots `@polyth/server` on a random loopback port, serves the packaged SPA, and passes an
absolute bundled OpenCode executable to `@polyth/backend-opencode`. The desktop layer
does not call OpenCode itself.

## Local builds

Use Node 22.14 or newer (matching `scripts/check-node.mjs` and `.nvmrc`).

```sh
npm install
npm run build:desktop
npm run desktop:download-opencode
npm --workspace @polyth/desktop start
```

Platform packages:

```sh
npm run desktop:dist:linux  # apps/desktop/release/*.AppImage
npm run desktop:dist:mac    # .dmg + updater .zip (run on macOS)
npm run desktop:dist:win    # apps/desktop/release/*.exe (run on Windows)
```

The exact OpenCode release and SHA-256 digests are locked in
`apps/desktop/opencode.json`. `download-opencode.mjs` refuses a mismatched archive.
Packaged binaries live under `resources/opencode/<platform>-<arch>/`; the server always
receives that absolute path and never falls back to the system `PATH`.

Controlled browser packaging uses the same explicit resource boundary. Before creating
a desktop artifact, `npm --workspace @polyth/desktop run stage:chromium` copies the
already-installed Chromium selected by the pinned `playwright-core` into
`resources/chromium/<platform>-<arch>/` and records its version and executable path.
The staging command never downloads a browser; release runners must provision the
matching Playwright browser before this step. The manual GitHub application-build workflow installs the Chromium revision selected by `playwright-core` into a hermetic cache, then stages it for the requested Windows or Linux x64 artifact. Local or future signed macOS distribution tooling must provision and stage the correct architecture-specific browser resources before packaging; the staging command itself never downloads them. Packaged startup points
`POLYTH_CHROMIUM_PATH` at that resource and reports the browser capability as
unavailable when the resource is missing. Electron's renderer CDP is not reused:
connecting to the app's debugging endpoint would expose the trusted desktop renderer
and its windows to the browser tool, while a dedicated Chromium process preserves the
browser service's isolated context and URL policy.

## Release and updates

GitHub Actions separates smoke artifacts from real releases.

`.github/workflows/build-apps.yml` is manual and unpublished:

- `windows-exe`: x64 NSIS installer;
- `linux-appimage`: x64 AppImage with packaged-app smoke;
- `mac-dmg`: unsigned universal DMG plus the updater ZIP;
- platform mobile targets and public npm SDK tarballs are available from the same manual chooser.

`.github/workflows/release.yml` is also manual but may run only from `master`. It builds signed Windows x64/arm64 installers, Linux x64/arm64 AppImages, and a signed/notarized universal macOS DMG + ZIP. The final job gathers the generated electron-builder updater metadata, creates or refreshes a draft GitHub Release, and publishes that release only after all required artifacts (and optional external publication) succeed.

The electron-builder provider is `Polyth/Polyth`. `electron-updater` consumes the published GitHub Release metadata (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`, plus architecture-specific channels). Automatic updates are enabled by default in Desktop settings: the app checks shortly after startup and every six hours, automatically downloads an available release when that setting is enabled, and installs the downloaded update on quit/restart. Manual check/download/install remains available when automatic updates are disabled.

macOS updater releases require code signing; the release workflow also notarizes the universal package. Manual `mac-dmg` builds deliberately disable signing/notarization and are not updater releases.

## Background integration

Close-to-tray and start-hidden behavior are configurable on every platform. Launch at
login uses native login items on macOS and Windows, and an XDG autostart entry pointing
at the stable `APPIMAGE` path on Linux. Login starts pass `--background` so the app
opens directly into the tray. The optional keep-awake setting uses Electron's
app-suspension blocker for long-running agents.

## Low-resource mode

Desktop settings includes an opt-in low-resource mode for older machines. It
disables interface animations, haptics, and live backdrop blur immediately.
After restart it also:

- defers the OpenCode model/agent catalog until the first user interaction;
- uses Electron software compositing and disables built-in spellcheck;
- caps Chromium's disk cache at 32 MiB;
- reduces server terminal replay from 200 KiB to 64 KiB per terminal;
- reduces renderer terminal scrollback from 5,000 to 1,000 rows;
- limits concurrent terminal child processes to four; and
- starts with a smaller 1100×720 window when no saved bounds exist.

The independent **Reduce animations and effects** setting applies the same
motion, haptic, and glass reduction without changing runtime or cache limits.

OpenCode starts normally as soon as the user interacts with the application, so
agent, model, terminal, and workflow behavior remains available. Hardware
acceleration remains the default outside low-resource mode.

## Linux AppImage verification

The packaged smoke test extracts the AppImage (so FUSE is not required), launches it
under Xvfb, and drives the real renderer over Chromium DevTools Protocol:

```sh
xvfb-run -a node apps/desktop/test/appimage-e2e.mjs \
  apps/desktop/release/Polyth-*.AppImage \
  /tmp/polyth-appimage.png \
  /tmp/polyth-appimage.log \
  "$PWD"
```

It checks server health, the sandboxed preload bridge, the contributed Desktop settings
page, all three window controls, persisted chrome position/theme, tray creation and
close-to-tray, native file reveal, update wiring, and a model-catalog request through
the bundled OpenCode process.

For repeatable process-level profiling, run the AppImage under Xvfb with either
`standard` or `low-resource`. Each lifecycle state is sampled for 30 seconds by
default and the JSON includes per-process-group RSS, VMS, CPU, process count,
and disk I/O:

```sh
xvfb-run -a node apps/desktop/test/appimage-profile.mjs \
  apps/desktop/release/Polyth-*.AppImage \
  /tmp/polyth-profile.json \
  "$PWD" \
  low-resource
```

## Security boundary

- Renderer: `sandbox: true`, `contextIsolation: true`, no Node integration.
- Preload: a fixed API for settings, window actions, updates, and absolute local paths.
- IPC: accepted only from the loopback Polyth origin.
- Navigation: stays on the local origin; allowlisted HTTP(S)/mailto links open in the
  system browser.
- Permissions: only audio capture (not camera/video) and notifications are accepted for the local app.
- Server: binds to `127.0.0.1` in desktop mode.
- Secrets: desktop settings contain presentation and lifecycle preferences only.
