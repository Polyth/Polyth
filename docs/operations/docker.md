# Running Polyth in Docker

The root `Dockerfile` packages the same server as `npm start`: the source tree
runs under Node type stripping, with prebuilt web bundles, the native runtime
supervisor, the pinned OpenCode binary (`apps/desktop/opencode.json`) and,
by default, the Polyth Link host. Compose files and the entrypoint live in
[`deploy/docker/`](../../deploy/docker).

## Image

| Build target | Contents |
|---|---|
| `polyth` (default) | Node 22, Polyth server + web bundles, OpenCode, `git`, `gh`, `ripgrep`, `openssh-client`, Polyth Link host |
| `polyth-browser` | `polyth` plus Debian Chromium for the agent-drivable browser (`POLYTH_CHROMIUM_PATH=/usr/bin/chromium`) |

| Build argument | Default | Meaning |
|---|---|---|
| `POLYTH_UID` / `POLYTH_GID` | `1000` | Account the server runs as. Match the owner of the mounted workspace, or Git refuses the repositories as "dubious ownership" and writes fail. |
| `POLYTH_LINK` | `host` | `host` compiles `polyth-link-host` (Rust, slow first build); `none` omits Polyth Link. |
| `GH_CLI` | `1` | `0` leaves out the GitHub CLI. |
| `POLYTH_WEB_BUILD_ID` | timestamp | Web bundle build id. |

```bash
docker build -t polyth:local .
docker build --target polyth-browser -t polyth:browser .
docker build --build-arg POLYTH_UID=$(id -u) --build-arg POLYTH_GID=$(id -g) -t polyth:local .
```

Layout inside the container:

| Path | Purpose |
|---|---|
| `/opt/polyth` | Application (read-only for the server account) |
| `/data` | `POLYTH_DATA_DIR`: canonical identity, sessions, settings. Volume. |
| `/home/node` | `HOME`: OpenCode/`gh`/SSH/Git configuration and provider logins. Volume. |
| `/workspace` | Mount your projects here and open them from the folder picker. |

Create the workspace folder yourself before the first `up`; a bind-mount
source that does not exist is created by Docker as `root` and the server
cannot write to it.

The entrypoint (`polyth`) runs under `tini`, so agent runtimes and their
children are reaped. Subcommands: `serve` (default), `setup-claim`,
`break-glass`, `migrate-legacy`, `help`; anything else runs as a command, for
example `opencode auth login`.

## Why there is no plain `-p 4400:4400`

Without a TLS origin, Polyth's browser identity accepts only a direct loopback
connection (`packages/identity/src/http.ts`), and the server binds
`127.0.0.1` by default. A port published on Docker's bridge network reaches
the container from the gateway address, not loopback, so login is rejected
with `insecure-transport`. Do not work around this with an in-container
forwarder: it would make every client that can reach the port look like the
machine's own browser. Use one of the two supported modes below.

## Mode 1 — this machine only (host network)

Linux Docker Engine (`network_mode: host`). Not verified on Docker Desktop for
macOS/Windows, whose host networking differs.

```bash
cd deploy/docker
cp .env.example .env                       # optional: POLYTH_UID/GID, POLYTH_WORKSPACE, POLYTH_PORT
mkdir -p workspace                         # or point POLYTH_WORKSPACE at an existing folder
docker compose build
docker compose run --rm polyth setup-claim # prints a short-lived claim token
docker compose up -d
```

Open `http://127.0.0.1:4400` (exactly this host name; the origin is
`http://127.0.0.1:<port>`), paste the setup code that `setup-claim` printed
(the page names the npm form of the command), create the owner account and
save the recovery codes. Then restart once so the full workspace runtime
starts:

```bash
docker compose restart polyth
```

Run `setup-claim` while the server is stopped: a running server holds the
data-directory writer lease and the claim command waits for it/fails with
`data-directory-locked`. A setup code lasts 15 minutes; if it expires, the page
returns to the setup-code step: stop the service and issue another one.

## Mode 2 — remote access behind a TLS proxy

`compose.proxy.yml` runs Polyth behind Caddy on a public HTTPS origin.
Polyth sets `POLYTH_PUBLIC_ORIGIN=https://$POLYTH_DOMAIN` and trusts forwarded
headers only from the exact proxy address in `POLYTH_TRUSTED_PROXIES`, so the
compose file gives Caddy a fixed address on a private network and publishes no
Polyth port.

```bash
cd deploy/docker
cp .env.example .env    # set POLYTH_DOMAIN; DNS must point at this host for a public certificate
docker compose -f compose.proxy.yml build
docker compose -f compose.proxy.yml run --rm polyth setup-claim
docker compose -f compose.proxy.yml --profile setup up polyth-setup
# open http://127.0.0.1:4400 on this host, paste the setup code, create the owner
# account, save the recovery codes, then Ctrl-C
docker compose -f compose.proxy.yml up -d
# sign in at https://$POLYTH_DOMAIN
```

First-run setup goes over loopback because the setup server
(`packages/server/src/setupServer.ts`) does not apply the trusted-proxy TLS
marker that the full runtime listener does (`createPublicHttpServer` in
`packages/server/src/httpCore.ts`), so a setup attempt through the proxy is
refused with `insecure-transport`. The `polyth-setup` service (profile
`setup`, never started by a plain `up`) runs the same image on the same data
volume with host networking and no public origin. From another machine use an
SSH tunnel, `ssh -L 4400:127.0.0.1:4400 <server>`, and open
`http://127.0.0.1:4400` locally; `POLYTH_SETUP_PORT` changes the port. The
owner is created with a password; add passkeys later from the HTTPS origin,
since passkeys bind to it. No extra restart is needed: the main service starts
after setup is complete.

Browsers must use the exact origin `https://$POLYTH_DOMAIN` (port 443).
Polyth compares `Host` with the configured origin, so publishing Caddy on
another `POLYTH_HTTPS_PORT` needs a matching origin that this compose file
does not build; keep 443 for browser access.

For a LAN host without public DNS set `POLYTH_TLS=tls internal` and trust
Caddy's local CA on your devices. If `172.29.84.0/24` overlaps an existing
network, change `POLYTH_SUBNET`, `POLYTH_PROXY_IP` and `POLYTH_APP_IP` together.
To use your own proxy instead of Caddy, keep the same three settings: listen
on a non-loopback `HOST`, set `POLYTH_PUBLIC_ORIGIN` to the HTTPS origin, and
set `POLYTH_TRUSTED_PROXIES` to the proxy's exact peer address (no CIDR, no
host names). The proxy must forward the original `Host` and set
`X-Forwarded-Proto: https`.

## Pairing phones through Polyth Link

The default image contains `polyth-link-host`. Link prefers direct
peer-to-peer connections; with host networking (mode 1) the host's addresses
are visible to it. On a bridge network (mode 2) it sees only the container
address, so direct LAN discovery and connectivity are limited. The Link host
process starting inside the container is tested; pairing a phone with a
containerized host is not device-verified.

## Agent harnesses and accounts

OpenCode is bundled and found on `PATH`. Provider logins and other harness
configuration live under `/home/node`, which is a volume, so they survive
upgrades. Log in from the Polyth UI, or run a CLI login inside the container:

```bash
docker compose exec polyth opencode auth login
docker compose exec polyth gh auth login
```

Other harnesses (Claude Code, Codex, Cursor, …) are not in the image. Extend
it with their CLIs in a derived `Dockerfile` (`FROM polyth:local`, `USER root`,
install, `USER node`). The Docker feature package does not get the host Docker
socket; mounting `/var/run/docker.sock` gives the container root-equivalent
control of the host, so do it only deliberately.

## Upgrades, backup, recovery

```bash
git pull && docker compose build && docker compose up -d   # source build
docker compose pull && docker compose up -d                # published image (POLYTH_IMAGE)
```

Stopping sends SIGTERM; the server drains running agent turns before it exits
(`stop_grace_period: 60s`). Back up the `polyth-data` volume while the service
is stopped. Owner password recovery runs offline against the same volume:

```bash
docker compose run --rm polyth break-glass --help
```

## Published images

The manual **Release** workflow publishes multi-arch (`linux/amd64`,
`linux/arm64`) images to `ghcr.io/<owner>/polyth` when `docker_image` is
selected: `<version>` and `latest` for `polyth`, `<version>-browser` and
`browser` for `polyth-browser`. A draft release moves only the version tags.
Images are tagged after the GitHub Release job succeeds. A newly created GHCR
package is private until its visibility is changed in the package settings.
**Build apps** can build and smoke-test unpublished images
(`docker_x64`/`docker_arm64`, optional `docker_browser`) and uploads them as
`docker save` artifacts (`docker load < polyth-*.tar.gz`).

`deploy/docker/smoke.sh <image>` is the boot check both workflows run: bundled
tools, a setup claim on a throwaway volume, `/api/health` and the web shell
on loopback, and a clean SIGTERM exit.
