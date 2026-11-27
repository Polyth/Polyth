# Community metrics (no telemetry)

Polyth does not measure its users: no build contacts a Polyth service to report itself
([workstation edition](../security/workstation-edition.md): "no telemetry, analytics or automatic crash
reporting in any Polyth build"; polyth.app sets no cookies and loads no analytics). The team still needs a
basic picture of adoption, so it reads counters that GitHub, npm and the update feed already keep.
`scripts/community-metrics.mjs` takes a daily snapshot of them; it adds no code to any build.

```sh
node scripts/community-metrics.mjs snapshot --out <file.jsonl>   # one line per UTC day, re-running replaces that day
node scripts/community-metrics.mjs report   --in  <file.jsonl> [--days 14] [--format ui|text|csv]
node scripts/community-metrics.mjs brief    --dir <data dir>                 # JSON the weekly note is written from
node scripts/community-metrics.mjs note     --dir <data dir> < note.json     # writes weekly.json
node scripts/community-metrics.mjs goal     --dir <data dir> --month 2026-12 --metric downloads|active|stars --target 1500
```

`POLYTH_METRICS_FILE` replaces `--out`/`--in`. The default file is `.scratch/community-metrics/snapshots.jsonl`
(gitignored, so it is a trial location only): keep the real file somewhere private to the team, such as a private
repository or a shared drive, and run `snapshot` once a day from a scheduler of the team's choice (a Polyth
Agent, cron or a scheduled CI job). The script never pushes, publishes or writes anywhere but that file.
`report --format ui` prints a `stats` block for a chat or dashboard; `--format text` prints a table; `--format csv`
prints the daily series described below.

## What is read

| Signal | Source | What it is | What it is not |
|---|---|---|---|
| Installer downloads | `GET /repos/{repo}/releases`, per-asset `download_count` | Downloads of installers and archives, per release, split stable / nightly and per platform (macOS, Windows, Linux, Android, iOS, headless server, other; from the file name) | People: one person fetches several files and reinstalls; the Windows and Linux auto-update fetches the installer too; CI and mirrors count |
| Update-feed requests | The `*.yml` assets (`latest*.yml`, `beta*.yml`, `workstation*.yml`, …), split per updater channel | Requests for the updater's feed. The desktop app asks 12 s after launch and every 6 hours, so `requests ÷ 4 ÷ days` is a rough **estimate** of active desktop apps | Exact: an app asked a different number of times a day, and a client that updates by another channel (Android, npm) is missed |
| npm downloads | `api.npmjs.org/downloads/range/last-week/{package}`, last full day | Installs through npm | Users: CI, mirrors and caches inflate it |
| Stars, forks | `GET /repos/{repo}` | Interest | Use |
| Unique viewers, 14 days | `gh api …/traffic/views` (needs a maintainer's own `gh` sign-in; left out when absent) | People who opened the repository page | Clone counts are not read: they are mostly CI and bots |

A release disappears when it is pruned (the builder keeps the three newest per channel) and workstation assets are replaced
on the newest stable release, so a total over all releases can go down. The report therefore compares each
release with itself between two snapshots; a new tag counts from zero and a counter that fell counts as zero. When
both snapshots carry the per-platform split, each platform is compared with itself, so a replaced Windows asset no
longer hides the Mac downloads of the same release. Snapshots written before the split existed lack `platforms` and
`feedChannels`; every reader treats that as unknown, never as zero. Snapshots missing a day show as one wider interval
(`gap`), never as invented days.

The dashboard and the CSV turn the intervals into calendar days (`dailySeries`): the snapshot runs early in the
UTC morning, so the interval that ends on snapshot day D counts towards the days before it (D−gap … D−1). A wider
interval is spread evenly over its days and marked as such (hatched in the chart, `≈` in the table,
`spread_over_missed_days` in the CSV). The running total is the downloads already in the kept releases at the first
snapshot plus every daily delta since; the page says how many came before counting began. A release's first-week
figure is its counter at the last snapshot no later than seven days after publication; a release published more than
a week before the first snapshot shows no first-week figure.

No signal here is a count of users. State numbers as "downloads", "update-feed requests" and "estimated active apps"
(the dashboard's "Активні застосунки, оцінка"), never as "users".

## Privacy

Only public aggregate counters are read; nothing is stored about a person, no cookie or id exists, and the
script talks only to `api.github.com` and `api.npmjs.org`. An optional `GITHUB_TOKEN` raises the API rate limit and is
never written to the file. The data is as private as the file you choose to keep it in.

## Team dashboard (closed)

`scripts/community-metrics-server.mjs serve` shows the snapshots as one script-free HTML page written for a
non-technical reader: a one-paragraph summary (last 7 days against the 7 before, estimated active desktop apps, the
most popular platform), four headline numbers with 30-day sparklines (downloads in 7 days, estimated active apps,
total downloads, GitHub stars or 14-day page visitors), a growth chart with CSS-only switches (downloads or active
apps; 7 days, 30 days, or 13 weeks for "90 days") and release/event marks, the platform and stable/prerelease split,
the first week of the four newest stable releases, a "how we count" note and the last 14 days with a CSV download.
Below the summary paragraph sit the agent's weekly note and this month's goals when their files exist (see
[weekly note and monthly goals](#weekly-note-and-monthly-goals)).
Ukrainian is the default (`METRICS_LANG=en` changes it, `?lang=en|uk` switches one view); dates are calendar days
in UTC and the "updated at" time uses `METRICS_TIMEZONE` (default `Europe/Kyiv`). A change from a base under 20 is
shown as a count, not a percentage. The platform split covers the last 30 days once at least a week of snapshots
carries it and otherwise the releases available in the latest snapshot; the subtitle says which.

Optional `events.json` next to `snapshots.jsonl` adds marks to the chart, for example
`[{"day":"2026-10-31","label":"Public launch"}]` (at most 200 entries, labels cut at 60 characters; stable releases
are marked automatically). `/?export=csv` (with `&lang=`) downloads the daily series: one row per day with
downloads, the stable/prerelease and per-platform split (empty when not recorded), update checks, estimated active
apps, npm and whether the day was spread; cells are only dates, numbers and `yes`/`no`, and a UTF-8 BOM lets Excel
open it. The CSV and the language switch ride on `/`, so a proxy that forwards `/` needs no new route.

The server is dependency-free, reads `snapshots.jsonl`, `events.json`, `goals.json`, `weekly.json` and `password.scrypt`
and re-reads each when its mtime changes. It is closed by default and is meant to sit behind a TLS proxy:

- No valid `password.scrypt` → every request answers `503`. A wrong or missing password answers `401` (HTTP Basic,
  any user name); 10 failures within 15 minutes lock the whole service for the rest of the window (`429`), so no client
  address is read or kept. A cancelled browser prompt leaves a short "team password needed" note with no data. Only
  `GET`/`HEAD` of `/` (with `?lang=`/`?export=csv`), `/healthz` and `/robots.txt` exist; every answer sets
  `no-store`, `noindex`, and a CSP with no script source.
- `hash-password` (password on stdin, never an argument) prints the same `scrypt$N$r$p$salt$hash` line the report
  relay uses; save it as `password.scrypt` in `METRICS_KEYS_DIR` (default `/keys`). Snapshots are read from
  `METRICS_DATA_DIR` (default `/data`). `METRICS_HOST`/`METRICS_PORT` default to `127.0.0.1:8789`; a non-loopback host
  needs `METRICS_TLS_TERMINATED=1`.

The reference deployment follows the report relay's shape: files in `/opt/polyth-metrics/{app,keys,data}`, a
hardened `node:22-alpine` container `polyth-metrics` on `127.0.0.1:8789`, and a systemd timer
`polyth-metrics-snapshot.timer` (06:10 UTC, `Persistent=true`) whose oneshot service runs
`community-metrics.mjs snapshot --out /data/snapshots.jsonl` in a throwaway container (no GitHub token, so the
traffic signal is absent there and the GitHub number is the star count). Updating is copying the two `.mjs` files
into `app/` and restarting the container; they need no build. The first snapshot after an update that adds a split
(platforms, feed channels) has nothing to compare the split with, so the page falls back to the latest releases for
about a week. Public exposure (a TLS vhost forwarding only `/` and `/healthz`, a DNS-only record
and the password) is a separate, owner-approved step. On that host `/usr/local/bin/polyth-metrics brief|note|goal …`
runs the matching command in the same kind of throwaway container (`--network none`, `--dir /data`, the data
mounted read-only for `brief`), so whoever may run Docker there can write the note or a goal without touching the
service container.

## Weekly note and monthly goals

Two optional files next to `snapshots.jsonl` add a row under the summary paragraph:

- **`weekly.json`, the weekly note.** Three plain lines per language, written every Monday by a Polyth Agent
  from `brief` (the same figures the page shows: the last 7 counted days against the 7 before, platforms, releases
  and events in the period, goal progress, the goals already set for later months, and a `wording` reminder that downloads and active apps are not people).
  `note` accepts `{"from":"YYYY-MM-DD","to":"YYYY-MM-DD","uk":[…],"en":[…]}` with 1–3 lines of at most 240
  characters per language (either may be left out; an English page then shows the Ukrainian lines marked
  `lang="uk"`), strips control, line-separator and bidi characters, stamps `writtenAt` itself and replaces the file
  atomically; anything else exits `2` and writes nothing. `**text**` is the only markup and becomes bold after
  escaping. A note older than nine days is marked as not renewed. The page names the period (`from`–`to`) and
  "Polyth agent" as the writer.
- **`goals.json`, the monthly goals.** `[{"month":"2026-12","metric":"downloads","target":1500}]`, one per month and
  metric (`downloads`, `active`, `stars`), set or removed (`--target 0`) with `goal`. The card shows the goals of the
  month of the latest counted day, so on the 1st the finished month shows its result. Downloads are summed over the
  month's counted days and projected at their own average to the month's end (from three counted days); the bar
  carries a tick at the even-pace point and the text says how many a day are still needed. A month in which
  counting began counts from that day and says so. Active apps (the 7-day average) and stars are compared with the
  target as levels, never projected. States: reached, on track, slightly behind (forecast ≥ 85 %), behind, missed
  (month over), collecting data, or "N to go" for a level.

The targets are the team's decision; the agent sets one only when a person asks it to.

## Not done on purpose

An opt-out or opt-in heartbeat from the apps, and server-side counters at the edge of polyth.app or the report relay, are
deliberately **not** built: either changes the public "no telemetry" promise or a live service, so each needs the
owner's decision, a consent design shared with the bug-report flow (one Settings → Privacy surface, a separate
endpoint and storage, a daily-rotating id like `dailyInstallId` in `packages/bug-report/src/sender.ts`, an
`…_ORIGIN=off` switch, workstation builds excluded) and updated documentation on this page, the security page and
the workstation edition document.

Tests: `scripts/test/community-metrics.test.ts`, `scripts/test/community-metrics-server.test.ts`.
