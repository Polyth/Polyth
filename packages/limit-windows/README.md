# @polyth/limit-windows

Provider limits come in windows: a 5-hour window usually starts with the first request after the last one ended, and ends five hours later whether you used it or not. This package decides when that first request happens, for every account separately, under *Settings → Limit windows*.

- **At an hour.** A new window starts at the hour you choose (`09:00`), on the days you choose. *Prepare ahead* also starts the windows before it (`04:00` for a 5-hour window), so one ends exactly on the hour even if something runs overnight. *Keep restarting* starts the next window after each reset, as long as the new one still ends by the next chosen hour; since 24 hours do not divide by 5, the gap falls just before that hour.
- **After every reset.** The next window starts within seconds of the last one ending, so none of them sits unused. An optional daily range keeps this to chosen hours.

Everything is off until a person turns it on for an account. A running window is never touched: no request can shorten it, so a request only ever goes to a window that is not running.

## Which accounts

Every source the [Limits service](../usage/README.md#limits-semantics) reads that has an account-wide window with a known length of at least an hour. Each runs on its own login:

| Source | Runs on | Windows |
| --- | --- | --- |
| `claude`, `claude-<account>` | that harness's `claude -p`, with its own `CLAUDE_CONFIG_DIR` | `5h`, `7d` |
| `codex`, `codex-<account>` | that harness's `codex exec --ephemeral`, with its own `CODEX_HOME` | what the plan reports (`5h`, weekly, or `30d`) |
| `antigravity`, `antigravity-<account>` | that harness's `agy --print`, with its own `HOME` | `google-*` and `third-party-*`, as two separate groups |
| `opencode-go` and any other provider source | the harness whose catalog lists that provider, OpenCode first (Pi also reaches `opencode-go`) | `5h`, weekly, monthly |

`routeOfSource` in `src/serverEntry.ts` is the rule. An extra account never falls through to another login. A `claude` or `codex` source reaches OpenCode through its `anthropic` or `openai` provider only when its own harness is not registered.

A harness that answers `HarnessProvider.completeUtility` runs without a runtime, session or project, in an empty directory (`<package data>/start`), so no project instructions or repository reach the request. A harness that serves a whole workspace (OpenCode) answers in a local project of the Space the plan was saved from, through `host.smallModelComplete` with purpose `minimal`, which is OpenCode's tool-less `title` agent.

## The cheapest model

`src/models.ts` ranks the live catalog; there is no list of model ids. A positive price from the catalog decides first. Otherwise the words in the name do (`haiku`, `mini`, `lite`, `luna` before `flash`, `oss` before an unmarked model before `opus`, `pro`, `sol`), then an alias the harness keeps current, then the older version, then catalog order. A free route ranks last because it may not count against the plan, and so may not start its window. On Antigravity each group only considers the models it meters (`windowMetersModel` in `@polyth/usage/limit-sources`). A person can pick another model; one the catalog stops offering falls back to the cheapest.

The request is `Reply with just: OK`. What it costs is mostly what the CLI itself always sends, which differs by harness (about 39k input tokens on `agy`, measured in September 2026).

## How a window reads

`phaseOf` in `src/windows.ts`, from what the providers reported on 2026-11-05:

- **Not started.** No reset at all (Claude), or a reset a full period ahead of every read on an empty window (Antigravity, OpenCode Go), which slides forward with the clock.
- **Running.** A reset that stays put. A started window can read `0%` for a long time, so `used` alone proves nothing.
- **Fixed calendar.** OpenCode Go's weekly window resets on Monday 00:00, used or not. It reads as running, so nothing tries to move it.

A `<model>/<period>` window belongs to one model and is not steered. A used-up window of a group holds that group until its reset, because the request would be refused.

## Evidence and safety

`src/decide.ts` is one pure decision, used by the server and shown by the page:

1. A start is written to `history-v1.json` *before* its request goes out. It is never replayed: after a crash, a timeout or a disable, the next reading says what happened.
2. A due start first asks the provider for a new reading, so a window a person just started cancels it. If that reading keeps failing (three tries, 30 s apart) the start goes ahead on the last good one: a usage endpoint that is down should not hold every window back, and a request into a running window costs next to nothing.
3. 150 s after a request a new reading judges it: `started` with its real reset, `no-effect`, or `unconfirmed` when no reading came (then it is assumed to have started, for one window's length). A sliding reset needs that long to tell apart.
4. Failed requests back off 10 min, 30 min, 1 h, 3 h. Two answered requests that started nothing hold the group for 12 hours or more, which is what happens when a CLI runs on an API key instead of the plan. At most 24 requests per group per day, whatever the readings say.
5. At most two requests run at a time; each is a CLI process on a shared host.

Boundary requests go out 45 s after the mark, because a provider that rounds a window's start down to its grid then lands exactly on it (Claude's resets end in `:59:59.85`). One that does not round ends up less than a minute late. A chosen hour missed by up to 20 minutes (a restart, a person's window that ran over it) still starts late; any later waits for the next one. A plan saved just after an hour does not fire for it.

## Who may do what

Host logins are deployment-wide, so plans and history are too (`<package data>/plans-v1.json`, `history-v1.json`): one account has one schedule.

- A **private login** is seen and changed only by the person who added it. Its plan records that owner and stops running if the account id ever belongs to someone else.
- A **shared login** is changed by the instance owner or a harness manager. Someone allowed to use it can read its plan; anyone else gets no sign of it.
- Only a `local-trusted` deployment runs any of this. The routes are local-only: paired devices need full access, and guarded accounts see the page as unavailable.

Responses carry no secrets. CLI errors are cut to their first line and redacted before they are stored.

## Routes

- `GET /api/limit-windows/state?timeZone=` — every account the caller may see, with its plan, windows, forecast, next step, models and recent starts. Reads cached snapshots; never asks a provider.
- `PUT /api/limit-windows/plans/:sourceId` — saves a plan (`parsePlan`), answers the account's new view.
- `POST /api/limit-windows/plans/:sourceId/start {meterId}` — *Start a window now*: the same reading and evidence, without the schedule. Refuses (`409`) a running, used-up or still-settling window.

## Limits

- Providers do not document when a window starts, and any of this can change. The evidence above is built to notice, not to prevent it.
- Whether a request counts against a plan depends on the provider. Starting a short window can also start the weekly one, which then runs from that moment.
- The forecast assumes nothing else uses the account. A person's own turn can start a window sooner, and the plan then follows it from its reset.
- `agy` records each print request as a native conversation under the account's `.gemini`.
- Plans run only while the server runs. A server that was down over a chosen hour starts late or skips it as above.
- The page's copy is English and Ukrainian (`widgets/copy.ts`); other languages read English.
