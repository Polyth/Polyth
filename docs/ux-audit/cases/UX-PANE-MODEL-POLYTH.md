# UX-PANE-MODEL — Polyth files/Git versus chat audit

- Case: `UX-PANE-MODEL`
- Model / role: `SOL` / Polyth auditor
- Status: `specified`
- Audited: `2026-08-20`
- Polyth source: `0ccb213e22b30759ca2643138eca4d164d3d91bd`
- Comparison: `UX-PANE-MODEL-polyth.md` at `0ccb213`

## Decision and classification

Polyth does not yet satisfy the polyth-derived pane contract. The primary
defect is **architectural, P0**: Polyth has two independent surface models.
`activeView` selects exactly one main workspace surface, while `railPlugin`
selects an optional right panel. Files exists in both models, Git is split
between a reduced Changes panel and a full Git view, and Terminal/Preview exist
only as full-view jumps. The same task therefore either preserves or removes
chat according to which icon the user happened to choose.

The second defect is **responsive geometry, P0**. Panel admission is controlled
by fixed viewport media queries, not the remaining chat width. A remembered
`640px` panel leaves only `244px` for chat at `1200px` and `145px` at `1101px`.
At `1000px` and `900px`, the fixed panel visibly covers the composer and wins
the Send center hit test. At `820px` and below, CSS hides the selected panel
while its Files button remains pressed.

## Runtime procedure

The web bundle was built from the audited revision and served from an isolated
runtime on port `4461`, using a copied multi-turn fixture session. Google Chrome
stable was driven through `playwright-core`; this subagent did not expose a
`computerUse` executor. The audit exercised Chat, Files, Git, panel persistence,
fast draft switching, viewport widths `1440`, `1200`, `1101`, `1000`, `900`,
`820`, and `768`, and center-point hit testing.

No model turn was submitted. The canonical session URL stayed unchanged and the
event log remained exactly `29` events ending at sequence `29` after all
presentation-only journeys.

## Comparison with polyth

| Journey | polyth reference | Polyth observation | Result |
|---|---|---|---|
| Files at `1440×900` | One docked editor beside mounted chat | The rail Files panel docks beside chat, but the header Files icon replaces chat with a different editor | **P0 inconsistent** |
| Git at `1440×900` | Full Git surface docks beside chat | Changes docks; full Git replaces chat and composer | **P0 fail** |
| Terminal / Preview | Dock beside chat on wide desktop | Rail icons are full-view `activeView` jumps | **P0 fail** |
| Default Files rail at `1440×900` | Chat remains operable | Chat `780px`; timeline/composer remain `6/1`; Send hits Send | Pass |
| Remembered `640px` rail at `1200×900` | Dock admission preserves usable chat | Chat `244px`; composer controls collide | **P0 fail** |
| Remembered `640px` rail at `1101×900` | Reject dock before collision | Chat `145px`; Send center hits `.rail-body` | **P0 fail** |
| Files rail at `1000×900` / `900×900` | Overlay/replacement must protect controls | Fixed `320px` panel covers composer; Send center hits `.rail-body` | **P0 fail** |
| Files rail at `820px` / `768px` | Explicit replacement with Back/Chat | Panel is `display:none`, Files stays `aria-pressed=true`, icon strip still consumes `44px` | **P0 fail** |

## Root cause

### 1. Main-surface selection unmounts chat

`WorkspaceHost` resolves one `activeView` and renders only that registered
component. `builtinSurfaces.tsx` registers Session, Files, Git, Terminal, and
Preview as peers. Selecting any non-Session workspace surface removes
`SessionSurface`, including Timeline and Composer, from the tree.

Live evidence at `1440×900`:

- Chat + Files rail: `timelineCount=6`, `composerCount=1`.
- Header Git: `timelineCount=0`, `composerCount=0`; the Files rail remains open.
- Header Files: `timelineCount=0`, `composerCount=0`; the separate Files rail
  also remains open.

This is not a necessary small-screen fallback. It is the default wide-screen
behavior of the header and of the Terminal/Preview rail jumps.

### 2. The right rail and workspace registry model different concepts

`railSurfaces.tsx` registers `FilesPanel` and `ChangesPanel`. The main workspace
registry separately registers `EditorView` and `GitView`. `ContextRail.JUMPS`
then changes `activeView` for Preview and Terminal instead of opening a panel.
There is no single canonical “workspace surface” with docked, overlay, and
expanded presentation modes.

Consequences:

- Files has two component implementations with different state and behavior.
- “Changes” preserves chat, while “Git” removes it.
- The active main view and active rail can both say Files simultaneously.
- Pane state cannot move coherently between docked and full-width modes.

### 3. Width clamping ignores available chat geometry

`railPrefs.ts` clamps only the panel itself (`240–640px`). It has one `344px`
default and global `polyth.railPrefs` storage, with no project key. CSS gives
the panel that exact minimum width. Nothing subtracts sidebar, strip, safe
insets, or required chat controls and rejects docking when the result is under
`320px`.

The `max-width: 1000px` rule changes the panel to `position: fixed`; it does not
make it modal, add a backdrop, trap focus, or protect hit targets. The
`max-width: 820px` rule simply hides `.rail`.

### 4. Replacement can lose a fresh draft

Composer saves text after a `250ms` timeout. Unmount cleanup cancels that timer
without flushing. Filling the composer and immediately selecting Git produced
no draft storage entry and Chat restored an empty composer. Thus the
wide-screen surface model can lose recent user input, not merely hide it.

## Findings

### PANE-POLYTH-01 — Files/Git have contradictory chat continuity

Severity: **P0**

The right Files and Changes panels preserve chat; header Files and Git replace
it. Git, Terminal, and Preview have no full-featured docked equivalent. A wide
desktop user cannot predict whether opening workspace context retains the
request, answer, composer, and draft.

### PANE-POLYTH-02 — Docking and overlay can cover primary controls

Severity: **P0**

There is no geometry admission guard. Large persisted widths squeeze chat below
the required minimum, and the `1000px` fixed-overlay rule paints over Send.
Hidden overflow masks the collision instead of selecting a safe presentation.

### PANE-POLYTH-03 — The narrow rail advertises hidden content

Severity: **P0**

At `820px` and below, the Files panel has zero geometry while its strip button
remains active and operable. This is neither a usable overlay nor an explicit
replacement. The header's separate Files view remains reachable, reinforcing
the duplicate and contradictory navigation model.

### PANE-POLYTH-04 — Pane controls and persistence are incomplete

Severity: **P1**

Widths and last-open state are global rather than project-scoped. Every surface
shares one default. There is no expand/collapse state, no keyboard resize path,
no wide-panel Escape close/focus return contract, and no persisted rail file or
Git selection across reload.

## Required repair contract

1. Keep Session/Chat mounted independently from workspace-pane selection on
   wide desktop.
2. Give Files, Git, Terminal, and Preview one canonical surface each. Present
   the same surface docked, overlay/replacement, or explicitly expanded; do not
   maintain reduced and full implementations with unrelated state.
3. Admit docking only when measured post-layout chat width is at least `320px`
   and every composer control remains fully visible and hit-testable.
4. Below that invariant, use an accessible modal overlay or full replacement
   with an obvious Back/Chat action. Never leave a pressed control targeting a
   hidden panel.
5. Flush the current draft synchronously before any surface transition. Preserve
   the exact timeline anchor, draft, pending cards, and focus on return.
6. Scope width, selected surface, expansion, tabs, file/diff selection, terminal
   state, and Preview URL by project. Supply per-surface defaults.
7. Make resizing keyboard-accessible and restore focus to the invoking control
   on close. Terminal Escape continues to belong to the PTY.
8. Keep pane-only operations out of the session log; this already passed.

## Evidence

- `/opt/cursor/artifacts/polyth_pane_chat_files_sol.png`
- `/opt/cursor/artifacts/polyth_pane_git_replaces_chat_sol.png`
- `/opt/cursor/artifacts/polyth_pane_files_replaces_chat_sol.png`
- `/opt/cursor/artifacts/polyth_pane_1200_files_sol.png`
- `/opt/cursor/artifacts/polyth_pane_1000_files_sol.png`
- `/opt/cursor/artifacts/polyth_pane_820_files_sol.png`
- `/opt/cursor/artifacts/polyth_pane_audit_sol.json`

Next stage: `SOL-PANE-UX-SPECIFIER`.
