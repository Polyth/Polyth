# Session Assist

The optional `@polyth/recap` package owns prompt improvement, the magic next
prompt button, and idle session recaps with grounded follow-up suggestions.
It is disabled by default and is not recommended by any project direction or
standard project creation set. Enable **Session Assist** in the package library
to use it; existing widget visibility and placement preferences still apply.

The `recap` package and settings identifiers stay stable for compatibility.
Its web entry registers the `composer.next-action` rail button, the headless
`recap.next-prompt` source on the `composer.suggestion` slot, the timeline
recap strip, and the settings page. Disabling the package removes these
registrations and its HTTP routes, stops recap timers, and discards pending
prompt results.

**Next prompt** works and looks like Claude Code's own prompt suggestions.
After a reply, the open chat's idle, empty composer asks the small model once
for the next message over the recent completed exchanges and shows it on the
host's suggestion chip above the composer (`ComposerDraftContext.offerSuggestion`,
`widgets/NextPromptSource.tsx`, `widgets/nextPrompt.ts`): click or Tab fills
the draft (never sends), × or Esc dismisses it, and typing just hides it. The
source is a `composer.suggestion` slot contribution the host mounts for every
agent chat, so hiding or moving the rail button (or a phone rail without it)
never turns suggestions off. Any conversation movement (`assistFreshnessSeq`,
so usage/title bookkeeping does not count) withdraws the suggestion; an answer
the server gave for a state the client has not caught up to yet still counts.
A remount, a session switch or a second open client reuses the answer for the
same conversation (the server shares one flight and keeps recent answers per
conversation and person), so an automatic suggestion costs at most one
small-model call per reply and person. A failed settings load is asked again
on the next conversation movement rather than leaving suggestions off.

When the harness suggests prompts itself (Claude Code), **When the harness
suggests too** (`suggestionPriority` in `assist.json`) decides who takes the
chip. `harness` (default) shows the harness's hint: it suppresses the request,
and Claude Code sessions get a few seconds' grace before Session Assist asks, so
Session Assist fills in only when Claude stays silent (first turn, plan mode,
near plan limits, a filtered guess). `assist` asks right away even when the
harness has a hint and offers the answer as `preferred`; while that request
runs, the chip is held empty (at most 10 s) so the harness hint does not flash
up and get replaced, and an empty answer gives the chip back to the harness.
The magic button on an empty composer asks the model again (`regenerate`) and
shows the result on the same chip, over a harness hint whatever the setting
says; a model with no grounded next step answers with a quiet notice. The
**Suggest the next prompt** switch (`suggestNextPrompt`, default on) turns the
automatic request off; automatic failures stay silent, explicit ones report a
notice.

**Recap** is one quiet caption at the transcript tail, on the prose text edge:
the ≤20-word recap and a dismiss held to its last word (revealed on hover for a
fine pointer). It has no glyph or visible label; the note's accessible name is
"Recap". It draws no suggestion of its own: when the idle recap also
grounds a next prompt and the conversation has not moved, Session Assist offers
it on the same composer chip, after its own answer for that conversation state
and, like it, below or above a harness hint by the priority setting. A recap that already suggests also skips the
automatic small-model request, so one reply never shows two suggestions.

Prompt improvement rewrites a non-empty draft only and replaces it, never
sending. It depends on the draft alone: typing, navigation and package
deactivation discard a stale result, later session events do not; Undo and
regeneration preserve the user's original words. Model selection uses the
requester's small-model preference, with the session's model and owning
harness as fallback.

Key callouts: after a completed turn, a "Before you continue" strip above the
recap lists must-know items, most urgent first: a decision the agent is waiting
on, a failed check, a credential/manual step, an action for the person, a check
that was skipped or could not run ("Not verified"), and a risk. It is **off by
default** (`showCallouts` in `assist.json`): the Session Assist settings page
explains the strip and turns it on. A deterministic
heuristic over the assistant's text (`src/callouts.ts`) runs locally in the
browser and never starts a model turn. Each rule has a `skip` guard for the
common false alarms — an expected failure ("the assertion should fail" in a
mutation check), a zero count ("0 failed", "finds 0 vulnerabilities"), a
failure already fixed, "no breaking changes", a negated risk ("never touches
the vulnerable code"), a polite "let me know if you want anything else" — and
an excused sentence can still match a later rule.

The strip is a light checklist card (Things-like) in the conversation's glass
material with the theme's contour: a title with the count of open items and the
fold's chevron, then one row shape for every kind. A row is a ring, the source
sentence quoted verbatim, and a quiet kind tag; only a decision or a failed
check adds a coloured dot to its tag, and a run of one kind shows its tag once
(the repeated name stays for assistive technology). The ring ticks any row off
(a step done, a question answered, a risk taken in): the sentence is struck
through, it leaves the count, and its next step goes; there is no per-row
dismiss. The whole sentence opens its message (`conversation.revealEvent`). Rows
offer one next step as a composer draft, never a send (`conversation.insert`):
**Reply** quotes a decision, **Ask to fix** / **Ask to verify** quote a failed
or unverified check with a request. Under a pointer the step takes the tag's
place on hover or keyboard focus; on touch, and in a narrow placement (where tag
and step move under the sentence), both show. A list over five items shows the
first four and a "Show N more" control. The header folds the strip to one line
that still lists each kind's tag and count. Dismissals, ticks and
the fold are browser-local presentation preferences
(`widgets/calloutDismissals.ts`, `localStorage`; dismissals and ticks keep the
latest turn per session for the 100 most recent sessions, the fold is one
preference for every strip): they survive a reload, are never written to
session history, and a new turn's callouts always show. **Find more** is an
explicit user action that POSTs `/api/sessions/:id/assist/callouts` and uses
the same small-model path as other Session Assist requests; model items are kept
only if their quote appears verbatim in the cited message and carry a "Found by
model" mark. Checking, "found N more", "nothing more found" and failures are
reported inside the strip, and a finished check is not offered again for that
turn; a stale reply (a newer turn arrived) is dropped silently. Labels use
`callouts.*` host locale keys, with built-in English fallbacks.

The package owns `/api/projects/:id/assist/prompt`,
`/api/sessions/:id/assist/suggestion`, `/api/sessions/:id/assist/callouts`, `/api/sessions/:id/assist`, and
`/api/settings/assist`. These routes are local-only. Session and project prompt
requests validate the resource through the request's scoped services before
reading history or invoking a model. Quiet-time settings keep the legacy
`assist.json` location; their existing deployment-wide storage is unchanged.
`showCallouts` joins the same file and defaults to off when absent.

Run deterministic checks with
`node --experimental-strip-types --test packages/recap/test/*.test.ts` and
validate browser entry changes with `npm run build:web`.
