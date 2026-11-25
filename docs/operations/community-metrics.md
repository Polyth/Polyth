# Community metrics (no telemetry)

Polyth does not measure its users: no build contacts a Polyth service to report itself
([workstation edition](../security/workstation-edition.md): "no telemetry, analytics or automatic crash
reporting in any Polyth build"; polyth.app sets no cookies and loads no analytics). The team still needs a
basic picture of adoption, so it reads counters that GitHub, npm and the update feed already keep.
`scripts/community-metrics.mjs` takes a daily snapshot of them; it adds no code to any build.

```sh
node scripts/community-metrics.mjs snapshot --out <file.jsonl>   # one line per UTC day, re-running replaces that day
node scripts/community-metrics.mjs report   --in  <file.jsonl> [--days 14] [--format ui|text]
```

`POLYTH_METRICS_FILE` replaces `--out`/`--in`. The default file is `.scratch/community-metrics/snapshots.jsonl`
(gitignored, so it is a trial location only): keep the real file somewhere private to the team, such as a private
repository or a shared drive, and run `snapshot` once a day from a scheduler of the team's choice (a Polyth
Agent, cron or a scheduled CI job). The script never pushes, publishes or writes anywhere but that file.
`report --format ui` prints a `stats` block for a chat or dashboard; `--format text` prints a table.

## What is read

| Signal | Source | What it is | What it is not |
|---|---|---|---|
| Installer downloads | `GET /repos/{repo}/releases`, per-asset `download_count` | Downloads of installers and archives, per release, split stable / nightly | People: one person fetches several files and reinstalls; CI and mirrors count too |
| Update-feed requests | The `*.yml` assets (`latest*.yml`, `workstation*.yml`, …) | Requests for the updater's feed. The desktop app asks 12 s after launch and every 6 hours, so `requests ÷ 4 ÷ days` is a rough **estimate** of active updaters | Exact: an app asked a different number of times a day, and a client that updates by another channel is missed |
| npm downloads | `api.npmjs.org/downloads/range/last-week/{package}`, last full day | Installs through npm | Users: CI, mirrors and caches inflate it |
| Stars, forks | `GET /repos/{repo}` | Interest | Use |
| Unique viewers, 14 days | `gh api …/traffic/views` (needs a maintainer's own `gh` sign-in; left out when absent) | People who opened the repository page | Clone counts are not read: they are mostly CI and bots |

A release disappears when it is pruned (the builder keeps the three newest per channel) and workstation assets are replaced
on the newest stable release, so a total over all releases can go down. The report therefore compares each
release with itself between two snapshots; a new tag counts from zero and a counter that fell counts as zero.
Snapshots missing a day show as one wider interval (`gap`), never as invented days.

No signal here is a count of users. State numbers as "downloads", "update-feed requests" and "estimated active updaters",
never as "users".

## Privacy

Only public aggregate counters are read; nothing is stored about a person, no cookie or id exists, and the
script talks only to `api.github.com` and `api.npmjs.org`. An optional `GITHUB_TOKEN` raises the API rate limit and is
never written to the file. The data is as private as the file you choose to keep it in.

## Team dashboard (closed)

`scripts/community-metrics-server.mjs serve` shows the snapshots as one script-free HTML page (tiles with
sparklines, a per-day table, the kept releases). It is dependency-free, reads `snapshots.jsonl` and
`password.scrypt` and re-reads each when its mtime changes. It is closed by default and is meant to sit behind a
TLS proxy:

- No valid `password.scrypt` → every request answers `503`. A wrong or missing password answers `401` (HTTP Basic,
  any user name); 10 failures within 15 minutes lock the whole service for the rest of the window (`429`), so no client
  address is read or kept. Only `GET`/`HEAD` of `/`, `/healthz` and `/robots.txt` exist; the page sets `no-store`,
  `noindex`, and a CSP with no script source.
- `hash-password` (password on stdin, never an argument) prints the same `scrypt$N$r$p$salt$hash` line the report
  relay uses; save it as `password.scrypt` in `METRICS_KEYS_DIR` (default `/keys`). Snapshots are read from
  `METRICS_DATA_DIR` (default `/data`). `METRICS_HOST`/`METRICS_PORT` default to `127.0.0.1:8789`; a non-loopback host
  needs `METRICS_TLS_TERMINATED=1`.

The reference deployment follows the report relay's shape: files in `/opt/polyth-metrics/{app,keys,data}`, a
hardened `node:22-alpine` container `polyth-metrics` on `127.0.0.1:8789`, and a systemd timer
`polyth-metrics-snapshot.timer` (06:10 UTC, `Persistent=true`) whose oneshot service runs
`community-metrics.mjs snapshot --out /data/snapshots.jsonl` in a throwaway container (no GitHub token, so the
traffic signal is absent there). Updating is copying the two `.mjs` files into `app/` and restarting the
container; they need no build. Public exposure (a TLS vhost forwarding only `/` and `/healthz`, a DNS-only record
and the password) is a separate, owner-approved step.

## Not done on purpose

An opt-out or opt-in heartbeat from the apps, and server-side counters at the edge of polyth.app or the report relay, are
deliberately **not** built: either changes the public "no telemetry" promise or a live service, so each needs the
owner's decision, a consent design shared with the bug-report flow (one Settings → Privacy surface, a separate
endpoint and storage, a daily-rotating id like `dailyInstallId` in `packages/bug-report/src/sender.ts`, an
`…_ORIGIN=off` switch, workstation builds excluded) and updated documentation on this page, the security page and
the workstation edition document.

Tests: `scripts/test/community-metrics.test.ts`, `scripts/test/community-metrics-server.test.ts`.
