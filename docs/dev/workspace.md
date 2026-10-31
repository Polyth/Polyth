# Workspace repositories and resources

A Project is the logical workspace and owns repository registrations. A Session
owns a durable selection of those repositories and its checkout allocation.
Files, Search, Source Control and Terminal each own their presentation scope.
Selecting a repository in one surface does not redirect another surface or
change the session runtime's execution repository.

## Registration and session membership

`@polyth/contracts/workspace` is browser-safe and owns `projectRepositories`,
`resolveWorkspaceContext` and `workspaceRepository`. The resolver does not probe
the filesystem: `ready` is projected state, not proof that a directory exists.
Owning file, Git and terminal services report actual filesystem failures.

Legacy Projects expose a stable synthetic `primary` repository. Adding another
repository materializes this legacy entry. Registration canonicalizes local Git
roots, rejects duplicates and symlink aliases, and retains identity evidence for
relocation. Repository settings support adding, renaming, locating, choosing a
new primary and removing registrations. Removal never deletes repository files;
the current primary must be replaced before its registration is removed. A
relocation must match the stored repository identity; absent identity evidence
is not permission to adopt an arbitrary directory. Remote inventory edits are
unsupported. Folder discovery is bounded and checks only the chosen folder and
its immediate children.

Changing the Project primary changes defaults for new work. `Project.path` and
`legacyRepositoryId` retain the original scalar execution identity for old
sessions. A relocated or removed registration must not silently redirect an
existing session. Durable snapshots retain removed registrations as missing.

New ordinary sessions snapshot all registered repositories unless the caller
selects a subset. `SessionWorkspace` contains membership, checkout paths,
`executionRepositoryId` and a monotonic revision. The execution repository is
the scalar cwd anchor, independent of UI scope. Paths and isolation evidence
are supplied by trusted checkout owners; HTTP membership requests carry only
repository IDs and an optional expected revision. Foreign projects/sessions,
unknown IDs, duplicate roots, stale revisions and inconsistent scalar checkout
paths fail closed. Session settings expose membership changes while idle;
removing a missing anchor requires an explicit replacement and runtime rebind.
Adding a Project registration does not silently change an existing snapshot.
After Locate, the session offers **Use located repositories** for ordinary
checkouts. The explicit `relocateRepositoryIds` request names existing selected
members and requires the captured revision. The server takes paths only from
the Project registration, releases the prior runtime, and commits the repaired
snapshot before rebinding. Managed checkouts use their isolation recovery flow.
Relocating the execution repository validates the proposed snapshot together
with its future scalar checkout path. The current pair is validated separately;
it remains authoritative until execution release and atomic workspace publication
complete. Completed delegated children can use this flow to leave a parent's
checkout without losing their canonical history or blocking its later cleanup.
Continuing without unavailable repositories retains only existing ready members.

A legacy isolated session without a snapshot exposes only its owned checkout.
New multi-repository isolation allocates one managed worktree per selected
repository and persists ownership evidence on each workspace row. Later
additions are allocated by the Git owner. Ordinary rows may be removed from a
selection; managed rows require their keep/merge/discard lifecycle first.
A new chat in a multi-repository Project chooses its repository scope in the
composer's location row (host `SessionContextBar`), between the project and
checkout pickers: project › repositories › checkout › isolation. The choice is
the unsent chat's `newSessionIntent.repositoryIds` (omitted = all) and is sent
once with creation; `composer/repositoryScope.ts` owns the pure rules (project
order, at least one repository, a complete subset collapses to all). The
checkout picker targets the execution repository and is labelled with its
alias. Linked-worktree management is primary-only and an isolation base branch
belongs to the execution repository, so with the primary out of scope the
checkout locks to each repository's current checkout and no worktree path or
base branch is sent. Single-repository Projects show no repository control.
The Files header indicator edits an open ordinary session's membership; it is
omitted from isolated session headers.

Picking another project in that row retargets the unsent chat, it does not
navigate (`moveNewSessionDraftToProject` in `store.ts`): the New Chat surface
stays, the live text plus link/browser-context attachments move, and the
target's remembered lane chat is not restored. Repository-relative and
native-staged attachments stay in the source project's draft; a draft already
waiting in the target is shelved as a previous new-chat draft.

## Mutation, release and recovery

Session/core owns the canonical mutation lock, revision checks, execution
release and fresh runtime epochs. Git owns checkout allocation, source
snapshots, publication receipts and cleanup. `withWorkspaceMutation` gives the
checkout owner a short-lived snapshot/commit scope under that lock after
execution release; callers must await all scope operations. The scope expires
when its callback settles. Workspace changes publish an ignorable canonical
event and projection together through the store's atomic batch operation.

Per-repository keep, merge, discard and recovery preserve sibling memberships
and distinguish the real execution anchor from a secondary checkout. Cleanup
requires exact managed ownership and dependency checks, process closure and
source-snapshot verification where publication has occurred. A published merge
retains the repository at its target checkout. Uncertain publication is never
replayed; startup recovery inspects each pending row and its receipt. For one
execution checkout, it also restores merge readiness from durable completed
turns; multiple isolated repositories use their independent recovery paths.
Scalar cleanup relocates idle, finished or failed ordinary descendants of the
isolated session to its verified origin through the canonical runtime rebind
and captured workspace revision. Their history and parent links remain intact.
An archived or unknown descendant that never reached a native session (no
runtime binding or backend id, e.g. a failed startup with an unresolved create)
moves as metadata only: no release, no new epoch, no runtime start, and its
unresolved operation stays recorded. Active, archived or unknown descendants
that ran, and unrelated, foreign-Space or independently isolated dependents
retain the source; an uncertain release also leaves cleanup pending. A confirmed absent source can
finish interrupted cleanup after destination and dependency checks, without
republishing or deleting an unproven leftover ref. A pending discard can return
to the recorded origin's current local branch without changing that checkout;
published merges still require their original target branch.
The recovery card distinguishes an unfinished persisted phase from an active
request: pending return/cleanup asks for recovery with a static glyph; a retry
in flight shows the spinner and exposes `aria-busy`.
An absent checkout still requires runtime execution release before session
deletion. A timeout or successful signal alone is not proof of that release.

`POST /api/isolation/:sessionId/return` (`returnUnchanged`) is the lossless
variant of discard for a single-repository isolation: under the session lock it
refuses (409, rejected) when the managed checkout has any commit ahead of the
target or any uncommitted change, otherwise it runs the discard path and
records `isolation/discarded` with `returned: true`, which the timeline shows as
a return rather than a discard. The Git package contributes the matching
session-menu entry through `sidebar.session.actions` (desktop row menu and the
phone Navigator's and overview Recent rows' hold menus): it reads isolation status when the menu
opens and offers **Return to {branch}** with nothing to integrate,
**Integrate into {branch}** (confirm, then the full merge-back) when the card's
merge is allowed, or opens the session so the isolation card can explain a
conflict, delegated work or an unavailable destination.

An existing ordinary chat can move into isolation:
`POST /api/isolation/:sessionId/isolate` (`isolateSession`). The session menu
offers **Move to isolated workspace** (after a confirmation) for a chat at rest
in a local project whose isolation level is not `off`. Agents reach the same
operation through the Polyth control tool's `session.isolate`
([orchestration](../agents/orchestration.md#choosing-the-workers-workspace)). Under the session lock,
the Git owner allocates one managed checkout per ready member repository. Each
checkout branches from the HEAD of the checkout the chat works in now, and
that checkout is its recorded origin, so merge-back returns there. The flow
uses the delegated-origin rule: a shared child of an isolated parent nests
into the parent's managed checkout. A parent that executes in the origin
becomes `sourceSessionId`, so it lists and merges the child like delegated
work and cannot merge before it.

The canonical runtime rebind then releases the old execution and starts a
fresh epoch in the managed checkout. History and parent links stay intact.
Uncommitted work is not carried over, because it may belong to other chats
sharing that checkout. The result reports `originUncommitted`, and the
timeline's `isolation/started` notice ("Isolated from {branch}") names it.

Failures:
- A running, archived or already isolated chat is refused, and so are a
  people-only conversation (it has no agent workspace; the session menu does
  not offer the move) and a missing member repository.
- A refused rebind removes the new checkouts.
- After the workspace is published but before the epoch is confirmed, the
  checkouts are kept. A retry finishes the same isolation instead of
  allocating again.
- The route reads and rebinds through the requester's Space-scoped session
  service (`manage` access).
- A remote (SSH) project is refused as `unsupported` by the server, for this
  move and for new isolated chats alike: managed checkouts are made by this
  server's Git, and the project's path lives on its host.

Every `/api/isolation/:sessionId[/action]` route first resolves the session
through the requester's Space-scoped session service, so a chat of another
Space is `not-found`. Reads need `view` access, **Resolve with AI** needs
`collaborate`, and every other lifecycle action needs `manage`.

Before the checkout is deleted, cleanup preserves the session-lifetime chat
media its canonical history references. A chat image is a project-relative path
(a `ui` block image field, a Markdown image, or an attachment `path`) rendered
through `/api/files/raw`, which resolves against the session's *current*
execution root. While isolated that root is the worktree; after merge/discard
the session is rebound to the destination checkout and untracked worktree files
(agent scratch media, a non-`_inbox` upload) would be gone, so the image would
404. `packages/files`'s `files.session-media` service copies exactly those
referenced files from the released checkout into the destination checkout —
never overwriting an existing destination file, never leaving either root, and
never blocking cleanup on a missing or oversized file. `_inbox/*` staged
uploads already survive because their read/staging path is project-root pinned.

Releasing an isolation record (merge, discard, abandon, repository discard or
session deletion) leaves nothing Polyth-owned behind. Process closure covers
terminals and the project-scoped utility runtimes (titles, commit messages,
recaps) acquired in the checkout through `RuntimePool.retireWorkspace`;
canonical session leases follow their session lifecycle. Removing the last
managed checkout or integration workspace also removes the empty
`<repo>-polyth-isolate` / `-polyth-integrate` folder. That folder sits next to
the repository's Git worktree. A project registered at a subdirectory of a
repository (`/repo/packages/app`) still places its checkouts next to `/repo`,
never inside the user's working tree; checkouts created before this rule, next
to the subdirectory, stay recognised and removable. Such a session still runs
at the checkout root, not at the matching subdirectory. When that parent is not writable (for example
`/data/swarm` under a root-owned `/data`) it is created instead under
`${POLYTH_MANAGED_WORKTREES_DIR:-${XDG_DATA_HOME:-~/.local/share}/polyth/worktrees}`
as `<repo>-<path-hash>-polyth-isolate`. Ownership checks accept only those two
locations, so changing that directory while a checkout exists makes its
cleanup fail closed. After the record is
released, `refs/polyth/isolation/<session>` is deleted. AI repair backups
(`refs/polyth/isolation-repair/<session>`) hold the user's target-checkout work
and are never deleted automatically, neither on release nor at startup.
Startup recovery drops leftover receipts only for locally known sessions
without isolation whose commit is reachable from a branch. It also drops a
"planned" creation receipt (`<git-common-dir>/polyth/creation-receipts`) older
than an hour whose checkout and branch never appeared, and reclaims one whose
create died right after `git worktree add`: the checkout sits at the receipt's
exact path with no marker, on the planned branch and start commit, and holds
nothing new. The planned receipt is published exclusively (`link`), so it is
the create's claim on its path: a second create for the same session, in this
process or another, is refused as `conflict` rather than racing the first. An archived session is
read-only, so recovery cannot run for it. Startup releases its isolation record
only when nothing the record names can still hold work: the checkout directory
is gone, and the isolate branch is gone or already contained in the target
branch (a hand merge that kept the branch; the branch itself is left in place).
When a discard or deletion finds the checkout already gone (`rm -rf` or
`git worktree remove` by hand), it prunes Git's stale entry and deletes the
isolate branch only if its tip is still the base commit or is contained in the
target branch; a branch with commits of its own stays.
A checkout deleted with `rm -rf` instead of `git worktree remove` leaves Git's
stale worktree entry listed until a prune; the missing directory is the
evidence, so that entry does not hold the record. The same release
applies to an `epoch-pending` session, at startup and on
`POST /api/isolation/:id/recover`. That case typically follows a hand merge
(`git worktree remove` plus `git branch -d`) followed by archive and restore.
This metadata-only `patchIsolation(null)` is admitted only for an archived or
epoch-pending session with no attached runtime, turn or admission. When the
session still executes in the deleted checkout, core also moves the execution
row, `worktreePath` and branch to the isolation's target checkout, which must be
registered. A restore or the next runtime epoch then starts there instead of in
the missing path. An in-flight publication or corrupt record is kept. A live
checkout or a branch with unmerged commits is kept too: restore the session to
merge or discard it.

Runtime epoch recovery checks that a session executing in its managed isolated
worktree still has that directory before it records a `session-reset` intent. A
missing worktree is refused as `not-found`. Only local projects are checked: a
remote project's path lives on its host.
Starting a fresh native session there would never confirm, and the resulting
unknown reset would fence every later recovery of the session.

A new isolated checkout inherits the ignored local environment of the checkout
it branched from through symlinks (`worktreeInheritance.ts`). Nothing is copied.
- **Dependencies.** Every ignored `node_modules` folder becomes a real directory
  of per-package links. Root and nested folders are included, and `@scope` and
  `.bin` are expanded. A relative workspace link is copied verbatim, so
  `@polyth/*` resolves to the isolate's own package sources. Other entries
  point at their real location, so nested isolates never stack links. npm
  bookkeeping such as `.package-lock.json` is skipped. Folders are matched as
  directories, so the usual `node_modules/` rule counts as ignored.
- **Never one directory link.** A single `node_modules` link would let
  `npm install` in the isolate rewrite the parent's tree.
- **Extra ignored files.** Files named in a tracked `.worktreeinclude`
  (gitignore syntax), such as the native supervisor binary, are linked one file
  at a time.
- **Safety.** Only paths the branch itself ignores are created, and existing
  paths are never replaced. Inherited links therefore never count as changes,
  are never snapshotted or merged, and are removed with the checkout. Removal
  never follows them.
- **Live view.** The links show the parent's installed tree as it is now. A
  branch that changes dependencies must install its own; that replaces only the
  links. An inherited file edited through its link changes the parent's copy.
- **Failures.** Inheritance runs after ownership is established. A failure is
  logged (`isolation inherit-failed`) and never fails the create.

When a merge publication finds overlapping staged, unstaged, or untracked work
in the target checkout, Git keeps that work and records a `target-overlap`
repair receipt. **Resolve with AI and proceed** snapshots the target work into a
Polyth-owned recovery ref, merges that snapshot into the isolated workspace,
and asks the agent to resolve it there; the original checkout is not edited by
the agent. Proceeding commits the resolved combination to the target branch,
then replaces the old checkout only after a ref CAS and a second fingerprint
check. A changed target aborts without overwriting it, and the recovery ref
remains available for manual restoration. This is intentionally different from
blindly running `reset`, `clean`, `checkout`, or dropping a stash.

In the session's isolation card, **Resolve with AI and proceed** is the one
resolve action for both kinds of conflict. Once pressed, the conflict card
hides while the agent's resolve turn runs. When that turn ends, the card retries
the merge on its own. If the merge conflicts again, the card comes back.

### Delegated isolation

Polyth delegation (`agent.spawn` with `isolation: "isolated"`) is the one
sanctioned nesting. The Git package's `createDelegatedSession`, reached through
`SERVER_SESSION_ISOLATION`, creates a canonical child of the delegating session
with a managed checkout of the delegator's execution repository, branched from
the HEAD of the checkout the delegator executes in. `sourceSessionId` and
`originPath` record that delegator and checkout, so merge-back returns there.
When that checkout is itself a managed isolation, it must belong to the
delegator or one of its ancestors, prove ownership and be `active`,
`merge-ready` or `conflict`; the child then targets that managed branch. The
public create path still rejects nesting, and `managed.create` accepts a
managed target only when asked to nest.

The same service also exposes the isolation card's read (`getStatus`) and its
Merge button (`mergeBack`, AI repair of overlapping target work included).
A live turn answers `reason: "working"` without reading the workspace. A
resting chat whose runtime is not yet proven settled (`epoch-pending`,
`unknown`, `reconciling`; `isolationRuntimeUnsettled`) still has its changes
read and answers `reason: "runtime-recovering"`: merge, keep and discard stay
disabled, but the card stays visible with Review instead of disappearing.
Callers authorize the session first: Judges' `merge-isolated` action calls them
only for an idle chat its owner manages and only when `actions.canMerge` is true.

**Choosing another target.** While the work rests in `active`, `merge-ready` or
`conflict` with changes and no pending delegated work, `getStatus` lists
`targets`: every ordinary local branch checked out in a checkout of the same
repository (managed `polyth/*` branches and the isolated checkout itself
excluded), each with its `path`, whether it is the recorded `origin` checkout
and whether it is the `current` target. `actions.canChooseTarget` is true when
one of them is not the current target. `POST /api/isolation/:sessionId/merge`
with `{ target: { branch, path } }` retargets under the session lock, then runs
the ordinary merge-back. The branch must be checked out at exactly that path
and must not be managed. It is refused for a nested (delegated) isolation and
while an AI target repair is recorded. The work must still have changes
against that branch. Retargeting rewrites the checkout's ownership marker
first (keeping the old target as `retargetedFrom`, which ownership also
accepts), then persists `targetBranch`/`originPath` as `active`, dropping an
old conflict or Keep-isolated dismissal. A later conflict is recorded against
the new branch. A branch that is not checked out anywhere cannot be chosen:
publication syncs a checkout and the session returns to it.

`POST /api/isolation/:sessionId/retarget` with `{ branch, path }`
(`IsolationRetargetInput`) makes the same choice without integrating, under
the same rules (the session at rest in `active`, `merge-ready` or `conflict`,
so no publication intent exists yet; choosing the current target is a no-op).
Every effective retarget, standalone or inside a merge, appends an
`isolation/retargeted` event (`{ fromBranch, targetBranch }`): the change of
destination is part of the chat's history, never a silent substitution. The
timeline does not render it yet.

`POST /api/isolation/:sessionId/merge` also takes `push: true`
(`IsolationMergeInput.push`). Once the work is published, the target branch is
pushed from its checkout to its upstream remote, else `origin`, with the
asking person's credentials (`actingGit` transport), and only while that
checkout is still on the branch. A refused push never undoes the merge: the
result carries `pushed: { ok: false, remote, branch, message }` and the person
pushes again from Source control. A delegated isolation (its target is the
parent's managed branch) refuses `push` before anything is written.

Source control's Changes tab ends with the **landing** for a single-repository
isolation (`LandingBar.tsx`): "Integrate into [branch ▾]", one check line
(conflict preview, whether the target has local changes, commits ahead,
uncommitted files that integrating commits) and one primary,
**Integrate into {branch} and push** or **Integrate into {branch}**. The chip opens
the destination list (a sheet on phones): every target with its checkout and
the *Push after integrating* switch (`pushAfterIntegrate` in the project's git
prefs, on by default). Picking a branch calls `retarget`; integrating calls
`merge`, with `target` only for a switched origin checkout, and reports the
push outcome as a notification because the landing leaves with the isolation.
With no default target the primary is **Choose a branch**; a recorded
conflict makes it **Review conflicts**.

The isolation card keeps its two-plus-one shape (Review / Commit and push over
one full-width primary). Other targets are an alternative, so they sit one
level down in its overflow: **… → Integrate into another branch ›** lists each
branch with the checkout it is open in, and picking one integrates there. When
the recorded origin checkout has since switched branches (the
destination-unavailable case), that is a way forward, not a warning: the card
stays the calm "Changes ready" card, notes "{path} is on {current} now, not
{branch}" and its primary becomes **Integrate into {current}**. Only when no
default target is left (the origin checkout is gone or on no ordinary branch)
does the card warn "Can't return to {branch} yet", and **Integrate into another
branch ▾** becomes its primary action.

A merge that conflicts records `state: "conflict"` with
`conflict: { message, files, at }`, where `at` (ms) is when the attempt found
it, and appends an `isolation/conflict` notice. The conflict stays open until a
turn completes after it: `getStatus`, boot recovery and a late turn-completed
hook all compare the newest completed `turn/stopped` with `at`. A record
without `at` (written before the field existed) is ordered by its notice's
`seq`. The turn that ended before the merge attempt therefore never reads as
the agent having resolved the conflict, so the card does not flicker between
"Integration needs attention" and nothing. Once a later turn has completed,
`canMerge` is offered again (merge-back accepts the `conflict` state). The card
shows a conflict the projection records at once, never an earlier "Changes
ready" answer; its actions still wait for the server's status read.

The merge runs in a throwaway integration checkout, so the session's working
tree never shows conflict markers. `GET /api/isolation/:sessionId/conflicts`
(`conflictPreview`) recomputes the conflicts against the live target branch. It
snapshots the workspace into an unreferenced commit exactly as Merge does, then
`git.mergeConflicts` runs `read-tree -m` in a private index and `git merge-file`
per path. It never writes the index, a ref or either checkout. The answer lists
each conflicting path with its kind and, for text, each overlapping region (the
target's lines, the session's lines, up to three unchanged lines around them),
capped per file, region and side. The preview does not follow renames, so a
path that one side deleted or renamed is listed only when the last merge
attempt reported it as well. The route first reads the chat through the
requester's own Space-scoped session service.

A live isolation whose `originPath` is a checkout is a dependent of that
checkout. Its merge, discard and session deletion refuse while one remains
(`reason: "delegated-pending"`, mutation rejected), cleanup keeps it, and its
status lists the children as `delegated` with merge and discard disabled. While
the delegator rests, its isolation card says why it cannot integrate and links
each child; a nested child's card names the "parent workspace" instead of the
managed branch. A nested child publishes only while its target isolation is
still open.
`mergeDelegated` releases a child without unique changes and refuses
overlapping uncommitted destination work (`reason: "target-overlap"`) instead
of recording an AI repair receipt. A merged child is rebound to the
delegator's checkout and later relocates with it like any finished descendant.

The session manifest and resolved roots are persisted in `user/message` before
native delivery. `CanonicalTurnRequest.workspace` carries that same authorized
scope. The Codex adapter maps ready roots to the supported per-turn workspace
write sandbox; missing roots grant no access and a reduced membership replaces
the previous root list. It leaves network access disabled. This adapter path
has protocol-test coverage, not live provider proof. Claude passes ready roots
as additional directories before admitting each turn and updates its streaming
query settings when membership changes. Its installed SDK documents replacement
of the supplied permissions object; protocol-fake tests do not prove native
permission revocation. Other adapters must supply
their own native permission mapping; the manifest alone does not establish
native multi-root access for every harness.

## Resource identity and links

`ResourceRef` carries scheme, Project, optional session, optional repository and
repository-relative locator. Selection ranges are open options, not document
identity. Equal paths in different repositories have separate tab/document keys,
buffers, revisions, undo histories and close lifecycles. Omitted and explicit
synthetic `primary` IDs retain their legacy identity equivalence.

The shared `ResourceLink` supports compact, qualified, line and range labels.
Prose references resolve on interaction within their authorized workspace; an
ambiguous path offers a repository chooser. Missing files become unavailable
text, and a deleted file may show its available Git diff. Async navigation is
fenced against newer opens and Project/session changes. Packages use canonical
refs through the supported host component seam instead of treating a bare path
as globally unique.

File and selected-line drag payloads retain repository identity. Editor drops
open the referenced location; composer drops attach the scoped file/range;
terminal drops insert a quoted path without executing it. Attachments preserve
repository IDs through canonical validation and native projection. Deduplication
includes repository and range. Multi-repository file pills include their alias.
Directory drops attach scoped references without recursively expanding contents.
Working-change drops attach bounded diffs; snapshot and hunk digests reject stale
drags. Inline AI resolves the selected repository and
checkout through the authorized session, and rejects stale/foreign/missing
scope before requesting a completion.

## Files, panes and editor

PaneHost owns tabs and dirty close guards. A single click or Quick Open Enter
opens a replaceable preview; double click, Ctrl/Cmd+Enter or editing pins it.
Each pane has at most one clean preview. Preview replacement releases the old
document through its provider, and dirty tabs never disappear during replacement.
The phone Open Files sheet uses the same tabs and close guards. CodeMirror state
remains owned by the editor package.

`workspacePresentationKey` includes connection, account, Space, Project and
session; tree state additionally includes repository. Expansion, selection,
scroll, hidden/ignored filters, sort order and auto-reveal are presentation
preferences, not canonical history. Files written in the active session are marked
created/modified/deleted (derived from the shared edit-tool rule
`@polyth/contracts/tool-edits`, refined by git status, never from a filesystem
watcher), with ancestor folder counts, a recency fade for the latest turn and a
persisted "Changed by chats only" filter. These session and repository
navigation records stay on the device; project presentation sync carries only
deliberate layout customization.

**File manager actions** (`EditorView.tsx`, `editor/treeSort.ts`,
`editor/uploads.ts`, `editor/searchMatch.ts`, `editor/FlatFileList.tsx`,
`src/archive.ts`). The options menu creates files/folders, uploads, downloads
the repository as a zip, switches the view between Tree and List, and orders
entries by name, last modified or size (in the tree folders stay first); the
modified and size orders show that value on each row. Local
`GET /api/files/tree` entries carry `mtime` (epoch ms) for this; SSH-remote tree
listings carry neither size nor `mtime`, so those orders fall back to name in
the remote tree. The List view reads every file once through
`GET /api/files/list` (`FileService.list`: files only, at most 10,000 entries
or 3 s locally, `truncated` when cut; the same heavy folders search skips,
`.git` and symlinks stay out; local entries carry Git-ignore marks, SSH uses
one bounded `find` with size and `mtime`) and shows name over folder in the
chosen order. The tree search follows typing (160 ms debounce, stale responses
dropped), lists name over folder with matched characters marked, and Enter
opens the first result (Ctrl/Cmd+Enter pins it).

Desktop files can be dropped anywhere on Files. Over the tree they go into the
folder under the pointer (else the repository root), and a closed folder held
under the drag for 650 ms opens, so a deep folder is reachable without letting
go; over the editor they go into the open file's folder (else the root) and an
overlay names that folder before the drop; over the List view, into the row's
folder. The editor never receives dropped files as text (Files handles them in
the capture phase). "Upload files…" picks into the same folders. Uploads go
through `POST /api/files/upload`: every name is checked with an optional stat
first, existing files are replaced only after one confirmation, folders with the
same name and files over 18 MiB (the base64 JSON body must stay under the
25 MiB limit) are refused per file. A tree row dragged onto another folder of
the same checkout moves there after one confirmation (`POST /api/files/rename`;
not into itself or its own subtree, not with unsaved edits; an open file's tab
follows it, tabs of files inside a moved folder do not).

Download uses `GET /api/files/raw?…&download=1`, which forces
`Content-Disposition: attachment`; the raw route's 20 MiB cap applies. Folders
download as a streamed zip from `GET /api/files/archive` (owned writer on
`node:zlib`, deflate except for already-compressed formats, UTF-8 names, no
ZIP64): it follows the tree's Show hidden / Hide ignored choices and the List
exclusions, refuses more than 10,000 files, more than 512 MiB in total or one
file over the raw cap. The browser first asks with `check=1` and shows a refusal
instead of starting a broken download; a failure after streaming began cuts the
connection rather than finishing a corrupt archive.

File panes also offer Copy contents (the live buffer, unsaved edits included),
show binary images with Fit/100% zoom, natural size and a transparency
checkerboard, render SVG through that viewer as an `<img>` data URL (so its
scripts and network loads never run), and preview CSV/TSV as a table
(`editor/csv.ts`: RFC 4180 quoting, separator guessed from the first line,
first 5,000 rows, 1,000 rendered; sticky header and row numbers, numeric
columns right-aligned, click a header to sort, row filter). CSV and SVG join
Markdown/HTML/JSON in the per-kind Edit/Preview memory. Go to symbol
(Ctrl/Cmd+Shift+O, the file menu or the toolbar) lists a lexical outline from
the live buffer (`editor/outline.ts`: Markdown headings, TS/JS, Python, Go,
Rust, CSS/SCSS selectors, YAML keys, shell, SQL and common C-like
declarations; no language server, so it is approximate) with a filter; picking
reveals the line, or scrolls rendered Markdown to the heading.

**Chat changes and colours.** Several chats can write into one checkout (a
parent and its `shared` children, or ordinary chats on the project root).
`GET /api/files/session-edits?projectId&sessionId[&repositoryId][&cursors=id:seq,…]`
(`packages/files/src/sessionEdits.ts`, remote capability `core.sessions.read`)
reports the viewing chat plus up to eight recently active chats (seven days, or
still tracked by a cursor) whose checkout resolves to the same root, through
the gateway-validated Space; isolated, archived, foreign and unreadable chats
are never included. It folds each chat's indexed tool events
(`eventsOfTypes`) into completed edit calls with the same rule as the web
reducer, is incremental per cursor (a started call newer than 15 minutes holds
the cursor), reads at most the last 50,000 events cold and 3,000 tool events per
request (`more` asks for another round), and drops payload strings over
64 KiB. Files merges that history with the live render model
(`widgets/editor/sessionEditsClient.ts`, `checkoutEdits.ts`) into one model per
repository and publishes it (`sessionEditsStore.ts`) to the tree, the tab
markers (`PaneProvider.marker`) and every file pane. Each chat has a colour
slot: the chat on screen is slot 0 (the review green), other chats follow by
creation order (`--session-tone-N` on `.editor-view`, derived from the theme's
signal tokens). The tree shows other chats' files only while Git still has them
uncommitted, with a dot per chat and a legend once a second chat is involved.

**Change highlighting in the editor.** For the open file, Files fetches the
working-tree diff against the index (`GET /api/git/diff`, the hunks
`/api/git/hunk/discard` acts on) and attributes every added line to a chat
(`changeAttribution.ts`): each edit's fragment (its new text plus the lines it
actually wrote; repeated context is not claimed) is found in the current text,
oldest first, so the newest writer of a line wins; an edit a later edit partly
rewrote is realigned on its surviving distinctive lines. A removal belongs to
the chat whose lines replaced it, else to the newest edit that removed that
text. With one editing chat every change is its own; otherwise unexplained lines
stay unattributed (gutter only, no tint). A diff that no longer matches the
loaded text is ignored until the next reload. The editor draws the result
(`EditorSurfaceProps.changes`, `packages/editor/widgets/changeMarks.ts`):
tinted lines, the removed text in place as a red block, a gutter bar per change
(click opens the hunk inspector), and inline Undo/Keep. Undo discards the hunk
with the exact-snapshot hunk API (refused while the buffer has unsaved edits);
Keep only hides that hunk on this device until Git shows a different one there.
A floating review bar steps through changes and through the chat's edited files.

**Editing.** CodeMirror draws its caret as a border, so the editor keeps the
caret, drop cursor and the border-only states (matching bracket, search match,
fold placeholder) visible under the borderless appearance
(`packages/editor/widgets/styles.css`). Editable buffers close brackets, indent
on input, support rectangular selection and complete from the language
(JS/TS scope and keywords) plus words of the document; read-only buffers never
open completions.

**Code intelligence** (optional `code-intelligence` package, off by default).
Packages feed the editor through the data-only `editor.intelligence` slot: a
contribution's `meta.provider` names its languages and answers completions,
hover and diagnostics (`packages/editor/widgets/intelligence.ts`); the editor
alone turns them into CodeMirror sources, a hover tooltip (plain text only)
and a debounced linter with a gutter, and a provider that serves a buffer's
language owns its completion list. The package's TypeScript/JavaScript
provider asks the editor's scoped language workspace
(`/api/editor/language` with `completion`, `hover`, `diagnostics`), which
analyses the live buffer as an overlay. That workspace never loads
`node_modules` declarations, so diagnostics are honest rather than complete:
syntax errors always, semantic errors only when they cannot be artifacts of
missing declarations (`DECLARATION_ARTIFACT_CODES`; a misspelt global is
therefore not flagged). Completions ask only after a word character or a
member dot, or on Ctrl+Space.

**Following a chat's edits** (`WorkbenchFilesHints.openSessionEdits`, on in
every profile unless one sets it to `false`; Chat, Canvas and IDE mode all
follow): every existing file the active chat edited is an open tab in that
chat's own pane (at most 40 newest; a tab the person closes stays closed until
the chat edits that file again), new edits open as they land, the newest edit of
the running turn comes to the front unless focus is in Files or the active tab
is dirty or not one of the chat's files, and a clean editor reloads when the
file changed on disk. IDE mode adds only the layout: a mirrored focused split
(ui.md "Mirrored shell").
Hidden trees do not fetch or reveal
files, and stale tree responses cannot publish into a different scope. Files and Source Control
toolbars use `WorkspaceSurfaceHeader`; Terminal keeps repository selection in
its tab strip. ModuleView continues to own the window title and close controls.
Features own their content and scoped CSS.

Source Control display preferences (`packages/git/widgets/gitPrefs.ts`) are
account-wide defaults edited under Settings → Source Control → Display and
synced through `package.git.preferences`: changes as folder tree or list,
line counts as numbers/bar/hidden, compact or comfortable density, default
diff layout, wrap, ignore whitespace, commit graph and relative or calendar
dates. The page's view menu edits the same defaults. Diff toolbars (layout,
wrap, ignore whitespace) store a per-workspace override of only the keys they
changed; everything else is inherited, so a later account change still reaches
that workspace.
Page styling lives in `source-control.css`; `styles.css` keeps the widgets
and surfaces shared outside the page.

Source Control profiles (commit author + authentication) are Space-wide server
state, not device state: `GET/PUT /api/git/source-control-profiles` (revisioned,
409 on a stale write) in `source-control-profiles.json` under the Space storage
(`packages/git/src/sourceControlProfilesStore.ts`). The client keeps a cached
copy for first paint, refetches on focus/visibility and migrates an older
localStorage-only state once when the server is still at revision 0. A profile
with authentication mode `ssh-key` names a private key inside the server user's
`~/.ssh` (`GET /api/git/ssh-keys` lists keys that have a `.pub`; `POST
/api/git/ssh-keys/test` runs `ssh -T` and reports the account). Selecting a
profile for a project writes repository Git config — `user.name`, `user.email`
and `core.sshCommand "ssh -i <key> -o IdentitiesOnly=yes"` — so the UI,
terminals, agents and plain Git CLI all push as that account; switching to a
profile without a key removes only a Polyth-format `core.sshCommand`. Key paths
are validated (realpath inside `~/.ssh`, not `.pub`, shell-safe characters) on
write and apply; a key deleted later never makes the stored state unreadable.

Source Control offers Working tree and Branch vs base review. Isolated sessions
default to Branch vs base; a deliberate scope choice is remembered per project.
Review changes opens Branch scope. While the session's isolation is in
conflict, a third Conflicts scope shows the conflict preview: the file list,
then per region a "Line N" header, context, the target branch's lines and this
session's lines. The card's Review conflicts (and each listed file) opens it at
that file. Conflicts is never remembered as the preferred scope and falls back
once the conflict is resolved. Branch review compares the merge base with
the current checkout, including committed, uncommitted and untracked changes;
it never stages or discards hunks. An explicit chosen base takes precedence
without changing the workspace or its isolation record; otherwise an isolation
target branch (or its recorded base commit), then origin's default, main or
master is used. File patches load on selection. Local notes are scoped by
project, repository, workspace, resolved base and branch (or detached HEAD);
changed hunks are marked outdated and excluded from insertion. Insert review
notes adds a bounded excerpt and
notes to the active chat draft without sending a message. Binary and truncated
previews, missing workspaces and unavailable bases remain explicit.
`GET /api/git/branch-diff` accepts `projectId`, optional `sessionId`,
`repositoryId`, `base`, `path` and `ignoreWhitespace=true`. It resolves projects
and sessions through the gateway-validated Space. An unavailable, foreign or
wrong-project supplied session always returns the same not-found error and
never falls back to the project checkout. Without `path` it returns base,
merge-base, HEAD, commits ahead and file status/statistics; with `path` it returns
only that changed file's bounded patch and snapshot digest.

Editor navigation uses the TypeScript language service for local JavaScript and
TypeScript definitions, references and rename previews. It bounds inventory and
input, applies supported in-repository tsconfig path aliases, and overlays the
current unsaved document per request. Rename checks revisions before applying
edits and blocks dirty targets. This is not an external language-server protocol
implementation or support for every language. Folding, bracket/occurrence
highlighting and Git gutter interactions remain editor-owned; a host that passes
`changes` (Files does) replaces the bare Git gutter with owner-supplied change
marks, which the editor only draws over the exact text they describe and maps
through later typing.

## Search and keyboard behavior

Files owns the persistent `workspace-search` surface. Ctrl/Cmd+Shift+F opens it
through capability routing. It supports all repositories or a local selection,
literal queries and include/exclude path globs. Results carry repository, path,
line, column and a bounded preview; per-repository failures remain visible.

Local search respects Git ignore rules, skips symlinks and binary files, and
bounds traversal, file size, duration and result count. `{ hits, truncated }`
distinguishes a bounded response from an exhaustive search. There is no remote
SSH content search or persistent index. Filename Quick Open searches the resolved
repositories and preserves equal paths, showing aliases when needed. Long paths
are shortened by whole segments while retaining the filename.

Ctrl/Cmd+F uses the focused Files or Terminal find handler, with find in the
conversation as fallback (the browser's own find when no session is open).
Session search is Ctrl/Cmd+Shift+O. Terminal find state belongs only to its mounted pane, starts closed
and is not persisted. Ctrl/Cmd+P opens files. Ctrl/Cmd+K and its default alias
Ctrl/Cmd+Shift+P open the command palette; explicit user bindings take precedence.

## Git and terminals

Polyth runs the system tools it needs rather than shipping its own: Git, the
GitHub CLI (`gh`), the GitLab CLI (`glab`) and OpenSSH (`ssh`, `ssh-keygen`,
`ssh-add`). One shared resolver (`@polyth/kernel/executable`) picks each
executable per launch: an explicit binary, then the tool's override variable
(`POLYTH_GIT_BIN` for Git), then the name on `PATH`, then a well-known install
location (Git for Windows, GitHub CLI, glab, scoop and Chocolatey paths and the
newest GitHub Desktop bundle, and Windows OpenSSH, on Windows; the standard and
Homebrew paths on macOS and Linux), and only then the bare name. This keeps a
folder that has `.git` from being reported as *not a Git repository*, `gh` or
`glab` from looking missing, and an SSH remote from looking unusable, on a
machine where the tool is installed but absent from `PATH`. A harness child
launched by Polyth also receives the resolved Git and OpenSSH directories.

Untracked branch-review content and statistics require Linux kernel directory
handles. Each parent is pinned without following symlinks before Git reads a
leaf; concurrent directory swaps cannot redirect the read. Other hosts report
this untracked review operation as unsupported. Kernel handle paths stay out
of the returned patch.

Git requests carry repository identity. PR-stack definitions are repository
scoped. Working-file and commit-log diff controls share the selected
Project/session/repository presentation scope; changing their layout, wrapping
or whitespace preference leaves account defaults unchanged. Restack uses an explicit preview, temporary checkout, reference checks
and publication receipts; pushing a rewritten branch uses a previewed remote
head and force-with-lease. Branch editors add, reorder and remove definitions;
the server resolves omitted commit IDs and captures the merge base in the
selected repository. Reparenting retains the previous immutable cutoff until
restack. Preview captures each destination SHA and is revalidated before any
rewrite; an updated base is expected, while rewritten branch history or dirty work block
application. Push publishes the exact previewed local commit rather than a
mutable ref. Stack operations must preserve uncertain outcomes
rather than replay mutations. Hosting credentials and external PR actions remain
subject to their existing service permissions.

Terminal creation resolves a selected repository or a local composite Workspace
from authorized ready roots. When opened for a canonical session, it defaults
to that session's execution repository, including its worktree or isolated
checkout. Composite directories belong to Space-private storage and contain
repository links. The terminal owner tracks referenced roots so checkout
cleanup can close terminals that still refer to them. Remote projects do not
provide a local composite Workspace. Repository selection affects newly created
terminals and never changes an existing shell's cwd. Explicit user tab names
take precedence over generated repository/shell labels.

Dismissing the Terminal package window preserves its tabs, shell processes,
unfinished input and last valid grid. Hidden panes do not resize their PTYs;
closing a terminal tab explicitly terminates that terminal. Glyph measurements
use layout pixels, including before the first shell is created, matching the
viewport even during window scale animations,
and observe font changes independently of window size. Widening rejoins
soft-wrapped history while leaving the active cursor's logical line in place
for the shell's own redraw. Scrollback replay records the grid at the retained
beginning and subsequent resizes, rebuilding output at those grids before
restoring the visible size. The output byte ring and resize metadata are both
bounded. Optional ordered `frames` accompany the existing `replay.data` string
over the terminal WebSocket; older peers retain string replay. Restoration
does not send replies to historical terminal queries into the running shell.

Touch input selects with a long press through the terminal's own cell
selection: handles adjust either end and a selection bar offers Copy, Select
all and Paste, all without moving the software keyboard's focus (details in
[terminal.md](terminal.md#touch-selection)). A short tap opens the software
keyboard, or first dismisses a selection. The mobile Copy control copies
selected terminal text, or the complete buffer when nothing is selected. Mouse
input retains terminal cell selection and application mouse reporting.

Adoption preserves session and repository ownership and excludes foreign-session
terminals. Composite link cleanup uses a trusted in-memory ownership handle,
matching the directory identity and exact link targets; its writable manifest
grants no delete authority. The Linux server supplies each local terminal with
an owned systemd scope. Checkout cleanup verifies that scope has stopped,
including background descendants, before removing composite links. A
not-yet-created unit is not release proof while its launcher can still submit
it. On unsupported hosts or remote terminals without equivalent proof, checkout
destruction fails closed. Space-private execution records preserve the exact
unit, host boot identity and launcher evidence. Before checkout destruction,
the terminal owner recovers matching records and verifies release; unresolved
launch admission remains blocked. Terminal UI reconnection is separate from
this execution-release recovery.

## Verification

Use the resource-bounded local command procedure in
[verification](../agents/verification.md). Serialize process-heavy checks on
resource-constrained hosts. Unit and protocol tests, real temporary Git
repositories, integrated canonical-session tests, browser fixtures and live
provider/device execution establish different evidence. A web build or a fake
runtime test does not establish native process release or device behavior.

### Isolated integration commit messages

Git generates the integration commit message from the staged squash diff before
publishing the target ref. Source Control settings select the session's effective
model (default), the account's configured small model, or a custom harness/model
through the shared `@polyth/models/model-picker`. The selection persists within
the Space via `/api/git/commit-settings`, with revision checks on updates. It
applies to isolated integration; the ordinary Git message suggestion keeps its
small-model default. The message is best-effort: integration waits at most
`COMMIT_MESSAGE_WAIT_MS` (12 s) and, on a timeout or generator failure, commits
with the session title (or `Merge isolated session into <target>`) and logs
`isolation commit-message-fallback`. An unavailable model never blocks or fails
the merge. Empty integrations do not invoke the generator. AI target repair retains its
commit-message suffix.

A merge-back failure that provably left the target branch untouched (before the
publish intent is persisted, or with an intent whose receipt is absent) is tagged
`mutationOutcome: "rejected"`, `retryability: "safe"`, so the UI shows the real
reason instead of "The result is not confirmed". Explicit tags on the error win;
a publication that may have happened still returns the pending result.
