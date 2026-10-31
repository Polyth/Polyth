# @polyth/usage

Usage keeps one analytics pipeline with three analytics scopes, plus a separate operational Limits page:

- **Session** — lifetime telemetry for one session: tokens, cache, reported cost, response throughput, whole-turn throughput, wall/model/tool time, TTFT, steps, retries, and turn detail.
- **Project** — range-based usage for one project: sessions, turns, tokens, cache, reported cost, activity, harnesses, models, and session detail.
- **Global** — the same range-based metrics across all projects, plus project and harness breakdowns.
- **Limits** — provider/harness account capacity: balances, limit windows, reset times, pace, and bounded exhaustion projections.

Limits do not become a fourth analytics scope. They use an isolated account-telemetry service under `src/limits.ts`; provider-specific discovery lives under `src/providers/`. This keeps quota/balance polling out of the durable session-event analytics pipeline and avoids restoring the old provider dashboard, pinning, billing profiles, provider layout editor, or legacy quota widgets (`usage.quotas`, `usage.quota-summary` and the other retired ids stay retired). The placeable [Limits widget](#limits-widget) is a read-only view of that same service, not a second quota path.

## Source of truth

The canonical source is the durable session event log. `usage/recorded` events are normalized into `UsageObservation` records by `src/analytics/collect.ts`. Legacy assistant usage is accepted only when a turn has no usable canonical usage event and is marked `derived`.

A projection-only cumulative session total is a last-resort historical fallback and is also marked `derived`; it is never presented as exact turn-level telemetry.

`src/analytics/service.ts` maintains a rebuildable Space-owned checkpoint so analytics does not depend on which sessions happen to be loaded in a browser. The server source uses the request's scoped session service: Session looks up only the requested session, Project lists only that project's sessions, and Global performs the authoritative full-Space sync. A missing or foreign-Space session yields no usage without exposing whether it exists.

Warm syncs check durable event tails with the same bounded concurrency as cold backfills; unchanged logs are reused even when a projection side effect lags behind an event append. A session's event log is re-read only when its tail advanced or a projection field the collector reads changed (project, parent, harness, model, cumulative totals, last turn time). Status and `updatedAt` are deliberately not part of that fingerprint: a working session flips them on every tick, and re-reading its whole log for that made each dashboard query pay for every live session. Checkpoints written with the older status-bearing fingerprint are upgraded in place rather than rescanned. Each materialized report contains only the sessions listed for its scope. Concurrent identical requests within one Space share a sync and report build, while later requests revalidate the source. A later identical query reuses its built report when that sync observed no observation or membership change and the local day is the same; only the clock fields are restamped (plus the open end of an `all` range). A title or status change alone does not rebuild the aggregate: the cached report's session and turn rows are relabelled from current metadata. Up to 32 reports per Space are kept. The checkpoint is written 10 s after the last change, and again on stop; the identity call starts parsing a cold checkpoint so the report request that follows finds a warm index. Local dates are resolved per aligned 15-minute slot, with an exact conversion for any slot that straddles midnight or an offset change. TTFT derivation sorts each turn's chunk times once and binary-searches every model segment. Activity-sorted detail selects its bounded visible rows before calculating row telemetry; totals and coverage still include every matching observation.

## Query semantics

`POST /api/usage/stats` is the analytics data route. `GET /api/usage/identity` only identifies the current runtime/Space for cache fencing. The runtime id (`serverInstanceId`) belongs to the deployment's storage root (`usage-instance-v1.json` under the shared `storageDir`), not to the process: a restart keeps the id so the browser's persisted reports stay valid and are merely revalidated, while a different data directory is a different runtime. Without a storage root the id is per process, as before. Limits are exposed separately through `GET /api/usage/limits` and `POST /api/usage/limits/refresh`.

`UsageStatsQuery` supports:

- local-calendar ranges: `7d`, `30d`, `90d`, `all`, or explicit custom bounds;
- project scope via `projectIds`;
- exact session scope via `sessionIds`;
- adaptive time buckets;
- bounded session/turn detail rows and their sort order.

Unsupported legacy filter fields are rejected instead of silently broadening a report. Range start is inclusive and range end is exclusive. The caller supplies an IANA timezone so daily boundaries are calendar-correct.

Session, Project, and Global are different queries over the same observations rather than separate statistics implementations.

## Metric semantics

Token components remain separate: input, output, reasoning, cache read, and cache write. Unknown telemetry remains unknown instead of becoming zero. Reported cost is shown only when observations contain cost.

Token counts are abbreviated to one decimal by the host's shared `fmtTokens` (`1.0k`, `1.0M`, `1.0B`) on the dashboard, the placeable cards, the cache and context readouts, and token-unit Limits windows. A figure that would round up to `1,000.0` of a unit moves to the next one, so 999,960,000 tokens read `1.0B`, never `1,000.0M`. Chart axes use the locale's compact notation (`500M`, `3B`) instead.

Adapters publish that shape under one contract, because `input + cacheRead` is the prompt footprint and the cache hit is `cacheRead / (input + cacheRead)`:

- `input` is the **non-cached** input. A provider that counts cached tokens inside its prompt total (OpenAI Responses/Completions style, Command Code's gateway rows, Codex App Server `inputTokens`) must subtract its cache counters before emitting. Anthropic and OpenCode already report the non-cached remainder.
- Cache counters stay in `cacheRead`/`cacheWrite`; they are never folded back into `input` and never double-counted.
- Every observation is an increment (one model response or one explicit per-turn aggregate), never a re-published cumulative counter. A provider that only exposes running totals must difference them, and must rebase when the total restarts instead of treating a reset as negative usage.

Getting this wrong is not cosmetic: an inclusive `input` halves the displayed cache hit for cache-heavy sessions, and differencing a per-response counter publishes prompt growth instead of response usage.

Timing, steps, and retries are **turn-level** measurements. Multiple token/cost observations inside one turn do not multiply them; aggregation deduplicates turn telemetry by session + turn id.

## Prompt cache health

`src/analytics/cacheHealth.ts` derives a provider-neutral cache signal from the same observations. It has no telemetry of its own and runs in both the server and the browser:

- **Last cache activity** — the latest observation of a session that read or wrote cache (`UsageSessionDetail.cache.lastActivityAt`), with the prefix it left cached (`cachedTokens` = read + write).
- **Lifetime (TTL)** — `ttlBasis` says where it came from. `provider-default` is a documented fixed default (only Anthropic: 5 minutes). `observed` means a cache hit came more than 5 minutes past that default, which proves the provider's longer lifetime (Anthropic: 1 hour). Everything else is `unknown`; OpenAI documents its automatic cache only as 5–10 minutes, up to an hour off-peak. No adapter records the lifetime a request asked for, so a 1-hour Claude Code cache reads as 5 minutes until a hit proves otherwise.
- **Burn** — a request on the same provider and model that read less than half of the prefix the previous request had cached, wrote cache instead, and came at least one lifetime after it. With an unknown lifetime, the shortest documented one (5 minutes) applies. The re-written tokens (`min(write, previous prefix − read)`) are summed into `UsageAggregate.cacheBurn` for totals, groups, sessions and turns. It is `null` when no observation reported cache writes, so it stays unknown for providers that report only reads, such as OpenAI. The scan reads every in-scope observation, not just the range, so a miss just after a range boundary is still proven by the request before it.

The session card adds **Prompt cache** (time left, then *Expired* with the tokens the next turn re-writes; with an unknown lifetime only *Idle for …*) and **Cache burn**. Its state comes from the loaded event tail, so it moves the moment a response lands, merged with the report's full-history burn. The countdown pauses while the session is working. It repaints every second in its last two minutes, every 15 s before that, every 30 s for idle time and never once expired. The Token mix block shows the scope's burn under the cache hit ring, and the **Cache burn** dashboard block (`cache`, after Token mix in every scope) lists where it happened: by model, project (Global), harness or session, or by turn in the Session scope. It lists only rows that burned, largest first. Reads-only telemetry is stated as not reported, never drawn as zero; the block is hidden for reports from servers that predate `cacheBurn`. Session and turn rows come from the report's capped detail lists. The card's countdown shows whole minutes (rounded up) until its last two minutes, then seconds; warning text uses `--amber-on-wash` for contrast on light themes.

Limits: a compaction or a provider-side eviction after an idle gap is indistinguishable from expiry and counts as burn. Per-turn aggregate observations (Codex) inflate the prefix size but not the miss ratio. Burn is reported in tokens, not money: the write-versus-read price ratio is provider-specific and not in the telemetry.

**Keep warm, on request.** Keeping a cache warm means sending a real model request before expiry, so Usage never does it on its own. The composer's context card (the `composer.context.details` slot, beside the host's Compact button) shows the cache warmth and the re-write a lapsed cache costs, and offers **Keep warm** for 30 min, 1, 2, 4 or 8 h (`POST /api/usage/keep-warm {sessionId, minutes}`, `0` stops; `GET /api/usage/keep-warm?sessionId=` reads the status). The chosen period is kept as cheaply as the cache allows (`src/keepWarm.ts`): a keep-alive goes out only just before the cache would lapse (90 s ahead after a person's turn, whose long answer delays the observed usage; after our own keep-alive twice its measured round trip plus 10 s, 20–60 s; never over a third of the lifetime), only while the chat is idle with nothing queued (a working chat keeps its own cache warm), never once the cache outlives the period by itself, and never to re-warm a cache that already went cold (that costs the same re-write the person's next message pays; keep-alives resume after it). Each keep-alive is verified: its response must read the cache; two misses, a failed send (never retried) or an unknown lifetime stop it. Only providers with a documented or observed lifetime qualify (`@polyth/usage/cache-ttl`). Keep-alives are sent as the person who asked, through `SessionService.send` with `keepAlive: true`: the host hides that turn from chat, fires no notification or turn-completion hooks (goals, recap, memory, isolation, judges) and keeps `lastTurnAt`, while its usage still counts. State is in memory: a server restart forgets it. Two other opt-in owners send keep-alives automatically: scheduled agents (`keepWarm: "auto"`, owned by `schedule`, which knows the next wake) and the `judges.keep-warm` Judgment use (owned by `judgment-judges`, for ordinary chats that Judgment says are clearly unfinished, within a per-pause and per-day budget; see its README). All read their cache facts from here: `@polyth/usage/cache-ttl` and `@polyth/usage/session-cache` (`sessionCacheFacts(projection, events)`: health plus the latest read and the prefix before it, which proves a hit or miss).

## Status-bar segments

`widgets/statusbarSegments.tsx` registers four mini-widgets for the status
bar's two widget areas (default at the trailing end, visible once the bar is
on, hideable and movable like the shell's own segments). They read the active
session only and render nothing without a session or data:

- `usage.statusbar.context` — prompt occupancy as `73.4k (7%)`, the share
  coloured by the context gauge's green/yellow/red level, then the session's
  reported spend (`SessionProjection.costTotal`) in whole cents (`<$0.01`
  instead of a zero). The gauge is the composer's (`useSessionContextGauge`).
- `usage.statusbar.cache` — the session card's prompt-cache line
  (`useSessionCache`): time left, `In use`, `Idle …` for an unknown lifetime,
  or `Expired`, with the same warning/critical tones. It never keeps a cache
  warm.
- `usage.statusbar.limits` — the `current` Limits source of the session's
  harness/model; of its capped windows the one with the least share left,
  as `Weekly 37% left`, coloured by the Limits bar-colour preference. Balances
  without a cap are skipped. It shares the 60 s limits poll and cache.

- `usage.statusbar.turn` — while the session runs a turn, a live `m:ss` timer
  from the open `turn/started`; afterwards the last finished turn's wall time
  (`36.0s`) and response speed (`51.8 tok/s` = output tokens over measured
  model-active time, the dashboard's response tok/s). Both come from
  `collectSessionObservations` (`widgets/turnStats.ts`); a turn without
  measured timing shows nothing.

Context, cache and turn open the Session view of the Usage pane; limits opens Limits.

## Harness breakdown

`UsageStatsReport.harnesses` groups the selected observations by the harness that ran them (`UsageObservation.harnessId`, stamped from the usage or turn event and falling back to the session's resolved harness). Ids are normalized to a lowercase slug. Known harnesses are labelled with their backend's display name from a fixed table (`displayHarness` in `src/providerIdentity.ts`, so a new backend needs an entry there to get a proper name); any other harness falls back to its prettified id. Each account of a multi-account harness is its own group, because it is its own harness id (`claude-work`). The server names it with the live registry name, such as `Claude Code · Work`, while the account is registered. A removed account still reads `Claude Code · Work`, derived from its id. Observations without a recorded harness form an explicit `unknown` group instead of vanishing, so the groups always partition the scope's totals. Each group carries the same `UsageAggregate` and cost/token trend as a model or project group.

Project and Global draw it as a static SVG donut with a legend for one metric (tokens, cost, or turns):

- shares are relative to the plotted values, i.e. harnesses that recorded a non-zero value for that metric; a harness with nothing to plot stays listed without a slice;
- the total in the hole is a lower bound (`≥`) whenever any harness lacked that metric, the same rule as every other total;
- slice tones follow a token ranking that does not depend on the selected metric, so switching the metric never recolors a harness; the unknown harness and any harness beyond the eight-tone palette use the neutral tone;
- Session scope has no breakdown: one session normally has one harness.

Derived throughput:

- response tok/s = output tokens from timed turns / measured model-active time;
- whole-turn tok/s = output tokens from timed turns / measured wall time.

Untimed legacy output is excluded from the throughput numerator. TTFT is averaged across measured turns. Wall/model/tool time is summed across the selected turns.

## Limits semantics

Supported provider adapters are discovered from the harness/provider credentials already present on the host. A private deployment may additionally declare HTTP sources in `limits-providers.json`; secrets are referenced by environment-variable name and are never returned to the browser.

Built-in sources and their credentials:

- OpenCode Go (`opencode-go`) reads its API key from the OpenCode/Pi auth stores.
- OpenCode Zen (`opencode-zen`) reads the OpenCode Console device-flow sign-in from the OpenCode `auth.json` (`opencode` entry), refreshes an expired token through the Console, and reports the member/credit monthly budget plus the Console balance. Pi's agent auth file is not a Console credential source for Zen. The Console routes are unofficial; a route that fails hides only the rows it feeds. When no monthly limit exists, only the balance is reported — spend is not turned into a fake capped quota.
- Kimi Code is regional: `kimi-for-coding` (CN) uses `api.kimi.com`, `kimi-code-plan-global` uses `api.kimi.ai`. Each key is sent only to its own host.
- Chutes AI, Synthetic and Kilo Gateway accept their documented `CHUTES_API_KEY`, `SYNTHETIC_API_KEY` and `KILO_API_KEY` environment variables first, then the auth-store key. Kilo reports Kilo Pass credits when active and the gateway balance otherwise.
- Xiaomi MiMo reads its dashboard cookie from `MIMO_USAGE_COOKIE` or `quota/mimo.json` in the managed data directory (a JSON object with a `cookie` field).
- Alibaba Personal Token Plan (`alibaba-token-plan`) runs only `bl usage token-plan --output json` from a trusted absolute PATH entry, from the home directory, with a timeout and no shell. It never installs or logs in to the CLI.
- Alibaba Coding Plan (`alibaba-coding-plan`) is a per-Space local estimate from the Space's own canonical usage observations, not a global adapter: the limits routes append it only for the requesting Space, mark it `scope: "space"`, and every limits response carries `serverInstanceId`/`spaceId`. It counts one request per exact or token-estimated usage observation of a **completed** turn; failed, cancelled and still-running turns and derived legacy backfill are excluded, so it may under-count but never guesses. It is enabled by the auth entry or `ALIBABA_CODING_PLAN_API_KEY`/`ALIBABA_API_KEY`; the tier comes from the auth entry, and an unknown tier reads as Lite. An explicit refresh answers 404 when it is not configured and 500 `limits-unavailable` when the analytics read fails.
- Gemini CLI companion logins stored under `google`, `google-gemini-cli`, `gemini-cli` or `opencode-gemini-auth` are read by the existing Google source.
- Polyth ships no Google OAuth client. An expired Google or Antigravity token is refreshed with the client that issued it, read from the user's own install (`src/providers/googleCliClients.ts`): Gemini CLI's `OAUTH_CLIENT_*` (found through the `gemini` launcher or a global npm prefix), `opencode-gemini-auth`'s `GEMINI_CLIENT_*` or `opencode-antigravity-auth`'s `ANTIGRAVITY_CLIENT_*` in OpenCode's plugin cache. An `agy` login is refreshed by `agy` itself: Usage runs the installed `agy models` (no model turn; `POLYTH_ANTIGRAVITY_BIN` overrides the binary) with `HOME` set to the login's home, then reads the rewritten token file. Without such an install the source reports an expired login instead of refreshing.

One provider source can read more than one credential store. A subscription belongs to an account, and that account can be signed in to several harnesses at once — OpenCode keeps its logins in `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`, Pi in `$PI_CODING_AGENT_DIR` (default `~/.pi/agent/auth.json`). `providerLogins` in `src/opencodeAuth.ts` lists those stores in order and deduplicates by value; an adapter that receives an authentication rejection (401/403) tries the next stored login before reporting a failure. This is why an expired key in one client does not hide a working login of the same account in another. A rejected credential is reported as **Key rejected** (create a new key in the provider's console), distinct from **Needs sign-in** for a credential that is missing entirely: an expired API key does not mean the account was signed out.

The Limits service:

- polls with jitter and exponential backoff;
- deduplicates concurrent refreshes;
- preserves the last successful snapshot when a source fails and marks it stale;
- separates balances from comparable limit windows instead of inventing fake percentages;
- retains a bounded 30-day sample history for pace calculations;
- ignores samples before the latest observed counter reset;
- only projects exhaustion after enough observation time exists.

Pace compares consumed capacity with elapsed window time. Projection is deliberately absent when the provider does not report a period/reset or the sample history is insufficient. It is also absent once the window is already used up: `paceProjection` in `limitsModel.ts` returns null for a window with no remaining capacity, so an exhausted row reads "Exhausted" alone instead of contradicting itself with a further "may exhaust …" forecast.

On the Limits page only the progress fill carries the pace signal: it stays green at or under the steady budget, warms through amber and approaches red as the observed rate nears the sensitivity threshold, and stays neutral while no reading exists yet (`pacePressure` in `limitsModel.ts`), so the fill and the status label cannot disagree. The window itself stays neutral and is never tinted by the raw remaining share.

The Limits page's source panels are directly arrangeable with the same `workspaceArrange.ts` engine as the navigator's projects: a still press anywhere on a panel lifts it (a tap or a scroll stays the page's), the others glide aside by FLIP and the list auto-scrolls near the edge — exactly the gesture the navigator's project rows use, with no separate grip. The order is saved once, when the panel lands, in `UsageLimitsPrefs.sourceOrder` (`polyth.usageLimitsPrefs`, mirrored as `package.usage.limits`). Hidden sources keep their saved slot (`mergeLimitSourceOrder`), and a source reported later keeps the family grouping until the user moves it. On a focused panel Alt+Shift+ArrowUp/ArrowDown move it, like a project row; the move is announced.

### Harness accounts

A harness can run several native logins, for example a second Claude Code account with its own `CLAUDE_CONFIG_DIR`. Each extra account is a separate `<harness>-<account>` harness. Its provider answers the server-only `HarnessProvider.limitsAccount()` with `{ family, configDir }`. `src/harnessAccounts.ts` reconciles those providers from the harness registry before every poll, read, and refresh. It registers one Limits source per account, with the harness id as the source id:

- the source reads only that account's login: the macOS keychain entry Claude Code keys by the directory (`Claude Code-credentials-<first 8 hex of sha256(configDir)>`), or `<configDir>/.credentials.json`. An account never borrows the default login, the OpenCode auth file, or `CLAUDE_CODE_OAUTH_TOKEN`; without its own login it reports "not signed in";
- each snapshot carries `account: { family, harnessId, label }`, and the label is read live, so a rename shows at once. A removed account's source disappears. The family's default harness (`claude`) and statically configured sources are never replaced;
- a newly found account is fetched immediately instead of waiting for the next poll;
- a Codex account reads only `<configDir>/auth.json` (its `CODEX_HOME`), never `~/.codex`, the OpenCode auth file or an API key in the environment;
- an Antigravity account's `agy` runs with `HOME` set to the account directory, so it reads only `<configDir>/.gemini/antigravity-cli/antigravity-oauth-token`, never the default `~/.gemini` login, `GEMINI_CLI_HOME`/`ANTIGRAVITY_CLI_HOME`, the OpenCode plugin's `antigravity-accounts.json` or the OpenCode auth file. The delegation shortlist's `google-*` / `third-party-*` split applies to account sources by family;
- only families with an account reader are discovered. Today those are `claude`, `codex` and `antigravity`; other families are ignored until Usage can read one account's credentials for them.

The Limits page, settings and widget name an account source `<source> · <account>` (`Claude · Work`) and keep it next to its family's default source.

## Delegation shortlist

`src/routing.ts` turns the same data into the agent-facing `agent.models` action of the Polyth control tool (`packages/harness-runtime/src/sessionControlTool.ts`). The package provides it as `SERVER_MODEL_ROUTING` from `@polyth/plugins`. Inputs:

- Space observations from the analytics index, via `UsageAnalyticsService.observations(space, from)`.
- `limits.snapshots()`, cached only: choosing a worker never waits on or spends a provider quota request.
- The caller's favorites from `SERVER_MODEL_FAVORITES`. That is the server's read of the synced `modelPrefs.favorites`; un-prefixed legacy keys belong to OpenCode.
- The live model catalog from `SERVER_RUNTIME_CATALOG`, the list the picker and the send preflight validate against, read with `maxAgeMs: ROUTING_CATALOG_MAX_AGE_MS` (one minute) so an older server copy is re-read through the harness registry first.
- The harness registry, which says whether each harness is running.

Candidates are favorites plus every harness/provider/model pair seen in the window, each named as its harness's live catalog names it. Telemetry records the model that ran, which is not always a selectable row: Claude Code reports `claude-opus-5-5` for the `opus` alias, and Antigravity used to report effort-suffixed ids. A pair resolves to the exact row; else to a row whose provider id is only spelled differently; else to an alias row whose `resolvedModelID` is the reported id (the user's starred alias first, then one whose id names the model, so `opus` beats `default`, then catalog order); else to the row whose advertised variant the id spells out (`gemini-3.8-flash-high` → `gemini-3.8-flash`). Pairs that land on one row merge their turns and sessions. An alias row shows what it runs now (`anthropic/opus (Claude Opus 5.5)`), and model-scoped quota windows match both the alias and what it runs. A pair the catalog lists none of these ways is no longer offered: it is left out and counted (`unlisted`, one line in the text). A harness with no catalog rows keeps its pairs as reported, marked `model unverified`; with no catalog at all the text says so once. Nothing is mapped from a static table, so a harness update, a retired model or a changed plan shows on the next call. Usable rows (harness registered, no exhausted applicable window) come first. Within each group, favorites come before other models; ties sort by turns, then by favorite order and recency. Quota sources and windows follow the Limits widget's own rules in `src/limitSources.ts` (aliases, account isolation, `<model>/<period>` scopes). One routing-only refinement: Antigravity's `google-*` windows meter only Gemini/Gemma models, and its `third-party-*` windows meter only the other models. A window whose reset has passed is ignored. In the quota lines, account labels that are email addresses or repeat the source id are omitted.

`candidates(space, { pairs })` replaces the shortlist with an explicit allow-list of `harness::provider/model` keys: exactly those pairs are ranked, used or not, with the same catalog naming, quota and availability rules (a pair the catalog no longer offers is still left out). Judges' limit judges use it to see their allowed models' headroom.

## Browser behavior

`widgets/usage/usageStatsClient.ts` owns exact-query stale-while-revalidate state. Cache keys include runtime identity, Space, schema version, and the full canonical query. Concurrent consumers of the same query share one transport request; cancelling a consumer leaves other consumers active, and cancelling all consumers aborts it. Cleared caches and changed runtime/Space identities fence late responses from repopulating the cache. An obsolete response cannot overwrite a newer scope, and a failed refresh keeps the last successful report visible. A warm scope switch reads that cache during render, so Session, Project, and Global repaint their report immediately instead of showing a blocking loading state; a runtime/Space change still clears the cache before a stale report is trusted.

Reports and the identity they belong to persist in `localStorage` (`polyth.usageStats.2.*`), so a new tab, a reload or a server restart paints the last report on the first frame with the "Refreshing" state and revalidates it, instead of a skeleton. The persisted identity seeds the module; the forced identity check every mount runs replaces it and clears every persisted report when the server's runtime or Space changed. At most 12 reports are persisted (the oldest write is evicted first), a report above 400 kB stays in memory only, and a persisted report older than seven days is not painted. The in-memory index still holds 24.

`widgets/usage/limitsClient.ts` persists the last-good limits snapshot the same way (`polyth.usageLimits.2`, ignored after a day; the unscoped `.1` snapshot is discarded). Only host-wide sources are persisted or painted from the cache: a `scope: "space"` source stays in memory with its server/Space identity and is merged only into a refresh from the same identity (`widgets/usage/limitsIdentity.ts`), so the Limits page and widget survive a tab remount, a reload or a new tab and revalidate in the background rather than blanking to a loading state.

On activation the package warms what the pane shows first: 1.5 s after the web package enables (never in a hidden document) it confirms the identity, requests the report for the scope the dashboard opens in (the remembered tab; Session falls back to the active project without a session; nothing for Limits; with the saved range) and the limits snapshot. Opening Usage then reads the in-memory cache even on the first visit of a fresh tab.

A report that lacks `harnesses` (a cached report or an older server) hides the Harnesses section instead of claiming no harness usage.

A transport failure without a prior report shows a retryable unavailable state, not an empty-data state. With a prior report, the dashboard keeps it visible and marks the refresh failure.

The main dashboard deliberately has no reorder animation or chart animation. Usage data stays stable and readable while live sessions update. The activity chart, sparklines and ratio rings are static SVG/CSS with no chart runtime. The plot is keyboard-explorable (arrows, Home/End, Escape) and announces each period through a polite live region.

Each analytics scope (Session, Project, Global) has its own block layout (`widgets/usage/dashboardLayout.ts`). **Customize layout** reorders blocks by dragging the handle (pointer or touch), with the arrow buttons, or with ↑/↓ on the focused handle, and hides or shows each block. Moves are announced. Hidden blocks keep their slot, and a block added in a later release is inserted after its default predecessor. The chosen tab (Session, Project, Global or Limits), layouts, the last range and the activity metric persist in `polyth.usageDashboardPrefs` and are mirrored through the `package.usage.dashboard` preference, so reopening the pane, a reload or another device returns to the same tab. A remembered Session tab shows Project while no session is active without overwriting the choice, and a mirrored value without a tab (an older client) keeps the current one.

The surface is kept alive. While hidden (`active === false`) it keeps its last report but neither requests nor follows live usage. Showing it again revalidates once. While visible, `usage/recorded` and `turn/stopped` events are throttled into at most one refresh per 900 ms. The throttle is not a resetting debounce, so concurrent sessions cannot postpone a refresh indefinitely. The identity check runs beside the report request instead of in front of it.

## Placeable usage cards

The Session, Project, and Global widgets share one package-owned card and the same analytics client as the dashboard. Each instance can choose **Adaptive**, **Overview**, or **Metrics**, a main metric, and whether to show activity. Project and Global also choose a range (7, 30, 90 days, or all time); Session always shows lifetime telemetry, with current context occupancy kept independent of those totals. Global can show the first four projects from the report's cost/token-ranked breakdown; the header reports how many are shown.

A host that owns the widget chrome omits a card the widget reports unavailable: `usage.session` without an active session, and `usage.limits` in its default `current` source without one, leave the phone Workspace panel, placed UI slots and the desktop Canvas entirely instead of painting a "No active session" empty state (`isAvailable`). Edit mode still shows them, so they can be moved or removed.

Every card reads as a quiet ledger. The heading is the session or project name, or *All projects* on Global (the scope word stays for assistive tech); Project and Global add their range (`30 days`), Session has none because its totals are lifetime. The main value is the hero in large type with its label and detail as one caption line (`14%` · `Context · 144.6k / 1.0M`), and context occupancy also draws a thin meter in the shared context gauge's level colour. The session's prompt cache sits beside the hero as a chip: the countdown text in its state's colour (warm, expiring, expired, in use, idle without a known lifetime) and a ring of the lifetime left. The other values follow in rows of three under quiet headings: **Spend** (tokens, cost, steps), **Cache** (hit rate, the cached prefix with its lifetime or "Re-written next turn", cache burn) and **Timing** (response and whole-turn rates, average TTFT); Project and Global have one row of totals without a heading. A unit or lower-bound sign is set smaller than its digits (`Figure.tsx` splits the formatted value; the text itself is unchanged). Costs are cents under $1,000 and compact above it (`≥$12.5K`), with the exact amount in the tooltip. Under the Borderless appearance the headings' hairlines disappear with every other separator.

**Workspace panel sizes.** The phone Workspace panel passes the size the person chose for a card (`panelSize` in the render context); every other host passes none and gets the full card. Session, Global and Limits offer **Compact** (the default) and **Standard**; Project keeps the **Wide** and **Large** pair it shipped with, so saved panels keep their size (`panelSizes` in `widgets/catalog.ts`). The smaller size of each pair is the *glance* (`usageWidgetCompact` in `widgetPresentation.ts`): the panel header already names the card, so the glance opens on the lead value in large type with what explains it on the same line (the context meter or the activity sparkline, and the cache chip), then one line with the lead's caption (`Context · 144.6k / 1.0M`, `Tokens · 30 days`) and the next two values. Group headings, timing, the activity chart and the projects list stay in the full card. With the Metrics layout the glance is one row of the first four values split by hairlines, under the range line Project and Global still need. Overview and Adaptive glances are the same; they differ in the full card. The standard size is the full ledger described above; there the Metrics totals fit five values on a phone row, and Global's projects carry a soft wash behind each row for their share of the total.

Adaptive cards respond to both their container's width and height. Wide cards place the hero beside the ledger; narrow cards stack them, and a session card under 300px wide uses two columns rather than clip a value. Shallow Adaptive cards omit the optional chart and the group headings and keep every metric reachable by native scrolling, including keyboard scrolling. Unbounded slots have a compact intrinsic height. Overview emphasizes the main value and two supporting metrics without headings; Metrics drops the hero and gives every value equal weight, the context and cache countdown first. Config is presentation-only and per instance, so duplicated cards may use different ranges and layouts. Existing placements keep their saved sizes.

Activity is a static, accessible bar list with at most 28 groups; the latest group is drawn in full accent and the rest in a wash of it. Consecutive buckets are summed rather than sampled, so peaks and totals are retained. Missing samples remain missing, and a group containing unreported usage is marked as a lower bound. Unknown values show `—`; incomplete token, cost, and turn totals show `≥`. Loading, missing scope, empty usage, and transport failure have separate states. A failed refresh retains the last successful card with a retry action; current session context remains visible when analytics is unavailable. Cards add no polling, resize observers, or chart runtime.

## Usage notifications

Settings → Usage → **Notifications**, **Limit alerts** and **After a turn** configure passing notices shown through `host.notifications` (the host stack; older hosts without it show none and the settings hide their previews). Preferences live in `widgets/usage/alertsPrefs.ts` (`polyth.usageAlertPrefs`, mirrored as `package.usage.alerts`). The rules are pure (`widgets/usage/alertsModel.ts`); `widgets/usage/alertsController.ts` feeds them in the browser and shows what they return. Usage never sends a turn for any of them.

- **Master switch, pause** (1 hour, or until the next 8:00) and **Keep warnings on screen** (limit warnings become sticky). An alert that is still true when a pause ends, or when its rule is turned on, shows then.
- **Limit alerts**, over the same snapshot as the Limits page (`GET /api/usage/limits`, which never asks a provider): *Pace too high* (above steady pace, or only likely to run out, using the Pace sensitivity setting and `classifyLimitPace`), *Running low* (any of 50/25/10/5 % left), *Limit reached* (with its reset time), *Available again* (a limit that was used up started a new period) and *Sign-in needed* (a source reports an authorization failure; transient errors stay quiet). *Watch sources* mutes a source's alerts; sources hidden from the Limits page never alert.
- **Once per period, per person.** A ledger (`src/alertLedger.ts`) remembers, per `<source>/<window>`, the lowest level, the strongest pace reading and whether it was used up. A new period (the reset moved on by more than 10 minutes, a passed reset without a new one, or a refill of 5 pp or more) re-arms it. The browser keeps its copy in `localStorage` (`polyth.usageAlerts.1` for host-wide sources; `polyth.usageAlerts.space.1:[serverInstanceId,spaceId]` for a per-Space source, which is not evaluated at all without that identity). The server keeps the person's copy in their Space (`GET`/`PUT /api/usage/alerts/ledger`, `alert-ledgers-v1.json` in the Space's usage directory, `src/alertLedgerStore.ts`; a per-Space ledger is stored only when it names that server and Space). Before every evaluation the two are merged: an announcement in the same period survives, a later period replaces an earlier one, and source problems come from the newer copy. A changed announcement is written back, and writes merge on the server, so two devices never erase each other's. A page does not evaluate until it has read the person's copy once, because the phone app's shell starts with empty `localStorage` on every launch and would otherwise repeat every alert on every open; a server without the route (404) leaves the ledger on the device as before. The low warning carries the pace forecast instead of a second card. One burst shows at most three cards: the two most urgent and one summary of the rest.
- **Which tab.** Only a visible tab evaluates, so open tabs normally alert once between them, and a device that opens after another one already alerted stays quiet for that period. A visible tab re-reads the snapshot every 2 minutes, on returning to the tab, and after every turn; the person's ledger is re-read with it when the copy in hand is older than a minute.
- **Turn summary** (off by default): after a live `turn/stopped` in the chat on screen, or in every chat except delegated children, a notice with the turn's tokens (input + output + cache, with its cache share), reported cost and the most constrained limits it ran against with their drop (`Claude 5-hour 62% left (−3%)`). Tokens come from the loaded event log for the turn id, else from the `usage/recorded` events seen live. With *Limits left* shown, each of the chat's sources whose reading is older than 90 s is refreshed once (`POST /api/usage/limits/refresh`) so the figure is current; that is a provider usage request, at most one per source per 90 s per tab. Turns under *Skip small turns* stay quiet. A replayed stop older than 2 minutes never reports.
- **Cache about to expire** (off by default): 1, 2 or 5 minutes before the prompt cache of a chat whose turn just ended lapses, if the lifetime is known (`cacheHealth.ts`), the prefix is at least 10k tokens and the chat is still idle with no newer response. A new turn cancels it. Only chats whose events are loaded in the tab can be watched (up to eight).
- **Previews**: each rule's bell shows a sample built from a real source name; previews never touch the ledger. "Open limits" on an alert opens the Usage pane on its Limits view (`viewRequest.ts`).

Alert and settings copy is English-only, like the rest of this settings page and the Limits values; the settings search entries are localized.

## Limits widget

`usage.limits` is a placeable widget over the Limits service. It has no analytics query of its own: it reads `GET /api/usage/limits` through `limitsClient.ts` (the Limits page's last-good snapshot, revalidated every minute per mounted instance) and applies the same Limits preferences as the page (remaining or used, reset format, pace sensitivity, projections, low-remaining threshold, pace warnings). Config is presentation-only and per instance, so duplicated widgets may show different sources and styles; changing it never refetches.

**Which limits** — `source` is one of:

- **Current harness / model** (default) — the sources that belong to the session's resolved harness or model provider (`currentLimitSources` in `limitsModel.ts`). A harness id and a model provider id both name a source, through a small alias table (`anthropic`/`claude-code` → `claude`, `openai`/`chatgpt` → `codex`, `commandcode` → `command-code`, `grok` → `xai`); every other id, such as `opencode-go` or `cursor`, matches directly. A window id of the form `<model>/<period>` (for example Claude's `opus/7d`) belongs to that model alone and is shown only when every word of its scope appears in the session's model id; account-wide windows always show. A session on one account of a multi-account harness (`claude-work`) shows only that account's source. Its model provider does not add the default login or another account, even before the account's source has been reported. The heading names the account (`Claude Code · Work`). With no session, or no source for the session's harness or provider, the widget says so rather than falling back to another source.
- **Selected sources** — exactly the sources chosen in the widget settings (`sources`, matched by normalized id), whatever their visibility on the Limits page. A choice survives its source disappearing so it can be unchecked.
- **All sources** — every detected source that is not hidden in Settings → Usage & Limits.

**Display styles** (`style`) all render the same rows: **Pace** (the default: bars with a steady-budget tick where an even burn would stand at this point of the window, a one-line legend for the tick, and a short pace verdict at the end of the reset line — `Runs out ~22:25` (or `~Thu 06:10` on another day) when the window will run out before it resets, else the pace label with the share left at reset; the full forecast is the verdict's tooltip, and with projections off only the label shows), **Bars** (the same rows without tick or verdict), **Segments** (ten-cell meter), **Rings**, **Chips**, **Table** and **Spotlight** (the most-constrained window in large type, every other window as a chip). In the row styles the window's value is set large in its tone, and the fill deepens toward its end. The meter fills with the value shown, remaining or used, and the tick sits on the same axis. Tone follows the shared rules: low remaining warns, an exhausted or likely-to-exhaust window is critical. When the heading names the harness and model and exactly one source answers, the source's plan sits beside it as a badge (`Claude Code · opus  Max`) and the source's own heading is kept for assistive tech only; several sources keep their headings. Balances and uncapped windows are text rows that never claim a meter value. Layout answers to the widget's own width only: Table adds its reset column from 380px and its pace column from 520px, and Bars and Rings flow into columns when there is room. `showReset` hides the reset text in every style.

In the phone Workspace panel's **Compact** size (the default there) every style keeps its character in less room, and the reset and the pace verdict move into the row's tooltip, which always carries the whole reading (value, detail, reset, forecast). Bars, Pace and Segments become one line per window — window, meter, value — on one grid shared by every source, so the meters start together; Pace keeps its tick. Rings shrink and hold the number alone, with the source under the window when there are several. Chips become one-line pills, Table keeps label and value, and Spotlight puts its figure beside the window and its reset. **Standard** is the full widget. Chips there are even tiles with the reset under the window's name, and a balance without a cap shows its value inside a dashed ring instead of a dash.

**States** — loading, unavailable with a retry, no source, nothing selected and no session are separate states. A source that failed its last poll keeps its last values under a note carrying the reason on hover; a source that never answered is a single error line. The inline refresh is hidden while the canvas is being arranged.

The widget chrome is localized in every shipped locale. Limit values (`98% left`, `Resets in 3 hours`, pace labels and verdicts) are produced by the helpers shared with the Limits page in `limitsModel.ts` and are English-only for now.
