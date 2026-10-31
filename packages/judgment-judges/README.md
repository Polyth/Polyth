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

All three are registered through `JUDGMENT_SERVICE.registerUse`, are off by default,
and are switched on and tuned in **Settings → Judgment → Uses**. Use state is
resolved before every evaluation. Registration follows the live Judgment
service, so either package may enable first.

| Use | Scope | Evidence | Question | Records when |
| --- | --- | --- | --- | --- |
| `judges.completion-check` | `judges.completion-check.v1` | long: request ≤1,500 chars, answer tail ≤3,000, commands, changed files, open todos | choice `verified` / `claimed_only` / `cannot_tell` | top answer is `claimed_only`, P ≥ `threshold` (0.7) and lead over the next ≥ `margin` (0.2) |
| `judges.needs-you` | `judges.needs-you.v1` | short: last 400 chars of the final answer | noul “Is the assistant waiting for the person to answer or decide?” | P ≥ `threshold` (0.7) |
| `judges.keep-warm` | `judges.keep-warm.v1` | short: request head ≤200 chars, answer tail ≤400, open-todo count | choice `unfinished` / `finished` / `cannot_tell` | top answer is `unfinished`, P ≥ `threshold` (0.8) and lead ≥ `margin` (0.3); arms keep-alives, records nothing |

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

A judge has: `name`, `enabled`, `trigger`, `filters.projectId?`, `evidence`,
one `question`, `fire` (`threshold`, `margin`, and `label` for a choice's
markers), `effects`, optional `routes`, `maxRounds` and `model`, and `dailyCap`
(1–1,000, default 40). Unknown fields are rejected. The server adds
`ownerUserId` (see [Ownership](#ownership-whose-access-a-judge-uses)); input
never sets it. All shapes and rules are in `src/types.ts`
(`validateJudgeInput`).

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

- `timeline-marker`: a quiet marker in the chat.
- `needs-attention`: the marker is highlighted (`attention: true`) and an idle
  chat's notification is raised to a question, as for `judges.needs-you`.
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
| `GET /api/judges` | `JudgesSnapshot`: revision, judges (with `ownerUserId`), today's usage, `judgmentAvailable`, `viewer` |
| `POST /api/judges` | `{ revision, judge }` create; the saver becomes the owner |
| `PUT /api/judges/:id` | `{ revision, judge }` replace; the saver becomes the owner |
| `DELETE /api/judges/:id?revision=N` | delete |
| `GET /api/judges/routes` | `JudgeRoutesSnapshot`: the caller's model shortlist (favorites and most-used, ≤ 50) with availability, quota used and blocked-until, for picking a limit judge's routes |
| `POST /api/judges/:id/backtest` | `{ limit ≤ 25 }`: runs a turn judge on the newest completed top-level turns of this project and returns per-turn chat, label, probability, `wouldFire`, `wouldDo` (actions) or `skipped` (`cap` or a Judgment failure reason). It records nothing and runs no action; other triggers are refused, and an owned judge skips chats its owner cannot open, whoever runs it. |

## Settings

**Settings → Judges** (group Engineering, order 56) is built from the shared
settings parts and `@polyth/web/ui`. It lists judges with a switch, a summary
(trigger · question · effects · scope), an *Acts as you* / *Acts as another
member* badge for acting judges, today's usage and Backtest (turn judges). The
editor offers: what the judge answers (*After a turn*, *Permission request*,
*Usage limit*), project scope, question type and answers/levels (or the
instructions and the allowed-models checklist for a limit judge, from
`GET /api/judges/routes`), evidence picks with lengths, threshold, margin,
*Show in the chat* (markers, with the answer they follow), *Act* (a warning that
actions use the saver's access, then the actions per answer for a choice or for
the whole judge, with message presets and an Auto-Approve level; approving and
denying on one answer exclude each other), *Messages in a
row*, the daily limit, Save/Discard and Delete with confirmation. Renaming or
removing an answer carries or drops its actions. It also shows the backtest
table and explains that the built-in judges live in Settings → Judgment → Uses.
The package CSS is scoped under `.judges-settings`, `.judges-marker` and
`.judges-verdict` and uses inline-size container queries, so the layout works
at phone, tablet and desktop widths.

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
approve-or-deny guard.
