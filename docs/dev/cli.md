# `polyth` command-line interface

`packages/cli` is the terminal client for a Polyth server checkout, a Docker
deployment, a remote web server, or Polyth Desktop. It speaks only the same
HTTP API the web/mobile UI uses (never a native harness), so every Space,
grant and approval rule is enforced by the server.

## Running it

| Where | How |
|---|---|
| Server checkout | `npm run polyth -- <command>` or `node packages/cli/bin/polyth.mjs <command>`; `npm link` inside `packages/cli` puts `polyth` on PATH |
| Docker | `docker exec <container> node packages/cli/bin/polyth.mjs <command>` (uses the container's data directory socket) |
| Polyth Desktop | File → **Install Command-Line Tool…** (tray: *Install command-line tool…*) writes a user-owned launcher (`~/.local/bin/polyth`, Windows `%LOCALAPPDATA%\Polyth\bin\polyth.cmd`) that runs the bundled `resources/cli/polyth.cjs` with the app's own binary (`ELECTRON_RUN_AS_NODE=1`), so no separate Node.js is needed |

`bin/polyth.mjs` imports the TypeScript source directly on Node ≥ 22.18 and
re-executes itself with `--experimental-strip-types` on older supported Node.
`apps/desktop/build.ts` bundles `apps/desktop/src/cliEntry.ts` to CommonJS.

## Where it connects (targets)

Precedence: `--url`/`POLYTH_URL` → `--target NAME`/`POLYTH_TARGET` →
`--data-dir`/`POLYTH_DATA_DIR` (or `POLYTH_CONTROL_SOCKET`) → the saved default
(`polyth target use`) → discovery of an existing control socket in `./data`,
this checkout's `data/`, then the Polyth Desktop data folder.

- **Control socket** (`<dataDir>/control.sock`; Windows named pipe
  `\\.\pipe\polyth-control-<sha256(dataDir)[0:12]>`, the same derivation as
  `packages/server/src/indexCore.ts` and `polyth-mcp`). No credential:
  possession of the 0600 socket is the authority (principal `internal-service`).
- **HTTP**: a URL plus a bearer token, or no token when the owner enabled the
  no-token mode. The CLI uses `node:http(s)`, not `fetch` — undici adds the
  browser provenance header `sec-fetch-mode`, which the server treats as
  "not a command-line client".

Saved targets and tokens live in one user-private file (`~/.config/polyth/cli.json`,
Windows `%APPDATA%\Polyth\cli.json`, override `POLYTH_CLI_CONFIG`), written 0600
in a 0700 directory. `POLYTH_TOKEN` overrides a saved token. Tokens never go on
argv, into logs or into output.

## Authentication and authority

| Way in | Principal | Reach |
|---|---|---|
| Control socket, `local-trusted` profile | `internal-service` | Operator; same as `polyth-mcp` |
| Control socket, `server-trusted` / `multi-tenant-sandboxed` | `internal-service` | **Only** `GET /api/health` and `GET /api/agent`. Every agent runs as the server's OS user and could open the socket, so it no longer speaks for an owner there (`httpCore.ts`, `CONTROL_SOCKET_RESTRICTED_ALLOW`) |
| `polyth login <url>` (device code) | `access-token` (`tokenKind: device`) | The chosen profile's grants |
| Automation token (Settings → Command line) | `access-token` (`tokenKind: automation`) | The chosen profile's grants, optionally pinned to one Space |
| No-token mode (owner opt-in) | `local-user` (`sessionId: trusted-cli`) as the owner who enabled it | Full owner authority, including approving agent requests |

**Access tokens** (`packages/identity/src/accessTokens.ts`, control-plane
migration v10 `cliAccessMigration`): `pth_` + 256 random bits; only a SHA-256
is stored. A token belongs to one person, carries an explicit grant list
(`CLI_ACCESS_PROFILES` in `@polyth/contracts`: `read`, `control`; explicit lists
are limited to `CLI_TOKEN_GRANTABLE`), may be pinned to one Space (a foreign
explicit Space answers 404), may expire (1–3650 days or never), records
last use, and dies with the account auth epoch (password change, logout
everywhere, suspension) or on revocation. Token principals are grant-bound like
paired devices: they reach only the default-deny `CORE_REMOTE_ACCESS` /
package `remoteAccess` route tables, capped by account guardrails.
`core.requests.respond`, credentials, identity/pairing management, package
installs and server control are never grantable — **a token can never answer an
agent's permission request.** Bearer tokens are accepted only over TLS (direct
or via a trusted proxy) or loopback, never as a fallback to cookies, and never
for WebSockets (the CLI long-polls instead).

**Device sign-in**: `POST /api/auth/cli/device` → `{deviceCode, userCode,
verificationPath: "/?settings=command-line"}`; the person confirms the code on
Settings → Command line (approval needs a sign-in within 5 minutes); the CLI
polls `POST /api/auth/cli/device/token` and receives the token exactly once.
Codes expire after 10 minutes; at most 5 pending per client address and 50
overall. These two endpoints and `POST /api/auth/cli/logout` (bearer revokes
itself) refuse any request carrying `Origin` or `Sec-Fetch-Site`. Identity
transport rules still apply: the canonical HTTPS origin, or direct loopback.

**UI routes** (cookie + CSRF, `packages/identity/src/http.ts`): `GET
/api/auth/cli`, `POST /api/auth/cli/tokens`, `DELETE /api/auth/cli/tokens/:id`,
`POST /api/auth/cli/device/lookup|decide`, `POST /api/auth/cli/trust`. Token
creation, device approval and trust changes require a recent sign-in.

**No-token mode** (`cli_trust`, instance owner only): `off` (default),
`loopback`, `private-network` (RFC 1918 and IPv6 ULA/link-local; *not* the
100.64/10 overlay range, which commonly fronts a public proxy). It applies only
to requests that carry `X-Polyth-CLI: 1`, carry no `Origin`/`Sec-Fetch-*`
headers, arrive directly (not through a trusted proxy) and carry no forwarding
header (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`). Any program on an
allowed machine — including agents running there — then acts as the owner.
Turning it off ends live channels (`refreshPrincipal`).

## Commands

`polyth help` lists them; `polyth help <command>` shows options. Groups:
sessions (`sessions`, `show`, `log [-f]`, `new`, `send`, `chat`, `stop`,
`wait`, `queue`, `fork`, `archive`, `restore`, `rm`), automation (`events`,
`on`, `requests`), Polyth (`status`, `projects`, `models`, `open`, `api`),
connection (`login`, `logout`, `whoami`, `target`), this machine (`server
status|logs|start|restart|setup-claim|break-glass`, only for a local checkout's
socket; Desktop manages its own server), `completion bash|zsh|fish`.

Projects resolve by id, name or path, defaulting to the project that contains
the working directory. Sessions resolve by full id, a unique ≥ 4-character
prefix among recent sessions, or `last`.

`polyth requests approve` works only in the no-token mode; otherwise approvals
stay in the UI (`polyth open`). Questions can be answered and requests rejected
from any principal the server allows.

## Automation contract

- `--json` on every command; errors go to stderr as one JSON object.
- Exit status: 0 ok · 1 failed · 2 usage · 3 not allowed · 4 not found ·
  5 unreachable · 6 conflict/unconfirmed · 7 timeout · 8 turn stopped · 130 interrupted.
- `polyth events` prints NDJSON feed events (`session.created`,
  `session.updated`, `turn.started`, `turn.finished`, `request.pending`,
  `session.archived`) with a `cursor` for `--since`. They are derived from
  session summaries, so rapid changes between two reads coalesce.
- `polyth on EVENT -- CMD` runs handlers one at a time with the event JSON on
  stdin and `POLYTH_EVENT`, `POLYTH_SESSION_ID`, `POLYTH_PROJECT_ID`,
  `POLYTH_SESSION_TITLE`, `POLYTH_SESSION_STATUS` in the environment.
- `--idempotency-key` on `send`/`new` maps to the server's durable,
  account-scoped `clientOperationId`, so retrying a message never delivers it
  twice. Session *creation* by `new` is not idempotent: `new` prints the
  session id first, so a script can retry with `send <id> --idempotency-key`.
- When the server reports an unconfirmed delivery (`outcome-unknown`), the CLI
  never resends; with `--wait` it follows the session while the server
  reconciles.

## Server additions used by the CLI

- `GET /api/cli/whoami` — principal kind, account, Space, deployment, grants.
- Long-poll: `GET /api/sessions/:id/events/forward?afterSeq=N&waitMs=…` and
  `GET /api/sessions/summaries?…&waitMs=…&updatedAfter=T` (max 30 s). Wake-ups
  (`sessionEventWaiters.ts`) are hints registered *before* the read and only
  cause a re-read of persisted history, so a missed wake costs latency, never an
  event. Shutdown releases every parked request.

## Verification

- `node --experimental-strip-types --test packages/cli/test/*.test.ts packages/identity/test/accessTokens.test.ts packages/identity/test/cliHttp.test.ts packages/server/test/cliAccess.test.ts apps/desktop/test/cliInstall.test.ts`
- End-to-end against an isolated server: `scripts/agent-beta.ts` gives a
  loopback beta whose loopback is already owner (debug access), so the
  no-token mode must be checked on a plain server without `POLYTH_AGENT_BETA`.

Not verified at the time of writing: the Electron `ELECTRON_RUN_AS_NODE`
launcher on real installs (the bundle was run with plain Node), Windows named
pipes, and the macOS/Windows launcher locations.
