# UX-COMPOSER-DISC — Polyth composer discoverability audit

## Result

**Status: specified. Polyth explains consequential modes better than
polyth, but several advertised capabilities are conditional, hidden, or
not connected to the live composer.**

Compared with the polyth audit at commit `2e3d0f5`, Polyth has the safer
execution vocabulary. A shell draft gains the visible label `Shell command ·
permission checked · output added to context` and changes Send to `Run`.
During an active turn, source-confirmed controls say `Steer`, `Queue`, or
`Interrupt` according to the configured behavior and keep a separate visible
`Stop` button. Model, agent, and profile triggers are semantic buttons whose
visible text supplies useful accessible names. At 390 and 320 CSS px, required
actions recompose to 44 px-high targets and stay inside the viewport.

The discovery layer is still incomplete. The empty placeholder is the only
composer-local explanation of `!`, `/`, `#`, and `@`; it disappears behind a
draft, and the Creator persona removes that grammar entirely. Upload,
workspace-file mention, drag/drop, paste, and GitHub-link attachment are
different paths with no persistent explanation. Goal attachment lives under
the header overflow, profile creation is a cryptic per-model `⚲` action, skills
and model variants are absent, and desktop controls measure only 28–32 px high.
Most critically, dictation is implemented as a `composer.leading` slot but
`installVoice()` has no caller. The live slot registry was empty and no mic was
rendered even with the Engineer persona, Dictation plugin, and dictation
preference enabled.

No product code was changed.

## Runtime and procedure

- Comparison reference: `UX-COMPOSER-DISC-polyth.md` from commit
  `2e3d0f5`; polyth `1.19.0`.
- Polyth source: `58c99338e15e5d68566a3f26e9a4ac7e7cd9d784`.
- Runtime: a current-source isolated server with its own data directory,
  project, session, attachment, and seeded agent profile. The previously
  recorded baseline at `docs/ux-audit/RUNTIME-BASELINE.md` was also checked.
- Browser: Google Chrome stable through the existing isolated CDP runtime at
  `1280×900`, `768×900`, `390×900`, and `320×900`.
- Live states: idle, typed, uploaded attachment, `/` commands, `@` files,
  empty `#`, shell, model, agent, profile, keyboard order, Engineer persona,
  and phone recomposition.
- Source-confirmed states: goal attachment, Creator persona, follow-up
  admission, busy-turn controls, draft persistence, attachment persistence,
  and the uncalled voice installer.
- A provider-backed active turn was not submitted. Busy-turn controls are
  source-confirmed rather than visually claimed.

## Affordance inventory

| Area | What a new user sees | What activation reveals | Classification |
|---|---|---|---|
| Upload | Persistent icon-only `⊕`, accessible name `Attach files` | Native multi-file picker; uploaded material becomes a removable named pill | `works-but-poor-ux`: no visible label, type compatibility, or distinction from `@` |
| Files | Placeholder says `@ for files` | Search after at least one query character; scored files and folders; keyboard footer | `works-but-poor-ux`: no persistent entry and no empty-query or no-result teaching |
| Commands | Placeholder says `/ for commands`; hero footer says `Ctrl+K commands` | Caret-local command list with descriptions and keyboard instructions | `works`: usable, but the composer has no persistent Commands action |
| Skills | Nothing | Nothing | `missing`: the slash path lists commands only |
| Snippets | Placeholder says `# for snippets` | Autocomplete only when configured matches exist | `poor-ux`: an empty `#` produced no popup or empty state |
| Shell | Placeholder says `! for shell` | Visible permission/context label, shell-specific placeholder, and `Run` | `works`: materially clearer than polyth |
| Goals | Header `···` menu, not the composer | `Attach goal…` opens an explicit objective, budget, and continuation form | `works-but-poor-ux`: safer than arming the next message, but remote from message composition |
| Voice | Nothing in the live composer | Nothing | `missing`: `installVoice()` is never invoked, so the slot is never registered |
| Model | `MODEL` plus current/default model | Search, provider groups, favorites ordering, and per-row `⚲` profile pinning | `works-but-poor-ux`: semantic trigger, but no modality/cost/context detail or variant |
| Agent | `AGENT` plus current/default agent | Search and descriptions | `works`: explicit and semantically named |
| Profile | `PROFILE` plus current pick, only after at least one profile exists | Search and bundled model/agent detail | `works-but-poor-ux`: absent at zero profiles; creation is hidden behind `⚲` or Settings |
| Idle Send | Visible `Send` plus shortcut | Sends text or pills; disabled honestly when empty/unavailable | `works`: clearer than an icon-only action |
| Busy controls | Source-confirmed visible behavior name plus separate `Stop` | Steer, queue, or interrupt according to Settings; queued items are manageable above the input | `works`: resolves polyth's most serious ambiguity |

## Comparison with polyth

| Concern | polyth `2e3d0f5` | Polyth | Decision |
|---|---|---|---|
| Shell consequence | Styling and placeholder; exit rules hidden | Visible Shell, permission, context, and Run copy | Keep Polyth |
| Busy delivery | Queue icon stacked over Stop; Steer preference hidden | Visible Queue/Steer/Interrupt and separate Stop | Keep Polyth |
| Selector semantics | Model/agent are focusable `DIV`s without button roles | Real buttons with value-bearing names and expanded state | Keep Polyth |
| Phone geometry | 24 px controls and narrow-shell clipping in audited runtime | 44 px phone actions and in-viewport Send at 390/320 | Keep Polyth |
| Command catalog | Commands and skills, typed and richly described | Commands only | polyth is ahead |
| Model inspection | Capability/modality metadata and variants | Provider grouping and favorites, but no variant or capability detail | polyth is ahead |
| Goal entry | Persistent target, but unsafe one-click arming | Explicit form, but hidden in header overflow | Combine Polyth safety with a visible entry |
| Dictation | Persistent when supported; full in-place lifecycle | Implementation exists but no live registration | polyth is ahead |

## Findings

### UX-COMP-PL-01 — Dictation is implemented but unreachable

Severity: **P0**

`MicButton` and `installVoice()` exist, and the latter would register
`voice.mic` in `composer.leading`. No production module calls
`installVoice()`. The live Engineer composer had the Dictation plugin and
dictation preference enabled, but `.mic-btn` count was zero and
`window.__polythSlots.listSlots("composer.leading")` returned an empty list.
Settings can therefore describe and enable a capability whose primary control
never appears.

Wire voice registration into boot, keep a disabled explanatory control when
capture is unavailable, and expose visible Listening/processing/error states
before claiming voice parity.

### UX-COMP-PL-02 — The placeholder remains the command grammar

Severity: **P1**

The full-persona placeholder teaches all four expert tokens:
`! for shell, / for commands, # for snippets, @ for files`. There is no
persistent token legend or direct Commands/Snippets/Shell control in the
composer. Once text or a restored draft covers the placeholder, those paths
become recall-only.

The Creator persona goes further: its placeholder becomes `Describe what you
want — it gets built as you watch…`, while the same token parser remains
active. Hiding jargon is reasonable; hiding every route to advanced help is
not. A compact Help/Insert menu can use plain language without exposing syntax
until requested.

### UX-COMP-PL-03 — Context insertion is split across unexplained paths

Severity: **P1**

The `⊕` button uploads bytes into `_inbox`. `@` searches existing workspace
paths. Internal and desktop drags become attachment pills, pasted files upload,
and a matching pasted GitHub PR/issue URL silently becomes a link pill. The
resulting pills are clear, named, removable, and draft-persistent, but the entry
points do not explain which material is copied, mentioned, or linked.

Use one visible Add context menu with Upload, Mention project file, Link
GitHub item, and Paste/drag guidance. Keep `@` as the fast keyboard path.

### UX-COMP-PL-04 — Autocomplete is visually keyboard-friendly but not
programmatically attached to the editor

Severity: **P1**

The popup has listbox/option roles and visibly documents
`↑↓`, Enter/Tab, and Escape. The controlling textarea has none of
`aria-autocomplete`, `aria-controls`, `aria-expanded`, or
`aria-activedescendant`. Focus stays in the textarea, so assistive technology
has no programmatic relationship to the changing active option.

Add combobox semantics while preserving the IME-safe uncontrolled editor.
Announce empty command, snippet, and file results instead of rendering nothing.

### UX-COMP-PL-05 — Profile discovery starts only after a profile exists

Severity: **P2**

With a seeded profile, the live composer exposed a semantic `Profile None`
button and a clear row (`Fast reviewer · opencode/deepseek-v4-flash-free ·
build`). With zero profiles, the entire trigger is conditionally absent. The
model menu offers profile creation through a repeated `⚲` button whose
accessible name is only `⚲`; the explanatory title is pointer-dependent.

Always show a Profile trigger with `None` and `Create profile…`, and name the
row action `Create profile from <model>` or `Edit profile <name>`.

### UX-COMP-PL-06 — Model selection omits decision-critical capability detail

Severity: **P2**

The model chooser is a real button, searchable, provider-grouped, and compatible
with favorites and recency. Its live list showed model names but no context
window, cost, supported modalities, connection/auth state, or thinking
variant. Users can attach files before learning whether the selected model can
consume them, and no variant control exists.

Add compact capability metadata and attachment-compatibility feedback before
selection. Variant belongs adjacent to Model only when the selected model
supports it.

### UX-COMP-PL-07 — Wide-layout targets are smaller than the phone contract

Severity: **P1**

At `1280×900`, Model/Agent/Profile measured `32px` high, Attach and Focus
measured `28px`, and Send measured `30px`. The same small targets remained at
`768×900`. At `390×900` and `320×900`, Attach, Focus, and Send correctly
recomposed to `44px` high and stayed inside the viewport.

Apply the 44 px target contract to touch/coarse input regardless of width, and
provide enough separation or an overflow menu for secondary actions. Do not
regress the current 390/320 in-viewport geometry.

## Required Polyth composer contract

1. Keep the visible Shell/permission/context label and visible
   Queue/Steer/Interrupt/Stop vocabulary.
2. Add one persistent Add context or Help entry that explains upload, file
   mention, GitHub link, commands, snippets, skills when available, and shell.
3. Register voice during app boot. Unsupported or disabled voice remains a
   named disabled control with a reason and Settings route.
4. Keep Model, Agent, Profile, Variant, and delivery controls semantic buttons
   with current values in their accessible names.
5. Always expose Profile discovery; replace glyph-only `⚲` actions with named
   create/edit actions.
6. Connect autocomplete to the textarea with complete combobox semantics and
   visible/announced empty states.
7. Show model capability and attachment compatibility before send; do not
   imply skills or variants exist until their implementations ship.
8. Preserve the current 390/320 two-tier layout, and make all coarse-pointer
   targets at least 44 px without depending on viewport width alone.
9. Preserve draft text, pills, selected execution configuration, and explicit
   mode across session switch and reload. Model-visible context must still be
   appended before display or runtime submission.

## Sanitized evidence

- `docs/ux-audit/RUNTIME-BASELINE.md`
- `/opt/cursor/artifacts/polyth_runtime_baseline_sol_58a2.png`
- `/opt/cursor/artifacts/polyth_composer_disc_current_1280_idle.png`
- `/opt/cursor/artifacts/polyth_composer_disc_current_768.png`
- `/opt/cursor/artifacts/polyth_composer_disc_current_390.png`
- `/opt/cursor/artifacts/polyth_composer_disc_current_320.png`
- Live Chrome ARIA snapshots, sequential Tab order, token popups, slot registry,
  and measured control geometry.
- Polyth source: `Composer.tsx`, `Picker.tsx`, `voice.tsx`, `main.tsx`,
  `GoalStrip.tsx`, `Header.tsx`, `prefs.ts`, and `styles.css`.

Next stage: `SOL-COMPOSER-UX-SPECIFIER`.
