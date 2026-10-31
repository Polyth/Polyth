# Project Memory

Project memory is managed from **Project → Settings → Memory**. The page is
project-labelled and uses the canonical project id from the host settings
dialog. It supports review, manual create/update, pin/unpin, lock/unlock,
archive, forget, bounded page search, export, staged import, policy controls,
and clear.

The records toolbar reports the server count for the active project filter.
Visible-page selection is limited to one page; **Select all filtered** may select
and act on at most 50 matching records. The filter is captured when selection is
made, and changing it clears the selection. Each bulk archive or forget uses the
record revision as a CAS check and reports successful and failed records
individually; a partial result is never presented as a full success.

Automatic recall runs during session admission when policy mode is `auto`. The
bounded target is at most 6 records and 6 KiB, with a hard cap of 8 records.
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

Matching is lexical; there are no embeddings. A query word of four or five
letters also matches by its first four letters, a longer one by all but its
last three letters (at least five), so inflected Ukrainian and English forms
meet (`гастриту` → `гастрит`, `symptoms` → `symptom`); shorter words, numbers
and paths match exactly. Ranking weights a hit in the
title four times and in tags or aliases twice a hit in the body. Agent search
(not admission recall, where a whole prompt would match too much) also adds
substring hits from a trigram index for words of four or more characters
(`palace` finds `MemPalace`). SQLite triggers keep that index in step with
every write, including writes by an older server; a store that predates it is
indexed once on open, and an SQLite without the trigram tokenizer keeps word
and stem matching only.

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

**Layers and provenance (storage only).** Every record has a `layer`:
`project` (bound to its project), or the Space-wide `space`, `agent` (owned
by an agent id) and `person` (owned by a user id). A caller reaches a layer
only through `MemoryScope.layers`, a server-minted list of grants; without
it a scope sees exactly the project layer. Today no caller passes grants, so
every existing record (migrated in place with `layer = 'project'`) and every
new one is a project record, and recall, search, the management page, tools
and export behave as before. Writes name their layer and author through the
store's trusted `MemoryWriteOptions`, never through `MemoryCreateInput`,
which routes build from request bodies. Clear, export and import cover the
project layer only; an import cannot reuse the id of a record in another
layer. Records carry `authoredBy` (a person for manual saves, an agent and
session for `memory_remember`, the system for harvest, Reflect and import;
absent on records saved earlier) and `approvedBy` (the person who activated
a candidate or approved a Reflect rule). The visibility resolver that will
grant the other layers to sessions is not built yet; see
[Spaces §14.6](../architecture/spaces-and-tenancy.md).

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

The feature package owns the UI and routes; Knowledge owns the canonical
Space-scoped store and browser-safe DTOs. See the [architecture package map](architecture.md)
and [Space tenancy model](../architecture/spaces-and-tenancy.md) for the
ownership and storage boundaries.
