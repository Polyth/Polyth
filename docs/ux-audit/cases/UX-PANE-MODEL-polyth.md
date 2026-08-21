# UX-PANE-MODEL — polyth workspace-pane audit

- Case: `UX-PANE-MODEL`
- Model / role: `SOL` / polyth auditor
- Status: `specified`
- Audited: `2026-08-20`
- Runtime baseline: `docs/ux-audit/RUNTIME-BASELINE.md`
- polyth: `1.19.0`, source `7a2e0ee138fe8a13f4dd65090fcf915a2692356f`

## Decision

Polyth should copy polyth's **wide-screen pane model**, not a blanket
“Files/Git replace chat” model. On a sufficiently wide desktop, Files, Git,
Terminal, and Browser/Preview belong in a resizable right workspace pane while
the selected chat, timeline, composer, and session context remain mounted and
visible. Replacement is the fallback when docking would make chat inoperable,
and full-width workspace is an explicit expand action.

polyth demonstrates the value of this model at `1440×900`: the user can
inspect a file, verify Git, run a terminal, or view the live application without
losing the agent's explanation. It also demonstrates the necessary limit. At
`1024×900`, the default Files pane covers the center of Send; at `900×900`, both
Files and Git cover it. “Chat remains” is not a pass when the pane is painted
over its controls.

## Runtime procedure

Google Chrome stable exercised the live isolated polyth runtime from the
baseline, with the existing `Runtime Baseline` session and its completed turn
loaded. The run used pointer and keyboard activation, direct reload, viewport
changes, panel expansion, Escape, a real file, Git, a live terminal, and the
embedded Browser opening Polyth on `localhost:4401`.

No model turn was submitted. Runtime health stayed ready, all pane switches
completed, the selected session URL stayed constant, and the run recorded no
console or page errors.

## Observed model

### Wide desktop

The desktop tree keeps `ChatView` mounted as the primary surface and adds a
right `ContextPanel` before a persistent icon rail. Rail activation opens or
switches the pane; activating the current rail item again closes it.

| Surface | 1440 default width | Chat continuity | Surface continuity |
|---|---:|---|---|
| Files | `670px` (`60%` of available content) | Completed answer and composer remain visible; Send is hit-testable. | File tree and `package.json` editor remain selected after Git and back. |
| Git | `446px` (`40%`) | Completed answer and composer remain visible; Send is hit-testable. | Branch `main`, sync action, clean state, and stashes action stay in one panel. |
| Terminal | `670px` (`60%`) | Chat remains visible beside a live shell. | The terminal tab and PTY stay mounted while another surface is active. |
| Browser | `502px` (`45%`) | Chat remains visible beside the running app. | `http://localhost:4401/` and its preview survive surface switches and reload. |

Files and Browser support multiple tabs. The rail selects the most recently
used tab of a surface. Width is stored per project directory and per surface,
while open/expanded state, tabs, selected target, rail order, and editor-tree
state are persisted. Closing the pane does not discard its tabs; reopening
restores the last surface state.

Expand grows the pane from its right edge to the full post-sidebar workspace.
Collapse restores its dock width. This is a useful explicit “focus on the
workspace” path and does not need to become the default Files/Git behavior.

### Adaptive behavior

| Condition | polyth observation | Audit result |
|---|---|---|
| `1440`, Files/Git | Chat column stays usable; both Send centers hit Send. | Pass |
| `1200`, Files | Pane `526px`, remaining chat column `350px`, composer `274px`; Send remains hit-testable. | Pass, lower bound |
| `1200`, Git | Pane clamps to `380px`; composer `420px`; Send remains hit-testable. | Pass |
| `1024`, Files | Pane `420px`, remaining chat column `280px`, composer `204px`; Send center hits the pane resize separator. | **P0 fail** |
| `1024`, Git | Pane `380px`, remaining chat column `320px`, composer `244px`; Send remains hit-testable. | Marginal pass |
| `900`, Files/Git | Pane minimum `380px`, remaining chat column `196px`, composer `136px`; Send center hits pane content. | **P0 fail** |
| `800`, Files/Git | Remaining answer width is `62px`, composer input `26px`; workspace content covers Send. | **P0 fail** |
| `768` mobile/coarse layout | Files and Terminal replace Chat; Git is a full-screen drawer; Browser is absent. Returning to Chat restores the same turn. | Pass |

The right fallback is therefore not a fixed viewport breakpoint alone. It must
be decided from the remaining primary-column width after the session sidebar,
rail, user pane width, and safe-area insets are applied.

## Findings

### PANE-OC-01 — Docking preserves task context on wide screens

Severity: **positive reference**

polyth avoids a costly mode switch: chat continues to show the request,
tool trace, answer, and composer while the user verifies the resulting files,
repository, terminal, or app. Per-surface widths are materially better than one
generic width: Git needs less room than the editor, terminal, or walkthrough.
Keeping inactive terminal, browser, walkthrough, and file state mounted also
prevents expensive restarts and lost reading position.

### PANE-OC-02 — A minimum pane width can paint over chat

Severity: **P0**

The panel clamps to at least `380px`, but the chat column has no corresponding
admission guard. At `1024px`, Files covers Send's center; at `900px`, Files and
Git both do. Overflow containment hides the collision instead of offering
horizontal recovery. Surface activation must promote to overlay/replacement
before this state is possible.

### PANE-OC-03 — Escape closure loses focus

Severity: **P1**

Focusing the Browser address and pressing Escape closes the pane, then leaves
`document.activeElement` on `BODY`. The pane's same-item rail toggle is safer
because focus remains on the rail button. Every close path must restore focus
to the invoking rail item, or to a deterministic adjacent control when the
invoker no longer exists. Terminal remains the deliberate exception: Escape
belongs to the PTY, so its visible close action and global panel shortcut must
remain available.

### PANE-OC-04 — Preview discovery is host-wide, not project-scoped

Severity: **P1**

The Browser empty state found `89` listening ports, including the Chrome debug
port `9223`, and rendered them all as “Running dev servers.” The discovery
request does not include the active directory. Announced servers are ranked
first, but an unannounced busy host still produces a long list of unrelated
infrastructure. Preview should prioritize servers started for the current
project/session, identify their command or project, and move unassociated
listeners behind an explicit “Other local servers” disclosure.

## Required Polyth pane contract

1. Files, Git, Terminal, and Preview open in one right workspace pane on wide
   desktop. The selected chat remains mounted, visible, scroll-stable, and
   operable.
2. Dock admission is geometry-based. Dock only when the resulting chat column
   is at least `320px` and every required chat control is fully hit-testable.
   Otherwise use a workspace overlay/replacement with an obvious Back/Chat
   action. Never let panel content cover chat controls.
3. Each surface has its own default and remembered width. Start with Git near
   `40%`, Preview near `45%`, and Files/Terminal near `60%`, then cap the result
   by the chat-width invariant. Resizing is keyboard-accessible and bounded.
4. The rail exposes stable accessible names, `aria-pressed`, visible focus,
   precise tooltips, and keyboard switching. Activating the selected surface
   closes it; Escape closes non-terminal surfaces and restores focus.
5. Pane tabs, active surface, width, expanded state, file/editor selection,
   terminal tab/buffer, and Preview URL survive surface switching, session
   switching, and direct reload at project scope. State from one project must
   not leak into another.
6. Expand is an explicit full-workspace mode. Collapse returns to the exact
   prior dock width and chat scroll/draft state.
7. On phone/coarse layouts, Files and Terminal replace Chat, Git uses the
   established workspace drawer/full view, and Back/Chat restores the exact
   timeline anchor and draft. Do not squeeze a dock beside chat.
8. Preview shows project-announced servers first with project/command identity.
   Host-wide listeners are secondary and protected ports/debug endpoints are
   not promoted as application previews.
9. Pane open, close, resize, reorder, selection, expansion, terminal focus, and
   preview navigation are presentation state. They append no session event.
   Any pane content that becomes model-visible is appended to the canonical
   session event log before chat display or model submission.

## Acceptance

- At `1440×900` and `1200×900`, open Files, Git, Terminal, and Preview from an
  active multi-turn session. The timeline, composer, and Send stay visible and
  their centers hit the intended controls.
- At every narrower width and at 200% zoom, automatically reject docking before
  the chat column falls below `320px`; the replacement/overlay path must be
  fully operable by pointer and keyboard.
- Select a file, switch to Git and Terminal, return to Files, close/reopen the
  pane, reload the canonical session URL, and verify file tab, panel width,
  active surface, chat scroll anchor, and composer draft.
- Open Preview from a terminal-announced project server, reload, and verify the
  same URL and chat. Unrelated local listeners stay behind secondary disclosure.
- Expand and collapse each surface. Verify no layout jump in the sidebar or
  rail, and verify the previous dock width returns exactly.
- Close Files, Git, and Preview by Escape, close button, and rail toggle.
  Focus returns to the invoker; Terminal Escape reaches the PTY.
- Compare the session event log byte-for-byte before and after pane-only
  journeys. It must be unchanged.

## Evidence

- `/opt/cursor/artifacts/polyth_pane_files_chat_sol.png`
- `/opt/cursor/artifacts/polyth_pane_browser_preview_chat_sol.png`
- `/opt/cursor/artifacts/polyth_pane_mobile_git_sol.png`

Next stage: `SOL-PANE-POLYTH-AUDITOR`.
