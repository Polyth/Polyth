# Polyth Desktop

`apps/desktop` wraps the existing server and web client in Electron. The main process
boots `@polyth/server` on a loopback port, serves the packaged SPA, and passes an
absolute bundled OpenCode executable to `@polyth/backend-opencode`. The desktop layer
does not call OpenCode itself.

The port is part of the window's origin, and Chromium keeps localStorage, IndexedDB
and site permissions per origin. The first launch takes a free port from the system
and saves it in `desktop/server-port.json` under the app's user data; later launches
reuse it, so device-local shell state such as the navigator's sort, custom project
order, open projects and shown-session counts survives a restart. Only when another
process holds the saved port does the app take a new one, and that launch starts with
empty origin storage (`src/serverPort.ts`). The port is still drawn at random per
installation; keeping it adds no predictability across installs, and a local process
or a probing page could find a listening loopback port before as well, so the port
was never a security boundary. Rollback: an older build ignores the file and takes a
random port on every launch; deleting the file makes the next launch take, and keep,
a new one.

Server features are selected from `polyth.serverEntry` manifests by
`apps/desktop/serverPackageInventory.ts`. The main-process esbuild plugin generates
static imports; installed applications do not scan repository directories. Source
execution/tests load the same discovered inventory. The desktop-specific Chat
Workspace factory is the only platform override. New features do not require a
manual row in `src/serverPackages.ts`; inventory and generated-import tests live
in `test/serverPackages.test.ts`.

Fresh installations initially serve the same SPA through the authority-only setup
server. Its Content Security Policy hashes the inline scripts in the trusted built
`index.html`, including the React import map. Arbitrary inline scripts remain blocked;
do not bypass this with `unsafe-inline` or Electron `webSecurity: false`. Rebuild and
restart after changing the shell. Server startup success alone is not renderer
verification: a first-launch smoke must also confirm that setup UI actually renders.

Polyth Desktop owns its first-run operator step. The trusted Electron main process
requests short-lived setup claims from the in-process setup lifecycle and exposes
them only through the context-isolated desktop bridge; the renderer never asks the
user for npm, a claim token, or a manual server restart. The claim broker
(`src/setupClaim.ts`) reuses a claim while it has more than a minute left, never
hands out an expired one, and rotates on `requestSetupClaim({ fresh: true })`. An
expired cached claim used to strand setup on "invalid claim" until the app
restarted. The setup screen binds the claim through the existing canonical setup
API only when the person continues past the account step, then Electron restarts
the local server on the same loopback port after account creation (also when a
reload lands on the setup server's ready state). Standalone/headless server setup
keeps the explicit `npm run setup:claim` operator flow. The screen contract is in
[UI §3.5](ui.md#35-first-run-setup-and-sign-in-screens).

Desktop boots the server with `desktopOwnerChannel: true`, which adds two
in-process lifecycle methods. When the person chooses "just me" or "me, from my
phone too", `desktop:setup:local` → `completeLocalSetup({ name })` finishes
setup without a password (`src/osDisplayName.ts` takes the name from the OS:
macOS `id -F`, the Linux GECOS field, otherwise the login name; renamed later in
Settings → Users → your account). While that owner has no password, every
server start (`startServer`) and `desktop:session:renew` call
`issueLocalOwnerSession()` and write the session with
`session.defaultSession.cookies.set` (httpOnly, SameSite=Strict, no expiry, so
it never rests in the profile's cookie database) for the window's loopback
origin; each call replaces the previous Desktop session. Protecting the
account (Settings → "Set a password…") first calls `desktop:session:confirm`:
the main process reads its own cookie and `confirmLocalOwnerSession(token)`
elevates that session for five minutes. The
token never crosses the bridge, so a browser or another app on the machine
stays at the sign-in screen. Cookies ignore ports, so the main process keeps
each `polyth_auth_*` cookie on the server it belongs to
(`src/sessionCookieGuard.ts`, `webRequest.onBeforeSendHeaders`). Once the owner sets a password the method returns
null and the window signs in like any browser. See
[Spaces §3.1](../architecture/spaces-and-tenancy.md#31-access-modes-accounts-or-a-password-less-desktop-owner).

## Connecting to another Polyth

The app is a client as well as a server: its window can show this computer's
Polyth or one elsewhere, and someone who only connects need not run a server at
all. There are two ways to reach a server.

- **Polyth Link.** On the other computer: Polyth Link → Pair device → *Copy pairing
  link*, because a computer cannot scan its own screen. The same invitation as the
  QR code, with the same safety words and approval. Every desktop build ships the
  Link host, Windows included (named-pipe IPC). The connection works across networks
  and keeps its device grants.
- **By address.** Any server already open in a browser, such as an HTTPS origin.
  The page is that server's own code, and it signs in like any browser.

### Parts

- **Server list** (`apps/web/src/components/DesktopServerList.tsx`). This
  build's shell on its own origin, `polyth-app://hub/`, answered from the shipped
  files with no server behind it (`src/hubProtocol.ts`, CSP by hash). It is the only
  page that may pair, connect or forget, and it reuses the phones' connection state
  machine (`ConnectionController`) over the main process. It opens whenever there is a
  choice to make; a server that opens takes over the window.
- **Link client** (`src/polythLinkClient.ts`). One `polyth-link-client stdio
  <data dir>` process, started on first use, JSON lines over stdin/stdout on all three
  platforms. When the app dies for any reason, stdin closes and the client ends; if
  the client dies, the window goes back through the list and reconnects at the same
  path. Its identity and connections live in `desktop/link-client/` under the app's
  user data, with Unix file modes where the platform has them. Unlike the phones it
  has no OS keychain, so the private key is protected like an SSH key.
- **Saved state** (`src/servers.ts`, `desktop/servers.json`). The server on screen,
  whether to run this computer's server, saved addresses, per-server microphone
  choices, and each Link server's proxy port. The port is part of the page's origin, so
  keeping it keeps that server's shell state between launches. It is kept apart from
  `settings.json`, which pages may read and write. Rollback: an older build ignores
  the file and opens this computer's server.
- **Switching.** The chip beside the Space switcher names the server when it is
  elsewhere and opens the native server menu; the same menu is in the account menu,
  the tray (Servers) and the app menu (Switch Server…). The command palette and
  Settings → Desktop open the list. Screens with no shell (sign-in, setup, "couldn't
  reach") carry *Choose another server*.

### Launch

`startupPlan` decides. The window returns to the server it was last on, through
the list for Link (`?open=<id>`) and directly for an address. *Keep this computer's
server running* in the list applies from the next launch; turning it off never stops
work in progress. If first-run setup never finished and the person goes to another
server, the setup server stops and the app counts as connect-only, since it held
nothing. Choosing This computer starts it again.

### What another server's page may do

`windowSurface()` sorts the sender's own frame URL into `local`, `hub`, `remote` or
nothing, and `channelAllowed` decides per channel. A `remote` page runs packages from
that server, so treat it as untrusted code in this window.

- It may move and report on the window, read display settings, go back to the list, quit
  the app and start an update it has already been offered. The last two are a nuisance at
  worst: updates stay signed, and quitting loses nothing durable.
- It may not pair, connect, forget, list saved servers, reach paths, the data folder,
  setup or the owner session. `desktop:info` hides the data and log paths from it.
- `settingsPatchFor` drops the choices that outlive the window: launch at login and
  automatic updates and their channel. These stay in the tray.
- It cannot call this computer's server. Sites ignore ports, so a Link page on
  `127.0.0.1` is the same site as that server and SameSite would let its session
  through; `blockedFromLocalServer` cancels every non-navigation request from any other
  page to that host, WebSockets too (`webRequest.onBeforeRequest`).
- This computer's session cookie goes only to its server, by name, even when an address
  shares its host (an SSH tunnel to `127.0.0.1:<port>`).
- The microphone asks once per server, by name; agents on another computer do not hold
  this one awake.
- Reveal-in-file-manager stays off (`localDesktopBridge`): those paths name files
  over there.

Known limit: two servers opened by address on one host name (two tunnels on
`127.0.0.1`) share a cookie jar, as they would in any browser, so each receives the
other's session cookie. This computer's session stays out of that, in both directions.

### Not verified

Live-tested only on Linux arm64 with debug binaries in an unpackaged Electron: pairing,
Link and address sessions, restart, connect-only launch, client crash, revocation and
blocked requests. `polyth-link-client` and `polyth-link-host` are type-checked for
`x86_64-pc-windows-gnu`, not linked or run here; the `link-client-windows` CI job runs
the client's stdio test and the host's named-pipe tests on a Windows runner. No
package, macOS or Windows window has run this, and no phone has paired with a Windows
host yet. The `arm64` Windows
release carries the x64 client under emulation because that job builds on an x64 runner.

## Command-line tool

The packaged app ships the `polyth` CLI as `resources/cli/polyth.cjs` (bundled
from `apps/desktop/src/cliEntry.ts` by `build.ts`). File → *Install Command-Line
Tool…* writes a user-owned launcher (`~/.local/bin/polyth`; Windows
`%LOCALAPPDATA%\Polyth\bin\polyth.cmd`, which the person adds to PATH) that runs
it with the app binary and `ELECTRON_RUN_AS_NODE=1`; an AppImage launcher points
at the stable `$APPIMAGE` file. The CLI reaches the running app through the
control socket in the desktop data folder. `polyth open` relaunches the app with
`--polyth-open=/p/…/s/…`; the single-instance handoff validates the path
(`cliInstall.ts`) and loads it in the existing window. See [CLI](cli.md).

## Node workers inside the app

The server runs in Electron's main process, so `process.execPath` is the app
binary, not Node. A script launched as `process.execPath <file>` without
`ELECTRON_RUN_AS_NODE=1` starts a second app instance that the single-instance
lock closes at once. Harness workers (Antigravity, Pi, Command Code) launched
through `createHarnessProcessAuthority` get the flag automatically
(`nodeModeSpawnOptions` in `packages/harness-runtime/src/processAuthority.ts`),
and their descendants inherit it. Any other `process.execPath` spawn must set it
itself, as `packages/server/src/agentTools.ts` does.

The server code is bundled into `app.asar`, so `new URL("../x", import.meta.url)`
points at a file that is not there and that no outside program could read. A
package's `assets/` folder ships to `resources/packages/<folder>/assets`; resolve
it through `POLYTH_RESOURCES_DIR` when the module-relative file is missing (see
`assetPath` in `packages/backend-deepseek/src/serverEntry.ts`).

On Windows a harness CLI installed by npm is a `.cmd` shim, which only starts
through `cmd.exe`, and Node joins that command line unquoted. Quote the shim path
and every argument (`windowsShimInvocation` in the process authority; probes quote
the path) or a path with a space splits.

## Local builds

Use Node 22.16 or newer (matching `scripts/check-node.mjs` and `.nvmrc`).

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

Build resources are generated by `scripts/prepare-icon.mjs` (`npm --workspace
@polyth/desktop run icons`; it needs sharp from the release tools, see
[Release tools](../operations/releases.md#release-tools)). The outputs
(`build/icon*.png` and `build/icons.stamp.json`) are committed and the build does
not regenerate them; `appIcon.test.ts` fails when a source changed without
regenerating. One brand master, `apps/web/icon-512.png`, produces two icons:
the 512px `build/icon.png` for the Linux/macOS slots and the tray, and the
256px `build/icon-win.png` for Windows. The master deliberately draws the mark
338px tall inside its 512px canvas — a ratio the mobile launch screens pin in
`apps/mobile/test/assets.test.ts` — but docks and taskbars paint an app icon
into their whole slot, so that margin made Polyth read smaller than its
neighbours. Both icons re-frame the same mark at the same aspect ratio onto an
88% fill (`APP_ICON_FILL`). Keep that fill in sync with
`apps/desktop/test/appIcon.test.ts` instead of editing the master.

The exact OpenCode release and SHA-256 digests are locked in
`apps/desktop/opencode.json`. `download-opencode.mjs` refuses a mismatched archive.
Connection failures and registry 5xx responses are retried a few times with a growing
delay (`POLYTH_OPENCODE_DOWNLOAD_ATTEMPTS`, default 4) because a CI runner that loses
the registry for seconds would otherwise discard the whole preceding native build;
a 4xx response fails immediately since it means the pin itself is wrong.
Packaged binaries live under `resources/opencode/<platform>-<arch>/`; the server always
receives that absolute path and never falls back to the system `PATH` for the binary
itself. The desktop marks that source as bundled, so Auto treats this downloaded
runtime as the fallback: it prefers a harness the user installed and authorized on the
host and uses the download only when none of those is runnable. Pinning OpenCode or
saving a harness preference still selects it explicitly. The desktop also publishes the
path as `POLYTH_OPENCODE_BUNDLED_BIN`, which `resolveOpenCodeBinary()` uses when a
caller names no binary: the process-free harness availability probe therefore reports
the bundle as installed on a machine with no OpenCode of its own, and Auto can choose it.
A credential-free OpenCode lists only its zero-cost `opencode/*` models (served with
OpenCode's public key), so a fresh install chats on those free models with no sign-up.
backend-opencode orders its catalog for the default (`src/modelOrder.ts`, both
protocols): models from a provider configured with real credentials first, then the
free tier (providers whose reported `apiKey` is `"public"`, plus zero-cost models of the
`opencode` provider even when signed in), then disconnected providers; ties keep
OpenCode's order. The composer and the global default fall back to the first available
model, so a configured paid provider becomes the default and the free tier is the
default only when nothing paid is configured. An explicit project or user default is
resolved before that fallback and always wins. The *Fastest / Balanced / Smartest
free* picks at the end of the catalog choose among those free models per turn; see
[OpenCode free auto-picks](../architecture/multi-harness.md#opencode-free-auto-picks). Web and server
installs ship no OpenCode: its harness reports "not installed" with an install action
on Settings → Harnesses, and the Providers & Models tour opens on a step that links
there.

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
to `cmd.exe`) and Windows command-line switches, while macOS/Linux use the user's
login shell — an explicit `SHELL` when the launcher provided it, otherwise the shell
recorded in the operating-system account database (`os.userInfo().shell`), with
`/bin/zsh` on macOS and `/bin/sh` elsewhere as the last resort. A packaged desktop
app launched from Finder/Dock does not inherit `SHELL`, so the terminal must not
silently drop to POSIX `sh`. That is the default (`auto`); Settings → Terminal can
pin another installed shell (PowerShell 7/Windows PowerShell start with `-NoLogo`).
Linux-only runtime containment and remote `flock`/
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

The default electron-builder provider is `Polyth/Polyth`; external-builder packages are rebuilt against the builder's own repository. `electron-updater` consumes the published GitHub Release metadata (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`, plus architecture-specific channels). Automatic updates are enabled by default in Desktop settings: the app checks shortly after startup and every six hours, automatically downloads an available release when that setting is enabled, and installs the downloaded update on quit/restart. Manual check/download/install remains available when automatic updates are disabled.

macOS updater releases require Developer ID signing and notarization; the release workflow remains strict and fails if those credentials are missing. `electron-updater` selects the matching x64/arm64 file from the shared `latest-mac.yml` feed. Manual `mac-dmg` builds use the same credentials when available. If they are absent, the manual workflow uses electron-builder ad-hoc signing (`mac.identity=-`) and disables notarization only for that smoke artifact. Ad-hoc DMGs are not trusted distribution artifacts and may require local Gatekeeper approval; they must never be published as a release of the signed `Polyth/Polyth` channel.

**Update channel** (Settings → Desktop; `updateChannel` in `settings.json`) picks Stable or Nightly builds from the release feed. A missing value defaults to the channel in the running build's version (`X.Y.N`, `X.Y.N-nightly`); a stored `test` choice and a `-beta` build from the retired Test channel follow Stable. `src/updaterChannel.ts` maps the choice onto electron-updater (`allowPrerelease` + `channel`), and `allowDowngrade` stays off after every switch. See [Release channels](../operations/releases.md#release-channels).

### macOS 12 build

Electron 44 requires macOS 13, so the regular macOS package refuses to start on macOS 12 Monterey ("requires macOS 13.0 or later"). The external builder's `mac-dmg-legacy` target (`scripts/ci/mac-legacy.mjs`, run by `remote-build.mjs` on an Intel runner) packages the same source for macOS 12 as `Polyth-<version>-mac-legacy-x64.dmg`/`.zip`: Intel only (every Apple silicon Mac runs macOS 13), Electron 43 through `--config.electronVersion` (native modules are rebuilt for it), `LSMinimumSystemVersion` 12.0, and the build define `POLYTH_DESKTOP_FLAVOR=mac-legacy`. The job fails unless the packaged app reports both values. Electron 43 is the last line that runs on Monterey and leaves support on 2027-01-05; after that this package gets no Chromium security fixes and should be retired (drop the target, its matrix entry and `legacy-mac.yml`).

Its updates come from `legacy-mac.yml`, which only this build reads (updater channel `legacy`, prereleases off, so it follows stable releases only, whatever **Update channel** says). The regular `latest-mac.yml` never names it. Settings shows the channel as a fixed **Stable** (`DesktopInfo.macLegacyUpdates`). With prereleases on, electron-updater would read the prerelease's own metadata and fall back to `latest-mac.yml`, the regular build that cannot start on 12. Once the Mac runs macOS 13 or newer (`process.getSystemVersion()`), the same build follows the regular channels, and its next update replaces it with the regular package. Unverified: the Playwright Chromium behind the agent Browser and the bundled OpenCode (a Bun binary) are the macOS builds the regular package ships, and neither has been run on macOS 12. The source typechecks against the Electron 43 typings; the package itself has not been run on a macOS 12 machine.

The external builder feed (see [Release operations](../operations/releases.md#external-builder-feed)) signs and notarizes macOS builds with Developer ID only when its Apple secrets are set; otherwise its macOS builds are ad-hoc signed, so Squirrel.Mac can never accept a later build in place. At startup `src/updaterInstallMode.ts` reads `codesign -dv`; for `Signature=adhoc` the app still checks the feed and reports a new version, but never downloads or installs it. **Download** opens the GitHub release page, and the user replaces the app by hand. Windows (unsigned NSIS, no `publisherName`) and Linux (writable AppImage) builds from that feed update in place.

**Update window and silent install.** A download the user asks for (the notice's **Download**, Settings, the update window's own buttons) opens a small frameless window in the bottom-right corner of the work area (`src/updateWindowView.ts` for its content and placement, `src/update-window.html` + `src/updateWindowPage.ts` for the page, `src/updateWindowPreload.ts` for its bridge; main accepts its `desktop:update-window:*` IPC only from that page). It shows the download (percent, bytes, speed) and closes on **Hide**; the tray item reopens it, and a watched download reopens it when it ends with the restart prompt (**Later** / **Restart now**) or an error (**Try again**). Background (automatic) downloads do not open it. **Restart now** sets the `installing` phase, shows the window while Polyth hides its main window and stops the server, records `desktop/update-pending.json` (`{version, from}`), then calls `quitAndInstall(true, true)`: on Windows NSIS runs with `/S --updated --force-run`, so no installer wizard appears and Polyth starts again by itself (a per-machine install still gets the Windows UAC prompt). NSIS cannot replace a running app, so the install itself happens after Polyth closes; the next start reads the pending file and shows `installed` (auto-closing after 8 s) or an `error` that the update did not install. If the installer cannot start at all, Polyth relaunches the old copy, which then reports that failure. If the page never reports `ready-to-show`, the window is still revealed after 1.5 s rather than staying hidden, so a broken bundle or a missing html file cannot leave the handover without any progress surface. The main-window notice steps aside as soon as the small window exists (`progressWindow` in the update state), not only once it paints: both surfaces share the bottom-right corner, and a notice that outlived window creation could be covered by a window that has not finished loading. The window's strings are English, like the tray menu. Its mark is the 256px app icon inlined by `build.ts` as a `data:` URL (the page's CSP allows only `data:` images): a file path would break once the installer starts removing the old copy while *Installing…* is shown.

The renderer learns about updates only through the preload bridge: `onUpdateState` events plus `getUpdateState()` (IPC `desktop:update:get`) for a state found before the window mounted or reloaded. Main stamps every state with `installMode` (`in-app` | `manual`). Besides the tray menu and **Settings → Desktop → Update status** (a themed bar with a percentage readout, indeterminate until the first progress tick, never the browser's native `<progress>`, and no extra action while the bar is already on screen), `apps/web/src/desktopUpdateNotice.tsx` (a renderless controller in the desktop contribution to `app.window.controls`) shows one persistent notification of the shared stack (`host.desktop-update`, kind `update`, then `progress` while downloading; [ui.md §4.8](ui.md#notifications)): a found release with **Download** (or **Open download page** on manual builds), its download progress, a ready update with **Restart to update**, and a non-dismissible **Installing…** card with an indeterminate spinner while the app hands over. That card remains until the small update window exists; without it, a slow server shutdown after the click looked like a frozen app, and a window that never appeared left no feedback at all. Closing it records `found:<version>` or `ready:<version>` in `localStorage` (`polyth.desktop.updateNotice.dismissed`), so a finished download or a newer version shows again. Builds that predate this card (or the external feed) still need one manual install before they can show it.

## Workstation edition build

The workstation edition is a local-only shell for coding harnesses on a managed work computer (rules and network endpoints: [workstation edition](../security/workstation-edition.md)). It is the same app (`com.polyth.desktop`, product name Polyth) built for every desktop target and published as extra assets on the same GitHub release. `scripts/ci/workstation.mjs` owns the build helpers; `remote-build.mjs` targets `mac-dmg-workstation` (arm64 and x64), `windows-exe-workstation` and `linux-appimage-workstation` run them.

- **Flavor.** `POLYTH_DESKTOP_FLAVOR=workstation` for `build:desktop`: `build.ts` bundles only packages whose manifest lists `"editions": ["workstation"]`, builds no Link binaries and removes `resources/chromium`. These targets skip `desktop:stage-chromium` and the Playwright download.
- **electron-builder configuration.** `workstationBuilderArgs` derives a full config from the `build` field of `apps/desktop/package.json` and passes it as `--config <file>`. electron-builder 26 reads only that file in place of the `build` field (`app-builder-lib` `util/config/load.js`), so the file is complete; relative `from` paths still resolve against `apps/desktop`; later `--config.*` flags merge on top. The derived config names artifacts `Polyth-<v>-<os>-<arch>-workstation.<ext>` (the edition after `<os>-<arch>`, so no standard-name filter can match it), drops the `chromium` and `polyth-link` extra resources, narrows the `packages` resource to `<id>/dist/web/**` and `<id>/assets/**` of workstation packages, excludes `node_modules/playwright-core/**` from the app files and sets the publish channel `workstation`. Output goes to `release/{mac-workstation-<arch>,win-workstation,linux-workstation}`.
- **Package check.** After electron-builder, `assertWorkstationPackage` fails the job when the unpacked app has `resources/chromium`, any `resources/polyth-link` file, a `resources/packages/<dir>` outside the workstation list, or when `build-meta/main.metafile.json` (esbuild's inputs for `dist/main.js`) reads a feature package (`polyth.serverEntry`) outside the list or `playwright-core`.
- **SBOM and sums.** `workstationSbom` writes a CycloneDX 1.5 document from the same metafile (every bundled `node_modules` package, Electron, the bundled OpenCode); `update-feed.mjs` adds `SHA256SUMS-workstation.txt` over every workstation asset.
- **Updates.** The build reads `workstation*.yml` (channel `workstation`, prereleases off) from the latest stable release; see [release operations](../operations/releases.md#workstation-edition-assets). The Linux job runs the startup smoke test under Xvfb instead of `appimage-e2e.mjs`, which drives the Link host this edition does not ship. While the edition tracks devel, a nightly build replaces those assets on the newest stable release; the app code and its updater channel are unchanged.

## Window chrome and interaction

The renderer header is the title bar: one `--desktop-titlebar-h` band (52 px, mirrored
by `DESKTOP_TITLEBAR_HEIGHT` in `apps/desktop/src/windowChrome.ts`, pinned by tests) on
which macOS and Linux centre their caption controls; Windows keeps its native caption
height (below). `windowChrome.ts` owns the per-platform
`BrowserWindow` chrome:

- **macOS** — `titleBarStyle: "hidden"` with `trafficLightPosition` centring the native
  traffic lights on the header. The OS draws them in DIP, so they do not scale with page
  zoom while the header band does: the renderer (`MacCaptionSync` in `desktop.tsx`) sends
  the band height through `syncCaptionControls` (`desktop:window:caption`) on every resize
  or zoom change, main re-centres the lights in DIP (`macTrafficLightPosition`) and returns
  the applied position read back with `getWindowButtonPosition()`, converted to CSS px
  (`macCaptionGeometry`). The caption zone (`--desktop-macos-titlebar-inset`, inline on
  `<body>`) is that extent plus a 14 px gap: 86 px at 100 %, wider below it, where a fixed
  86 px ended under the green light. Electron exposes the lights' position but not their
  size, so the 54×14 DIP group (`MACOS_TRAFFIC_LIGHT_GROUP`) is the one assumed constant;
  a shell without the call keeps the 86 px CSS default. The zone drops in fullscreen (the
  lights hide there).
- **Windows** — `titleBarStyle: "hidden"` with the native Window Controls Overlay, so the
  caption buttons, Snap Layouts flyout, rounded corners, and shadow are the operating
  system's. The caption zone takes the overlay's rectangle as `desktop.tsx` measures it
  with `navigator.windowControlsOverlay.getTitlebarAreaRect()` on every `geometrychange`
  (`--desktop-wco-left/-right`, inline on `<body>`, rounded up so at 125 % and 150 %
  scaling no sliver of content sits under a button's hover fill), falling back to the
  `titlebar-area-*` environment variables before the first measurement; its side comes
  from the same rect, so a mirrored system UI moves it. Real 125–150 % hardware is not
  verified. The overlay
  background is fully transparent: the renderer sends the window background with zero
  alpha (`#rrggbb00`), so Windows paints only the glyphs and their hover/press fills over
  whatever surface the layout puts in the zone — the header's material, a column's head,
  the workspace backdrop — instead of a solid patch of one sampled color that matches
  none of them. The glyphs take the header's control ink (`--text-dim`, the color the
  renderer's own caption buttons use, so both platforms read the same) and the overlay is
  as tall as the caption band (the `.desktop-caption-zone` box), which on Windows is the
  system's standard 32 px caption (`--desktop-caption-h`, mirrored by
  `WINDOWS_CAPTION_HEIGHT`, the overlay's height before the renderer reports): Electron
  keeps each caption button 46 DIP wide and stretches it to the full overlay height, so an
  overlay as tall as the 52–84 px header made tall slab buttons. The buttons sit flush in
  the window's top corner, as in native Windows apps. Both go through
  `setTitleBarAppearance`; main accepts `#rrggbbaa` for the background but only `#rrggbb`
  for the glyphs, scales the height by the page zoom (bounded to 28–160 DIP, the caption
  height at the 500 % zoom ceiling), and calls `setTitleBarOverlay`
  (Electron documents `#RRGGBBAA` overlay colors; below full alpha its caption-button
  container stops filling its layer). A shell that rejects the alpha form gets the opaque
  window background instead.
- **Linux** — frameless and transparent; the renderer clips the rounded sheet to
  `--radius-sheet` and draws Polyth's vector caption buttons inside the header row. The
  cluster is header chrome, not a bespoke surface: the same compact control geometry as the
  header's own icon buttons (`--control-h-sm`, `--radius-control`), the `--surface-overlay`
  fill (`--surface-overlay-hover/-strong` on hover/press), the cut-glass chip material under
  glass, and the shared danger pair (`--red` on `--red-ink`) on the close button's
  hover/focus/press. By default (`controlsFollowSystem`, the setting's **Auto**) the
  buttons follow the desktop environment's own layout — side, order and set — read by
  `apps/desktop/src/linuxButtonLayout.ts`: GNOME-family `button-layout` through
  `gsettings` (Cinnamon and MATE schemas too), KWin's `kwinrc` `ButtonsOnLeft/Right`, and
  xfwm4's `button_layout` through `xfconf-query`, each bounded to 1.5 s and `null` on any
  failure. GNOME's default `appmenu:close` shows Close alone; a split layout keeps only the
  side that holds Close. Main reads it when the window opens and again on focus (at most
  every 5 s), and sends it in window state (`systemControls`), so a change in the desktop's
  settings lands without a restart; `--desktop-controls-count` sizes the cluster. Choosing
  Left or Right turns following off (left uses close-minimize-maximize order); a settings
  file from before the option follows the system unless it had moved the buttons left, and
  a renderer that sends only a side also turns it off. Desktop settings also choose an
  Auto/Dark/Light button theme. Auto follows the Polyth theme; Dark/Light pin a
  fixed scheme over the sampled/glass look, and the setting never touches `nativeTheme`, so it
  cannot repaint the app through `prefers-color-scheme`.

Every platform names the corner its caption controls own, the **caption zone**:
`desktop.tsx` publishes its side as `body[data-desktop-caption]` (`left`/`right`, absent
in macOS fullscreen) and renders an empty, unpainted `.desktop-caption-zone` box in
`<body>`; `styles.css` sizes it per platform as `--desktop-caption-left/-right` (a
physical width at each top corner, breathing room included) and `--desktop-caption-h`
(the band the controls centre on). Nothing renders under the zone. The classic header pads
by it. In the full-height layouts (`columns`, `bare`) the workspace starts where the band
ends (`--desktop-caption-band`); an expanded navigator under the zone keeps its full height and
starts its content below the band, while a collapsed one (46–49 px, narrower than the
traffic lights or any caption cluster) starts below the band entirely, so the controls
never straddle its edge, and the navigator away from it keeps only the title
bar's drag band (a no-drag strip carves the taller band out of its rows); the launcher column on that side is narrower than the
zone (the Windows overlay alone is three 46 px buttons), so the whole column — idle strip,
pinned or floating window, full-window layer, and a closing window on its way back to the
tablet-width cluster — starts below the band, level with the workspace (a bottom or narrow
dock keeps its full-height host and moves only its strip); and the bar between the columns
measures the zone like its other overlays and stops a column gap short of it
(`shellLayout.css`, `Header.tsx`). On Linux the band is centred on the bar's row: it
grows by the row's top inset above and below — Floating columns' edge inset, and the
island capsule's extra step (52 px flush spread, 68 px floating spread or flush island,
84 px floating island). macOS keeps the window's traffic-light position and Windows its
32 px caption in the top corner; the drag band (`.app::before`) stays at least the title
bar's height there. Pinned by
`apps/web/test/desktopWindowChrome.test.ts`.

Window state (`maximized`, `fullscreen`, `focused`) reaches `<body>` as `data-desktop-*`
attributes: maximized/fullscreen windows square their corners and an inactive window's
Linux buttons fall flat — no fill, edge or shadow, a 55 % glyph, eased — and come back
on hover, while the Windows overlay's glyphs take the muted ink (`--muted`). The Desktop settings page shows the button preferences only on
Linux. A window saved maximized is maximized when first shown, never while hidden (on
Windows `maximize()` would show a start-hidden window).

The caption controls layer at `--z-window-controls` (`--z-overlay` + 5): above scrims and
drawers, so the window stays closable and movable-by-menu while Settings or a dialog is open,
but below toasts, popovers, and tooltips. They never cover content because every layer that
fills the window starts its content below the caption band (`--desktop-titlebar-reserve`,
equal to `--desktop-caption-h`: the title bar, taller where the bar's row hangs lower,
Windows' 32 px caption there):
dialog and
sheet backdrops, the Settings scrim and shell,
the lock screen, the phone-width session drawer, and the phone-width package layers
(`.module-view--main`, `.rail-fullscreen`, `.panel-sheet`). The scrim still dims the whole
window. A new full-window layer must honour the reserve; pinned by
`apps/web/test/desktopWindowChrome.test.ts`.

Renderer controls, dialogs, and modal scrims are explicitly excluded from Electron
drag regions. The Linux control group passes pointer events through its empty space, so
opening Settings or entering Canvas edit mode cannot make an underlying close/edit
control inert.

### Native menus

The application menu (macOS menu bar; Windows/Linux keep accelerators without an in-window
menu bar) carries Settings, New Chat, Search Chats, and Command Palette. Their shortcuts are
displayed with `registerAccelerator: false`: the renderer keymap (`@polyth/hotkeys`, which
honours remapping) stays the single owner, and a menu click sends a `desktop:command` that
the renderer maps to the shell's `cmd.*` commands. Electron draws no context menu by itself,
so main supplies one for text fields (undo/redo, cut/copy/paste, select all), selections,
external links, and spelling suggestions; a page that draws its own menu calls
`preventDefault()` and suppresses it. Windows sets the AppUserModelID to the installer
`appId` (`com.polyth.desktop`) so toast notifications and taskbar grouping are attributed to
Polyth. The tray glyph uses each platform's notification-area size (16/18/22 px).

Only Linux chrome has a real packaged-run check (the AppImage E2E below); macOS traffic-light
centring and the Windows overlay are source-inspected and fixture-rendered, not
device-verified.

## Background integration

Close-to-tray and start-hidden behavior are configurable on every platform. Launch at
login uses native login items on macOS and Windows, and an XDG autostart entry pointing
at the stable `APPIMAGE` path on Linux. Login starts pass `--background` so the app
opens directly into the tray. The optional keep-awake setting uses Electron's
app-suspension blocker for long-running agents. `keepAwakeMode` chooses when
main holds it: `working` (the default) only while the renderer reports a
working agent, `always` for as long as Polyth runs. A settings file written
before modes with `keepAwake: true` normalizes to `always`, so it keeps its
old behaviour. The renderer (`apps/web/src/desktopKeepAwake.tsx`) reports
`setAgentActivity` only on change (any session the window knows in `working`);
main forgets the report when the page navigates or the renderer dies, and the
page withdraws it on teardown. Main broadcasts `desktop:keep-awake:state`
(`enabled`, `mode`, `working`, `active`), which drives the status-bar cup
segment (`desktop.keep-awake`: faint when off, muted while waiting for work,
green with "Awake" while held; a click toggles keep-awake). The decision is
`keepAwakeWanted` in `apps/desktop/src/keepAwake.ts`. Only sessions this
window has loaded count as work; source-inspected and unit-tested, not
device-verified.

## Diagnosing a frozen window

The server runs inside Electron's main process, so anything that holds its thread
also stops the window: synchronous store reads, a synchronous process start, a long
JSON parse. `polyth-desktop.log` in the app's `desktop` user-data folder tells the
cases apart:

- `Event loop blocked for …s` means the server held the main thread.
- `Window page stopped responding` means the page itself froze while the main
  process kept running.
- Neither line during a freeze points outside this process: harness children, the
  disk or a scanner. Compare with Task Manager while it happens.

## Low-resource mode

Desktop settings includes an opt-in low-resource mode for older machines. It
disables interface animations, haptics, and live backdrop blur immediately.
After restart it also:

- defers the OpenCode model/agent catalog until the first user interaction;
- disables built-in spellcheck;
- caps Chromium's disk cache at 32 MiB;
- reduces server terminal replay from 200 KiB to 64 KiB per terminal;
- reduces renderer terminal scrollback from 5,000 to 1,000 rows;
- limits concurrent terminal child processes to four; and
- starts with a smaller 1100×720 window when no saved bounds exist.

The independent **Reduce animations and effects** setting applies the same
motion, haptic, and glass reduction without changing runtime or cache limits.

OpenCode starts normally as soon as the user interacts with the application, so
agent, model, terminal, and workflow behavior remains available.

Low-resource mode keeps GPU acceleration. A separate **Software rendering**
setting (`softwareRendering`, default off, applies after restart) calls
`app.disableHardwareAcceleration()`; it exists only as an escape hatch for
broken graphics drivers. On integrated GPUs software compositing moves every
scroll and typing frame onto the CPU and was measured to make the UI slower,
so the two settings must not be coupled again. Existing settings files that
enabled low-resource mode are not migrated to software rendering.

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

It finishes first run the way the default "just me" answer does (`completeLocalSetup`,
no password; the account form only for shells without it), then checks server health,
the in-process owner session, the sandboxed preload bridge, the contributed Desktop settings
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
- Preload: a fixed API for settings, window actions/state, title-bar overlay colors,
  native menu commands, updates, absolute local paths and the server list.
- IPC: decided per channel from the sender frame's own origin
  (see [What another server's page may do](#what-another-servers-page-may-do)).
- Navigation: a page stays on its own origin, and only the server list may hand the
  window to a server it connected; allowlisted HTTP(S)/mailto links open in the system browser.
- Permissions: only audio capture (not camera/video) and notifications. Another server asks once for the microphone.
- Server: binds to `127.0.0.1` in desktop mode.
- Secrets: desktop settings contain presentation and lifecycle preferences only.
