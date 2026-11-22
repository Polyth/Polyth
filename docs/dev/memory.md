# Project Memory

Project memory is managed from **Project → Settings → Memory**. The page is
project-labelled and uses the canonical project id from the host settings
dialog. It supports review, manual create/update, pin/unpin, lock/unlock,
archive, forget, bounded page search, export, staged import, policy controls,
and clear.

The page has three tabs: **Records** (search, lifecycle filter, the list and
My notes), **Rules** (rules learned from corrections; the tab carries the count
waiting for a decision) and **Settings** (delivery policy, harvesting, export,
import and clear). Tabs stay mounted, so a draft in one survives a look at
another. A record is one row: tapping it opens the editor, and its ⋯ menu holds
mark reviewed, pin, lock, archive and forget. A row names only what sets the
record apart (category, a lifecycle other than active, pinned, locked, a
freshness other than current or unknown) and ends with its age. Passing results
go to the host notification stack; errors stay on the page. The page is drawn
with the host's controls (and confirms through `host.ui.confirm`), handed to the
package through `MemoryUiContext` (`packages/memory/widgets/ui.tsx`), and is
laid out by container queries on `.pkg-memory`, phone first.

**List.** The search matches every typed word in title, body, tags or aliases,
in any order and any case (Cyrillic included: both sides go through the same
Unicode fold, `memory_fold`, because SQLite's `LIKE` folds ASCII only), marks
the matches in the rows, and its snippet starts near the first match. Escape in
a search with text clears it before the dialog may close. The lifecycle filter
is one row of chips. The list shows 20 rows and **Show more** adds the next 20;
a refresh after a change keeps every row that was on screen.

**Editor** (`MemoryEditor.tsx`). A tapped row opens at once with what the row
already knows; the whole record (read ahead on hover, focus or press) fills in
and the fields stay read-only until it does. The list stays mounted underneath,
so Back returns to the same scroll position, search and row. The title wraps and
grows; category is a chip group; the body grows with its text and shows its size
once past half of the 8 KiB limit; tags, aliases, paths and sources are chip
fields (Enter or a comma adds, Backspace takes the last back), with the last
three behind **More details**. Save is enabled only for a changed, valid draft;
Ctrl/⌘+Enter saves and Escape steps back to the list (asking before dropping a
draft) instead of closing the dialog. A save sends values that were already on
the record in their original form, so a session source stays a session source
and a module stays a module; only typed-in values become manual sources or
paths. The editor's ⋯ menu offers the row's actions while the draft is clean and
re-reads the record after one. Every manual save is user locked.

**My notes** rows open their editor in place; their ⋯ menu holds Edit, Share…
and Delete, and Delete asks first.

Selection is a mode entered from the toolbar's ⋯ menu (**Select records**):
rows gain checkboxes and a bar offers Archive and Forget.
**Select all shown** selects the rows on screen; **Select all filtered** may select
and act on at most 50 matching records. The filter is captured when selection is
made, and changing it clears the selection. Each bulk archive or forget uses the
record revision as a CAS check and reports successful and failed records
individually; a partial result is never presented as a full success.

Automatic recall runs during session admission when policy mode is `auto`. It
adds a `<polyth-project-memory>` block of at most 6 notes (hard cap 8) inside
the project's byte budget (6 KiB at most). Each note is one entry: `[id]` and
the title, then the whole note when title and body fit in 480 bytes, otherwise
its opening (up to 200 characters, cut at a sentence or word) and the full
size, as in `… (1.5K in all)`. The agent reads the rest with `memory_get`. The
`id` is the first 8 characters of the record id, or the full id when those 8
would name two records the chat can reach; every memory tool accepts either.
A personal note carries `· personal`, a note about someone `· about <name>`.

A note is recalled only when it is about the request. The query is built from
the prompt's words that tell notes apart: a word found in more than a tenth of
the Space's active notes (and in more than 20 of them) is left out, like the
stop words. A ranked note then needs a query word in its title, tags or
aliases, or two different ones in its body, or one that at most 3 notes contain
at all; and it must rank at least half as well as the best such note. So "ok"
or "continue" recalls nothing. A pinned note that matches is never filtered
out, and pinned notes are what a prompt with no telling word recalls. On a copy of a
real 938-note memory this took the block from about 6 KiB on every turn to
0–2.6 KiB.

The session persists the prepared contribution before runtime delivery and
rechecks the policy generation and settings revision fence before sending it
to a provider. Turning delivery `off` stops future recall and fences pending
harvest work; it cannot remove context already delivered to a native runtime.

Automatic harvesting requires explicit consent, an exact provider/model pair
in the allowlist, and a positive durable utility call budget. The utility
model only observes admitted bounded session evidence. A failed, unavailable,
blocked, or exhausted utility call is shown as a health state and is not
reported as a successful harvest. Manual saves are user locked.

In Automatic mode, scoped agent search, get, and remember tools are authorized
without repeated prompts; explicit permission denies still take precedence.
Read-only mode permits agent reads and blocks agent writes; Off blocks the
agent tools. Management-page edits remain explicit user actions. Feedback,
including archive and forget, retains normal tool authorization.

`memory_search` uses the same matching as recall (the store's `search`): only
active records, any query word may match, pinned first then ranked, policy
exclusions applied. Archived, candidate, superseded and forgotten records never
appear in it, and `memory_get` treats a forgotten record as not found. The
management page's record filter is a separate whole-phrase substring match over
every lifecycle. When full-text search is unavailable, recall and search both
fall back to a bounded per-word match, never a whole-phrase one.

Matching is lexical; there are no embeddings. Apostrophes inside a word are
dropped on both sides, so `пам'ять`, `пам’ять` and `памʼять` are one word. A
query word of four or five
letters also matches by its first four letters, a longer one by all but its
last three letters (at least five), so inflected Ukrainian and English forms
meet (`гастриту` → `гастрит`, `symptoms` → `symptom`); shorter words, numbers
and paths match exactly. Ranking weights a hit in the
title four times and in tags or aliases twice a hit in the body. Agent search
(not admission recall, where a whole prompt would match too much) also finds
words of four or more characters inside longer ones (`palace` finds
`MemPalace`). There is no index for that: when the word index returns fewer
hits than were asked for, the store scans the newest 5,000 active notes the
chat can reach.

What a memory tool returns is plain lines, not record JSON: `memory_search`
and `memory_search_projects` give `[id] title` and an excerpt that starts near
the first matched word (a cross-project hit also names its project and project
id); `memory_get` gives one header line (`id`, revision, category, tags, last
update, labels) and the note; `memory_remember` gives `saved <id>`. Full ids,
counts and statuses go to the host in the result's `metadata`.

`memory_remember` takes optional `supersedes` ids: after saving the new record
it moves those records to `superseded`, which drops them from recall and search
but keeps them, with their history, on the management page. It refuses, before
saving anything, a missing, inactive, person-authored or person-approved
record: a person's own words change only through the management page.

**Other projects.** `memory_search_projects` searches the project layer of every
project the person the turn acts for can open in this Space (the host's
`personSpaceContext`; a single-person install uses its one person) whose memory
is not off, ranked together, with each project's exclusions applied. Results
name their project; `memory_get_project` reads one full active record of such a
project. Both refuse a session with no person, a person who is no longer a
member and an unopenable project (reported as not found). The source project's
**Other projects** policy (`crossProjectRecall`) decides consent: `ask`
(default) leaves the call to the ordinary permission prompt, `allow`
auto-approves it, `off` refuses it. Explicit permission denies still win, and a
chat on Auto-approve answers the prompt as it does for other read-only tools.

The memory package also projects one deployment instruction, *Polyth long-term
memory*, into every harness: Polyth memory is where durable project knowledge
goes (not a separate memory MCP server such as MemPalace), search before answering
about earlier work, save settled facts with `memory_remember`, and use
`memory_search_projects` for other projects.

Every harness (Claude, Codex, OpenCode, Pi, Antigravity, Command Code and the
ACP family: Cursor, Grok, omp, fx) receives the memory tools through the same
`polyth-agent-tools` MCP bridge. The Space and project come from the harness
capability grant, so a session in an isolated worktree uses its owning
project's memory. Recall is added during canonical session admission, so the
`<polyth-project-memory>` block does not depend on the harness.

New project policies activate validated harvest output automatically. Existing
review preferences are preserved; **Harvest review** can select automatic
activation or manual review. Review activates a candidate and archive removes
it from recall. Recall matches individual query terms and ranks the results,
so a natural-language request need not match every word in a record.

Enter the utility provider and model together, then **Save utility model**.
Saving resets utility consent; enable the saved model explicitly and set its
call budget before harvesting. Enabling agent memory does not authorize paid
utility calls by itself.

Turn completion kicks harvesting for the affected session immediately.
Restart recovery also scans admitted projects for durable work: it drains
found jobs with a short delay and waits 30 seconds after an idle scan. Large
session inventories yield to the event loop every eight sessions so the scan
does not stall HTTP requests. Until the utility model is ready (consented,
allowlisted and marked ready) discovery skips the project entirely: no job
could succeed, and rescanning every session tail each poll pinned a CPU core
on large inventories. Marking the utility ready re-queues the denied jobs and
the next poll resumes from the persisted cursors.

`blockWithoutMemory` is the strict policy. When enabled, unavailable or
blocked recall can prevent admission; the UI reports the server result and
does not infer that memory was delivered. An empty recall, including a project
with no memory records yet, allows the turn to run and records that no memory
was delivered. Read-only, offline, busy, corrupt
payload, unavailable, and stale-revision states remain recoverable through
retry, reload, correction, or export.

Forget and clear are destructive project actions. Forget creates a durable
tombstone and clears pending delivery for the affected source; clear forgets
the project records and fences pending harvest jobs. Neither action restores
records automatically. Recovery exports include active, candidate, and
archived records. Export a recovery file before replacement or clearing
if the records may be needed later. Import is staged: preview reports
duplicates, conflicts, and invalid records; replace requires a recovery export
and explicit project-labelled confirmation.

**Layers and provenance.** Every record has a `layer`:
`project` (bound to its project), the Space-wide `space` and `agent` (owned
by an agent id), and `person` (owned by a user id; with a `projectId` it is
that person's note in one project, without one it is about them everywhere).
A caller reaches a layer only through `MemoryScope.layers`, a server-minted
list of grants; without it a scope sees exactly the project layer. Only
`chatAccess` grants `person` to a chat, and only one private to that person;
the rules are in [Spaces §14.6](../architecture/spaces-and-tenancy.md). The
generic routes, export and clear stay on the project layer. A person reaches
their own notes through `/api/memory/personal*`, shown as My notes in Project
settings → Memory once someone else can open the project or they already hold
notes. Writes name their layer and author through the
store's trusted `MemoryWriteOptions`, never through `MemoryCreateInput`,
which routes build from request bodies. Clear, export and import cover the
project layer only; an import cannot reuse the id of a record in another
layer. Records carry `authoredBy` (a person for manual saves, an agent and
session for `memory_remember`, the system for harvest, Reflect and import;
absent on records saved earlier) and `approvedBy` (the person who activated
a candidate or approved a Reflect rule), and optionally `about`, the name of
the person a fact concerns.

Memory evidence is bounded project context, not a complete native transcript
or a guarantee that a provider retained or acted on it. Native context already
sent cannot be erased by changing policy or forgetting a record. Source
provenance and lifecycle remain visible in the management page.

Reflect turns corrections a person typed ("no, do X instead", "always…",
"never…"; English and Ukrainian patterns, no model call) into proposed rules
with provenance. Nothing is scanned while project memory is off. Approval
creates a locked user-stated memory; writing the rule to the project-root
`AGENTS.md`/`CLAUDE.md` is a separate, confirmed action that refuses symlinks,
oversized files and remote projects. Assistant/tool output, imported history,
delegated child sessions and pasted code never count. See
[`packages/memory/README.md`](../../packages/memory/README.md).

## Storage

The memory package owns its data: one SQLite database per Space,
`<space>/packages/memory/memory.db` (`src/spaceStore.ts`, `src/store.ts`), and
the browser-safe DTOs in `src/contracts.ts` (`@polyth/memory/contracts`). It
holds the records, one word index (FTS5, contentless: the index only, no
second copy of the text, and only active records), earlier revisions of edited
records (the current state is the record itself), policies, tombstones and
harvest cursors. Settled harvest jobs are deleted when the store opens.

Memory used to live in the Knowledge package's database
(`<space>/packages/knowledge/knowledge.db`, tables `memory_*`). The first time
a Space's store opens, `src/legacyImport.ts` moves it:

1. Every record is copied with its id, revision, dates, layer, owner and
   provenance, then read back and compared column by column. Records already in
   the new store are skipped by id, never overwritten. Earlier revisions,
   policies, cursors, idempotency receipts, tombstones and live harvest jobs
   come along; settled and denied jobs do not (harvesting resumes from the
   cursors). Knowledge items of kind `memory`, which is how memory was kept
   before it had tables, are copied in the same pass.
2. The copy commits only when every old record is present in the new store.
   A record that cannot be copied stops the move, rolls it back and leaves the
   old tables whole; memory is then unavailable for that Space and the cause is
   logged at start.
3. After the commit the old `memory_*` tables, their indexes and triggers are
   dropped and the old database is compacted. Knowledge's own rows stay.

The package opens every Space that has a project when it is enabled, so every
Space on a server moves at the first start of this version, without anyone
opening Memory. A start that is interrupted repeats the move safely. An older
server started afterwards finds no memory tables in `knowledge.db` and shows an
empty memory; the notes are in `memory.db`.

On a copy of a real Space (938 notes, 1.45 MB of text) the old tables took
20.6 MB and the new database takes 4.4 MB; the move ran in 0.35 s.

See the [architecture package map](architecture.md) and
[Space tenancy model](../architecture/spaces-and-tenancy.md) for the ownership
and storage boundaries.
