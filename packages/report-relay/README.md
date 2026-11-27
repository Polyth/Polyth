# Polyth report relay

Feedback intake and legacy bug-report intake for Polyth. See [Feedback intake](#feedback-intake) for the current path; the rest of this page describes the legacy bug-report path (`POST /v1/report`), still answered for older nightlies.

Legacy bug-report intake: a tester's nightly desktop app, or the
nightly Polyth server behind a page opened in a browser (`app.client: "browser"`,
labelled `client:browser`; its version is the server's), sends one report to
`POST /v1/report`; the relay checks the tester's group token (or the legacy
shared tester password) and the app version, files the report as an issue in a
private GitHub repository, uploads the attachments to that repository's
`attachments` branch and answers `created` or `added`. It is not part of the push
service: push promises it never sees text, so this service is the one place that
does.

It requires a group token — one per tester cohort, held only as a SHA-256 digest —
or the legacy single tester password (held only as an scrypt hash), and a
fine-grained GitHub token limited to the one private repository (Issues RW +
Contents RW). The public release list only decides which app versions are
accepted.

## API

`POST /v1/report`, `application/json`, at most `2 200 000` decoded bytes
(`BUG_REPORT_LIMITS.bodyBytes` in `@polyth/contracts/bug-report`), header
`Authorization: Bearer <token>`. A token is `<keyId>.<secret>` (for example
`qa-eu.9f3c…`); a value with no `.` is the legacy tester password. The body is
the exact `BugReportPayload` shape in that module — an unknown field rejects the
whole report, so the group can never be claimed by the body: it comes from the
token that authenticated the call.

The answer is the `BugReportResult` body with its documented status:

| result | status | meaning |
| --- | --- | --- |
| `created` | 200 | a new issue was filed |
| `added` | 200 | a comment was added to the open issue for this fingerprint |
| `invalid` | 400 | body, content type or JSON is not the exact shape |
| `password` | 401 | missing or wrong tester password/token, unknown key id or a disabled token |
| `version` | 422 | not a nightly, or newer than every published nightly of `Polyth/Polyth` |
| `rate` | 429 | a source, install, password or the service is over its limit |
| `unavailable` | 503 | no GitHub configured, GitHub failing, releases unreadable or kill switch |

`GET /v1/health` is `{"ok": true, "github": <bool>}`, `github` saying only
whether a token and repository are configured. Any other route is
`404 {"error": "not-found"}`.

## Checks and limits

Cheap checks run first: route and method, content type, declared and streamed
body size, then the token (more than 10 failures per address in 10 minutes
locks that address out with `429`), then the exact JSON shape, then the app
version, then idempotency. There is no cap per source address or per install:
a tester sends as many reports as they need. A version is
accepted when it is a published nightly, or an older nightly the release list no
longer shows (only the newest few nightlies are kept, and a tester may not have
updated yet); a version newer than every published nightly is a local build and
is refused. The whole
service files at most 200 issues and comments per day, which bounds what a
leaked token can file, and each token carries its own smaller `dayCap` in
`tokens.json`, so one leaked cohort token cannot exhaust the day for everyone.
Windows are in memory and bounded to 50 000 keys. The limits are overridable
through the `ReportRelay` options for tests.

A repeated `reportId` within 30 days answers the stored result without calling
GitHub. Repeats are deduplicated by fingerprint: the first error's
`Code:`/`Component:`/`Operation:`/`HTTP status:` lines plus the platform, or,
without errors, the install id plus the normalized text. An open issue for the
fingerprint gets a comment that names the group it came from; a closed or
missing one gets a new issue that names the previous number. When a fingerprint
arrives from a second group its comment also lists every group that has seen it
(`Seen in groups: …`) — one problem on two cohorts is the strongest signal the
intake produces.

## Authentication

Two things can authenticate a report: a **group token** (the intended path) or
the **legacy shared tester password**. Both arrive in the same header and both
end up as a group slug: a group token as its own group, the password as
`default`.

### Group tokens

`tokens.json` holds one entry per cohort. Only the SHA-256 digest of a token's
secret half is stored, never the secret:

```json
{ "tokens": [
  { "keyId": "qa-eu", "group": "qa-eu", "label": "QA EU", "hash": "<64 hex>", "dayCap": 40, "disabled": false },
  { "keyId": "beta-2", "group": "beta", "label": "Beta cohort", "hash": "<64 hex>", "dayCap": 40 }
] }
```

- `keyId` — `[a-z0-9][a-z0-9_-]{0,47}`, never secret. It is the half before the
  `.` in a bearer, so authentication is a Map lookup plus one constant-time
  digest compare instead of an scrypt run per stored token. Two `keyId`s may
  share one `group`, which is how a cohort rotates its token without losing its
  history.
- `group` — `[a-z0-9][a-z0-9-]{0,31}`. It becomes the `group:<slug>` label, the
  marker attribute and the stats bucket. It is a cohort, never a person.
- `label` — optional, shown in the issue table.
- `hash` — lowercase hex of `sha256(<secret half>)`.
- `dayCap` — reports per UTC day for this token (default 200).
- `disabled` — `true` refuses the token exactly like an unknown one.

Create the `group:<slug>` label (and `group:default` if the legacy password stays in
use) in the private repository before the first report from that group: a
fine-grained token cannot create a missing label, and the 422 fallback then files
the issue with no labels at all — the group would survive only in the body marker,
the body table and `stats/`.

Mint one with the CLI: the secret is shown once on stderr, and the
hash-only entry that goes into `tokens.json` is printed on stdout, so the two
can be captured separately and the secret never lands in a file the relay
reads:

```sh
polyth-report-relay token --group qa-eu --label "QA EU" --day-cap 40 \
  > qa-eu.entry.json     # { keyId, group, label, hash, dayCap, disabled }
# stderr:  qa-eu.9f3c…    ← give this whole string to that group's testers
polyth-report-relay list-tokens      # keyId, group, dayCap, active/disabled, label
```

The secret is a full `<keyId>.<43 base64url chars>`, 1–200 printable ASCII
characters, so it fits the existing tester-password field: nothing in the
desktop app or the server changes, a tester pastes the group token where they
used to paste the password, and it is kept in their OS keychain.

Rotation and revocation are edits to `tokens.json`: the relay re-reads the file
when its mtime or size changes, no restart. Set `disabled: true` rather than
deleting an entry — the group keeps its history and can be told apart from a
typo. Adding a `keyId` with the same `group` and disabling the old one rotates
without a gap.

A token that is unknown, disabled or presents the wrong secret answers the same
`401 {"result": "password"}` as a wrong password: no account enumeration.

### Legacy tester password

One shared password, 1–200 printable ASCII characters without spaces
(`isTesterPassword` in `@polyth/contracts/bug-report`), for installs that
predate group tokens. It is filed under the `default` group. Create the one-line
scrypt record (N=16384, r=8, p=1, 32-byte hash) by typing or piping the password
— it is read from stdin, never from an argument, and is not echoed on a
terminal:

```sh
polyth-report-relay hash-password > /keys/password.scrypt
```

Piping works too (`… | polyth-report-relay hash-password`), but keep the
password out of shell history and argument lists. Rotating it is writing a new
file; the relay re-reads it when its mtime changes and compares with
`crypto.timingSafeEqual`.

A legacy password containing a `.` stops authenticating once `tokens.json`
exists: a dotted bearer is treated as a token, and checking it against the
password would cost one scrypt per guess. Give such a tester a group token.

## Configuration

Node 22.16+, no dependencies. Keys live in `REPORT_RELAY_KEYS_DIR` (default
`/keys`), state in `REPORT_RELAY_DATA_DIR` (default `/data`).

- `tokens.json`: group tokens, `{ "tokens": [ … ] }`. Optional; without it only
  the legacy password authenticates. At most 200 entries; an unreadable entry is
  dropped rather than guessed at.
- `password.scrypt`: the line `hash-password` prints (legacy `default` group).
- `github.json`: `{"repo": "Owner/Name", "branch": "attachments"}`; `branch`
  defaults to `attachments`.
- `github-token`: a fine-grained PAT limited to that repository with Issues RW
  and Contents RW. These files are re-read when their mtime changes.

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
Apache vhost that forwards only `/v1/report`, `/v1/health`, `/v1/feedback`,
`/v1/feedback/forget`, the inbox page `/inbox` and `/v1/inbox/*` (body limit
2 400 000 bytes, 40 s timeout, no client addresses in its access log). Root-owned
helpers place the secrets from stdin only, never from arguments, and print only
`saved` or a validation error; the relay re-reads them without a restart:

- `sudo polyth-reports-token`: the fine-grained token (`github-token`).
- `sudo polyth-reports-password`: the tester password, typed twice, hashed in a
  throwaway container without network (`password.scrypt`).
- `tokens.json`: written from the `token` command's stdout entries, one per
  cohort. The same helper path places it; the relay picks it up on the next
  report.

`polyth-reports-cert` obtains the Let's Encrypt certificate once the name resolves
to the host (the Cloudflare record must be DNS-only) and then keeps a twice-daily
renewal job. The install and verification scripts are kept with the deployment in
`/opt/polyth-reports/deploy-kit`, not in this public repository.

## Feedback intake

The app and the Polyth server send feedback to `POST /v1/feedback`
(`application/json`, at most `FEEDBACK_LIMITS.bodyBytes`, no password or login: the
person has no account). The body is the exact `FeedbackPayload` of
`@polyth/contracts/feedback`: `kind` (`bug`, `idea`, `pain`, `praise`), `text`, `basics`
(always) and the optional `technical`, `profile`, `contact` and `screenshot`, each present
exactly when its `consent.*` flag says so. A repeated `feedbackId` answers the stored
result. Answers: `received` 200 with the `ref` shown to the person, `invalid` 400, `rate`
429, `unavailable` 503.

- **Store.** `feedback.db` (SQLite, `node:sqlite`) in the data folder, one row per
  feedback with its screenshot as a blob (`src/feedbackStore.ts`). Nothing is public. It is
  kept `feedbackRetentionDays` (90) and pruned with the legacy data; rows with status `keep` stay.
- **Limits (stage 1).** Only a service-wide daily budget (`feedbackDay`, 2 000 stored per
  rolling day); no cap per source address or install, because the team wants to hear every
  user. Stage 2 (per-install quotas, proof of work, verified contact) is not built.
- **Forget.** `POST /v1/feedback/forget` with `{version: 1, install}` deletes everything
  stored under that pseudonym and answers `forgotten` with the count.
- **Inbox.** The team reads with an inbox key. The admin key is the scrypt record
  `inbox.scrypt` in the keys folder (written like the tester password with
  `hash-password`; rotated only by rewriting that file). Team keys live in `feedback.db`
  table `inbox_keys` (id, label, scrypt record, created/revoked; a revoked row stays for
  its history and its id is never reused). Only the admin key may `GET /v1/inbox/keys`
  (every key with the addresses it was used from), `POST /v1/inbox/keys` (`{id, label}`;
  answers the token `<id>.<43 random chars>` once, stores only its scrypt record) and
  `POST /v1/inbox/keys/<id>/revoke`; a team key gets `403` there. `GET /v1/inbox/me` names
  the key in use. Every accepted request updates table `inbox_access` (key, address,
  first/last seen, hits); `report-relay.mjs inbox-access --data <dir>` prints it. More than
  the failure limit per address in 10 minutes answers `429`. Routes: `GET /v1/inbox` (filter by `kind`, `status`, `role`, `days`;
  paged), `GET /v1/inbox/summary` (counts by kind, status and role, for
  the PM), `GET /v1/inbox/<ref>`, `GET /v1/inbox/<ref>/screenshot`, `POST /v1/inbox/<ref>`
  (status `new|seen|planned|done|dropped|keep` and a team note) and
  `POST /v1/inbox/<ref>/github` (files that feedback as an issue in the private reports
  repository; the text is quoted and `@`/`#` neutralised as for bug reports). The proxy
  must forward `/v1/feedback`, `/v1/feedback/forget`, `/inbox` and `/v1/inbox/*` in
  addition to `/v1/report` and `/v1/health`; the token is the only lock on the inbox.
- **Inbox page.** `GET /inbox` (`src/inboxPage.ts`) is one self-contained page over that
  API: totals, filters, the list, a detail with the screenshot, status, note and "File to
  GitHub", and for the admin key a "Keys" view (create a key, shown once; revoke; every
  key's addresses). It holds no data; the token is typed on the page and kept in the tab's
  `sessionStorage` only. Feedback text is untrusted, so the page builds every node with
  `textContent`, and its CSP allows only its own script and style (by hash), same-origin
  fetches and `blob:` images, with no framing (`test/feedback.test.ts` checks both).
- **Privacy.** The intake logs `{route, result, status, latencyMs}` only: never text,
  contact, profile, screenshot, pseudonym or source address.

## Attachments and retention

Files go to the `attachments` branch under `reports/YYYY-MM-DD/<reportId>/`:
`report.json` is the parsed report without screenshot data, and
`screenshot.jpg` is the screenshot when the tester attached one. If the branch
does not exist the relay creates it once as an orphan with a short README, then
retries. The issue body embeds the screenshot, links `report.json` and the
public release, and carries a hidden
`<!-- polyth-report fp=… id=… group=… key=… -->` marker. The labels are
`nightly-report`, `v<version>`, `platform:<os>`, `group:<slug>`, plus
`client:browser`, `has-screenshot` and `low-signal` when they apply.

Retention is 30 days. A `prune()` pass at start and every 24 hours rewrites the
branch as a new parentless commit holding only the files of recent date folders
(folder entries are never copied, so old files cannot ride along; a truncated
tree listing skips the rewrite rather than lose recent files) and closes open
`nightly-report` issues
whose last update is older than 30 days, except those labelled `keep` or
`triaged`. Failures are logged and the next pass retries.

## Stats artifact

Once per `prune()` pass (at start and every 24 hours) the relay publishes
`stats/YYYY-MM-DD.md` on the same branch, but only when the rendered content
changed since that date's last upload and only when the window has any reports.
It is a snapshot of the trailing 7 days (configurable through
`statsWindowDays`), so a person or the nightly triager can diff two days without
parsing GitHub, and no read endpoint is exposed:

- one row per group: reports, new issues, comments, install-days,
  `Reports / install-day`, screenshot and `low-signal` shares, platforms;
- the same per UTC day;
- **Seen in more than one group**: every fingerprint that reported from two or
  more cohorts, with its issue number — the comparison the group tokens exist
  for. A crash or data loss on two cohorts holds the nightly.

`Install-days` is the honest denominator: the install id rotates every UTC day,
so distinct ids per day are counted per group per day. `polyth-report-relay
stats [--data <dir>] [--days 1-14]` renders the same markdown from a local
`stats.json` without touching GitHub.

These files are not pruned: `stats/` is the long-term activity record, while
`reports/` keeps 30 days.

## Privacy

Report text, contact, settings, packages, errors and screenshot bytes are
stored only in the private repository and the issue filed from them. The
person's text is quoted in the issue, every `@` and every `#<number>` in it
(and in the title, the table and the settings/errors block, whose backtick runs
are broken so nothing can close its fence) gets a zero-width joiner so the relay
never pings anyone or cross-links an issue, and the contact (an optional GitHub username) is shown
as plain code, not a mention.

The process keeps only rate counters, a 30-day `state.json` mapping a report id
to an issue and a fingerprint to an issue (each map bounded to 20 000 entries, a
corrupt file moved aside), and a 14-day `stats.json` of per-group counters. That
file also holds each group's rotating install ids for the day (bounded, never
published) so install-days can be counted. The published `stats/*.md` carries
counts, group slugs, coarse platform families and issue numbers only: no report
text, contact, settings, errors, version strings or install id ever appears in
it. Logging is one JSON line per
request `{route, result, status, latencyMs}` plus GitHub failure lines
`{github: <operation>, status}`: never the token, report text, contact,
settings, screenshot, install id or source address. The request log stays
anonymous; group attribution lives in the labels and in `stats.json`. GitHub's
own error text is never returned to the client.
