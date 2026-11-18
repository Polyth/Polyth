# Judges

After each completed turn, Judges asks [Judgment](../judgment/README.md) a few
bounded questions about that turn and, if an answer clears the user's threshold,
records a quiet marker in the chat. Judgment is evidence, not authority: an
answer is only a probability, and code decides what happens with it. Failure,
timeout, cancellation, `cannot_tell` and a low margin record no marker and do
nothing, so the session behaves exactly as it would without this package. The
one note below the threshold is a permission judge's
[note on the request's card](#notes-on-the-request-card): that it is checking,
that it got no answer, or where its answer left the request.

Two things go beyond a marker, both opt-in and both decided by fixed code, never
by text from a model: the [keep-warm use](#keep-warm) may send a fixed hidden
keep-alive within a budget, and a person may give a user-defined judge
[actions](#actions) (send a message, merge the isolated work, approve or deny the
waiting request, change Auto-Approve, switch the model at a usage limit). Actions run
with that person's own access, exactly as if they pressed the button.

## When it runs

The server entry subscribes lazily to `SERVER_TURN_COMPLETION_BUS`,
`SERVER_PERMISSION_WAITING_BUS` and `SERVER_TURN_STOPPED_BUS` in `onEnable`
and disposes them in `onDisable`. Listeners only enqueue (at most 4 evaluations
at once; a newer event of the same kind for a session replaces a queued one),
because the host awaits bus listeners in order.

A turn is judged when the session is an ordinary top-level chat: no `parentId`
(delegated child), not `archived`, and no unfinished `historyImport`. The log
must end with a user message followed by `turn/stopped` with reason `completed`.
Each turn is judged at most once. Permission and limit judges also see
delegated children ([Triggers](#triggers)).

Evidence comes only from canonical events of that turn: the person's request
(`raw` when present; never a judge's message or a hidden resend), the last
assistant message, shell commands from
`tool/call` inputs with their result/error outcome, files named by edit/write/patch
tool inputs (including `*** Update File:` patch headers), and open
(`pending`/`active`) items of the latest `task/snapshot`. Every string is
trimmed, and known credential shapes (API keys, tokens, bearer headers,
`password=`, private keys) are replaced with `[redacted]` before judging.

## Built-in uses

All four are registered through `JUDGMENT_SERVICE.registerUse`, are off by default,
and are switched on and tuned in **Settings → Judgment → Uses**; Settings →
Judges lists them with their state for the project. Use state is
resolved before every evaluation. Registration follows the live Judgment
service, so either package may enable first.

| Use | Scope | Evidence | Question | Records when |
| --- | --- | --- | --- | --- |
| `judges.completion-check` | `judges.completion-check.v1` | long: request ≤1,500 chars, answer tail ≤3,000, commands, changed files, open todos | choice `verified` / `claimed_only` / `cannot_tell` | top answer is `claimed_only`, P ≥ `threshold` (0.7) and lead over the next ≥ `margin` (0.2) |
| `judges.needs-you` | `judges.needs-you.v1` | short: last 400 chars of the final answer | noul “Is the assistant waiting for the person to answer or decide?” | P ≥ `threshold` (0.7) |
| `judges.keep-warm` | `judges.keep-warm.v1` | short: request head ≤200 chars, answer tail ≤400, open-todo count | choice `unfinished` / `finished` / `cannot_tell` | top answer is `unfinished`, P ≥ `threshold` (0.8) and lead ≥ `margin` (0.3); arms keep-alives, records nothing |
| `judges.quiet-command` | `judges.quiet-command.v1` | short: tool name, input ≤600 chars, minutes running/quiet, ever showed activity, agent's last text before the call ≤600 | choice `working` / `stuck` / `cannot_tell` | top answer is `working` and P ≥ `threshold` (0.75); presses Keep running |

`judges.completion-check` also has `suggestFollowUp` (boolean, default off).
When it is on, the marker carries a fixed “please verify” text, shown as an
**Ask the agent to verify** button. The button calls `host.conversation.insert`,
which fills the composer; the person decides whether to send it.

`judges.needs-you` records `attention: true`. After the event is persisted, the
package calls the host's `SESSION_ATTENTION_SERVICE.waitingForPerson` (from
`@polyth/plugins`). For an idle top-level chat the host re-sends the turn's push
notification as a *question* ("is waiting for your answer") with the same key,
so the OS notification is replaced; the notification centre keeps both rows.
A session that is working, waiting on a request, or delegated is not notified
again. The user's notification kinds still apply (the question kind).

## Quiet commands

`judges.quiet-command` (`src/quietCommand.ts`) listens on `SERVER_TOOL_QUIET_BUS`,
which Polyth publishes once per quiet stretch, about a minute before the silence
stop (9 minutes of silence by default; never for a call already kept). Skipped
when the use is off for the event's Space, the event has no `spaceId`, or less
than 10 s remain. The call's input and the agent's last text come from the
event's own Space through its Space facade (`host.forSpace`), redacted and
clipped. One `working` / `stuck` / `cannot_tell` question, timeout
`min(45 s, stopsAt − now − 5 s)`. Only a `working` answer at or above
`threshold` calls `keepToolRunning(sessionId, callId, { via: "judge", useId })`
(the call then runs to the 60-minute limit) and records a marker. Stuck,
unsure, low chance, timeout, error and a `conflict` (the call already ended)
all do nothing: the stop runs.

## Keep warm

`judges.keep-warm` (`src/keepWarm.ts`) keeps the prompt cache of a chat that is
clearly not finished warm for a short, priced pause, so the person's next
message reads the cache instead of re-writing it. Judgment only answers whether
the work is unfinished; code decides everything else and stops early:

1. **Arm, after a completed turn of an eligible chat** (same eligibility as
   above). Skipped without a Judgment call when the chat has no cache telemetry,
   no documented cache lifetime (only Anthropic's 5 minutes, or a proven 1 hour,
   see the [Usage cache rules](../usage/README.md#prompt-cache-health)), a
   cached prefix below `minCachedTokens` (20,000), or the turn was a scheduled
   agent's (`schedule` keeps those warm itself). Arms only on a confident
   `unfinished`.
2. **Budget per pause:** `min(maxKeepAlives, ⌊P × (1.25 − 0.1) ÷ (0.1 + 0.02)⌋)`
   — the keep-alives the chance of coming back pays for, at Anthropic's cache
   write/read prices plus a small per-turn overhead, capped by the user
   (`maxKeepAlives`, default 3: about 20 minutes on a 5-minute cache). A Space
   sends at most `dailyLimit` (40) per UTC day.
3. **Send** (checked every 15 s) one keep-alive when the cache is within its
   last minute (at most a fifth of its lifetime), only while the chat is idle,
   still top-level and unarchived, has nothing queued, and no newer person
   message than the arming turn. The keep-alive is the fixed
   `KEEP_ALIVE_PROMPT` through `SessionService.send` with
   `hiddenUserMessage: true` and memory read/remember off, on the chat's
   current route. Its short "OK" reply is visible in the chat (the Usage
   package's person-requested Keep warm uses the host's `keepAlive` turn
   flag, which hides the whole turn; this use does not yet).
4. **Stop** at the budget or daily limit, when the cache has already expired
   (a cold cache is not re-warmed), when a settled keep-alive's response did
   not read the cache (or reported no cache use), when a send fails (never
   retried), on any other completed turn (which re-evaluates from scratch), on
   disable, and on server restart (armed state is in memory only).

A keep-alive turn is never judged: evidence skips the hidden fixed prompt, and
its completion neither re-arms nor counts as work. Background sends need the
`local-trusted` deployment (`systemSessionsForSession`); elsewhere the send
fails and the chat is dropped.

## User-defined judges

The list is Space-wide. Each judge can optionally be limited to one project of
that Space. It is stored at
`spaceStorage(space).packageDir("judgment-judges")/judges.json` as
`{ version: 1, revision, judges }`: replaced atomically (mode 0600), every
mutation needs the current `revision`, and corrupt storage fails instead of
resetting. Ids are server-generated (`j` + 12 hex characters); a project filter
must name a project of the same Space.

A judge has: `name`, optional `description` (what it is for, ≤ 300 characters;
blank means none), `enabled`, `trigger`, `filters.projectId?`, `evidence`,
one `question`, `fire` (`threshold`, `margin`, and `label` for a choice's
markers), `effects`, optional `routes`, `maxRounds` and `model`, and `dailyCap`
(1–1,000, default 40). Unknown fields are rejected. The server adds
`ownerUserId` (see [Ownership](#ownership-whose-access-a-judge-uses)) and
`starter` (see [Starter judges](#starter-judges)); input never sets either.
All shapes and rules are in `src/types.ts` (`validateJudgeInput`).

### Starter judges

`src/starters.ts` holds ready-made judges: basic settings to start from, **not
recommendations**, and every surface that offers them says so. Their copy
(name, description, question, answer meanings, follow-up) comes from the
package's own i18n keys (`judgesstarter.*`), so a starter is created in the
person's language; message texts reuse the English `MESSAGE_PRESETS`.

| Starter | Category | Trigger | Asks | Does | Seeded |
| --- | --- | --- | --- | --- | --- |
| `stop-destructive` | permissions | permission | would the request destroy data, rewrite history or expose secrets (`destructive` / `harmless`) | denies on `destructive` and flags the chat (80% / lead 30) | yes |
| `approve-routine` | permissions | permission | is it a routine, low-risk step of the request (`routine` / `needs_look`) | approves once on `routine` (90% / lead 40) | yes |
| `review-commands` | actions | turn | did the turn run or change something risky (yes/no) | flags the chat | yes |
| `keep-going` | long-work | turn | did the assistant stop before finishing (`unfinished` / `finished` / `needs_person`) | sends *Continue* on `unfinished`, 3 in a row at most | yes |
| `stay-on-task` | quality | turn | did the turn change unrelated files (yes/no) | marks the chat and offers a follow-up | yes |
| `merge-when-done` | actions | turn | is the work finished and verified (`done` / `not_done`) | merges an isolated chat on `done` (90% / lead 40) | no |
| `audit-big-changes` | quality | turn | how large and risky is the change (`big` / `small`) | sends *Spawn an auditor* on `big`, once in a row | no |
| `switch-at-limit` | limits | limit | the person's wait-or-switch instructions | switches model; needs the person's allowed models | no |

Seeding: while a Space never saved a judge (`judges.json` does not exist),
`GET /api/judges` answers `fresh: true`, and the page then calls
`POST /api/judges/starters { locale }`. The server writes the seeded starters
(the denying guard first, so it is asked before the approver) switched off,
owned by no one, each stamped `starter: <id>`, at revision 1. A list that
exists, even an emptied one, is never seeded again, and repeated calls change
nothing. A locale the package does not speak falls back to English.

`starter` marks a judge that is still its template. Turning it on or off keeps
the mark (and, like any save, makes the person who did it the owner, so an
acting starter acts only once someone turned it on); any other change drops
it, and the judge is the person's own. A stored `starter` the package does not
know makes the list unreadable, like any corrupt entry. Every template,
seeded or not, is offered again in **Add judge**.

### Who answers

A judge is answered by an agent model, never by the Space's Judgment engine, so it
needs no API key and never touches Credential Vault. Every judge question is asked
with `target: { engineId: "agent", … }` (the [Agent model
engine](../judgment/README.md#agent-model-engine)): `model`
(`harness::provider/model`, chosen in the editor's **Answered by** from the owner's
model shortlist) when set, otherwise the owner's Small Model (Settings → Sessions).
An owned judge's run is created for its owner (`personSpaceContext`), so it is
their Small Model and their harness account; a judge without an owner has no Small
Model to use. The completion is tool-less: a harness without a direct completion
fails rather than running the evidence as an agent turn. The built-in uses above
keep following Settings → Judgment.

### Triggers

| `trigger` | When it asks | Sessions | Evidence picks |
| --- | --- | --- | --- |
| `turn-completed` | `SERVER_TURN_COMPLETION_BUS` | top-level chats only (as for the built-ins) | `last-request`, `last-answer`, `commands-run`, `changed-files`, `open-todos` (1–5) |
| `permission-requested` | `SERVER_PERMISSION_WAITING_BUS`: a live request no rule or automatic approval decided waits for a person (a decided answer that failed to deliver, a deny rule's included, and requests replayed after a reconnect are never offered) | also delegated children (their cards mirror into the parent) | `permission-request` (required: title, risk, reasons, the server's redacted preview lines), plus the turn-so-far picks |
| `limit-reached` | `SERVER_TURN_STOPPED_BUS` with reason `error` while `projection.resume` is pending (a usage limit with an automatic resume) | also delegated children | `last-request`, `last-answer`, `open-todos` (0–3); the route facts are always sent |

Each pick is 100–4,000 characters. The *request* is always the person's latest
own message: a judge's message, a hidden wake or an automatic resend is never
read as one. A request or a limit stop is judged once per judge; a request
another judge or the person already answered is not asked about.

### Questions and when a judge fires

- **Yes/no** (`noul`): P(yes) ≥ threshold and P(yes) − P(no) ≥ margin. Markers
  and actions run together.
- **Choice** (2–8 lowercase labels with descriptions): only the confident top
  answer counts (P ≥ threshold and P − best other ≥ margin). Each action names
  the answer it belongs to (`when`), so one judge can map answers to different
  actions. Markers follow `fire.label`, which is required only when the judge
  has markers.
- **Score** (2–8 level rubric): score ÷ (levels − 1) ≥ threshold; margin is
  not used.
- **Route** (`limit-reached` only, see [Model switch](#model-switch-at-a-usage-limit)):
  the person's `text` is the instructions; the answers are generated.

### Effects

Markers change only what people see:

- `timeline-marker`: a quiet note card in the chat, the trace of the decision
  (a request card the judge answered is gone by then): the judge's glyph and
  name, and on the trailing edge its answer with the request card's chance
  meter (`safe ▬ 88% likely`); under it one line per action with a mark for
  its outcome (done, sending, skipped, failed), then the follow-up. It wears
  the paused notice's overlay tint, so no theme's amber or red tints it, and
  insets its content like the chip activity pill, so under that pill the
  glyph and the name fall on the pill's columns.
- `needs-attention`: the marker is highlighted (`attention: true`: an amber
  glyph and a full-strength name; a failed action turns the glyph red) and an
  idle chat's notification is raised to a question, as for `judges.needs-you`.
- `suggest-follow-up` (`text` ≤ 500, turn judges): a button that fills the
  composer and is never sent automatically.

### Actions

| Action | Triggers | What runs (through the owner's facade) | Skipped, recorded, when |
| --- | --- | --- | --- |
| `send-message` `{ text ≤ 1,000, when? }` | turn | `SessionService.send(text, delivery "normal")` with admission `{ author: { userId: owner, via: "judge" } }`, after the marker | the chat is not idle, something is queued, the person wrote after the judged turn, or `maxRounds` (1–20, default 3) judge messages already followed the person's last own message |
| `merge-isolated` `{ when? }` | turn | `SERVER_SESSION_ISOLATION.mergeBack`: exactly the isolation card's **Merge** (squash commit into the branch it started from, release the checkout) | Git is off, the chat is busy or not isolated, `getStatus().actions.canMerge` is false, or the owner does not *manage* the chat |
| `approve-request` `{ when? }` | permission | `replyPermission(requestId, "once")` | the Space has a guarded member (`automaticAllowed: false`), or the request is no longer open |
| `deny-request` `{ when? }` | permission | `replyPermission(requestId, "reject")`: the card's **Deny** | the request is no longer open. A guarded Space still denies, as its own deny rules do (only *allow* turns into *ask* there) |
| `set-approval` `{ level: on \| all \| off, when? }` | turn, permission | `autoAcceptSet` (Auto-Approve, Full access, or off) | the chat already has that setting |
| `switch-route` | limit | `resumeNow({ model, harness: pinned })`: the rate-limit notice's *continue on another model* | the chat already resumed |

Message presets (`MESSAGE_PRESETS`) are *Continue*, *Fix what is left*,
*Refine* and *Spawn an auditor* (asks the agent to delegate a validation and
audit of its work and fix the findings); any own text up to 1,000 characters
works too. Actions run approve → deny → Auto-Approve → merge → switch → message,
so a widened Auto-Approve never answers the request first and a message goes
last. One answer either lets the request through (`approve-request`, or
`set-approval` to Full access) or denies it, never both; a yes/no or score judge,
whose actions all run when it fires, can do only one of the two (validation
refuses the rest, and the Settings editor greys the conflicting choice out).
A judge's own turns are judged again, which makes a *continue until done*
autopilot; `maxRounds` hands the chat back to its person. Every outcome is
re-checked right before acting, and nothing is retried: an uncertain send may
have landed.

### Ownership: whose access a judge uses

Saving a judge (create, edit, or the list's switch) stamps
`ownerUserId` with the signed-in person who saved it; whoever saves a judge
lends it their access, never someone else's. A judge with actions can only be
saved by a person (server work gets `forbidden`).

An owned judge evaluates a chat only when its owner can open it
(`host.personSpaceContext(owner)` → `forSpace(person).sessions.snapshot`), so
another person's private chat is never sent to Judgment; when the owner left
the Space the judge neither reads nor acts. Actions go through that same
person facade, so session access (`collaborate` to send, approve or resume,
`manage` for Auto-Approve and merge), account guardrails (a guarded account
cannot approve or turn on Auto-Approve, and switches only to its allowed
models) and account limits apply exactly as for the person. Judges saved before
ownership existed keep marking every chat and cannot act.

### Model switch at a usage limit

A limit judge lists 1–8 allowed `routes` (`harness::provider/model`, chosen in
Settings from the owner's own model shortlist). On a limit stop it asks
`SERVER_MODEL_ROUTING.candidates(owner, { pairs: routes })` for live headroom,
offers only allowed routes that are available, not blocked and not the chat's
current model, and skips the call when none is left (the chat just waits).
Without Usage the list is offered as written, headroom unknown.

Judgment gets a choice between `wait` ("resumes by itself at …, in about N
minutes") and `route_1`…`route_n` ("continue now on harness · provider/model,
N% of its quota used"), plus the facts: `now`, `stopped` (current model, limit
scope, provider, `resumesAt`, `waitMinutes`, `providerResetAt`,
`retryAfterSeconds`, attempt), `options` (answer, model, quota used, favorite)
and `quotas` (each source's windows with use and reset times). A confident
route answer switches; `wait` or a close call leaves the automatic resume
alone. One switch per stop.

### Daily cap

Each judge runs through `JUDGMENT_SERVICE.createRun` with scope
`judges.custom.<judgeId>.v1`. The daily cap counts reserved Judgment calls per
judge per UTC day in `usage.json`, backtests included. Calls are not refunded
on failure, and an unreadable ledger blocks calls rather than lifting the cap.

A call that got no answer (no Small Model, a refused harness, a timeout, an
unreadable reply…) is never a decision and records nothing in the chat, but it is
not silent: the server logs the judge id and Judgment failure reason (never
evidence), and today's ledger row keeps `failure: { reason, at }` until the judge's
next answer. Settings shows it on the judge's row with what to do about it.

## Recorded event

When a judge fires, the package appends one ignorable `judgment/assessment`
event through `host.events.append(..., { ignorable: true, producerPlugin:
"judgment-judges" })`. It is persisted before it is broadcast and is never part
of model history. The payload is `AssessmentData` in `src/types.ts`: `useId`,
`scope`, `kind`, `title`, `label`, `probability`, optional `probabilities`,
`margin`, `attention`, `followUp`, `judgeId`, `trigger` and `actions`
(`{ kind, status: done | sending | skipped | failed, detail }` in run order),
plus `ts`. Evidence is never recorded. Actions other than a message run first,
so the event records their real outcome; a message is recorded as `sending`
and sent after the event, so the note sits above it; a failed send appends a
second event with `failed`.

The web entry renders it through the `session.timeline.event` slot
(`meta.eventTypes: ["judgment/assessment"]`) as a left-aligned note on the
turn above: the judge's title as a tag, the answer and its chance ("71%
likely"), one line per action ("Sent “…”", "Merged into master (abc1234)",
"Merge skipped: nothing to merge yet"; a failure turns the tag red) and, when
the judge offers one, a button that only fills the composer. A message a judge
sent carries `author.via: "judge"`, and the chat labels it *Sent by a judge*.

### Notes on the request card

A permission judge that decides on requests (`decidesRequests`: an
`approve-request` or `deny-request` action, or `set-approval` to Full access,
which answers every open card) tells the request's card about its work with two
ignorable events, both recorded only while the request still waits (one its
action, another judge or the person already answered has no card left to tell):

- `judgment/request-check` (`RequestCheckData`): `state: "checking"` right
  before the judge asks Judgment (after its daily-cap reservation), and
  `state: "no-answer"` with Judgment's failure `reason` (`timeout`,
  `model-unavailable`, `cancelled` when the package was turned off, `failed` on
  an error, including a verdict the store refused…) when the call ends without
  a recorded verdict. The verdict, a later event, ends a check by itself. A check
  already opened is closed even if the package was turned off meanwhile, since
  that request is not judged again.
- `judgment/request-judged` (`RequestVerdictData`), for every answer, fired or
  not, after its actions ran: `judgeId`, `title`, `requestId`, `verdict`,
  `safety`, the judge's own top answer (`label`, `probability`), `ts`, and
  `action` when an approving or denying verdict's action did not go through
  (`kind`, `status`, `detail`, and a `reason` code for the skips the card names
  in the person's language). An approval or denial that went through closed the
  card, so the assessment marker above is its record.

Evidence is never recorded; a judge that only marks requests records neither.

| `verdict` | When (the judge's own fire rule, `requestVerdict` in `src/custom.ts`) |
| --- | --- |
| `approve` | Exactly when the approving action runs: a choice's confident top answer that approves, a yes/no's confident yes, a score at or over the threshold. |
| `deny` | Exactly when the denial runs, the same way. |
| `against` | A judge that can approve is confident in an answer that does not approve (or deny): a choice's other confident top answer, P(no) ≥ threshold with the margin, a score at or under 1 − threshold. Advice only. |
| `clear` | The same for a judge that can only deny: it is sure there is nothing to deny ("no objection"). Advice only. |
| `unsure` | Anything else: a close call or a chance under the threshold. The request waits for its person, as before. |

`safety` is the judge's chance that the request is safe: the summed probability
of the answers that approve it (choice), P(yes) (yes/no), or the normalized
score; for a judge that can only deny, one minus the chance of the answers that
deny it. A delegated child's request is mirrored in its parent chat, so while
that mirror is open (same `requestId`, `sourceSessionId` = the child) the
parent gets a copy of each note naming the child, when the judge's owner can
open the parent too (an unowned judge marks every chat, as above).

The card shows them through the host slot `session.permission.notes`, just
above the request's decisions (`widgets/RequestVerdict.tsx`): one quiet line
per judge with its latest note on that request. While it checks, a neutral tag
with the theme's spinner in place of the dot (*Checking…*) and the judge's
name; with no answer, *No answer*; with a verdict, a tag (*Approved* /
*Denied* / *Unsure* / *Advises against* / *No objection*), the judge's name, a
short meter and "N% safe". A check with nothing after it for
`REQUEST_CHECK_STALE_MS` (5 minutes, above Judgment's longest call) was cut
short by a restart and reads as *No answer*; a check that arrives while the
card is open is timed by the device's own clock, so a clock set ahead of the
server's never cuts it short. The meter hides on a narrow card; the judge's
answer and "The decision is yours" are in the tooltip and in screen-reader
text, and all lines share one `role="status"` region, so the change from
checking to a verdict is announced once. Only an approval or a denial acts, and it closes the card; every
note a card still shows leaves Allow and Deny to the person. The strings are
the package's own i18n bundle (`src/i18n`, 12 locales).

## Routes

All routes are local-only (`routeScopes: ["judges"]`) and require an owned
`projectId` query parameter.

| Route | Purpose |
| --- | --- |
| `GET /api/judges` | `JudgesSnapshot`: revision, judges (with `ownerUserId` and `starter`), today's usage, `judgmentAvailable`, `viewer`, `fresh` while nothing was ever saved, and `builtins` (each built-in use's resolved switch for this project, through `JUDGMENT_SERVICE.resolveUse`; absent while Judgment is not running) |
| `POST /api/judges` | `{ revision, judge }` create; the saver becomes the owner |
| `POST /api/judges/starters` | `{ locale? }`: adds the seeded starters to a Space that never saved a judge, then answers the snapshot; otherwise changes nothing |
| `PUT /api/judges/:id` | `{ revision, judge }` replace; the saver becomes the owner |
| `DELETE /api/judges/:id?revision=N` | delete |
| `GET /api/judges/routes` | `JudgeRoutesSnapshot`: the caller's model shortlist (favorites and most-used, ≤ 50) with availability, quota used and blocked-until, for picking a limit judge's routes |
| `POST /api/judges/:id/backtest` | `{ limit ≤ 25 }`: runs a turn judge on the newest completed top-level turns of this project and returns per-turn chat, label, probability, `wouldFire`, `wouldDo` (actions) or `skipped` (`cap` or a Judgment failure reason). It records nothing and runs no action; other triggers are refused, and an owned judge skips chats its owner cannot open, whoever runs it. |

## Settings

**Settings → Judges** (group Engineering, order 56) is built from the shared
settings parts (`PageHead`, `Section`, `ItemList`/`ItemRow`, `DisclosureRow`,
`FormField`, `Row`, `Seg`, `NumberField`, `SaveBar`) and `@polyth/web/ui`. It
is the one place that lists everything that judges a chat:

- **How judges work** (`widgets/JudgesGuide.tsx`): one row that opens onto the
  three facts every judge reduces to (*When* it wakes, what it *Asks*, what it
  *Does*) and three rules (close calls do nothing; actions use the access of
  whoever turned the judge on; daily limits and backtests). It is open while no
  judge (custom or built-in) is on; opening or closing it is remembered on this
  device only (`localStorage` `polyth.judges.guide.v1`). The header's `?` opens
  the package tour (`widgets/onboardingTour.ts`, `host.onboarding.registerTour`).
- **Your judges**: while any starter remains, an info notice says starter
  judges are basic settings to get going, not recommendations, and off until
  turned on. Each judge is an `ItemRow`: its category tile (`widgets/judgeKinds.tsx`:
  permissions, actions, long-running work, quality, usage limits, attention;
  the glyph on a wash of the category's tint mixed into the raised surface),
  its name, a *Starter* badge, *when · does* in words (hidden on a list under
  520px, where the description says it), whose access an acting judge uses
  (said only for a judge that is on or that someone saved), *No answer* and
  *Daily limit reached* badges, its description (else its question), the last
  failure with what to do about it, the switch, and a chevron that opens it.
- **Built-in judges**: Completion check, Waiting for you, Keep warm and Quiet
  commands with *On*/*Off* for this project; a row opens Settings → Judgment,
  which still owns their switches and parameters.

**Add judge** opens a template view (`widgets/StarterGallery.tsx`): a blank
judge, the starters disclaimer, then every template grouped by category, marked
*In your list* when a starter with that id is already there and *Pick models
first* for the limit template. A template only fills the editor; nothing is
saved until Save, and a judge added this way is on.

A judge opens as a detail view (`widgets/JudgeEditor.tsx`) in place of the
list, with *All judges* to go back: its tile, name, badges and today's usage;
the **When / Asks / Does** strip (one line per answer that does something,
`unfinished → sends a message`, kept live while editing); for a starter, a
notice that it is a starting point and that saving a change makes it the
person's own; then *Basics* (name, description, trigger, project scope),
*Question* (type and answers or levels; for a limit judge the instructions and
allowed models), *Show in the chat*, *Act* (the access warning, then the
actions per answer or for the whole judge, message presets, Auto-Approve
level, *Messages in a row*; approving and denying on one answer exclude each
other), *How sure it must be* (*Very sure* 90%/lead 40, *Sure* 80/30, *Fairly
sure* 70/20, or *Custom* with the two numbers; a score judge keeps its
threshold), *More settings* (closed rows showing their value: *Answered by*,
*Evidence* with lengths, *Daily limit*), *Try it on past turns* for a saved
turn judge (backtest size and table; changes must be saved first), the
`SaveBar` (Save offered only once the draft differs) and a danger section with
Delete. Renaming or removing an answer carries or drops its actions.

The package CSS is scoped under `.judges-settings`, `.judges-marker` and
`.judges-verdict` and lays out by inline-size container queries (the page at
40rem and 32rem, the shared list at 520px), so it works at phone, tablet and
desktop widths.

## Verification

```sh
node --experimental-strip-types --test packages/judgment-judges/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/judgment-judges
```

The tests use the real Judgment server entry with `createFakeJudgmentEngine`
and make no network or paid calls. They cover storage, CAS, foreign-Space
isolation, the effect allowlist and per-trigger validation, the cap, backtests
that record nothing and run no action, firing and failure paths of the
built-ins and custom judges, the keep-warm budget, due time, stop rules and
hidden keep-alive (with mocked timers), skipped child, archived and importing
sessions, credential redaction, bus disposal on disable, and the settings page
and marker under happy-dom. `test/actions.test.ts` covers ownership (only a
person saves an acting judge; the saver owns it; an owner who cannot open a
chat, or left, makes the judge read and do nothing), messages as a judge after
the marker with the rounds limit and busy/stale guards, the Merge-button path
and its skips, approvals, denials and Auto-Approve through the owner's facade
(guarded Spaces approve nothing but still deny, answered requests, delegated
children, a denial that fails), the card notes (checking before the call, no
answer with its reason, with copies for an open parent mirror; nothing more once
the request was answered, also while the judge was thinking; unsure, against,
clear, denied-but-failed and approved-but-skipped verdicts; the copy for an open
parent mirror and none for a closed or foreign one or a parent the owner cannot
open; none for a judge that only marks requests) and
the model switch with only usable allowed models offered, wait, dedupe and the
Usage-off fallback. `test/verdict.test.ts` pins the verdict to the fire rule for
choice, yes/no and score questions, for judges that approve, deny or both, and
the approve-or-deny validation; `test/settings.test.ts` renders the card line
(latest note per judge, checking, no answer and a stale check, mirror
filtering, live update, localized skip reasons) and the editor's
approve-or-deny guard, the first visit (the starters request in the person's
language, the disclaimer, off starters claiming nobody's access, the guide open
and remembered closed), the starter's own view (its notice, Save offered only
after a change, the sureness steps and *Custom*), the template view (every
template grouped by category, *In your list*, a template that saves nothing by
itself) and the built-in rows. `test/server.test.ts` also covers seeding once,
off and unowned, in the asked language with an English fallback, the denying
guard before the approver, a toggle keeping `starter` and an edit dropping it,
an emptied list never seeded again, an unknown stored starter refused, every
template valid in every locale, the description field and the built-in states.
