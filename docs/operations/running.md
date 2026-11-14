# Ways to run Polyth

Polyth is always one server that owns your data, sessions and agent runtimes. The
clients (browser, desktop window, phone) connect to it. Pick the setup that fits;
the [quick start](../../README.md#quick-start) covers the first one.

| Setup | Server runs | Reach it from | Start here |
|---|---|---|---|
| [Local from source](#local-from-source) | your machine, `npm start` | this machine's browser | `npm start` |
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
  server.
- [`polyth`](../dev/cli.md) is a command-line client for a running server or Polyth
  Desktop.
