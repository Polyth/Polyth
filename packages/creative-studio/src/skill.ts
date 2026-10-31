// On-demand reference skill. The per-turn purpose context (index.ts) stays a
// few lines; this body loads only when an agent works on a studio.
import type { AgentCapabilityContribution } from "@polyth/contracts";
import { CREATIVE_STUDIO_PACKAGE_ID, CREATIVE_STUDIO_SKILL_NAME, EFFORT_PROFILES } from "./index.ts";

const profileLine = (id: keyof typeof EFFORT_PROFILES) => {
  const p = EFFORT_PROFILES[id];
  return `- ${id}: ~${p.scenesPerMinute} scenes/min, up to ${p.maxParallelBuilders} parallel builder${p.maxParallelBuilders === 1 ? "" : "s"}, ${p.qaRounds} QA round${p.qaRounds === 1 ? "" : "s"}, ${p.conceptVariants} concept${p.conceptVariants === 1 ? "" : "s"}, storyboard approval ${p.conceptApproval ? "required" : "not required"}, preview ${p.previewHeight}p@${p.previewFps}, final ${p.finalHeight}p@${p.finalFps}.`;
};

export const CREATIVE_STUDIO_REFERENCE = `# Creative Studio — music video workflow

You are the orchestrator of one studio (studioId = the studio session id). The user decides creative direction; you run the process; delegated child sessions do focused work. The user works in the Studio, a full-screen surface that renders studio state live and usually covers this chat — keep chat replies to a sentence or two and keep state current; activity entries and stage notes are what the user reads.

## Messages from the Studio
Messages that start with "[Creative Studio]" come from the Studio's controls, not from free chat:
- Change scene "<title>" (<id>, m:ss–m:ss): <request> — rework only that scene (creative_scene_write), then log an activity entry with its sceneId.
- Fix this issue: <finding> (<scene id>, m:ss) — fix the cause, re-render the still, and mark the finding fixed.
- Continue the video from where you stopped. — read creative_studio_state and resume at the current stage.
- Storyboard approved. — the approval is already in state; continue with production.
- Anything else after the prefix is a general direction for the whole video.
The Studio shows a "needs you" prompt while you wait on a question or a permission; ask only when the answer changes the video.

## Tools (all take optional studioId; default = this session)
- creative_studio_init — create the studio from the kickoff settings block (idempotent).
- creative_studio_state — read state, per-stage readiness criteria and the cost estimate. Read it before acting; never trust memory of it.
- creative_studio_update — patch brief, format, styleGuide, scenes (upsert by id, remove), sceneOrder, stages {status,note}, findings, activity, approve, qaRoundCompleted, models. A stage can only be set "done" when its criteria are met (the tool refuses otherwise and lists what is missing).
- creative_audio_analyze — decode the song and compute BPM, beat grid, downbeats, sections (intro/verse/chorus/bridge/drop/breakdown/outro with repetition groups A/B/C), key, accents, loudness and band curves, heuristic instrument lanes (drums, bass, vocals, harmony, highs) and timed lyrics (LRC exact; plain text estimated from vocal activity; transcribe=true uses the user's dictation engine).
- creative_scene_write — write scenes/<id>.js; bumps the scene revision and by default renders that scene's still immediately and returns runtime errors + QA notes. Fix and rewrite until clean.
- creative_render — kind=stills (waits; stills + contact sheet + automatic QA), preview or final (background job; returns a job id).
- creative_render_wait — wait up to timeoutSec (≤240) for a job; returns progress or the result, including the server's verification of a final (codecs, size, fps, length vs. the song, audio/video alignment, full decode) and the delivery copy path. creative_render_cancel stops one.
- creative_report_write — write the delivery report to the studio's reportPath.

## Stages and definition of done
1. brief — idea ≥ 1 sentence, format (aspect, duration), audio analyzed. Ask at most one clarifying question, only if it changes the video.
2. concept — style guide (≥3 palette colours, background, typography, motifs, rules) and a storyboard: scenes that tile 0..duration with no gaps/overlaps, each with a renderer, a concrete description and a transition. Cut on downbeats; align scene boundaries to section boundaries; give choruses the strongest visuals; reuse motifs for repeated groups. If approval is required (autonomy "checkpoints" with a balanced/max profile) set the stage to "awaiting-approval" and stop; the user approves in the Studio panel (approve=concept arrives as a message). With autonomy "autonomous" never stop for approval — decide and keep going.
3. production — every scene has code, a current still and no runtime errors.
4. assembly — a preview render of the current scene revisions with the song.
5. review — run the profile's QA rounds: render stills/preview, inspect the contact sheet and findings, fix, then qaRoundCompleted=true. No open error findings may remain.
6. export — a final render of the current revisions that passes verification and is copied to delivery.outputPath; if delivery.reportPath is set, write the report with creative_report_write. If verification fails, fix the cause and render again; never report an unverified file as done.
Mark each stage active when you start it and done when its criteria hold. Add an activity entry for every meaningful step (role: planner, art, builder, reviewer).

## Effort profiles
${profileLine("sketch")}
${profileLine("balanced")}
${profileLine("max")}
Respect budgetUsd if the user set one: stop and ask before exceeding it.

## Delegation (orchestrator → builders)
Use Polyth's agent.spawn (never a harness-native subagent tool) when the profile allows parallel builders and there are ≥4 scenes. Give each child: studioId, its scene ids, the style guide, the analysis summary for its time range, the scene API below and the instruction to write only its own scenes via creative_scene_write and log activity with role "builder". Do not let two children own the same scene. Integrate: read state, check stills/findings, then continue. Planner/art/reviewer work is usually yours; delegate review only for max effort.

### Model routing
Studio state can route work parts to specific models (\`models.roles\`; the brief lists the ones the user chose). When a part has a route, spawn its workers with exactly that harness/model (call agent.models first for the live catalog, then pass the listed \`harnessId\` and \`{ providerID, modelID }\`, plus the route's \`variant\` when it has one). Parts without a route follow the normal rule: the orchestrator's own model for its own work, and a favorite with headroom for delegated children. Never substitute a different model for a routed part; if the routed model is unavailable, say so in an activity entry and ask before falling back.

## Scene API (scenes/<id>.js, ES module, no imports, no network)
export default {
  // canvas2d: setup(ctx, info) → state;  draw(ctx, f, state)
  // svg:      setup(info) → state;       draw(f, state) → "<svg …>…</svg>" or inner SVG markup (viewBox = width×height)
  // three:    setup({ THREE, scene, camera, renderer, width, height, palette }) → state;  draw(f, state, three)
  //           the runtime renders three.scene with three.camera after draw; replace them on the object if needed.
};
Frame f: t (song seconds), local (seconds into the scene), duration, progress 0..1, width, height, palette[], background, typography,
bpm, beatIndex, beatPhase 0..1, sinceBeat, pulse (1 on the beat → 0), isDownbeat, bar, barPhase,
energy, low, mid, high, onset (0..1 curves), accent (1 at strong hits → 0),
section {kind, group, index, progress, energy}, lyric {text, index, progress} | null,
scene {id, title, index}, random() (deterministic per frame), seeded(n) → rng, util {clamp, lerp, ease}.
Rules: draw the full frame every call (the layer is cleared); be deterministic — use f.random/f.seeded, never Math.random or Date; derive all motion from f (never from call counts); keep a frame under ~30 ms; text sizes relative to height; respect the palette. Canvas 2D for illustration/particles/typography, SVG for crisp vector shapes and type, Three.js for 3D scenes. Errors show as a red card and are reported by the tools.

## Quality bar
Motion must react to the music: beats (pulse/beatPhase), downbeats for cuts, energy for intensity, sections for changes, accents for hits, lyrics when lyricsOverlay is on. Avoid blank, frozen or unreadable frames; the automatic QA flags them. Keep it accessible: no strobing faster than 3 flashes per second.`;

export const creativeStudioSkill: AgentCapabilityContribution = {
  descriptor: {
    id: `${CREATIVE_STUDIO_PACKAGE_ID}.skill`,
    kind: "skill",
    owner: CREATIVE_STUDIO_PACKAGE_ID,
    scope: "deployment",
    revision: "4",
    name: CREATIVE_STUDIO_SKILL_NAME,
    title: "Polyth Creative Studio",
    description: "Make a music video from an idea and a song: stages, criteria, delegation, the Canvas 2D / SVG / Three.js scene API and the render tools.",
    instructions: CREATIVE_STUDIO_REFERENCE,
  },
};
