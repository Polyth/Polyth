# Polyth report relay

Nightly bug-report intake for Polyth. A tester's nightly desktop app, or the
nightly Polyth server behind a page opened in a browser (`app.client: "browser"`,
labelled `client:browser`; its version is the server's), sends one report to
`POST /v1/report`; the relay checks the tester password and
the app version, files the report as an issue in a private GitHub repository,
uploads the attachments to that repository's `attachments` branch and answers
`created` or `added`. It is not part of the push service: push promises it
never sees text, so this service is the one place that does.

It requires a tester password (held only as an scrypt hash) and a fine-grained
GitHub token limited to the one private repository (Issues RW + Contents RW).
The public release list only decides which app versions are accepted.

## API

`POST /v1/report`, `application/json`, at most `2 200 000` decoded bytes
(`BUG_REPORT_LIMITS.bodyBytes` in `@polyth/contracts/bug-report`), header
`Authorization: Bearer <tester password>`. The body is the exact
`BugReportPayload` shape in that module — an unknown field rejects the whole
report.

The answer is the `BugReportResult` body with its documented status:

| result | status | meaning |
| --- | --- | --- |
| `created` | 200 | a new issue was filed |
| `added` | 200 | a comment was added to the open issue for this fingerprint |
| `invalid` | 400 | body, content type or JSON is not the exact shape |
| `password` | 401 | missing or wrong tester password |
| `version` | 422 | not a nightly, or newer than every published nightly of `Polyth/Polyth` |
| `rate` | 429 | a source, install, password or the service is over its limit |
| `unavailable` | 503 | no GitHub configured, GitHub failing, releases unreadable or kill switch |

`GET /v1/health` is `{"ok": true, "github": <bool>}`, `github` saying only
whether a token and repository are configured. Any other route is
`404 {"error": "not-found"}`.

## Checks and limits

Cheap checks run first: route and method, content type, declared and streamed
body size, then the password (more than 10 failures per address in 10 minutes
locks that address out with `429`), then the exact JSON shape, then the app
version, then idempotency. There is no cap per source address or per install:
a tester sends as many reports as they need. A version is
accepted when it is a published nightly, or an older nightly the release list no
longer shows (only the newest few nightlies are kept, and a tester may not have
updated yet); a version newer than every published nightly is a local build and
is refused. The whole
service files at most 200 issues and comments per day, which bounds what a
leaked password can file. Windows are in memory and bounded to 50 000 keys.
Both limits are overridable through the
`ReportRelay` options for tests.

A repeated `reportId` within 30 days answers the stored result without calling
GitHub. Repeats are deduplicated by fingerprint: the first error's
`Code:`/`Component:`/`Operation:`/`HTTP status:` lines plus the platform, or,
without errors, the install id plus the normalized text. An open issue for the
fingerprint gets a comment; a closed or missing one gets a new issue that names
the previous number.

## Password

The relay never stores the password. A tester password is 1–200 printable
ASCII characters without spaces (`isTesterPassword` in
`@polyth/contracts/bug-report`), so the header, this command and the desktop
app's keychain all carry the same bytes. Create the one-line scrypt record
(N=16384, r=8, p=1, 32-byte hash) by typing or piping the password — it is read
from stdin, never from an argument, and is not echoed on a terminal:

```sh
polyth-report-relay hash-password > /keys/password.scrypt   # or: node report-relay.mjs hash-password
```

Piping works too (`… | polyth-report-relay hash-password`), but keep the
password out of shell history and argument lists.

Rotating it is writing a new file: the relay re-reads it when its mtime
changes. Compare is `crypto.timingSafeEqual`.

## Configuration

Node 22.16+, no dependencies. Keys live in `REPORT_RELAY_KEYS_DIR` (default
`/keys`), state in `REPORT_RELAY_DATA_DIR` (default `/data`).

- `password.scrypt`: the line `hash-password` prints.
- `github.json`: `{"repo": "Owner/Name", "branch": "attachments"}`; `branch`
  defaults to `attachments`.
- `github-token`: a fine-grained PAT limited to that repository with Issues RW
  and Contents RW. Both GitHub files are re-read when their mtime changes.

`REPORT_RELAY_HOST`/`REPORT_RELAY_PORT` default to `127.0.0.1:8788`.
`REPORT_RELAY_OFF=1` answers `unavailable` to every report (kill switch).
`REPORT_RELAY_TRUSTED_PROXY` is the proxy's address as this listener sees it;
only its last `X-Forwarded-For` entry names the sender. The relay refuses a
non-loopback listener unless `REPORT_RELAY_TLS_TERMINATED=1`, and
`REPORT_RELAY_TEST_MODE=1` binds loopback only.

It imports the wire shape from `@polyth/contracts`, so deploy it as one
self-contained file built with the repository's own esbuild (about 50 KB, no
`node_modules` on the host):

```sh
node_modules/.bin/esbuild packages/report-relay/src/cli.ts --bundle --platform=node \
  --format=esm --target=node22 --outfile=/opt/polyth-reports/app/report-relay.mjs
node /opt/polyth-reports/app/report-relay.mjs hash-password > /opt/polyth-reports/keys/password.scrypt
```

The deployment is a locked-down container behind the host's TLS proxy:

```sh
docker run -d --name polyth-reports --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 \
  --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 64 \
  --log-opt max-size=5m --log-opt max-file=2 \
  -p 127.0.0.1:8788:8788 \
  -e REPORT_RELAY_HOST=0.0.0.0 -e REPORT_RELAY_TLS_TERMINATED=1 -e REPORT_RELAY_TRUSTED_PROXY=<bridge gateway> \
  -v /opt/polyth-reports/app:/app:ro -v /opt/polyth-reports/keys:/keys:ro -v /opt/polyth-reports/data:/data \
  node:22-alpine node /app/report-relay.mjs
```

The production deployment (`reports.polyth.app`) follows this shape: the bundle in
`/opt/polyth-reports/app`, keys in `/opt/polyth-reports/keys`, state in
`/opt/polyth-reports/data`, container `polyth-reports` on `127.0.0.1:8788`, and an
Apache vhost that forwards only `/v1/report` and `/v1/health` (body limit
2 400 000 bytes, 40 s timeout, no client addresses in its access log). Root-owned
helpers place the secrets from stdin only, never from arguments, and print only
`saved` or a validation error; the relay re-reads them without a restart:

- `sudo polyth-reports-token`: the fine-grained token (`github-token`).
- `sudo polyth-reports-password`: the tester password, typed twice, hashed in a
  throwaway container without network (`password.scrypt`).

`polyth-reports-cert` obtains the Let's Encrypt certificate once the name resolves
to the host (the Cloudflare record must be DNS-only) and then keeps a twice-daily
renewal job. The install and verification scripts are kept with the deployment in
`/opt/polyth-reports/deploy-kit`, not in this public repository.

## Attachments and retention

Files go to the `attachments` branch under `reports/YYYY-MM-DD/<reportId>/`:
`report.json` is the parsed report without screenshot data, and
`screenshot.jpg` is the screenshot when the tester attached one. If the branch
does not exist the relay creates it once as an orphan with a short README, then
retries. The issue body embeds the screenshot, links `report.json` and the
public release, and carries a hidden `<!-- polyth-report fp=… id=… -->` marker.

Retention is 30 days. A `prune()` pass at start and every 24 hours rewrites the
branch as a new parentless commit holding only the files of recent date folders
(folder entries are never copied, so old files cannot ride along; a truncated
tree listing skips the rewrite rather than lose recent files) and closes open
`nightly-report` issues
whose last update is older than 30 days, except those labelled `keep` or
`triaged`. Failures are logged and the next pass retries.

## Privacy

Report text, contact, settings, packages, errors and screenshot bytes are
stored only in the private repository and the issue filed from them. The
person's text is quoted in the issue, every `@` and every `#<number>` in it
(and in the title, the table and the settings/errors block, whose backtick runs
are broken so nothing can close its fence) gets a zero-width joiner so the relay
never pings anyone or cross-links an issue, and the contact (an optional GitHub username) is shown
as plain code, not a mention.

The process keeps only rate counters and a 30-day `state.json` mapping a
report id to an issue and a fingerprint to an issue; each map is bounded to
20 000 entries and a corrupt file is moved aside. Logging is one JSON line per
request `{route, result, status, latencyMs}` plus GitHub failure lines
`{github: <operation>, status}`: never the password, report text, contact,
settings, screenshot, install id or source address. GitHub's own error text is
never returned to the client.
