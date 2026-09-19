# Polyth Desktop

`apps/desktop` wraps the existing server and web client in Electron. The main process
boots `@polyth/server` on a random loopback port, serves the packaged SPA, and passes an
absolute bundled OpenCode executable to `@polyth/backend-opencode`. The desktop layer
does not call OpenCode itself.

Fresh installations initially serve the same SPA through the authority-only setup
server. Its Content Security Policy hashes the inline scripts in the trusted built
`index.html`, including the React import map. Arbitrary inline scripts remain blocked;
do not bypass this with `unsafe-inline` or Electron `webSecurity: false`. Rebuild and
restart after changing the shell. Server startup success alone is not renderer
verification: a first-launch smoke must also confirm that setup UI actually renders.

Polyth Desktop owns its first-run operator step. The trusted Electron main process
requests one short-lived setup claim from the in-process setup lifecycle and exposes
it only through the context-isolated desktop bridge; the renderer never asks the user
for npm, a claim token, or a manual server restart. The setup screen binds that claim
through the existing canonical setup API, then Electron restarts the local server on
the same loopback port after account creation. Standalone/headless server setup keeps
the explicit `npm run setup:claim` operator flow.

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
The staging command never downloads a browser; build/release runners provision the
matching Playwright revision before this step. Windows and Linux stage the requested
architecture directly; macOS stages native x64 and arm64 Chromium resources separately
before packaging both app architectures. Packaged startup points
`POLYTH_CHROMIUM_PATH` at that resource and fails closed if either bundled Chromium
or bundled OpenCode is missing, rather than searching the host for a substitute.
Electron's renderer CDP is not reused:
connecting to the app's debugging endpoint would expose the trusted desktop renderer
and its windows to the browser tool, while a dedicated Chromium process preserves the
browser service's isolated context and URL policy.

Local terminal launch is platform-native as well: Windows uses `COMSPEC` (falling back
to `cmd.exe`) and Windows command-line switches, while macOS/Linux use `SHELL`
(falling back to `/bin/sh`). Linux-only runtime containment and remote `flock`/
`/proc` logic remains gated to Linux execution paths and is not a desktop host
dependency on macOS or Windows.

## Release and updates

GitHub Actions separates smoke artifacts from real releases.

`.github/workflows/build-apps.yml` is manual and unpublished:

- `windows-exe`: x64 NSIS installer plus packaged-server startup smoke;
- `linux-appimage`: x64 AppImage with full packaged-app smoke;
- `mac-dmg`: native x64 DMG and arm64 DMG as separate artifacts, plus packaged-server startup smoke on the runner-native architecture. With complete Apple secrets they are Developer ID signed/notarized; without those secrets the manual workflow falls back to explicit ad-hoc signing for smoke/testing only. No updater ZIP is produced by this workflow;
- platform mobile targets and public npm SDK tarballs are available from the same manual chooser.

`.github/workflows/release.yml` is also manual but may run only from `master`. It builds signed Windows x64/arm64 installers, Linux x64/arm64 AppImages, and signed/notarized native macOS x64 + arm64 DMG/ZIP pairs. Before artifact handoff it launches the packaged Windows x64 app and one runner-native macOS app through the startup-smoke path, which must boot the bundled server using only packaged OpenCode/Chromium resources. The final job gathers the generated electron-builder updater metadata, creates or refreshes a draft GitHub Release, and publishes that release only after all required artifacts (and optional external publication) succeed.

The electron-builder provider is `Polyth/Polyth`. `electron-updater` consumes the published GitHub Release metadata (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`, plus architecture-specific channels). Automatic updates are enabled by default in Desktop settings: the app checks shortly after startup and every six hours, automatically downloads an available release when that setting is enabled, and installs the downloaded update on quit/restart. Manual check/download/install remains available when automatic updates are disabled.

macOS updater releases require Developer ID signing and notarization; the release workflow remains strict and fails if those credentials are missing. `electron-updater` selects the matching x64/arm64 file from the shared `latest-mac.yml` feed. Manual `mac-dmg` builds use the same credentials when available. If they are absent, the manual workflow uses electron-builder ad-hoc signing (`mac.identity=-`) and disables notarization only for that smoke artifact. Ad-hoc DMGs are not trusted distribution artifacts and may require local Gatekeeper approval; they must never be published as a release.

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
