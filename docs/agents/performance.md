# Performance measurement contract

Use this document when a task asks for faster startup, catalog loading, harness switching, streaming, rendering or lower resource use. It is a measurement protocol, not a claim that any numeric budget has already been achieved.

## Define the workload

Specify operation, start/stop milestones, dataset/session size, cold/warm state, network/provider conditions, machine, build and sample count. Separate first usable UI from first token and final completion. Provider latency is not interchangeable with local orchestration overhead. Record whether data is real or mocked.

## Find removable work

Measure the critical path: discovery, auth/capability checks, IPC/network requests, parsing, event append, reconciliation, rendering. Count repeated requests and redundant work. Inspect cache identity, lifetime and invalidation before adding memoization. Existing state owners and lifecycle seams are preferred to a second global cache.

Safe optimizations include scoped single-flight requests, bounded reusable metadata, lazy nonessential modules, narrower subscriptions, incremental derivation and cleanup of inactive work. Each needs evidence that it does not leak across server/Space/account/project/runtime identities or show stale results.

Never trade away authorization, durability, release proof, idempotence or correct cancellation. A fast but incorrect response is a regression. Do not replace functional behavior with a placeholder merely to improve perceived latency. Preserve low-resource and user appearance preferences.

## Compare fairly

Run before/after under comparable conditions with multiple samples. Report sample size, observed range or appropriate statistics and memory/request count where relevant. One observation cannot justify a p95 claim. Include an erroring/slow-provider scenario and rapid selection changes. Avoid flaky millisecond assertions when work-count and state-invariant tests are more reliable.

Keep profiling output bounded and redacted. Add instrumentation only where the task needs it; do not permanently log user prompts or secrets. Document residual external latency and what was not measured.

## Client boot and transfer

Workload: `/` to composer rendered, headless Chromium with DevTools network
emulation (100 ms RTT, 20 Mbit/s), an agent-beta server, cold (empty cache) and
warm (same profile) reloads, plus a non-loopback hostname mapped to 127.0.0.1
for the ordinary browser path. 2026-10-17, shared ARM host under load:
warm 1.26–1.28 s → 0.90–0.97 s (n=2 → n=6), cold 3.16–3.19 s → 2.72–2.76 s,
warm transfer 1.33 MB → 70–190 KB. The rest of the warm path is mostly
evaluating the cached bootstrap closure (~300 ms CPU), not network.

Invariants that keep it there:

- Static responses (`sendStaticFile`): hashed chunks are immutable; any other
  URL whose `?b=` names the published build (`build-id.json`, written last)
  is immutable too; `index.html` and the generation markers stay `no-store`;
  everything else is `no-cache` with a weak ETag and answers 304.
- Boot round trips: the HTML shell inlines this request's auth status
  (`<script id="polyth-auth-status" type="application/json">`, no CSRF
  token, `no-store, private`; read once by `takeEmbeddedAuthStatus`), so a
  browser boot asks no `/api/auth/status` at all — A/B at 300 ms RTT, same
  build: median ~1.27 s vs ~1.61 s (n=7 vs 8). A `ui-session` status carries
  `accountId`, so no `/api/auth/accounts` read; a loopback shell (Link, local server) requests
  `/api/spaces` alongside the status; `/__polyth/client-context` is asked
  only on a loopback origin (only the Link proxy serves it); the bootstrap
  chunk alone is `modulepreload`ed.
- `GET /api/projects?iconRefs=1` replaces large raster icons with
  `/api/projects/:id/icon?v=<hash>`; the PATCH route treats an echoed ref as
  "unchanged". Clients without the flag keep inline data URLs.
- WS compression and replay pacing: [session reading](../architecture/session-reading.md).
- Polyth Link: `Accept-Encoding` is forwarded and WS frames are deflated
  between client and host ([Polyth Link](../architecture/polyth-link.md));
  measured boot API set 364 KB raw → 118 KB gzip, a 500-event page
  182 KB → 31 KB. Needs both a new host and a new app; not device-verified.

## Session spawn timing

`SessionService.create` starts a bounded, in-memory sample after validating the
canonical identity and workspace, before runtime acquisition. Authenticated,
Space-scoped session debug (`GET /api/agent/sessions/:sessionId/debug` or Polyth
`session.debug`) exposes it as the optional `spawnTiming` field. Debug reads do
not acquire a runtime. Samples hold only a timestamp, harness id, durations and
reuse metadata; they contain no prompt, path, tool input or error text.

| Field | Measurement boundary |
| --- | --- |
| `startedAt` | Wall-clock timestamp identifying validated session creation. |
| `runtimeAcquireMs` | First runtime lookup, including harness resolution, provisioning and waiting for an existing creation flight. |
| `nativeSessionCreateMs` | First dispatched native create/ensure operation, excluding canonical preparation and subsequent reconciliation. |
| `turnAdmissionMs` | First delivered turn admission attempt, from claiming dispatch through its settled receipt, including uncertain or rejected outcomes. Merely enqueueing a prompt does not fill it. |
| `firstRuntimeEventMs` | From validated creation to the first accepted runtime turn-content event after a Polyth admission attempt, at canonical ingress after persistence. Idle discovery, native lifecycle markers alone, duplicate/refused observations and stale generations do not supply it. |
| `warmRuntimeHit` | For OpenCode, reuse of an initialized physical runtime entry. Joining its pending initial creation is cold. This flag does not probe the daemon's health or certify that recovery will be unnecessary. Fresh session-lifetime factories report false; workspace providers without physical evidence leave it absent. |
| `runtimeSpawnMs` | Observed owned-local OpenCode physical launch to health readiness, excluding binary discovery, engine inspection, config preparation and capability readback. Absent on warm acquisitions, remote launches and uninstrumented providers. |

Durations use a monotonic clock and each stage keeps its first measurement.
Absent fields mean unobserved, not zero. The first-event interval includes any
delay before the first prompt and queued delivery; it is not first-token latency
from prompt submission. Physical startup is part of acquisition, so these
durations must not be summed. Concurrent cold callers may share the same
physical startup measurement. Initial-launch telemetry does not track every
later daemon recovery.

The default recorder retains the newest 256 created-session samples. Session
deletion and service disposal remove them; restart loses them. Replayed or
imported sessions do not invent historical timing. This telemetry adds no
canonical event, storage migration or change to admission/release semantics.
Deterministic clock-controlled checks live in
`packages/server/test/spawnTelemetry.test.ts` and
`packages/server/test/sessionSpawnTelemetry.test.ts`; physical reuse evidence is
covered by `runtimeOccupancy.test.ts` and the harness registry tests. These
fixtures establish measurement semantics, not provider latency benchmarks.

## OpenCode warm retention

`Harnesses → OpenCode → Runtime → Warm workspaces` controls retention in the
current Space. This is a policy over the existing physical OpenCode pool, not a
new pool or a change to session authority. It does not eagerly launch a runtime.

| Mode | Unused-runtime idle wait |
| --- | --- |
| Default | Ten minutes. |
| Keep warm | `idleTtlMinutes`, initially 60; valid range 1–1,440 minutes. |
| Off | No idle wait; release begins only after cleanup is proven safe. |

Default and Keep warm share `maxWarmWorkspaces`, initially 2, with a valid range
of 1–16. The least recently used unused workspace is reclaimed first when this
budget is exceeded, independently in each Space. A workspace is the existing
physical connection/project/resolved-cwd key; isolated worktrees count
separately. The limit applies to reclaimable unused runtimes. Canonical session
leases (including native creation before event wiring), bindings, executions,
runtime calls, live streams and uncertain reconciliation remain protected, so
the total number of processes can exceed the idle budget while work is active
or cleanup is blocked. Off has an effective idle budget of zero.
An unwired canonical session that still names this exact authority/generation
also protects its working, unknown or reconciling execution and pending
operations/requests/queue. A metadata lookup after boot does not establish
idle execution and does not eagerly materialize that session for cleanup.

Idle expiry and budget pressure use the same admission barrier, safety proof
and owned physical teardown as ordinary eviction. Activity or a policy update
during that proof invalidates it. Acquisition holds protect discovery/factory
completion; failed acquisitions release their hold. Off retries a blocked
cleanup at a bounded interval rather than continuously polling. Reclamation
leaves native databases and canonical history intact. Shutdown still disposes
all owned processes through the existing lifecycle.

The package owns `GET /api/opencode/runtime-policy` and revision-checked `PUT`
with `{ settings: { mode, idleTtlMinutes, maxWarmWorkspaces }, expectedRevision }`.
The server uses gateway-validated `rc.space`, never a Space id in the payload.
Settings persist atomically in that Space's
`packages/opencode/runtime-policy.json`; a stale revision returns 409, invalid
input returns 400, and unreadable storage returns 503 without overwriting it.
Policy updates apply to existing runtimes without a provider restart. Disabling
the companion package uses Default retention and preserves the saved settings.
If its policy service or storage is unavailable, the physical owner uses the
finite Default policy. The shared service is `SERVER_OPENCODE_RUNTIME_POLICY` in
`@polyth/plugins`, resolved after package registration and in runtime handlers.

`packages/opencode/test/runtimePolicy.test.ts` verifies validation, persistence,
revisions, Space separation and symlink refusal. The warm-policy and runtime
pool lifecycle suites verify deadlines, LRU pressure and racing activity,
acquisition and policy changes. They establish lifecycle behavior using
fixtures; they are not provider latency or native-device benchmarks.

## Synthetic session I/O

`node --experimental-strip-types scripts/bench-session-io.ts` creates an
isolated synthetic store under `.scratch/polyth-performance-reliability/`:
650 sessions, two million events, one 170,000-event session, periodic large
tool payloads and 30 warm read samples. It reports full-gap versus forward-page
reads, newest windows, full projections versus first summaries, response bytes
and query plans. Run it with the repository's bounded-check owner and enough
time for fixture generation; never point it at a live database. Generation is
excluded from read timings. This measures store I/O, not HTTP, provider,
browser paint, WebKit or long-running stream latency.

See [session reading](../architecture/session-reading.md) for paging,
activation, summary compatibility and current client-cache limits. Work-count
gates live beside their owners: forward-page continuity, batched projections,
changed timeline frontiers, ingestion queue caps, and server control paths that
must not replay a whole session log (`historyReplayHotPaths.test.ts`). They
complement, rather than replace, real rendering and resource-retention profiles.

## Timeline scroll and composer typing

Workload: one synthetic session (120 turns: markdown, code, table, three tool
calls each; ~7k timeline DOM nodes in the 150-row window), canonical isolated
server, headed Chrome with hardware GPU, 1536×790 at 125% scale, 160 wheel
steps up and down, then ~100 typed characters plus `@` completion and
backspaces. i5-10310U / Intel UHD, 2026-10-24, n=3–4 per side.

- Scroll: renderer JS 0.88–1.02 s → 0.25–0.34 s, main-thread busy
  4.2–4.8 s → 3.1–4.0 s per 7.5 s scroll; p95 frame 16.8 ms both sides. The
  prompt-rail scroll-spy issued one `querySelector` per prompt every frame
  (mostly for rows windowed out of the DOM); `promptRowTops` reads all rows in
  one walk, and the latest-prompt visibility check keeps its row between
  scroll events. Keep per-frame scroll work O(1) subtree walks.
- `content-visibility: auto` on `.timeline > .msg` was measured worse for
  scroll (more layout/script, more dropped frames) and only ~12% better for
  typing; it is intentionally not used on timeline rows.
- Typing: ~11 ms main thread per keystroke, of which React's synchronous
  composer update is ~2.3 ms and the auto-grow measure ~0.75 ms; the rest is
  Chromium editing, paint and layerization. Splitting composer state was not
  worth its risk at this cost.
- Desktop software rendering (`app.disableHardwareAcceleration()`, WARP)
  moves every frame's raster and compositing to the CPU; on this machine the
  GPU process spent 3.5× the renderer's CPU time. It is a separate escape
  hatch, not part of low-resource mode ([desktop](../dev/desktop.md#low-resource-mode)).

Event Timing `duration` under CDP-synthesized input is not a latency signal:
a bare `<textarea>` on a blank page measured 30–100 ms. Start any CPU profiler
or trace before the frame probe; its startup stalls a frame by ~350 ms.

## Live server profile

The live server can be sampled without a restart: `kill -USR1 <server pid>`
opens the inspector on 127.0.0.1:9229, and a CDP client records windowed
`Profiler` samples. Pair each window with the main thread's own CPU ticks
(`/proc/<pid>/task/<pid>/stat`, fields 14+15), since whole-process CPU also
counts GC and libuv threads. The inspector keeps listening on loopback until
that process exits, so profile only with the operator's consent. Keep profiles
under `.scratch/<task>/`; they contain code paths, not payloads.
