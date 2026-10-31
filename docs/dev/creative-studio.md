# Creative Studio

`@polyth/creative-studio` turns an idea and a song into a music video with an
agent. Polyth runs the process; the user makes the creative decisions. The
package owns the audio analyzer, the scene runtime, the renderer, the agent
tools and skill, the studio surface and its workbench profile. It does not own
a model runtime or a video generator: scenes are code (Canvas 2D, SVG or
Three.js) that the agent writes, and the package renders them deterministically.

It ships **disabled**; enable it under `Settings → Packages` (Workspace).
Enabling it adds a `Creative Studio` view tab, a searchable capability and the
`creative-studio` session purpose. The tab is not a chat with a side panel: the
studio is the whole workspace (a `homeSurface` profile with its own chat lane,
see [ui.md §4.7](ui.md#47-workspace-layout-package-lifecycle-and-project-context)).
Each video is one chat of that lane; the studio covers it, talks to it and
reveals it on request.

## Data model

One studio belongs to one canonical session, the *studio session*. Its files
live in that session's execution checkout:

```
.polyth/creative-studio/<session-id>/
  studio.json            durable state (the only state file)
  audio/<song>, audio/analysis.json, audio/lyrics.txt|.lrc
  scenes/<scene-id>.js   scene modules
  stills/<scene-id>.jpg, stills/contact-sheet.jpg
  renders/live.jpg, renders/preview.mp4, renders/final.mp4
```

`studio.json` (`StudioState` in `src/index.ts`) holds the brief, format,
effort, style guide, six stages, scenes, render jobs, QA findings, activity
feed and approvals. Every write goes through the server store
(`src/server/store.ts`): a per-studio in-process mutex, atomic temp-file +
rename, and traversal/symlink-escape checks against the checkout. The browser
never writes the file directly; it patches through the package route, so tools
from parallel delegated sessions and UI clicks cannot interleave a
read-modify-write. `parseStudioState` tolerates old or hand-edited files.

Server-maintained fields (`revision`, `hasCode`, `stillRevision`, render jobs)
are not part of `StudioPatch`. A render is *current* only for the scene
revisions it was made from (`renderIsCurrent`).

## Stages and definition of done

`brief → concept → production → assembly → review → export`. Readiness is
computed from durable state only (`stageCriteria`), shown in the studio as the
"Ready when" checklist and enforced by `applyStudioPatch`: a stage cannot be set
`done` until its criteria hold.

| Stage | Done when |
| --- | --- |
| brief | idea described, format set, song analyzed |
| concept | scenes tile 0..duration with no gaps/overlaps, every scene described, palette ≥ 3 colours, storyboard approved (balanced/max) |
| production | every scene has code, a current still and no runtime error |
| assembly | a current preview render with the song |
| review | the effort profile's QA rounds are done and no open error finding remains |
| export | a current final render that passes the delivery check; copied to `delivery.outputPath` and the report written when those are set |

`autonomy` is `checkpoints` (the storyboard waits for the user's approval on
balanced/max) or `autonomous` (never stops; `needsConceptApproval`). The
optional `delivery` spec (`normalizeDelivery`) sets the final height
(720/1080/1440/2160), fps (24/30/60), `matchSongLength`, and checkout-relative
`outputPath` (`.mp4`) and `reportPath` (`.md`); traversal, absolute and `.git`
paths are refused. Without it the effort profile decides (`finalSpec`).

Effort profiles (`EFFORT_PROFILES`) set scenes per minute, parallel builders,
QA rounds, concept variants, approval and render sizes. `estimateCost` is a
labelled heuristic range; the studio shows it beside the studio session's
measured tokens/cost. Video length is the chosen duration, cut short by a
shorter song, or exactly the song's length with `matchSongLength`; the video
always starts at 0:00 of the track.

## New video flow and the brief

`widgets/Wizard.tsx` is the create flow a studio chat without a studio shows:
one question per screen with the primary action in a fixed bottom bar, the
level switch (Quick / Guided / Expert, remembered per browser in
`polyth.creative-studio.level`) beside the "New video" eyebrow, and a thin step
bar that names only the current step on a phone:

| Level | Steps | For |
| --- | --- | --- |
| Quick | one screen: media kind (a sideways strip), idea, song; defaults shown as chips (a chip opens Guided at its step) | first-time users |
| Guided | Idea → Song → Style → Format → Review | most users |
| Expert | + a Models step (per-work-part routing), Delivery (resolution, fps, file paths, report, six agent rules, extra instructions) and an editable brief | producers |

Media kinds (`MEDIA_PRESETS` in `src/brief.ts`: story, dance, lyric,
visualizer, teaser) preset dimension, mood, lyrics overlay, frame and length
while keeping what the user wrote; each has one-tap example ideas (a snapping
carousel on a phone). The song card plays the chosen file locally and reads its
length, which then drives the "whole song" estimate. Depth choices show their
own scene/time estimate. From 980px a live poster sits beside the step; on a
phone the poster appears once, on Review. Steps validate before moving on
(`widgets/wizardModel.ts`); delivery paths use the same rules as the server.

**Starting.** With a chat (the studio chat exists): create the studio, upload
the song/lyrics into the chat's checkout, then send the brief. Without one (a
fresh lane chat, the usual start): the song can only be uploaded once the chat
and its checkout exist, so `widgets/start.ts` keeps the choices in a pending
start, seeds the brief into the lane's new-chat composer
(`host.conversation.startNewSession`) and asks that composer to send it
(`host.conversation.submitDraft`, the canonical path: the person's harness,
model and isolation choice). The studio shows a setup screen; when a studio
lane chat created after the seed appears without a studio, the studio adopts
it: creates the studio, uploads the song and lyrics (`adoptable`). The brief
says the song is being uploaded (`buildBrief(spec, { uploading })`), so the
agent waits for `creative_studio_state` to list it; `creative_studio_init` is
idempotent, so the agent's own init is harmless. When no composer can send
(older host, refusal) the studio reveals its chat with the brief in the
composer; when a submitted brief produces no chat within 45 s, the setup screen
offers the conversation.

`buildBrief(spec)` generates the kickoff message from the choices — what to
make, the idea quoted, mood and style, the song and its notes/tools READMEs,
the exact deliverable (`path, W×H, fps, H.264 yuv420p with AAC audio, the same
length as the song file`), the working mode, the rules (stay in the folder,
installed free tools only, no downloaded assets, open-licensed fonts with the
licence kept, never claim to have heard or watched, verify playback and sync),
the report, and a settings block for `creative_studio_init`. Guided users can
read it; experts can edit it, and an edited brief is sent exactly as written.
English on purpose: it instructs an agent, while the user's text is quoted as
typed. Start creates the studio, uploads the song/lyrics, then sends the brief;
without a chat it seeds a new-conversation draft.

## Agent contract

While enabled the package registers, in `onEnable`:

* the `creative-studio` session purpose — a short per-turn context with the
  studio id and paths;
* the on-demand skill `polyth-creative-studio` (`src/skill.ts`) — stages,
  criteria, effort profiles, delegation rules, the scene API and the quality
  bar;
* nine deployment-scoped tools: `creative_studio_init`, `creative_studio_state`,
  `creative_studio_update`, `creative_audio_analyze`, `creative_scene_write`,
  `creative_render`, `creative_render_wait`, `creative_render_cancel`,
  `creative_report_write`.

Tools resolve the studio inside the caller's checkout (`ctx.cwd`). `studioId`
defaults to the calling session; delegated children that share the checkout
pass their parent's id. Writes stay inside the studio folder, song/lyrics reads
stay inside the checkout, so the tools auto-approve. Delegation (parallel scene
builders) uses Polyth `agent.spawn` as the skill describes; roles (planner,
art, builder, reviewer) label activity entries and are not processes.

`creative_scene_write` rejects modules that `import` anything (Three.js arrives
as the `THREE` argument), bumps the scene revision and by default renders that
scene's still immediately, returning runtime errors and QA notes — the
builder's fix loop.

## Audio analysis

`src/audio/dsp.ts` is a pure TypeScript analyzer over mono PCM decoded by FFmpeg
(`src/audio/decode.ts`, bounded duration/bytes/time, killed on abort):

* STFT (Hann 2048 / hop 512 at 22.05 kHz), loudness, four bands, flatness and
  chroma per frame;
* onset envelope from spectral flux averaged in 12 log-spaced bands (a kick
  weighs as much as broadband hats) with adaptive local gain;
* tempo by prior-weighted autocorrelation, beats by dynamic programming
  (Ellis 2007), downbeats by the beat phase with the most low-end attack;
* sections from bar-level self-similarity novelty, repetition groups (A/B/C)
  and kinds (intro, verse, chorus, bridge, drop, breakdown, outro);
* key by Krumhansl profiles, strong accents, 20 Hz loudness/band/onset curves;
* instrument lanes (drums, bass, vocals, harmony, highs) — heuristic presence,
  not stem separation; the UI labels them as estimates.

Lyrics: `.lrc` keeps the author's timestamps; plain text is spread over the
estimated vocal spans and snapped to beats (marked as estimated); with
`transcribe: true` the tool sends ≤100 s vocal windows to the user's configured
dictation engine (which may be a paid cloud provider) and warns that the result
is machine-transcribed.

## Scene runtime and rendering

`src/render/runtime.ts` exports one JavaScript runtime string
(`STUDIO_RUNTIME_SOURCE`) executed in two places:

* **headless Chromium on the server** (`src/render/renderer.ts`) for stills,
  contact sheets and videos — frames stream as JPEG into FFmpeg (H.264 +
  AAC, `+faststart`); Three.js uses SwiftShader WebGL;
* **the live preview** in the studio surface — a sandboxed iframe
  (`sandbox="allow-scripts"`, no `allow-same-origin`, CSP with
  `connect-src 'none'`). The parent owns the clock: the song's `<audio>` element
  drives frame times, so picture and music stay in sync. Each frame document
  announces itself with its own `loaded` message, which starts the init; the
  parent listens from a layout effect (a srcdoc frame can post before passive
  effects run) and never uses the iframe `load` event, which also fires for
  the initial `about:blank` and would send the init into a discarded document.

The runtime gives every scene a frame object (time, beat/bar phase, pulse,
loudness and band curves, section, lyric line, palette, deterministic random),
composes transitions (cut, fade, flash, wipe), optionally burns in lyrics,
draws an animatic card for scenes without code and an error card for scenes
that throw, and computes thumbnail statistics for automatic QA (flat/blank,
frozen and very dark scenes, runtime errors). Server renders block all network
requests.

Delivery check (`verifyVideo`): after a final render the server inspects the
file with ffprobe — video/audio streams present, H.264 yuv420p + AAC, size and
fps, length against the song (or the chosen duration), audio/video length and
start alignment — and fully decodes it with `ffmpeg -xerror`, so a truncated
file cannot pass. Only a verified final is copied to `delivery.outputPath`.
The result is stored on the job (`verification`, `delivered`) and returned by
`creative_render_wait`.

Process ownership: each render job owns one Chromium and one FFmpeg child,
closed in `finally`, on cancel and on package disable (`service.dispose()`
aborts every job and waits). Renders are serialized per host (one CPU-bound job
at a time, bounded queue); one preview/final job per studio. A job still marked
`running` without a live owner (restart) is reconciled to `interrupted` on the
next read. The scene runtime needs a local Chromium (`POLYTH_CHROMIUM_PATH` or
a well-known path, resolved by `@polyth/browser/chromium`) and `ffmpeg`
(`POLYTH_FFMPEG_PATH` overrides). Three.js comes from the package's `three`
dependency; without it Three.js scenes render an error card.

## Routes

All under `/api/creative-studio/`, local-only (`localOnlyRemoteAccess`), every
request scoped through `rc.space` → `host.forSpace`; the studio id is the
session id and a foreign or unknown session answers like a missing one. Remote
(SSH) projects are refused for now.

| Route | Purpose |
| --- | --- |
| `GET state?since=` | state + revision; `unchanged` when the revision matches (cheap polling) |
| `POST state` | `init` or `patch` (user role) |
| `GET analysis`, `GET scenes` | full analysis with curves; scene code for the live preview |
| `GET media?path=` | stills, renders and the studio song with HTTP Range (video seeking) |
| `POST upload?name=` | raw song (≤ 80 MB) or lyrics (≤ 64 KB) into `audio/` |
| `POST analyze`, `POST render`, `POST render/cancel` | the same service the tools use |
| `GET vendor/three` | Three.js sources for the live preview |

## Studio surface

The studio is its own app, not a chat panel: the video is the hero, the agent
works in the background, and the person steers through studio controls.

* **Top bar** — the video title and meta (kind, frame, length, tempo), the
  agent's status as the person reads it (`Working`, `Needs you` — also while a
  storyboard waits for approval —, `Paused`, `Ready`) and a menu: open
  conversation, new video, open the video file, show the studio files.
* **Pipeline** — the six stages as one segmented bar with the current stage
  named and measured ("Scenes · 4 of 6 scenes built", "Assembly · preview
  42%", `stageProgress`); it opens the Progress view.
* **Stage** (`widgets/Stage.tsx`) — a dark theater lit by the palette's most
  vivid colours (`glowColors`), the screen fitted inside it in the video's
  aspect. The current scene's still is the poster until the sandboxed runtime
  reports ready (a lower-third title card when there is no still); tap the
  screen or the transport to play. A rendered preview/final plays on the same
  stage with native controls and a "Back to live" chip. Chips mark live work
  and scene errors (they open Review).
* **Filmstrip** (`widgets/Timeline.tsx`) — the whole song: section bands,
  scene stills proportional to time (current and selected scenes marked),
  energy with beats and downbeats, lyric spans and the playhead. Drag anywhere
  to scrub (pointer capture; it claims horizontal swipes with
  `data-owns-swipe` so the phone's swipe Back stays out); a tap selects the
  scene; keyboard: arrows by beat, Shift+arrows by scene, Home/End. Until the
  song is analyzed or scenes exist it shows an empty-state line.
* **Next step** (`nextMoment` in `widgets/studioModel.ts`, `widgets/Moment.tsx`)
  — the one thing to do now, by priority: the agent waits for an answer or a
  permission (open the conversation), approve the storyboard, a running render
  (progress, stop), the verified video (watch, open file), open error
  findings, a failed step (ask to fix), a paused agent (continue). Nothing
  while the agent simply works.
* **Views** — Scenes (style guide; a tapped scene expands with Play from here
  and Change), Sound (song, tempo/key/bars/sections, energy, sections and
  lyrics that seek when tapped, instrument estimates), Export (the final with
  its delivery check, watch/open/download, the running job with its live frame,
  render actions, history), Review (rounds, findings with their scene and time,
  ask to fix, dismiss, the contact sheet) and Progress (stages with the current
  one's criteria, the agent's last replies, the activity feed, estimate vs.
  measured usage). The view follows the stage until the person picks one.
* **Message dock** (`widgets/Dock.tsx`) — the studio's way to talk to the
  agent. "Change" on a scene targets the dock at it (a removable chip); the
  request is phrased by `studioRequest` and logged as a user activity entry.
  While the agent works the message is queued after its current step.

Layouts follow the studio's own container: below 980px it is one scrolling
page (top bar, stage, filmstrip, next step, views) with the views' glass tab
bar sticking to the top and the dock to the bottom, and a seek that starts in a
view (Play from here, a timestamp) scrolls the stage back into sight; from
980px it is an editor — stage, transport, filmstrip and dock in the main
column, the next step and the views in an inspector column. Playback time lives
in a small clock store (`widgets/clock.ts`) that the player writes every frame;
the playhead follows it through refs and only the clock text and the current
scene re-render, so playback never re-renders the studio. Copy ships in English
and Ukrainian (`widgets/strings.ts`, `widgets/wizardStrings.ts`); text the
person or the agent wrote is direction-isolated (`dir="auto"`). Polling backs
off when the surface is inactive and speeds up while the agent works or a
render runs.

**Profile and conversation.** The `creative-studio` profile is `homeSurface`
with `sessionPurpose` (the lane-home contract in ui.md §4.7): the studio stays
the home while navigation moves between the lane's chats, a new video is a new
lane chat (`host.conversation.startNewSession`), and closing the studio or
"Open conversation" reveals the video's chat — needed for approvals,
questions, model choice and the full transcript. That chat shows a "Back to the
studio" control above its composer (`widgets/ReturnToStudio.tsx` in
`session.composer.before`). Studio data is only shown for the chat it was
loaded for (`useStudio`), and re-entering the lane shows the loading state
while its remembered video opens.

## Models

A studio has two model settings, both in `StudioState.models`
(`StudioModels` in `src/index.ts`):

- `default` — the route the **studio session itself** runs on. The wizard's
  Format step (Guided) and Models step (Expert) show a session picker, and the
  Studio's action menu has a **Models** panel to change it later. Applying it
  writes the chat's draft execution config (`host.executionDraft`, pinned
  harness + `HarnessModelRef`), the same browser-local choice the composer
  sends: a chat-less start materialises the canonical session on that route,
  and an existing chat switches on its next turn. "Auto" writes an explicit
  auto selection (never a fabricated route), so the chat's own default wins
  and a previously pinned model is dropped.
- `roles` — optional **per-work-part** routes (Expert only). The five parts are
  the agent work the skill splits, not render stages: `plan` (style guide and
  storyboard), `descriptions` (per-scene text), `code` (scene modules),
  `review` (QA rounds and fixes) and `report` (the delivery report). A part
  without a route follows `default`.

The catalog comes from the live harness snapshots
(`/api/harnesses/snapshots?detail=1&projectId=…`), flattened by
`widgets/modelCatalog.ts` and rendered with `@polyth/models/model-picker`, so a
route always names a model this machine can run. Routes are validated
(`normalizeStudioModelRef`: harness-id slug plus provider/model strings; junk
is refused, never rewritten) and a variant the model does not advertise is
dropped.

`buildBrief` writes the routes into the brief's **Models** section (and the
init block), telling the agent to spawn each part's workers on exactly that
harness/model — the studio skill's Delegation section mirrors it, and instructs
the agent to report an unavailable route instead of silently substituting.
Without routes the brief has no Models section and the agent keeps the skill's
normal behaviour.

## Verification and limits

`packages/creative-studio/test/`: synthetic-song analyzer tests, state/criteria
tests, studio-model tests (`studioModel.test.ts`: agent state, next-step
priority, stage progress, requests, agent notes, chat-less adoption), mounted
surface tests (happy-dom: the three create flows, the chat-less start through
the composer and its adoption, approval, scene-scoped requests, queueing while
the agent works, review/export actions, watching a final, needs-you, the
transient no-chat render, Ukrainian, the return control), and an end-to-end
pipeline test (real FFmpeg + headless Chromium: analysis, Canvas 2D/SVG/Three.js
scenes, stills, QA findings for a throwing and a blank scene, preview MP4 with
an audio stream, cancellation, and an autonomous 720p/24 fps final that passes
the delivery check, is copied to `final/music-video.mp4` and closes export with
the report). The e2e test skips without Chromium/FFmpeg and needs the `three`
dependency installed for its Three.js scene. The lane-home navigation is pinned
by `apps/web/test/laneHomeSurface.test.ts`. Model settings are pinned by
`test/modelCatalog.test.ts` (catalog flattening, route/variant handling,
summaries), the state and brief tests (validation, patch merge, persistence,
routing lines) and the mounted surface tests (the Expert Models step, the
session picker, and that Auto never writes a draft route).

Known limits: activity entries written by the server are English; analysis is
heuristic (no stem separation, 4/4 assumed); renders are software-rendered and
CPU-bound; remote projects are not supported; generative image/video models are
not integrated — the scene API is code-drawn. If the first send of a chat-less
start fails, the composer keeps the brief in a fresh chat while the chat it
created already holds the studio and the song; sending again starts another
chat. Approvals and questions stay in the conversation (the studio points
there); the studio does not re-implement them — but model choice is now a
first-class studio setting as well.
