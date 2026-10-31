# Command ownership and side effects

Observed at the evidence baseline. Inspect current manifests before execution. These are repository commands, not automatically authorized operations. Run from the repository root unless stated otherwise. The kit CLI requires Node >=22.16 and Git for inventory/impact; it does not require npm dependencies.

| Command | Meaning | Side effect / limitation |
| --- | --- | --- |
| `npm ci` | Install locked workspace dependencies | Network and install scripts; only when installation is authorized |
| `npm run build:web` / `npm run build` | Bundle package web entries and web shell | Writes dist; does not validate native apps |
| `npm start` | Start Node server | Uses real runtime/data unless explicitly isolated |
| `npm run dev` | Build once then start | Not a guarantee of HMR |
| `npm run watch` | Run the development supervisor | Can start/manage a runtime; read `scripts/supervisor.ts` and its actual options before starting. Restarts the server on exit and, via a liveness watchdog, SIGKILLs and restarts a server that answered before but then left `/api/health` unanswered for `--liveness` seconds (default 60, `off` disables); the server logs `event loop blocked for …` after each stall of 1 s or more |
| `npm run polyth:restart` | Rebuild and restart the live Polyth server, detached and drain-aware; returns at once, so it is safe from a Polyth session (see [Restarting the live server](#restarting-the-live-server)) | Schedules systemd unit `polyth-restart`; touches live `./data` and `:4400` only after its checks pass; requires the user systemd manager; flags `--max-wait`, `--force`, `--skip-canary`, `--full` |
| `POLYTH_DEBUG_AGENT_ACCESS=1 npm start` | Start explicit agent debug access | Direct-loopback REST/WS acts as the active owner without browser login; outside loopback-only `local-trusted` deployment, an operator override is logged while the bypass stays loopback-only; Polyth Link never inherits it |
| `npm run agent:beta` | Build and run disposable agent UI beta | Loopback-only web UI, temporary Polyth data, no browser login, host harness discovery/auth; workspace edit/write and shell mutation paths are denied and temporary data is removed on exit |
| `npm test` | Root Node test glob via `scripts/run-tests.mjs` | Broader than generic CI selection; may include environment-dependent tests. Runs with a private per-run `TMPDIR` (`scripts/run-tmp.mjs`) that is removed afterwards. Kills the test tree and fails when free memory runs low ([verification](verification.md#bounded-local-verification)) |
| `node scripts/run-tests.mjs <existing-test.ts> [more…]` | Focused Node test | Adds `--experimental-strip-types --test` and passes other arguments through (`--test-name-pattern=…`, `--test-concurrency=1`); same private `TMPDIR` and low-memory guard as `npm test`. Prefer it to a bare `node --experimental-strip-types --test <file>`, which writes every fixture a suite does not remove straight into the shared `/tmp` and has no memory guard |
| `node scripts/run-bounded-check.mjs -- <command> [args…]` | Resource-capped local verification on Linux | Requires a systemd user manager; limits memory, CPU, task count and duration and gives the command a private `TMPDIR` removed afterwards; see [verification](verification.md) |
| `node node_modules/typescript/bin/tsc --noEmit -p <existing-project>` | Existing local TypeScript compiler | No implicit download; verify installed compiler and tsconfig first |
| `node scripts/ci/select-tests.mjs ci` | Print generic CI-owned tests | Selection only, does not execute tests |
| `node scripts/ci/select-tests.mjs polyth-link` | Print Link-owned tests | Selection only; the shared CI quality contract runs this set |
| `npm run build:desktop` | Web + Electron build | Not signing, packaging or launched-app smoke |
| `npm run mobile:sync` / `npm run build:mobile` | Web build + Capacitor sync | Writes native generated files; not a native production build |
| `npm run mobile:build:android` | Web, sync and Android build command | Requires Android toolchain and current signing/config requirements |
| `npm run mobile:open:ios` / `mobile:open:android` | Open native project | Requires platform tooling; not a test |
| `npm run build:link` | Build declared Link Rust executables | Requires pinned Rust toolchain; not a native mobile adapter test |
| `docker build -t polyth:local .` / `docker compose -f deploy/docker/compose.yml …` | Build/run the server container ([Docker](../operations/docker.md)) | Pulls base images and builds Rust Link host; compose uses host networking and its own volumes, not `./data` |
| `deploy/docker/smoke.sh <image> [port]` | Boot smoke test of a built image | Throwaway volume, host network on port 47400 by default |
| `node scripts/ci/promote-master.mjs plan` | Print which packages a promotion leaves on devel and whether removing them is safe | Read-only; exit 1 when a kept package depends on a devel-only one |
| `node scripts/ci/promote-master.mjs check-drift <master> <devel>` | Refuse master changes devel does not carry | Read-only git comparison |
| `node scripts/ci/promote-master.mjs apply` | Turn the current checkout into the master tree ([branches](../operations/releases.md#branches-devel-and-master)) | Deletes devel-only package folders, rewrites `package.json`/`package-lock.json` via `npm install --package-lock-only` (network), regenerates i18n wiring and prunes `docs/agents` maps; run only in a disposable checkout of the devel commit |
| `node scripts/ci/check-dco.mjs <base> <head>` | List commits in a range that lack their author's `Signed-off-by` trailer (the PR DCO check) | Read-only git log; exit 1 when one is missing |
| `node scripts/completion-sound.mjs` | Regenerate the completion chime (`apps/web/src/assets/completion.mp3` and its data URI) | Rewrites both asset files; needs `ffmpeg` with libmp3lame |

Repository validation lives in `.github/workflows/ci.yml`; `.github/workflows/dco.yml` checks every pull request's commits for a DCO sign-off. `.github/workflows/scorecard.yml` runs OpenSSF Scorecard once the repository is public. Every action is pinned to a commit SHA with its version in a comment (enforced by `scripts/test/workflowPins.test.ts`; Dependabot updates both). Manual unpublished artifacts live in `.github/workflows/build-apps.yml`. Actual publication is owned by the manual, master-only `.github/workflows/release.yml`. `.github/workflows/promote.yml` (manual) rebuilds `master` from `devel`, and `.github/workflows/nightly.yml` builds `devel` nightlies once the repository opts in; signed iOS/TestFlight is produced by the external builder's nightly run via `scripts/ci/remote-build.mjs` until that cutover. Read these files for exact build/sign/upload boundaries rather than copying commands from an old chat.

## Restarting the live server

Load changed server code into the live instance with `npm run polyth:restart` and nothing else. From a Polyth session never run `systemctl --user restart polyth-supervisor`, `kill` the server, or any restart that waits for its own result: the server drains every running agent turn before it exits, and the session that asked is one of those turns, so a caller that waits for the restart waits for itself until the supervisor's 30 s SIGKILL cuts every turn (`createRuntimeAdmissionBarrier.drain` in `packages/server/src/indexCore.ts`, `graceMs` in `scripts/supervisorPlan.ts`).

The command only schedules a worker in its own systemd unit and returns, so **finish your turn afterwards**. Progress: `journalctl --user -fu polyth-restart -o cat`; outcome: `$XDG_RUNTIME_DIR/polyth-restart.result`. The worker (`scripts/restart-polyth.ts`) leaves the live server untouched until all of these hold:

1. `npm run build:web` succeeded; the previous bundles are restored if it fails, because the build deletes `apps/web/dist` and `packages/*/dist/web` before it rebuilds them.
2. The working tree booted in an isolated `scripts/agent-beta.ts` instance, so a tree that cannot start never reaches the live server.
3. No agent turn is running: sessions in `working`, plus `waiting` sessions whose `runtime.activeTurn` is true (an open question with no running turn does not hold the drain). It refuses, server untouched, after `--max-wait` seconds (default 900).

It then sends SIGTERM to the server child only; the supervisor restarts it like a crash, and the server drains before it exits. A draining server refuses every new turn, so the worker waits only for the turns the agent API showed at SIGTERM (none, after step 3); a session that looks busy later is a refused send. The drain also waits on executions the API never shows (small-model tasks, a leg that never sent idle — on 2026-10-04 one held a drain for 16 min), so once the SIGTERM-time turns are done the server gets 30 s and is then SIGKILLed; a server left fenced is an outage, so after 30 min of drain it is SIGKILLed too. `--force` skips step 3 and the turn wait, and therefore interrupts running turns. It finishes by confirming that a *different* process answers `/api/health` (the old one answers all through its drain) and that the shell and every package module and stylesheet load. If the server does not come back the supervisor unit is restarted once.

When the supervisor unit does not exist yet (for example after a reboot), the worker creates it from `$XDG_CONFIG_HOME/polyth/restart.env` (default `~/.config/polyth/restart.env`): `KEY=VALUE` lines for `HOST`, `PORT`, `POLYTH_PUBLIC_ORIGIN`, `POLYTH_TRUSTED_PROXIES`, `POLYTH_DEBUG_AGENT_ACCESS` and `POLYTH_WEB_BUILD_FRESHNESS`, with the process environment winning. Without that file the unit binds loopback only, and the public-site check after a restart runs only when `POLYTH_PUBLIC_ORIGIN` is set. Use `--full` after changing `scripts/supervisor*.ts`, the unit environment or Node. Known limits: the bundle build still recreates the output directories in place, so the UI can answer 404 for the 10–25 s of a build (a supervisor watch build has the same window), and the isolated boot test cannot see failures that depend on live configuration or on migrating live data.

## Existing CI is not “everything passed”

Current `ci.yml` runs smoke validation on code pushes to `devel` and `master`, on every pull request to them, and on ordinary manual dispatch: a web build plus streaming and sync tests. The full job validates agent guidance, runs `release-quality.mjs` (web build, owned TypeScript projects and release/workflow contract tests), and runs Rust format/lint/workspace tests; it runs on manual dispatch with `full=true` and, once the repository is public, on every push and pull request (while it is private it stays manual to bound the Actions budget). The repository variable `CI_DISABLED` can skip both jobs before runner allocation. Validate a PR locally when hosted checks are absent; do not treat an empty check list as a pass. Broader environment-heavy suites are not a blocking baseline until independently made green; do not silently widen or weaken the gate.

No root lint or root typecheck script was declared at the audit baseline. Do not infer the absence of CI from that fact. Use manifest-defined commands or the actual installed local compiler. Never let a package manager install a missing tool silently while claiming to have only run a check.

The release-quality contract includes the Judgment and Judgment adapter TypeScript
projects and their deterministic offline tests, plus the desktop manifest inventory
test. See [Judgment verification](../../packages/judgment/README.md#verification)
for focused commands; no provider credentials or paid turns are required.

## Safe test environments

Do not hardcode a private IP, assume any port is the user's intended instance, or kill a process just because it occupies a preferred port. Establish the instance identity. Test mutation/restart/migration against isolated data and an isolated port; one data directory has one owner. Confirm fake runtimes do not call paid providers. Never point fixtures at the user's active data.

## Identity migration preparation

`node --experimental-strip-types scripts/migrate-identity.ts --help` describes the
operator-only `inspect`, `stage` and `verify` commands. See
[the migration preparation procedure](../dev/identity-migration.md) before use.
Staging requires a stopped installation, a pinned inventory digest, and a private
non-overlapping destination. It creates a scoped input capsule, not a full asset
backup or an activated control authority. No live apply or automatic restart is
exposed. Fixture tests live in `packages/tenancy/test/migrationStage.test.ts` and
`scripts/test/migrate-identity.test.ts`.
