# Ways to run Polyth

Polyth is always one server that owns your data, sessions and agent runtimes. The
clients (browser, desktop window, phone) connect to it. Pick the setup that fits;
the [quick start](../../README.md#quick-start) covers the first one.

| Setup | Server runs | Reach it from | Start here |
|---|---|---|---|
| [Local from source](#local-from-source) | your machine, `npm start` | this machine's browser | `npm start` |
| [Packaged server](#packaged-server) | any machine with Node.js, no checkout or build tools | this machine's browser, or via a proxy | `npm run build:server` |
| [Development supervisor](#development-supervisor) | your machine, auto-rebuild and restart | this machine's browser | `npm run watch` |
| [Docker, this machine](#docker) | container on Linux, host network | this machine's browser | `deploy/docker/compose.yml` |
| [Docker behind HTTPS](#docker) | container and Caddy TLS proxy | any browser, `https://your.domain` | `deploy/docker/compose.proxy.yml` |
| [Your own HTTPS reverse proxy](#behind-your-own-https-reverse-proxy) | your machine or VPS, `npm start` | any browser via your proxy | `POLYTH_PUBLIC_ORIGIN` |
| [Desktop app](#desktop-app) | inside the app (bundled OpenCode and Chromium) | the app window | `npm run desktop:dev` |
| [Phone via Polyth Link](#phones-and-remote-devices) | any of the above | Android or iOS app, paired | `npm run build:mobile` |
| [Disposable beta](#debug-and-disposable-modes) | temporary data, loopback | this machine, no login | `npm run agent:beta` |

## Local from source

You need Node.js 22.16 or newer and at least one supported agent CLI installed and
signed in. Then `npm install`, `npm run build`, `npm run setup:claim` (first run only,
with the server stopped) and `npm start`. The server binds `127.0.0.1` and keeps
everything in `POLYTH_DATA_DIR`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4400` | HTTP port |
| `HOST` | `127.0.0.1` | Listen address. Without a public origin, browser sign-in works only over direct loopback |
| `POLYTH_DATA_DIR` | `./data` | Data directory (one running server per directory) |
| `POLYTH_PUBLIC_ORIGIN` | none | HTTPS origin when published behind a TLS proxy (requires `POLYTH_TRUSTED_PROXIES`) |
| `POLYTH_TRUSTED_PROXIES` | none | Comma-separated exact proxy addresses allowed to report forwarded TLS |
| `POLYTH_CHROMIUM_PATH` | auto | Chromium executable for the built-in browser |
| `POLYTH_LINK_HOST` | auto | `polyth-link-host` executable (otherwise `target/release` after `npm run build:link`) |
| `POLYTH_DEBUG_AGENT_ACCESS` | none | `1` allows loopback API access without sign-in, see [debug modes](#debug-and-disposable-modes) |

## Packaged server

`npm run build:server` builds one archive for the machine it runs on:
`apps/server/release/polyth-server-<version>-<platform>-<arch>.tar.gz` and its
`.sha256`, plus the same tree split for npm in `apps/server/release/npm/`: `polyth`
(the code and the `polyth` command, identical on every platform) and
`@polyth/server-<platform>-<arch>` (`resources/` for one platform, installed by npm
only there through `os`/`cpu`). The server takes `resources/` beside itself, else
from that package, and refuses one of another version. Inside is the server with every server package compiled in, the web app,
`polyth-link-host`, the runtime supervisor (Linux) and the four runtime dependencies
that cannot be bundled (`node-pty`, `playwright-core`, `esbuild`, `typescript`). The
machine that runs it needs Node.js 22.16 or newer and the agent CLIs, nothing else:
no checkout, no compilers, no development dependencies. The layout is described in
`apps/server/src/layout.ts`; `resources/` has the same shape as Desktop's resources
directory and is the server's `POLYTH_RESOURCES_DIR`.

Releases publish it through three channels, all the same tree:
[npm](https://www.npmjs.com/package/polyth) (`npm install -g polyth`, which pulls the
matching `@polyth/server-<platform>-<arch>`), the
[Homebrew tap](https://github.com/Polyth/homebrew-tap) (`brew install polyth/tap/polyth`,
then `brew services start polyth`) and the archives on each GitHub Release
([publication](releases.md)). An npm or Homebrew install puts `polyth` on the `PATH`;
an unpacked archive runs `bin/polyth.mjs` with Node:

```bash
tar -xzf polyth-server-<version>-linux-x64.tar.gz -C /opt   # unpacks /opt/polyth
node /opt/polyth/bin/polyth.mjs server setup-claim           # first run only, server stopped
node /opt/polyth/bin/polyth.mjs server start                 # foreground
```

`bin/polyth.mjs` is the ordinary [`polyth` CLI](../../packages/cli); in a packaged
install `polyth server start`, `setup-claim` and `break-glass` run the bundled entries
instead of a checkout's npm scripts, and `start` turns the CLI process into the
server, so a service manager's stop signal reaches the server itself. Without
`POLYTH_DATA_DIR` the data lives in `~/.local/share/polyth-server/data` (Linux,
`XDG_DATA_HOME`), `~/Library/Application Support/Polyth Server/data` (macOS) or
`%LOCALAPPDATA%\Polyth Server\data` (Windows), apart from Desktop's, so both can run on
one machine. Every variable of [Local from source](#local-from-source) applies.

Run it under the machine's service manager with one command:

```bash
polyth service install                      # systemd --user unit, or a macOS LaunchAgent
sudo polyth service install --system --run-as polyth --env-file /etc/polyth/polyth.env
polyth service status
polyth service uninstall
```

`install` writes `polyth.service` (Linux: `~/.config/systemd/user/`, or
`/etc/systemd/system/` with `--system`) or `app.polyth.server.plist` (macOS:
`~/Library/LaunchAgents/`, or `/Library/LaunchDaemons/`), then enables and starts it.
It records `POLYTH_DATA_DIR` (`--data-dir` or `POLYTH_DATA_DIR`, else the default above
for the account the service runs as, which is where `polyth update` run by that account
looks; with another directory, pass it to `polyth update` too) and, when given,
`--host` and `--port`; it never writes tokens or secrets, so put those in the
`--env-file` (systemd). A user service needs `loginctl enable-linger $USER` to run
without a login session; a system service never runs as root unless you name it.
`--dry-run` prints the file and commands, `--no-start` only writes, `--force` replaces
an existing file and restarts the service with it. A hand-written unit
(`ExecStart=/usr/bin/node /opt/polyth/bin/polyth.mjs server start`, `KillMode=mixed`,
`Restart=on-failure`) still works.

### Updating a packaged server

```bash
polyth update --check              # installed and newest release of this install's channel
polyth update                      # install it, restart, confirm
polyth update --channel nightly    # or --version 1.2.357; --no-restart installs only
polyth update --rollback           # back to the release the last update replaced (archive)
```

`polyth update` works out what installed it. An npm install is updated with
`npm install polyth@<version>` (global or in its prefix). A release archive downloads
`polyth-server-<version>-<platform>-<arch>.tar.gz` from the release, checks it against
the release's `SHA256SUMS-server.txt`, unpacks it into `<install>/.update-<version>/`
and swaps it in place: the current entries move to `<install>/.previous/`, so the
paths a service names never change and the server's own user, which owns the install,
can update it. Homebrew, Docker and checkout installs are told the command their
manager uses instead. Releases come from `POLYTH_UPDATE_REPOSITORY` (default
`Polyth/Polyth`); `POLYTH_UPDATE_RELEASES_URL` may name a mirror that answers in the
shape of GitHub's releases API, for hosts without GitHub access.

When a systemd or launchd service from `polyth service install` runs this install
(its command names this install's `bin/polyth.mjs`; a `polyth.service` that runs
another install is left alone), the update restarts it and waits up to ten minutes
for the server to answer with the new version. The server drains the turns running
at SIGTERM before it exits. If it does not come back, the previous release is put
back and restarted. Without such a service the update says that the server still
runs the old release until it is restarted; the running server keeps its files, but
the web assets it serves already belong to the new release. One update runs at a
time (`.polyth-update.lock` beside the install).

With `POLYTH_UPDATE_REPOSITORY` set, Settings → About offers a newer stable release
with the command for this install: `polyth update`, Homebrew's
`brew upgrade polyth && brew services restart polyth`, `docker compose pull` in a
container, or the checkout's `git pull` sequence.

### Automatic updates (npm and Homebrew)

Settings → About → **Update automatically** lets the instance owner have an npm or
Homebrew install update itself (off by default; other accounts see the state, and
release-archive, Docker and checkout servers do not show the row). The server owns
it (`packages/server/src/serverAutoUpdate.ts`, drivers in
`apps/server/src/selfUpdate.ts`, setting in `<data>/server-auto-update.json`):

1. Every six hours it asks for the newest release of its channel: npm reads
   `npm view polyth@latest` (`@nightly` for a nightly install), Homebrew reads the
   latest stable GitHub release of `POLYTH_UPDATE_REPOSITORY` (default
   `Polyth/Polyth`), because the tap carries stable releases only.
2. A newer release waits until no chat is `working`, `reconciling` or `waiting` on
   its person (a question unanswered for 12 hours no longer holds it).
3. The package manager installs it: `npm install [--global | --prefix <p>]
   polyth@<version>` with the npm beside the server's Node, or `brew update` +
   `brew upgrade polyth` with the Homebrew the keg lives in and
   `HOMEBREW_NO_INSTALL_CLEANUP=1`, so the running server's keg stays until the
   restart. The new tree must answer `polyth --version` with the new version; an npm
   install that does not is put back to the running version.
4. Once no chat is working again, the server writes the attempt down, shuts down
   gracefully and exits with code 75. Its service starts the new release:
   systemd `Restart=on-failure` (`polyth service install`, or `brew services` on
   Linux) or launchd keep-alive on an unsuccessful exit (`polyth service install`,
   `brew services`). The next boot reports *Updated from X to Y*, or that it came
   back on the old version.

The row is disabled with the reason when nothing would restart the server: the
process must run in Polyth's own systemd unit (`polyth.service`,
`homebrew.polyth.service`, read from `/proc/self/cgroup`) or launchd job
(`app.polyth.server`, `homebrew.mxcl.polyth`); set `POLYTH_SUPERVISED=1` for another
supervisor that restarts on a non-zero exit. It is also disabled when the server's
account cannot write the npm install, or when it runs as root under Homebrew. A
failed release is retried after a day; a Homebrew tap that does not offer the new
version yet is asked again at the next check. There is no automatic rollback after
the restart: a release that does not start needs `polyth update --version <old>`
(npm) or the previous keg (Homebrew), and the pre-migration copies below.

Every server, however it was installed, copies a canonical database before it
migrates its schema: the control plane (`control-plane/control.sqlite`) and the
session history (`sessions.db`) go to
`<data>/pre-migration/<name>-before-<version>-<time>.sqlite`, the three newest per
database are kept, and a copy that would leave less than 512 MB free is skipped with
a log line. Schema changes are forward-only and an older server refuses a control
plane migrated past it, so going back to an older version after a migration means
restoring these copies: stop the server, copy each snapshot over its database,
delete that database's `-wal` and `-shm` files, start the older version. `polyth
update` prints these steps when the previous release does not start either.

`polyth server restart` is the checkout's rebuild-and-restart and is refused in a
packaged install: restart through the service manager. Releases publish these archives
and the npm packages ([Nightly builds from devel](releases.md#nightly-builds-from-devel)).

Building needs the web build (`build:server` runs it first), `cargo` for
`polyth-link-host` unless `POLYTH_LINK_BIN_DIR` names a directory that already has it,
and a C compiler on Linux for the supervisor. `POLYTH_VERSION` sets the version (the
root `package.json` version otherwise). The build copies the runtime dependencies from
`node_modules` and refuses, under `CI`, versions that differ from `package-lock.json`;
locally it warns. `npm run smoke --workspace @polyth/server-app [archive]` unpacks an
archive into a temporary directory, completes first-run setup through the HTTP API the
setup page uses, restarts into the full server, signs in, makes an authenticated
request and stops it.

## Development supervisor

```bash
npm run watch                        # build, start, rebuild and restart on change
npm run watch -- --restart=never     # rebuild without restarting the server (handy while agents work)
```

`npm run watch` restarts the server for `packages/*/src` changes, rebuilds bundles for
`packages/*/widgets` and `apps/web/src` changes, and restarts the server with backoff
if it exits. File watching is only a latency optimization: the supervisor also sweeps
the source roots every couple of seconds, so a change whose event was dropped is still
rebuilt. `npm run watch -- --help` lists the flags.

## Docker

The root [`Dockerfile`](../../Dockerfile) builds the server with its web bundles, the
runtime supervisor, a pinned OpenCode binary, `git`, `gh` and the Polyth Link host;
the `polyth-browser` target adds Chromium. Data, home (agent sign-ins) and your
projects are volumes: `/data`, `/home/node` and `/workspace`.

```bash
cd deploy/docker
cp .env.example .env                        # set POLYTH_UID/GID to `id -u`/`id -g` and POLYTH_WORKSPACE
mkdir -p workspace                          # default POLYTH_WORKSPACE, mounted at /workspace
docker compose build
docker compose run --rm polyth setup-claim  # first run, server stopped
docker compose up -d                        # http://127.0.0.1:4400; `docker compose restart polyth` after setup
```

`compose.yml` uses host networking (Linux Docker Engine) because a published bridge
port does not arrive over loopback and sign-in would be refused. For access from
other machines use `compose.proxy.yml`, which puts Polyth behind Caddy with automatic
HTTPS on `POLYTH_DOMAIN`. Image variants, build arguments, agent sign-in, upgrades and
backups are in [Running Polyth in Docker](docker.md).

## Behind your own HTTPS reverse proxy

Run the server on a non-loopback address and declare the public origin and the
proxy's exact address:

```bash
HOST=0.0.0.0 POLYTH_PUBLIC_ORIGIN=https://polyth.example.com POLYTH_TRUSTED_PROXIES=10.0.0.5 npm start
```

The proxy must terminate TLS, forward the original `Host` and set
`X-Forwarded-Proto: https`; forwarded headers from any other peer are ignored. Never
expose plain HTTP on a public interface. The first-run setup page does not accept
proxy-terminated TLS, so create the owner account once over loopback (plain
`npm start`, or an SSH tunnel), then start with the public origin.

## Desktop app

Polyth Desktop (Electron) runs its own loopback server with bundled OpenCode and
Chromium and handles first-run setup itself. It can also show Polyth running on another
computer, through Polyth Link or by address, with or without a server of its own.
Installers (AppImage, DMG, NSIS EXE) are on
[polyth.app/download](https://polyth.app/download/); release channels and the update
feed are described in [Releases](releases.md). From source:

```bash
npm run desktop:dev          # build, download the pinned OpenCode, launch
npm run desktop:dist:linux   # or desktop:dist:mac / desktop:dist:win
```

See [Polyth Desktop](../dev/desktop.md).

## Phones and remote devices

The Android and iOS app is a client for an existing Polyth server. Pair it by QR code,
nearby discovery or a six-digit code, approve it on the computer, and it reconnects on
its own afterwards. The host needs the `polyth-link-host` executable
(`npm run build:link`; bundled in the desktop app and the Docker image). Build the app
with `npm run build:mobile`, then `npm run mobile:open:android` or
`npm run mobile:open:ios`. See [Polyth Link on mobile](../mobile/polyth-link.md).

## Debug and disposable modes

- `npm run agent:beta` builds and runs a disposable loopback instance with temporary
  data and no sign-in. Workspace writes and mutating shell commands are denied, and the
  data is removed on exit.
- `POLYTH_DEBUG_AGENT_ACCESS=1 npm start` lets direct loopback HTTP and WebSocket
  requests act as the active owner without signing in. It never applies to Polyth Link
  ingress, and identity and setup endpoints keep their CSRF and origin checks.
- `npm run auth:break-glass -- --help` is offline owner password recovery for a stopped
  server. `inspect` lists the installation ID and the local logins (read-only);
  run with only `--data-dir DIR` on a terminal, it asks for the login, a typed
  `RESET` and the new password twice. Polyth Desktop ships the same tool:
  `polyth --target desktop server break-glass` with the app quit.
- [`polyth`](../dev/cli.md) is a command-line client for a running server or Polyth
  Desktop.
