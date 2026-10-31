// Agent tools. Each resolves the studio inside the calling session's checkout
// (ctx.cwd); `studioId` lets delegated children that share the checkout work
// on their parent's studio. Writes stay inside `.polyth/creative-studio/<id>/`,
// reads of song/lyrics files stay inside the checkout.
import type { AgentCapabilityContribution, JsonObject, ToolExecutionContext } from "@polyth/contracts";
import {
  applyStudioPatch,
  ASPECT_IDS,
  AUTONOMY_MODES,
  finalSpec,
  MEDIA_KINDS,
  VISUAL_DIMENSIONS,
  CREATIVE_STUDIO_PACKAGE_ID,
  currentStage,
  EFFORT_IDS,
  estimateCost,
  effectiveDuration,
  isSceneId,
  normalizeStudioId,
  pushActivity,
  ROLE_IDS,
  STAGE_IDS,
  stageCriteria,
  studioPaths,
  type RoleId,
  type StudioInit,
  type StudioPatch,
  type StudioState,
} from "../index.ts";
import { summarizeAnalysis } from "../audio/analysis.ts";
import type { StudioService } from "./service.ts";
import type { StudioRef } from "./store.ts";

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid-input" });
const json = (value: unknown) => ({ output: JSON.stringify(value) });

const studioIdSchema: JsonObject = {
  type: "string",
  description: "Studio id = the studio session's id. Omit inside the studio session; delegated children pass their parent's id.",
};

function refOf(input: JsonObject, ctx: ToolExecutionContext): StudioRef {
  if (!ctx.cwd) throw invalid("this session has no checkout");
  return { cwd: ctx.cwd, studioId: normalizeStudioId(input.studioId ?? ctx.sessionId) };
}

/** Compact, model-friendly view: no curves, bounded lists. */
export function stateView(state: StudioState, service?: Pick<StudioService, "isStale">) {
  return {
    id: state.id,
    title: state.title,
    effort: state.effort,
    autonomy: state.autonomy,
    ...(state.mediaKind ? { mediaKind: state.mediaKind } : {}),
    ...(state.dimension ? { dimension: state.dimension } : {}),
    ...(state.moods?.length ? { moods: state.moods } : {}),
    delivery: { ...finalSpec(state), ...(state.delivery ?? {}), ...(state.reportWrittenAt ? { reportWrittenAt: state.reportWrittenAt } : {}) },
    format: { ...state.format, effectiveDurationSec: effectiveDuration(state) },
    brief: state.brief,
    audio: state.audio ?? null,
    styleGuide: state.styleGuide ?? null,
    currentStage: currentStage(state),
    stages: Object.fromEntries(STAGE_IDS.map((stage) => [stage, {
      ...state.stages[stage],
      criteria: stageCriteria(state, stage),
    }])),
    approvals: state.approvals,
    qaRounds: state.qaRounds,
    scenes: state.scenes.map((scene) => ({
      ...scene,
      file: scene.hasCode ? studioPaths(state.id).scene(scene.id) : null,
      stillCurrent: scene.stillRevision === scene.revision,
    })),
    openFindings: state.findings.filter((finding) => finding.status === "open").slice(-30),
    renders: state.renders.slice(-5).map((job) => ({ ...job, ...(service?.isStale(job) ? { stalled: true } : {}) })),
    recentActivity: state.activity.slice(-12),
    estimate: estimateCost({ effort: state.effort, durationSec: effectiveDuration(state), ...(state.scenes.length ? { scenes: state.scenes.length } : {}) }),
    ...(state.models ? { models: state.models } : {}),
    ...(state.budgetUsd !== undefined ? { budgetUsd: state.budgetUsd } : {}),
    paths: studioPaths(state.id),
  };
}

const str = (value: unknown, max = 4000) => (typeof value === "string" ? value.slice(0, max) : undefined);

export function createStudioTools(service: StudioService): AgentCapabilityContribution[] {
  const store = service.store;
  const tool = (
    name: string,
    description: string,
    properties: JsonObject,
    required: string[],
    mutating: boolean,
    execute: (input: JsonObject, ctx: ToolExecutionContext) => Promise<{ output: string; metadata?: JsonObject }>,
  ): AgentCapabilityContribution => ({
    descriptor: {
      id: `${CREATIVE_STUDIO_PACKAGE_ID}.${name}`,
      kind: "tool",
      owner: CREATIVE_STUDIO_PACKAGE_ID,
      scope: "deployment",
      revision: "1",
      name,
      description,
      inputSchema: { type: "object", additionalProperties: false, properties: { studioId: studioIdSchema, ...properties }, ...(required.length ? { required } : {}) },
      trust: "workspace",
      mutating,
    },
    execute,
    // Confined to the studio folder of the caller's own checkout and to local,
    // bounded FFmpeg/Chromium children, so routine studio steps do not prompt.
    autoApprove: () => true,
  });

  return [
    tool(
      "creative_studio_init",
      "Create this session's Creative Studio from the kickoff settings (idea, effort, aspect, durationSec, audioPath, lyricsOverlay). Idempotent: returns the existing studio unless reset=true.",
      {
        idea: { type: "string", minLength: 1, maxLength: 4000 },
        title: { type: "string", maxLength: 120 },
        effort: { type: "string", enum: [...EFFORT_IDS] },
        aspect: { type: "string", enum: [...ASPECT_IDS] },
        durationSec: { type: "number", minimum: 5, maximum: 600 },
        audioPath: { type: "string", description: "Song file relative to the checkout (mp3, wav, m4a, flac, ogg)." },
        lyricsOverlay: { type: "boolean" },
        style: { type: "string" },
        mood: { type: "string" },
        mediaKind: { type: "string", enum: [...MEDIA_KINDS] },
        dimension: { type: "string", enum: [...VISUAL_DIMENSIONS] },
        moods: { type: "array", items: { type: "string" }, maxItems: 8 },
        autonomy: { type: "string", enum: [...AUTONOMY_MODES], description: "autonomous = deliver without waiting for approvals." },
        models: {
          type: "object",
          description: "Model routes: { default: {harnessId, providerID, modelID, variant?}, roles: {plan|descriptions|code|review|report: {harnessId, providerID, modelID, variant?}} }. A work-part route overrides default for that part's delegated work.",
        },
        delivery: {
          type: "object",
          description: "{ height: 720|1080|1440|2160, fps: 24|30|60, matchSongLength, outputPath: e.g. final/music-video.mp4, reportPath: e.g. report.md }",
        },
        reset: { type: "boolean", description: "Discard the existing studio state (scene files are kept)." },
      },
      ["idea"],
      true,
      async (input, ctx) => {
        const ref = refOf(input, ctx);
        const { state, created } = await store.init(ref, {
          idea: String(input.idea ?? ""),
          ...(str(input.title) ? { title: str(input.title)! } : {}),
          ...(typeof input.effort === "string" ? { effort: input.effort as StudioState["effort"] } : {}),
          ...(typeof input.aspect === "string" ? { aspect: input.aspect as StudioState["format"]["aspect"] } : {}),
          ...(typeof input.durationSec === "number" ? { durationSec: input.durationSec } : {}),
          ...(str(input.audioPath, 500) ? { audioPath: str(input.audioPath, 500)! } : {}),
          ...(input.lyricsOverlay === true ? { lyricsOverlay: true } : {}),
          ...(str(input.style, 600) ? { style: str(input.style, 600)! } : {}),
          ...(str(input.mood, 300) ? { mood: str(input.mood, 300)! } : {}),
          ...(typeof input.mediaKind === "string" ? { mediaKind: input.mediaKind as StudioInit["mediaKind"] } : {}),
          ...(typeof input.dimension === "string" ? { dimension: input.dimension as StudioInit["dimension"] } : {}),
          ...(Array.isArray(input.moods) ? { moods: input.moods.map(String) } : {}),
          ...(typeof input.autonomy === "string" ? { autonomy: input.autonomy as StudioInit["autonomy"] } : {}),
          ...(input.models && typeof input.models === "object" && !Array.isArray(input.models) ? { models: input.models as StudioInit["models"] } : {}),
          ...(input.delivery && typeof input.delivery === "object" && !Array.isArray(input.delivery) ? { delivery: input.delivery as StudioInit["delivery"] } : {}),
        }, { reset: input.reset === true });
        return json({ created, studio: stateView(state, service) });
      },
    ),
    tool(
      "creative_studio_state",
      "Read the studio: stages with readiness criteria, scenes, findings, renders, recent activity and the cost estimate. includeAnalysis=true adds the audio analysis summary (sections, beats, key, lyrics).",
      { includeAnalysis: { type: "boolean" } },
      [],
      false,
      async (input, ctx) => {
        const ref = refOf(input, ctx);
        const state = await service.reconcile(ref);
        if (!state) throw Object.assign(new Error(`no studio ${ref.studioId} in this checkout; call creative_studio_init`), { code: "not-found" });
        const analysis = input.includeAnalysis === true ? await store.readAnalysis(ref) : null;
        return json({ studio: stateView(state, service), ...(analysis ? { analysis: summarizeAnalysis(analysis) } : {}) });
      },
    ),
    tool(
      "creative_studio_update",
      "Patch studio state: title, brief, format, effort, styleGuide, scenes (upsert by id; remove:true deletes), sceneOrder, stages {status, note}, findings, activity [{role, message, stage, sceneId}], approve (concept|final), qaRoundCompleted, budgetUsd, models. Setting a stage to done is refused until its criteria hold.",
      {
        patch: {
          type: "object",
          description: "StudioPatch. scenes: [{id, title, start, end, renderer: canvas2d|svg|three, description, section, transition: {kind: cut|fade|flash|wipe, duration}, status: planned|building|ready|needs-fix|approved, owner, notes}]. stages: {brief|concept|production|assembly|review|export: {status: pending|active|awaiting-approval|done|blocked|skipped, note}}.",
        },
        role: { type: "string", enum: [...ROLE_IDS], description: "Default role for activity entries." },
      },
      ["patch"],
      true,
      async (input, ctx) => {
        const ref = refOf(input, ctx);
        const patch = input.patch;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw invalid("patch must be an object");
        const role = typeof input.role === "string" && (ROLE_IDS as readonly string[]).includes(input.role) ? input.role as RoleId : undefined;
        const state = await store.update(ref, (current) => applyStudioPatch(current, patch as StudioPatch, {
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(role ? { defaultRole: role } : {}),
        }));
        return json({ studio: stateView(state, service) });
      },
    ),
    tool(
      "creative_audio_analyze",
      "Analyze the studio song (or audioPath): BPM, beats, downbeats, sections with repetition groups, key, accents, loudness/band curves, instrument presence lanes and timed lyrics. Provide lyricsPath (.lrc for exact timing, .txt for estimated timing) or lyricsText; transcribe=true uses the user's configured dictation engine, which may be a paid cloud service.",
      {
        audioPath: { type: "string" },
        lyricsPath: { type: "string" },
        lyricsText: { type: "string", maxLength: 20000 },
        transcribe: { type: "boolean" },
        language: { type: "string", maxLength: 16 },
      },
      [],
      true,
      async (input, ctx) => {
        const ref = refOf(input, ctx);
        const summary = await service.analyze(ref, {
          ...(str(input.audioPath, 500) ? { audioPath: str(input.audioPath, 500)! } : {}),
          ...(str(input.lyricsPath, 500) ? { lyricsPath: str(input.lyricsPath, 500)! } : {}),
          ...(str(input.lyricsText, 20000) ? { lyricsText: str(input.lyricsText, 20000)! } : {}),
          ...(input.transcribe === true ? { transcribe: true } : {}),
          ...(str(input.language, 16) ? { language: str(input.language, 16)! } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return json(summary);
      },
    ),
    tool(
      "creative_scene_write",
      "Write the code of one scene (scenes/<sceneId>.js, ES module with export default { setup?, draw }, no imports). Bumps the scene revision, marks it ready and, unless renderStill=false, renders its still right away and returns runtime errors and QA notes to fix.",
      {
        sceneId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$" },
        code: { type: "string", minLength: 1, maxLength: 200000 },
        renderStill: { type: "boolean" },
        note: { type: "string", maxLength: 300, description: "Activity note shown to the user." },
      },
      ["sceneId", "code"],
      true,
      async (input, ctx) => {
        const ref = refOf(input, ctx);
        const sceneId = String(input.sceneId ?? "");
        if (!isSceneId(sceneId)) throw invalid("invalid sceneId");
        const state = await store.require(ref);
        if (!state.scenes.some((scene) => scene.id === sceneId)) throw invalid(`scene ${sceneId} is not in the storyboard; add it with creative_studio_update first`);
        await store.writeScene(ref, sceneId, String(input.code ?? ""));
        const updated = await store.update(ref, (current) => {
          const scene = current.scenes.find((candidate) => candidate.id === sceneId);
          if (scene) {
            scene.revision += 1;
            scene.hasCode = true;
            if (scene.status === "planned" || scene.status === "building" || scene.status === "needs-fix") scene.status = "ready";
            delete scene.lastError;
          }
          pushActivity(current, {
            at: Date.now(), role: "builder", stage: "production", sceneId,
            message: str(input.note, 300) || `Scene ${sceneId} written (revision ${scene?.revision ?? "?"})`,
            ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          });
          return current;
        });
        const scene = updated.scenes.find((candidate) => candidate.id === sceneId)!;
        if (input.renderStill === false) return json({ sceneId, revision: scene.revision, file: studioPaths(ref.studioId).scene(sceneId) });
        const result = await service.renderStills(ref, { sceneIds: [sceneId], ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return json({
          sceneId,
          revision: scene.revision,
          still: result.scenes[0]?.still,
          errors: result.errors,
          findings: result.findings,
          ok: result.errors.length === 0 && !result.findings.some((finding) => finding.severity === "error"),
        });
      },
    ),
    tool(
      "creative_render",
      "Render the studio. kind=stills waits and writes one still per scene, a contact sheet and automatic QA findings (blank, frozen, dark, runtime errors). kind=preview (low-res with audio) or final (full quality) starts a background job and returns its id; use creative_render_wait.",
      {
        kind: { type: "string", enum: ["stills", "preview", "final"] },
        sceneIds: { type: "array", items: { type: "string" }, maxItems: 60, description: "stills only: limit to these scenes." },
      },
      ["kind"],
      true,
      async (input, ctx) => {
        const ref = refOf(input, ctx);
        const kind = String(input.kind);
        if (kind === "stills") {
          const sceneIds = Array.isArray(input.sceneIds) ? input.sceneIds.map(String).filter(isSceneId) : undefined;
          const result = await service.renderStills(ref, { ...(sceneIds?.length ? { sceneIds } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
          return json(result);
        }
        if (kind !== "preview" && kind !== "final") throw invalid("kind must be stills, preview or final");
        const job = await service.startRender(ref, kind);
        return json({ job, next: "Call creative_render_wait with this jobId; the user sees live progress meanwhile." });
      },
    ),
    tool(
      "creative_render_wait",
      "Wait for a preview/final render job (default: the latest) for up to timeoutSec (default 120, max 240). Returns the job with progress, output path, runtime errors and status.",
      { jobId: { type: "string" }, timeoutSec: { type: "number", minimum: 1, maximum: 240 } },
      [],
      false,
      async (input, ctx) => {
        const ref = refOf(input, ctx);
        const timeout = Math.min(240, Math.max(1, Number(input.timeoutSec ?? 120))) * 1000;
        const job = await service.waitRender(ref, str(input.jobId, 40), timeout);
        if (!job) throw Object.assign(new Error("no render job found"), { code: "not-found" });
        const state = await store.read(ref);
        return json({ job, openFindings: state?.findings.filter((finding) => finding.status === "open").slice(-20) ?? [] });
      },
    ),
    tool(
      "creative_report_write",
      "Write the delivery report (Markdown) to the studio's reportPath (default report.md): what you made and the idea, how you made it, what you checked, and what you could not do. Only state what you verified; you cannot hear audio or watch video.",
      { markdown: { type: "string", minLength: 40, maxLength: 60000 } },
      ["markdown"],
      true,
      async (input, ctx) => {
        const ref = refOf(input, ctx);
        const state = await store.require(ref);
        const target = state.delivery?.reportPath ?? "report.md";
        await store.writeBinary(ref, target, new TextEncoder().encode(String(input.markdown ?? "").trimEnd() + "\n"));
        const updated = await store.update(ref, (current) => {
          current.reportWrittenAt = Date.now();
          pushActivity(current, { at: Date.now(), role: "orchestrator", stage: "export", message: `Report written to ${target}`, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}) });
          return current;
        });
        return json({ path: target, criteria: stageCriteria(updated, "export") });
      },
    ),
    tool(
      "creative_render_cancel",
      "Cancel the running preview/final render of this studio (or a specific jobId).",
      { jobId: { type: "string" } },
      [],
      true,
      async (input, ctx) => json({ cancelled: await service.cancelRender(refOf(input, ctx), str(input.jobId, 40)) }),
    ),
  ];
}
