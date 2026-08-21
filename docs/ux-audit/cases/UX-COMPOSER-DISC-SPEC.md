# UX-COMPOSER-DISC — honest composer discovery specification

- Case: `UX-COMPOSER-DISC`
- Model / role: `SOL` / UX and architecture specification
- Status: `specified`
- Specified: `2026-08-20`
- Product source baseline: `58c99338e15e5d68566a3f26e9a4ac7e7cd9d784`
- Inputs: polyth audit at `2e3d0f5` and Polyth audit at `6c43239`
- Scope: novice and expert discovery of context, commands, snippets, shell,
  voice, model, agent, profile, goal, and delivery controls. This artifact
  changes no product code.

## Decision and user outcome

Polyth keeps its safer execution language: Shell has a visible consequence
label and `Run`; active-turn actions say `Queue`, `Steer`, or `Interrupt` and
keep a separate `Stop`. It does not copy polyth's placeholder-only grammar,
icon-only busy stack, or ambiguous goal arming.

The implementation adds one persistent, visible `Add` trigger to the composer.
Its accessible name is `Add context or use a composer tool`. The menu names
real outcomes first and shows `@`, `/`, `#`, and `!` only as secondary expert
hints. It is present after text replaces the placeholder and in the Creator
persona. Direct sigil entry remains equally capable.

The menu, selectors, and voice control are projections of live truth, not a
feature wish list:

- Commands and snippets come from successful project catalog responses.
- Project files come from the existing scored workspace search.
- GitHub references are links for the active repository; their issue body is
  not claimed to be imported.
- Dictation is available only from a configured server engine or actual browser
  speech support.
- Model detail shows only fields supplied by `ModelDescriptor`.
- Skills, model variants, and attachment-modality support are not advertised
  because the audited Polyth contracts do not expose them.

Opening discovery UI or inserting draft syntax appends no session event. Text,
attachments, links, shell output, and resolved execution configuration retain
their existing durable and append-before-display boundaries.

## Novice path

The Creator persona and users who do not know prompt syntax get a complete
plain-language route:

1. `Add` remains visible beside the direct composer actions.
2. `Upload files…`, `Mention project file…`, `Link GitHub issue or pull
   request…`, `Attach goal…`, `Commands`, `Snippets`, and `Shell command` state
   what they do before showing any sigil.
3. Selecting `Mention project file…`, `Commands`, or `Snippets` focuses the
   editor and opens the appropriate list or instructional empty state. The user
   does not have to type `@`, `/`, or `#` first.
4. Creator continues to hide Model and Agent jargon. It exposes one semantic
   `Setup` trigger whose full accessible name is
   `Working setup (profile), current <name or Default>`. It offers saved
   profiles and `Create advanced setup…`; it does not invent a separate
   persona/profile system.
5. Unsupported actions remain visible only when a useful explanation or setup
   route exists. A disabled row includes the reason in visible text, not just a
   tooltip.

The first successful file, link, snippet, command, or dictation action produces
the same draft text or attachment pill as the expert path. There is no
novice-only message format and no hidden prompt wrapper.

## Expert path

Experienced users keep the fast grammar and gain persistent recall:

- `@` searches project files at any eligible token position.
- `/` at a line start searches commands.
- `#` searches configured snippets.
- leading `!` enters Shell mode.
- The `Add` menu displays each corresponding sigil in a secondary shortcut
  column and may be reached in normal Tab order; no new global shortcut is
  claimed.
- An expert can type a sigil, select a result with arrows plus Enter or Tab,
  dismiss with Escape, and continue composing without focus leaving the
  textarea.
- A drafted message never loses access to the grammar, current execution
  configuration, dictation state, or delivery behavior.

The menu is a discovery path into the existing grammar, not a second parser or
send pipeline.

## Capability-truth model

Every discovery row has one of four states: `loading`, `available`, `empty`, or
`unavailable`. `empty` means a successful authoritative response returned no
items. `unavailable` means the request failed or a required context is absent.
Those states may not be collapsed into one empty array.

| Surface | Authoritative truth | Honest presentation | Prohibited claim |
|---|---|---|---|
| Upload | Active project plus the existing upload/file routes | `Upload files…`; disabled with `Open a project first` when absent | That bytes stay outside the project; uploads are copied to `_inbox` |
| Project mention | Active project plus successful scored file search | `Mention project file…`; instruction, loading, results, or named empty state | That `@` uploads a file or searches agents |
| GitHub link | Parsed URL, successful repository probe, and matching active remote | `Link GitHub issue or pull request…`; dialog says `Adds a link only` | That issue/PR content, comments, or credentials are imported |
| Commands | Successful `/api/commands` result | Count and command descriptions; `No commands available` only after success | Skills, or that a transport failure means zero commands |
| Snippets | Successful `/api/snippets` result | Count/results; when empty, `No snippets yet` plus `Create a snippet…` | A popup or result that does not exist |
| Shell | Active project/session creation path and existing shell route | `Shell command`; consequence copy remains visible and Send becomes `Run` | A terminal, sandbox, automatic approval, or hidden permission bypass |
| Goal | Active session and enabled Goals plugin | `Attach goal…` opens the existing explicit objective/budget form | One-click arming of the next ordinary message |
| Dictation | Dictation plugin preference, dictation preference, browser support, and server capability response | Available, off, loading, or unavailable with a Voice settings route | A working mic merely because settings contain a Dictation toggle |
| Model | `ModelDescriptor` fields received from the server | Name/provider; context only when numeric; connection only when reported | Modality, attachment support, thinking variant, or cost units not defined by contract |
| Agent | Actual `AgentDescriptor` rows | Name and supplied description | Permissions or modes not supplied to this picker |
| Profile/setup | Actual stored profiles and model availability for creation | `None`/`Default`, saved rows, and a named create action | That a profile exists before save, or that Creator has a different profile type |
| Busy delivery | Current turn plus configured follow-up behavior | Existing visible `Queue`/`Steer`/`Interrupt` and separate `Stop` | A hidden alternate behavior or a floating unlabeled queue icon |

The web API adds a strict composer-catalog read that preserves independent
command and snippet outcomes. Existing convenience callers may continue to
fall back to arrays, but Composer must receive the four-state result. An HTTP
error is `unavailable`, never `empty`.

`ModelDescriptor.context` is a token count and may render as `128k context`.
The current `cost` field has no unit in the contract, so this slice does not
render it. `capabilities?: string[]` has no normalized modality vocabulary, so
it is not translated into attachment claims. With one or more attachment pills,
the model area says `Attachment compatibility is not reported by this
provider` unless a future reviewed contract supplies normalized accepted input
kinds. Send remains governed by the backend; the UI does not guess.

## Persistent Add menu

### Trigger and layout

Replace the icon-only `⊕` entry with a button whose visible text is `Add`.
The icon may remain decorative. The trigger has:

- `type="button"`;
- accessible name `Add context or use a composer tool`;
- `aria-haspopup="menu"`;
- truthful `aria-expanded`;
- `aria-controls="composer-add-menu"` while mounted; and
- a minimum `44×44px` target for coarse pointers and at phone widths.

At wide fine-pointer layouts its visual box may follow desktop density, but its
focus ring and label remain visible. The menu opens upward when the docked
composer lacks space below and downward from the hero. It stays within the
viewport at `320`, `390`, `768`, and `1280` CSS px.

### Exact menu content

The DOM and visual order are:

1. Group label `Add context`
2. `Upload files…` — `Copies files into this project’s _inbox`
3. `Mention project file…` — expert hint `@`
4. `Link GitHub issue or pull request…` — `Adds a link only`
5. `Attach goal…` when Goals is enabled; disabled as `Open a session first`
   until a session exists
6. Group label `Compose`
7. `Commands` — expert hint `/` and authoritative available count
8. `Snippets` — expert hint `#` and authoritative available count
9. `Shell command` — expert hint `!` and
   `Permission checked; output is added to context`

Skills and Variant do not appear. If a future implementation adds them, it
must first add an authoritative typed capability/list result and a separate
review; changing copy alone is insufficient.

Menu activation rules are exact:

- `Upload files…` closes the menu and opens the existing multi-file input.
- `Mention project file…` closes the menu, inserts an IME-safe `@` token at the
  caret with required whitespace, focuses the textarea, and opens Files help.
- `Commands` inserts `/` at a valid line start. If the caret is on nonempty
  content, it inserts a newline first; it never creates an inert mid-line slash.
- `Snippets` inserts an IME-safe `#` token at the caret and opens Snippets.
- `Shell command` replaces an empty/whitespace draft with `!` and focuses the
  textarea. With a nonempty prompt draft, the row is disabled and visibly says
  `Send or clear this draft before entering Shell mode`; it never reinterprets
  existing prose as an executable command.
- `Attach goal…` opens the existing `GoalAttachForm`; it does not synthesize a
  prompt or arm Send.

All editor writes use `TextInputHandle`; none writes directly to the textarea
or interrupts IME composition. Escape closes only the menu and restores focus
to `Add`. Selection closes the menu and moves focus to the resulting target.
Outside press closes and restores the trigger unless focus intentionally moved
to a file picker or dialog.

### GitHub link dialog

The link action opens a modal named `Link GitHub issue or pull request`.
It contains one URL input, visible copy
`Polyth adds a reference to the matching project repository. It does not import
issue or pull-request contents.`, `Cancel`, and `Add link`.

`Add link` is enabled only for a syntactically valid GitHub issue or pull
request URL. Submission uses an `AttachResult`-style helper that distinguishes:

- invalid URL;
- active project has no detected GitHub repository;
- repository does not match;
- attachment limit reached; and
- request failure.

Only a matching URL creates the existing removable `PR #n` or `Issue #n` pill.
Failure creates no pill, preserves the input, and reports a bounded inline
error. The paste path may reuse the helper but retains its current fallback to
plain text when the URL is not consumed.

## Autocomplete contract

The textarea is a multiline ARIA combobox while a recognized discovery token
is active:

- `role="combobox"`;
- `aria-autocomplete="list"`;
- truthful `aria-expanded`;
- `aria-controls="composer-autocomplete-list"` while open; and
- `aria-activedescendant="<stable option id>"` only when a result is active.

`AdaptiveTextInput` gains explicit optional props for these attributes; it
remains uncontrolled and IME-safe. The popup listbox has the controlled id.
Each option has a stable id derived from token kind plus item identity, not its
array index.

Recognized tokens keep the popup open even with no selectable result:

| State | Visible and announced body |
|---|---|
| Empty `@` | `Type a file or folder name to search this project.` |
| File request pending | `Searching project files…` |
| No file hits | `No project files match “<query>”.` |
| Commands loading | `Loading commands…` |
| No command hits | `No commands match “<query>”.` |
| Commands unavailable | `Commands are unavailable for this project.` |
| Snippets loading | `Loading snippets…` |
| No snippets configured | `No snippets yet.` plus `Create a snippet…` |
| No snippet hits | `No snippets match “<query>”.` |
| Snippets unavailable | `Snippets are unavailable for this project.` |

One polite live region announces a state transition once. It does not repeat on
every render or duplicate the selected option name. Arrow keys change the
active descendant. Enter and Tab insert only when a selectable option exists;
Tab follows normal focus order in instructional, loading, empty, and error
states. Escape closes the popup and leaves the token and focus in the editor.

Async file responses retain the existing sequence guard. A project, session,
token kind, token range, or query change invalidates the prior request. A stale
response never reopens a popup or replaces current results.

## Model, Agent, Profile, and Setup

Full composer mode always renders semantic Model, Agent, and Profile triggers
when their underlying selector is applicable. Profile remains present even
with zero saved profiles. Exact trigger names are:

- `Select model, current <value>`;
- `Select agent, current <value>`; and
- `Select profile, current <value or None>`.

Creator renders the same profile data through `Setup`, named
`Working setup (profile), current <value or Default>`, while Model and Agent
remain hidden. This is a copy adaptation over one profile store and one send
field, not a new capability.

The Profile/Setup list contains:

1. `None` or `Default`;
2. each actual stored profile with supplied model and optional agent detail;
3. `Create profile…` in full mode or `Create advanced setup…` in Creator.

Creation is disabled with `Connect a model before creating a profile` when
there are no models and includes `Open model settings`. Successful
`Save and use` selects the returned real profile id. Cancel and failure leave
the prior selection unchanged.

The model row's glyph-only `⚲` is removed. Its row action is visibly
`Create profile` or `Edit profile`; its accessible name is
`Create profile from <model>` or `Edit profile <profile>`. Picker row actions
must accept item-specific names. They never also select the model row.

Model rows show provider and numeric context when available. They do not render
cost, modalities, variants, or attachment support from guesses. Agent rows show
only the supplied name and description.

### Selection and persistence

Model, Agent, and Profile are one execution configuration:

- Selecting a profile clears explicit model and agent overrides.
- Selecting an explicit model or agent clears the selected profile so the
  visible Profile value never claims an unmodified bundle.
- `None` clears only the profile selection.
- A profile removed after selection becomes a visible
  `Profile unavailable — choose another` state; Send is blocked until the user
  chooses a valid profile or None. It never silently substitutes a profile.

Pending configuration is stored with the existing draft, per canonical
session, and for the no-session hero. It survives reload and session switches
without crossing between sessions. A new `composerConfig.ts` owns a versioned
browser-local record; Composer does not add three unrelated storage calls.

On successful send, the server records the selected profile id or explicit
clear in `SessionProjection.agentProfileId` and persists the resolved
model/agent as it already does. The durable `user/message` retains the profile
id plus resolved configuration before the turn starts, so later profile edits
cannot rewrite replay. The request must distinguish omitted/inherited profile
from explicit `null`/None. After authoritative projection refresh, the local
pending record may be removed only if it still equals what was sent.

## Voice registration and visible lifecycle

`installVoice()` is invoked exactly once before the first ready `App` render,
so `composer.leading` already contains `voice.mic` when Composer reads the
registry. Installation is idempotent: repeated development boot cannot add a
second slot or store subscription.

The slot does not disappear when Dictation is off:

- Plugin off: disabled `Dictate` plus visible `Voice plugin is off` and an
  operable `Voice settings` action.
- Dictation preference off: disabled `Dictate` plus visible
  `Dictation is off` and `Voice settings`.
- Capability loading: disabled `Dictate` plus `Checking microphone…`.
- Browser unsupported and server unavailable: disabled `Dictate` plus the
  returned reason and `Voice settings`.
- Available: enabled visible `Dictate`.

The explanatory status and Settings action may collapse into a small popover on
phone, but neither exists only in `title`. The settings action calls
`openSettingsPage("voice")`.

Activation has visible states:

1. `Starting microphone…`
2. `Listening…` with an operable `Stop dictation`
3. Server engine only: `Transcribing…` after Stop and before insertion
4. Failure: `Dictation failed: <bounded reason>` with `Try again` and
   `Voice settings`
5. Success: transcript inserted through the IME-safe composer command and focus
   returned to the editor

The control has truthful `aria-pressed` only while listening, and status changes
are announced once. Browser final chunks and server final text remain drafts;
they append no session event until the user sends. Starting or stopping
dictation does not send automatically.

## Shell and active-turn controls

Preserve the audited Polyth behavior:

- A leading `!` is the only Shell-mode grammar.
- Shell mode visibly says
  `Shell command · permission checked · output added to context`.
- The primary action says `Run`.
- Leaving Shell mode requires removing the leading `!`; the Add action never
  silently changes a nonempty prompt into Shell.
- Shell mode cannot send attachment pills as command input. Existing pills
  remain in the prompt draft and are still present when the user returns to
  prompt mode.

During a working turn, the primary action's visible label comes from the
effective configured behavior: `Queue`, `Steer`, or `Interrupt`. Its accessible
name includes the same behavior. `Stop` remains a separate named button.
Attachments that cannot steer continue through the existing honest queue
fallback and queued state; no UI copy says they steered.

## Responsive, keyboard, and assistive behavior

This specification composes with the approved two-tier phone composer:

- Selectors/Setup remain in the selector tier.
- Slot-rendered voice remains in the extension tier.
- `Add`, focused editor, delivery, and Stop remain in the action tier.
- At `320×900` and `390×900`, Add, Setup/Profile, voice, Send/Run/delivery, and
  Stop are at least `44×44px`, in bounds, nonoverlapping, and center-hit-test to
  themselves or descendants.
- At coarse pointer, the same `44px` target contract applies regardless of
  viewport width.
- Menu and popup use at most the viewport width minus `16px`; a multiline draft
  does not push their focused item outside the visible scrollport.

Sequential focus order is textarea, selectors, extensions, Add, focused editor,
primary action, and Stop within the existing visual groups. An open Add menu or
modal owns focus according to the existing shared modal/menu behavior. Hidden
items are not tabbable or hit-testable.

All controls use native buttons or inputs. Visible labels may be compacted only
when the full purpose remains in the accessible name. State, availability,
error, Shell, listening, and delivery behavior do not rely on Ember color.

## Event, API, and security invariants

1. Opening/closing Add, autocomplete, Picker, Profile form, GitHub dialog, or
   Voice settings is browser-local and appends no session event.
2. Token insertion, dictation transcript insertion, selector changes, and
   unsent attachment pills are draft state and are not model-visible.
3. Upload and GitHub helpers retain active-project and attachment-count
   validation. A browser path or URL never grants broader filesystem/network
   authority.
4. A GitHub link pill contains the sanitized matching URL only. It includes no
   token, fetched issue body, hidden remote metadata, or credential.
5. Shell execution keeps the existing server permission and durable event path.
   No browser-side direct process execution is introduced.
6. On Send, model-visible text, attachments, resolved profile/model/agent, and
   shell results are appended before broadcast or UI display as applicable.
7. Only `packages/backend-opencode` may contact the OpenCode process/SDK. This
   discovery slice adds no OpenCode import or endpoint elsewhere.
8. No command, snippet, model, profile, file, voice, skill, or variant is shown
   as available from a hard-coded demo list.

## Minimal implementation files and seams

| File | Exact responsibility |
|---|---|
| `apps/web/src/composer/discovery.ts` (new) | Pure four-state catalog/menu model, safe token insertion decisions, autocomplete ids/status copy, and honest model detail formatting. |
| `apps/web/src/composerConfig.ts` (new) | Versioned per-session/no-session execution draft, inheritance, explicit None, equality, and consume-after-authoritative-send rules. |
| `apps/web/src/components/ComposerAddMenu.tsx` (new) | Persistent Add trigger/menu, capability-state rows, focus restoration, and GitHub-link dialog. No parser or send path. |
| `apps/web/src/components/Composer.tsx` | Wire one Add menu to existing input/file/attachment/goal/send seams; keep autocomplete open for instruction/error states; persist one execution configuration; supply truthful selector names. |
| `apps/web/src/components/input/AdaptiveTextInput.tsx` | Optional combobox relationship props without making the textarea controlled or weakening IME admission. |
| `apps/web/src/components/Picker.tsx` | Current-value trigger names, item-specific named row actions, and Create profile item handling. |
| `apps/web/src/attachments.ts` | Result-bearing GitHub-link helper shared by dialog and paste; preserve matching-remote and attachment-limit checks. |
| `apps/web/src/api.ts` | Strict independent command/snippet catalog outcomes; no failure-to-empty coercion for Composer. |
| `apps/web/src/voice.tsx` and `apps/web/src/main.tsx` | Idempotent pre-render registration, truthful availability, visible dictation lifecycle, and Voice settings route. |
| `packages/contracts/src/index.ts`, `packages/server/src/http.ts`, and `packages/server/src/sessions.ts` | Distinguish inherited profile from explicit None; persist selected/cleared profile with resolved model/agent while preserving durable event ordering. |
| `apps/web/src/styles.css` | Ember menu/lifecycle styling, coarse-pointer and phone targets, bounded popups, focus, non-color state, and two-tier integration. |
| `apps/web/test/composerDiscovery.test.ts` (new) | Pure truth-state, insertion, metadata, id, and configuration persistence tests. |
| `apps/web/test/composerDiscovery.live.ts` (new) | Isolated live novice/expert, ARIA, geometry, voice, selector, and no-fake-capability gate. |

Do not duplicate command/snippet parsing, file search, profile storage, goal
submission, attachment pills, shell submission, voice preference storage, or
`send()`. Existing owners remain authoritative.

## Test and release acceptance

### Automated gates

1. Catalog tests distinguish loading, successful empty, request failure, and
   project absent independently for commands and snippets.
2. Menu insertion tests prove `@` and `#` insert at the caret, `/` starts a
   valid line, and `!` never reinterprets a nonempty prompt.
3. Autocomplete tests prove stable option ids, truthful combobox state,
   instructional/empty/error copy, normal Tab on no option, stale file-response
   rejection, and IME deferral.
4. GitHub tests cover invalid, no repo, mismatched repo, matching issue,
   matching pull request, duplicate, limit, and transport failure. Only matches
   create link-only pills.
5. Capability tests assert no Skills or Variant row/control and no attachment,
   modality, or cost claim from absent/undefined fields.
6. Picker tests assert current-value names, named create/edit profile actions,
   Profile present at zero profiles, Creator Setup aliasing the same ids, and
   deleted-profile Send blocking.
7. Configuration tests switch sessions and reload before Send; each session
   restores its own exact profile/model/agent state. Profile selection and
   explicit overrides clear each other as specified.
8. Server tests distinguish omitted profile from explicit None, persist the
   projection, and append one `user/message` with the actual resolved
   configuration before runtime start.
9. Voice tests prove one registration/subscription, all availability states,
   no transcript event before Send, and no auto-send on Stop.
10. Existing shell, queue, attachment, prompt language, input core, profile,
    message delivery, and OpenCode boundary tests continue to pass.

### Live novice and expert gate

Use an isolated synthetic runtime at `1280×900`, `768×900`, `390×900`, and
`320×900`, plus a coarse-pointer `1280×900` case:

1. In Creator with a nonempty restored draft, `Add` is visible. Without typing a
   sigil, use it to mention a project file, create/insert a snippet, and open the
   command catalog. The resulting draft/pills match direct syntax.
2. In full mode, type `@`, `/`, and `#` in valid positions. Capture instruction,
   loading, results, successful empty, and forced endpoint-failure states.
   Screen-reader relationships and announcements match the contract.
3. With no snippets, the UI says `No snippets yet` and reaches Commands &
   Snippets settings. With a forced command `500`, it says unavailable rather
   than zero. No UI surface says Skills.
4. Link a matching GitHub issue and verify a link-only pill; submit a mismatched
   repository and verify no pill plus the exact error. No issue body appears.
5. Enter Shell from an empty draft and verify label plus Run. Repeat with a
   nonempty draft and verify the menu cannot reinterpret it.
6. Run Voice with plugin off, preference off, unsupported browser, configured
   server, listening, processing, success, and forced failure. Each state is
   visible and named; setup reaches Voice settings. The slot count remains one
   after remount.
7. At zero profiles, Profile/Setup remains discoverable and can create a real
   profile. Verify full and Creator names, Save and use, reload, session switch,
   profile deletion, and explicit None.
8. Attach a file and inspect models with and without `context`. Only supplied
   detail appears; attachment compatibility is explicitly unreported and no
   Variant control appears.
9. During a synthetic active turn, verify current configured delivery copy,
   separate Stop, queued attachment fallback, and exact center hit testing.
10. Tab/Shift+Tab, arrows, Enter, Space, Escape, outside press, and modal focus
    restoration work at every size. No focused or primary control is clipped,
    overlapped, or hidden behind the composer.

Run:

```sh
node --test apps/web/test/composerDiscovery.test.ts
node --test apps/web/test/smoke.test.ts
node --test apps/web/test/composerDiscovery.live.ts
node --test packages/server/test/delivery.test.ts
(cd packages/contracts && npx tsc --noEmit)
(cd packages/server && npx tsc --noEmit)
(cd apps/web && npx tsc --noEmit)
npm test
```

The live gate receives the isolated runtime URL, fixture project/session ids,
voice capability overrides, and command/snippet failure controls through
documented environment variables. Save the minimal passing screenshots and one
short expert/novice walkthrough. Do not use static mockups as release evidence.

## Explicit non-goals

- No Skills catalog, skill syntax, model Variant selector, inferred modality,
  guessed attachment compatibility, or unlabeled capability glyph.
- No polyth DOM/CSS, placeholder-only legend, stacked queue icon, unsafe
  goal arm switch, profile invention, or `24px` touch targets.
- No second composer, parser, attachment store, command store, profile store,
  goal form, voice preference store, or Send path.
- No auto-run Shell action, hidden permission change, automatic dictation Send,
  external URL fetch in the browser, or GitHub issue-content ingestion.
- No provider-cost display until the contract defines units; no capability
  translation until the contract defines normalized values.
- No broad Settings, command palette, goal, model-provider, plugin, theme,
  timeline, rail, or responsive-shell redesign.
- No server event for opening discovery UI or editing draft configuration.
- No relaxation of append-before-display, canonical replay, session isolation,
  active-project path checks, or the OpenCode package boundary.

## Exact next task

`Fable-COMPOSER-DISC-implementer`: implement only the files and acceptance
contract in this specification, then hand the isolated runtime and passing
novice/expert artifacts to the SOL verifier.
