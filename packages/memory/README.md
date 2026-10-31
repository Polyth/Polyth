# @polyth/memory

Project-scoped memory: recall during session admission, consented harvesting,
agent memory tools and the **Memory** project settings page. The canonical
policy description is [docs/dev/memory.md](../../docs/dev/memory.md); this file
covers package-local behaviour that is not described there.

## Reflect: rules learned from user corrections

Reflect turns corrections a person types in any harness ("always…", "never…",
"no, use X instead", "I prefer…", and the Ukrainian equivalents) into
**proposed** rules that the user reviews in Memory settings → *Learned from
your corrections*.

- **Source.** Canonical Polyth session history, after each turn completes
  (`SERVER_TURN_COMPLETION_BUS`) or on *Scan recent sessions* (newest 25
  sessions). First sight of a session scans only its last 200 events; a
  per-session cursor makes later scans incremental. Detection is deterministic
  (`src/reflect.ts`); no model is called.
- **Authority.** Only person-authored `user/message` text counts. Assistant
  output, tool results, hidden/auto-resume prompts, GitHub handoff prompts,
  slash-command template expansions (only `raw` is used), turns with
  `memory.remember: "off"`, delegated child sessions (`parentId`) and imported
  history (`historyImport`) are ignored. Fenced/indented code and `>` quotes are
  stripped as pasted content. Conversational lead-ins ("No,", "Yes,", "Ні,"…)
  are stripped from the rule and ignored by the dedupe key. Questions are not rules. Text with an injection
  phrase or URL is dropped and secrets are redacted (shared harvest sanitizer).
- **Policy.** Nothing is scanned while project memory mode is `off` (the
  default): the view reports `memoryOff: true`, the panel disables *Scan
  recent sessions* with an explanation, and `POST …/scan` refuses with HTTP 409
  `memory-off` (`mutationOutcome: "not-started"`). The per-project *Detect
  corrections* toggle stops automatic per-turn scans; an explicit *Scan recent
  sessions* still runs.
- **Storage.** Proposals and cursors live in
  `host.spaceStorage(ctx).packageDir("memory")/reflect/<digest>.json`, keyed by
  Space, project and person, and are only reachable after scoped project
  admission. A person's file holds proposals from messages *they* wrote: the
  per-turn scan runs as the session's actor (a non-member actor is skipped)
  and an explicit scan as the signed-in person. The Space+project file (the
  pre-person state, unchanged) is the project's shared rules: unauthored
  messages and sessions no person acts for. Every member sees and may decide
  on shared rules next to their own; nobody sees another person's. A member's
  *Detect corrections* switch is their own (a new person file starts from the
  shared one); a Space admin's also switches the shared rules.
  Each proposal keeps provenance: session id/title, event seq and id, signal.
  A rejected rule is never proposed again.
- **Approval.** *Approve* (optionally after *Edit*) creates an active,
  user-locked, `user-stated` memory with a `session` source pointing at the
  exact message, `authoredBy: {kind: "system", via: "reflect"}` and the
  approving person in `approvedBy`. Approval is idempotent; edits after approval belong to the
  memory record.
- **Instruction files.** Writing to `AGENTS.md` or `CLAUDE.md` is a separate,
  explicit choice confirmed in the browser with the exact line and path; the
  request must carry the `append-project-instruction` confirmation token. Only
  those two root-level basenames are accepted, the project root is resolved
  with `realpath`, a symlinked instruction file is refused, files over 1 MiB
  are refused, and every open uses `O_NOFOLLOW`. The rule is added as one
  bullet under `## Learned rules` (created if missing, existing bullets are
  deduplicated). Remote projects cannot be written. A failed write leaves the
  approved memory in place and the rule can be written later from *Recently
  decided*.

- **Durability filter (Judgment use `memory.reflect-durability`).**
  Evaluates whether candidate user corrections represent lasting preferences
  rather than one-off instructions (`scope: memory.reflect-durability.v1`,
  `evidence: short`).
  - **Questions.** `noul` *Is this a lasting preference or rule rather than a
    one-off instruction?* and `choice` area (*code*, *style*, *process*,
    *communication*, *other*).
  - **Parameters.** `hideBelow` (probability, default `0.3`): proposals with
    durability probability below this threshold are hidden from the proposal
    list but kept reviewable via a *Show hidden (N)* affordance in Memory settings.
  - **Policy.** The proposal list is sorted by durability descending, and each
    proposal displays its evaluated area and durability percentage. Approval
    remains an explicit human action; Judgment never creates a memory.
  - **Fallback.** When Judgment is off, disabled, or an evaluation fails,
    proposals are shown exactly as today (no filtering by durability, no area/score).
    Additive fields (`durability`, `area`, `judgment`) are persisted in the proposal
    JSON; older proposal files continue to load without error.

Routes (Space member required for writes, local-only like the rest of
memory): `GET /api/memory/reflect`, `PUT /api/memory/reflect/settings`,
`POST /api/memory/reflect/scan`, `POST /api/memory/reflect/:id/approve|reject|instruction`.

Tests: `node --experimental-strip-types --test packages/memory/test/*.test.ts`.
