// Creative Studio — browser-safe contract shared by the server tools, the
// render runtime and the studio surface. No Node imports here.
//
// One studio belongs to one canonical session (the "studio session"). Its
// files live in that session's checkout under `.polyth/creative-studio/<id>/`,
// so delegated child sessions that share the checkout can work on the same
// studio by passing its id. `studio.json` is the single durable state file;
// every write goes through the server store (tools and package routes), which
// validates and serializes it.

export const CREATIVE_STUDIO_PACKAGE_ID = "creative-studio";
export const CREATIVE_STUDIO_PURPOSE = "creative-studio";
export const CREATIVE_STUDIO_SKILL_NAME = "polyth-creative-studio";
export const STUDIO_ROOT = ".polyth/creative-studio";
export const STUDIO_STATE_VERSION = 1;

/** Canonical session ids are UUIDs: one path segment that cannot escape the root. */
const CANONICAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Scene ids are short slugs so they double as file names. */
const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function normalizeStudioId(value: unknown): string {
  const id = String(value ?? "").trim().toLowerCase();
  if (!CANONICAL_ID.test(id)) {
    throw Object.assign(new Error("studioId must be the studio session's canonical id"), { code: "invalid-input" });
  }
  return id;
}

export function isSceneId(value: unknown): value is string {
  return typeof value === "string" && SCENE_ID.test(value);
}

export const studioPaths = (studioId: string) => {
  const dir = `${STUDIO_ROOT}/${normalizeStudioId(studioId)}`;
  return {
    dir,
    state: `${dir}/studio.json`,
    audioDir: `${dir}/audio`,
    analysis: `${dir}/audio/analysis.json`,
    scenesDir: `${dir}/scenes`,
    scene: (sceneId: string) => {
      if (!isSceneId(sceneId)) throw Object.assign(new Error(`invalid scene id: ${sceneId}`), { code: "invalid-input" });
      return `${dir}/scenes/${sceneId}.js`;
    },
    stillsDir: `${dir}/stills`,
    still: (sceneId: string) => `${dir}/stills/${sceneId}.jpg`,
    contactSheet: `${dir}/stills/contact-sheet.jpg`,
    rendersDir: `${dir}/renders`,
    liveFrame: `${dir}/renders/live.jpg`,
    render: (kind: "preview" | "final") => `${dir}/renders/${kind}.mp4`,
  };
};

// ------------------------------------------------------------------ model

export const STAGE_IDS = ["brief", "concept", "production", "assembly", "review", "export"] as const;
export type StageId = typeof STAGE_IDS[number];
export const STAGE_STATUSES = ["pending", "active", "awaiting-approval", "done", "blocked", "skipped"] as const;
export type StageStatus = typeof STAGE_STATUSES[number];

export const EFFORT_IDS = ["sketch", "balanced", "max"] as const;
export type EffortId = typeof EFFORT_IDS[number];
export const ASPECT_IDS = ["16:9", "9:16", "1:1"] as const;
export type AspectId = typeof ASPECT_IDS[number];
export const DURATION_PRESETS = [15, 60, 180] as const;

/** What kind of media the studio makes. Drives presets and the brief. */
export const MEDIA_KINDS = ["story", "dance", "lyric", "visualizer", "teaser"] as const;
export type MediaKind = typeof MEDIA_KINDS[number];
export const VISUAL_DIMENSIONS = ["2d", "3d", "mixed"] as const;
export type VisualDimension = typeof VISUAL_DIMENSIONS[number];
/** checkpoints = the user approves the storyboard; autonomous = deliver without stopping. */
export const AUTONOMY_MODES = ["checkpoints", "autonomous"] as const;
export type AutonomyMode = typeof AUTONOMY_MODES[number];
export const DELIVERY_HEIGHTS = [720, 1080, 1440, 2160] as const;
export const DELIVERY_FPS = [24, 30, 60] as const;

export const RENDERER_KINDS = ["canvas2d", "svg", "three"] as const;
export type RendererKind = typeof RENDERER_KINDS[number];
export const SCENE_STATUSES = ["planned", "building", "ready", "needs-fix", "approved"] as const;
export type SceneStatus = typeof SCENE_STATUSES[number];
export const TRANSITION_KINDS = ["cut", "fade", "flash", "wipe"] as const;
export type TransitionKind = typeof TRANSITION_KINDS[number];

/** Logical roles. They label who did a piece of work in the activity feed;
 * they are not processes. `orchestrator` is the studio session itself. */
export const ROLE_IDS = ["orchestrator", "planner", "art", "builder", "reviewer", "user", "system"] as const;
export type RoleId = typeof ROLE_IDS[number];

export interface StudioBrief {
  idea: string;
  audience?: string;
  mood?: string;
  style?: string;
  mustHave?: string[];
  avoid?: string[];
}

export interface StudioFormat {
  aspect: AspectId;
  durationSec: number;
  /** Burn timed lyrics into the frame. */
  lyricsOverlay?: boolean;
}

export interface StyleGuide {
  palette: string[];
  background?: string;
  typography?: string;
  motifs?: string[];
  characters?: string[];
  rules?: string[];
}

export interface StudioScene {
  id: string;
  title: string;
  start: number;
  end: number;
  renderer: RendererKind;
  description: string;
  section?: string;
  transition?: { kind: TransitionKind; duration: number };
  status: SceneStatus;
  /** Bumped by the server whenever the scene file is written through the tools. */
  revision: number;
  /** True once `scenes/<id>.js` exists. Maintained by the server. */
  hasCode?: boolean;
  /** Revision whose still is on disk. Maintained by the render tool. */
  stillRevision?: number;
  owner?: string;
  notes?: string;
  lastError?: string;
}

export interface StageState {
  status: StageStatus;
  note?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type RenderKind = "stills" | "preview" | "final";
export type RenderStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface RenderJob {
  id: string;
  kind: RenderKind;
  status: RenderStatus;
  progress: number;
  framesDone: number;
  framesTotal: number;
  width: number;
  height: number;
  fps: number;
  startedAt: number;
  heartbeatAt: number;
  finishedAt?: number;
  output?: string;
  /** Scene revisions this render was made from. */
  sceneRevisions?: Record<string, number>;
  error?: string;
  sceneErrors?: Array<{ sceneId: string; message: string }>;
  verification?: RenderVerification;
  /** Checkout-relative delivery copy written after a verified final. */
  delivered?: string;
}

export type FindingSeverity = "info" | "warn" | "error";
export interface QaFinding {
  id: string;
  severity: FindingSeverity;
  message: string;
  sceneId?: string;
  time?: number;
  source: "qa" | "review" | "user";
  status: "open" | "fixed" | "dismissed";
  at: number;
}

export interface ActivityEntry {
  at: number;
  role: RoleId;
  message: string;
  stage?: StageId;
  sceneId?: string;
  /** Session that did the work (delegated child or the studio session). */
  sessionId?: string;
}

/** How the finished video is delivered. Absent = effort profile defaults. */
export interface StudioDelivery {
  /** Short side in pixels (1080 → 1920×1080 at 16:9). */
  height: number;
  fps: number;
  /** The video lasts exactly as long as the song file. */
  matchSongLength: boolean;
  /** Checkout-relative copy of the final video, e.g. final/music-video.mp4. */
  outputPath?: string;
  /** Checkout-relative report the agent must write, e.g. report.md. */
  reportPath?: string;
}

/**
 * Work parts a studio can route to their own model. They are the agent work
 * the studio skill splits between the orchestrator session and delegated
 * children, not render stages: `plan` writes the style guide and storyboard,
 * `descriptions` writes per-scene descriptions, `code` writes scene modules,
 * `review` runs the QA rounds, `report` writes the delivery report.
 */
export const STUDIO_WORK_ROLES = ["plan", "descriptions", "code", "review", "report"] as const;
export type StudioWorkRole = typeof STUDIO_WORK_ROLES[number];

/**
 * One model route inside a studio. Mirrors `HarnessModelRef` so it survives a
 * round trip through the brief and into `agent.spawn`, but stays browser-safe
 * (this module must not import Node-only package roots).
 */
export interface StudioModelRef {
  harnessId: string;
  providerID: string;
  modelID: string;
  /** Named reasoning variant advertised by that harness for that model. */
  variant?: string;
}

/**
 * Studio model settings. `default` is the route the studio session itself
 * runs on (the wizard applies it to the chat's draft execution config before
 * the brief is sent). `roles` is the optional Expert routing table: a work
 * part without an entry follows `default`, and the brief tells the agent to
 * spawn that part's workers on the listed route.
 */
export interface StudioModels {
  default?: StudioModelRef;
  roles?: Partial<Record<StudioWorkRole, StudioModelRef>>;
}

/** Server check of a finished final render (ffprobe). */
export interface RenderVerification {
  ok: boolean;
  durationSec: number;
  songSec?: number;
  videoCodec?: string;
  pixelFormat?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  problems: string[];
}

export interface StudioAudio {
  path: string;
  name?: string;
  analyzedAt?: number;
  durationSec?: number;
  bpm?: number;
  key?: string;
  lyricsPath?: string;
}

export interface StudioState {
  version: number;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  brief: StudioBrief;
  format: StudioFormat;
  effort: EffortId;
  audio?: StudioAudio;
  styleGuide?: StyleGuide;
  stages: Record<StageId, StageState>;
  scenes: StudioScene[];
  renders: RenderJob[];
  findings: QaFinding[];
  activity: ActivityEntry[];
  approvals: { concept?: number; final?: number };
  qaRounds: number;
  /** Optional spending ceiling the user set, in US dollars. */
  budgetUsd?: number;
  /** Model route for the studio session and, in Expert mode, per work part. */
  models?: StudioModels;
  mediaKind?: MediaKind;
  dimension?: VisualDimension;
  moods?: string[];
  autonomy: AutonomyMode;
  delivery?: StudioDelivery;
  /** Set by the server when the report file is written through the tool. */
  reportWrittenAt?: number;
}

// --------------------------------------------------------------- profiles

export interface EffortProfile {
  id: EffortId;
  /** Final render height for 16:9; other aspects keep the same pixel budget. */
  finalHeight: number;
  finalFps: number;
  previewHeight: number;
  previewFps: number;
  /** Rough scenes per minute of music. */
  scenesPerMinute: number;
  /** Max concurrent delegated scene builders. 1 = no delegation. */
  maxParallelBuilders: number;
  qaRounds: number;
  /** User must approve the storyboard before production. */
  conceptApproval: boolean;
  /** Alternative concepts to propose before the storyboard. */
  conceptVariants: number;
}

export const EFFORT_PROFILES: Readonly<Record<EffortId, EffortProfile>> = {
  sketch: {
    id: "sketch", finalHeight: 720, finalFps: 24, previewHeight: 270, previewFps: 12,
    scenesPerMinute: 4, maxParallelBuilders: 1, qaRounds: 0, conceptApproval: false, conceptVariants: 1,
  },
  balanced: {
    id: "balanced", finalHeight: 1080, finalFps: 30, previewHeight: 360, previewFps: 15,
    scenesPerMinute: 8, maxParallelBuilders: 3, qaRounds: 1, conceptApproval: true, conceptVariants: 1,
  },
  max: {
    id: "max", finalHeight: 1080, finalFps: 30, previewHeight: 360, previewFps: 15,
    scenesPerMinute: 12, maxParallelBuilders: 6, qaRounds: 2, conceptApproval: true, conceptVariants: 3,
  },
};

/** Even pixel dimensions (H.264 needs them) for an aspect at a given short side. */
export function frameSize(aspect: AspectId, height: number): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (aspect === "9:16") return { width: even(height), height: even(height * 16 / 9) };
  if (aspect === "1:1") return { width: even(height), height: even(height) };
  return { width: even(height * 16 / 9), height: even(height) };
}

export interface CostEstimate {
  scenes: number;
  /** Model tokens for the whole project, input + output, as a range. */
  tokens: [number, number];
  /** Agent turns including delegated children. */
  agentTurns: [number, number];
  /** Wall-clock minutes for agent work plus renders. */
  minutes: [number, number];
  renderMinutes: number;
  parallelBuilders: number;
}

/**
 * Heuristic planning estimate. It is deliberately a range: real cost depends
 * on the model, the harness and how many revisions the user asks for. The UI
 * labels it as an estimate and shows the studio session's measured usage
 * next to it.
 */
export function estimateCost(input: { effort: EffortId; durationSec: number; scenes?: number }): CostEstimate {
  const profile = EFFORT_PROFILES[input.effort];
  const minutesOfMusic = Math.max(0.1, input.durationSec / 60);
  const scenes = Math.max(1, input.scenes ?? Math.round(profile.scenesPerMinute * minutesOfMusic));
  const perScene = { sketch: [9_000, 18_000], balanced: [18_000, 40_000], max: [35_000, 80_000] }[input.effort];
  const fixed = { sketch: [25_000, 45_000], balanced: [60_000, 110_000], max: [120_000, 220_000] }[input.effort];
  const reviewFactor = 1 + profile.qaRounds * 0.25;
  const tokens: [number, number] = [
    Math.round((fixed[0]! + perScene[0]! * scenes) * reviewFactor),
    Math.round((fixed[1]! + perScene[1]! * scenes) * reviewFactor * (1 + (profile.conceptVariants - 1) * 0.15)),
  ];
  const parallelBuilders = Math.min(profile.maxParallelBuilders, scenes);
  const turnsPerScene = 2 + profile.qaRounds;
  const agentTurns: [number, number] = [
    Math.round(4 + scenes * turnsPerScene * 0.8),
    Math.round(8 + scenes * turnsPerScene * 1.6),
  ];
  // Frames rendered in software: final + one preview per QA round.
  const finalFrames = input.durationSec * profile.finalFps * (profile.finalHeight >= 1080 ? 2.2 : 1);
  const previewFrames = input.durationSec * profile.previewFps * 0.35 * Math.max(1, profile.qaRounds);
  const renderMinutes = Math.round(((finalFrames + previewFrames) * 0.06) / 60 * 10) / 10;
  const agentMinutes = scenes * turnsPerScene * 1.2 / Math.max(1, parallelBuilders);
  const minutes: [number, number] = [
    Math.round(agentMinutes * 0.7 + renderMinutes + 3),
    Math.round(agentMinutes * 1.8 + renderMinutes * 1.5 + 8),
  ];
  return { scenes, tokens, agentTurns, minutes, renderMinutes, parallelBuilders };
}

/** Video length: the chosen duration, cut short by a shorter song. The video
 * always starts at 0:00 of the track. */
export function effectiveDuration(state: Pick<StudioState, "format" | "audio"> & { delivery?: StudioDelivery }): number {
  const audio = state.audio?.durationSec;
  if (audio && audio > 0 && state.delivery?.matchSongLength) return audio;
  return audio && audio > 0 ? Math.min(state.format.durationSec, audio) : state.format.durationSec;
}

/** Final render size and rate: the user's delivery spec, else the effort profile. */
export function finalSpec(state: Pick<StudioState, "effort" | "format"> & { delivery?: StudioDelivery }): { width: number; height: number; fps: number } {
  const profile = EFFORT_PROFILES[state.effort];
  const size = frameSize(state.format.aspect, state.delivery?.height ?? profile.finalHeight);
  return { ...size, fps: state.delivery?.fps ?? profile.finalFps };
}

/** Whether the storyboard waits for the user. */
export const needsConceptApproval = (state: Pick<StudioState, "effort" | "autonomy">): boolean =>
  EFFORT_PROFILES[state.effort].conceptApproval && state.autonomy !== "autonomous";

// -------------------------------------------------------------- criteria

export interface Criterion { id: string; met: boolean; detail?: string }

const GAP_TOLERANCE = 0.08;

/** Coverage problems of the storyboard timeline. Empty = scenes tile 0..duration. */
export function timelineProblems(scenes: readonly StudioScene[], durationSec: number): string[] {
  const problems: string[] = [];
  const sorted = scenes.toSorted((a, b) => a.start - b.start);
  let cursor = 0;
  for (const scene of sorted) {
    if (scene.end <= scene.start) problems.push(`${scene.id}: ends before it starts`);
    if (scene.start - cursor > GAP_TOLERANCE) problems.push(`gap ${fmtTime(cursor)}–${fmtTime(scene.start)}`);
    if (cursor - scene.start > GAP_TOLERANCE) problems.push(`${scene.id}: overlaps the previous scene`);
    cursor = Math.max(cursor, scene.end);
  }
  if (sorted.length && durationSec - cursor > GAP_TOLERANCE) problems.push(`gap ${fmtTime(cursor)}–${fmtTime(durationSec)}`);
  return problems;
}

const latestRender = (state: StudioState, kind: RenderKind): RenderJob | undefined =>
  state.renders.filter((job) => job.kind === kind).at(-1);

/** Whether a render reflects the current scenes (no scene changed since). */
export function renderIsCurrent(state: StudioState, job: RenderJob | undefined): boolean {
  if (!job || job.status !== "done" || !job.sceneRevisions) return false;
  return state.scenes.every((scene) => job.sceneRevisions?.[scene.id] === scene.revision)
    && Object.keys(job.sceneRevisions).length === state.scenes.length;
}

/**
 * Definition of done per stage, computed from durable state only. The UI shows
 * these as the readiness checklist; the skill tells the agent to satisfy them
 * before marking a stage `done`.
 */
export function stageCriteria(state: StudioState, stage: StageId): Criterion[] {
  const profile = EFFORT_PROFILES[state.effort];
  const scenes = state.scenes;
  switch (stage) {
    case "brief":
      return [
        { id: "idea", met: state.brief.idea.trim().length >= 12 },
        { id: "format", met: state.format.durationSec > 0 },
        { id: "audio", met: Boolean(state.audio?.analyzedAt), ...(state.audio && !state.audio.analyzedAt ? { detail: "not analyzed" } : {}) },
      ];
    case "concept": {
      const problems = timelineProblems(scenes, effectiveDuration(state));
      return [
        { id: "scenes", met: scenes.length > 0 },
        { id: "timeline", met: scenes.length > 0 && problems.length === 0, ...(problems.length ? { detail: problems.slice(0, 3).join("; ") } : {}) },
        { id: "style", met: (state.styleGuide?.palette.length ?? 0) >= 3 },
        { id: "described", met: scenes.length > 0 && scenes.every((scene) => scene.description.trim().length >= 12) },
        ...(needsConceptApproval(state) ? [{ id: "approved", met: Boolean(state.approvals.concept) }] : []),
      ];
    }
    case "production":
      return [
        { id: "code", met: scenes.length > 0 && scenes.every((scene) => scene.hasCode) },
        { id: "stills", met: scenes.length > 0 && scenes.every((scene) => scene.stillRevision === scene.revision) },
        { id: "errors", met: scenes.every((scene) => !scene.lastError) },
      ];
    case "assembly": {
      const preview = latestRender(state, "preview");
      return [
        { id: "preview", met: renderIsCurrent(state, preview) },
        { id: "audio", met: Boolean(state.audio?.path) },
      ];
    }
    case "review":
      return [
        { id: "rounds", met: state.qaRounds >= profile.qaRounds },
        { id: "blocking", met: !state.findings.some((finding) => finding.status === "open" && finding.severity === "error") },
      ];
    case "export": {
      const final = latestRender(state, "final");
      return [
        { id: "final", met: renderIsCurrent(state, final) },
        { id: "verified", met: Boolean(final?.verification?.ok), ...(final?.verification && !final.verification.ok ? { detail: final.verification.problems.slice(0, 2).join("; ") } : {}) },
        ...(state.delivery?.outputPath ? [{ id: "delivered", met: final?.delivered === state.delivery.outputPath }] : []),
        ...(state.delivery?.reportPath ? [{ id: "report", met: Boolean(state.reportWrittenAt) }] : []),
      ];
    }
  }
}

export const stageReady = (state: StudioState, stage: StageId): boolean =>
  stageCriteria(state, stage).every((criterion) => criterion.met);

/** First stage that is not done/skipped — what the studio is working on. */
export function currentStage(state: StudioState): StageId {
  return STAGE_IDS.find((stage) => !["done", "skipped"].includes(state.stages[stage].status)) ?? "export";
}

// ------------------------------------------------------------ construction

export interface StudioInit {
  title?: string;
  idea: string;
  effort?: EffortId;
  aspect?: AspectId;
  durationSec?: number;
  audioPath?: string;
  lyricsOverlay?: boolean;
  style?: string;
  mood?: string;
  mediaKind?: MediaKind;
  dimension?: VisualDimension;
  moods?: string[];
  autonomy?: AutonomyMode;
  /** Model route for the studio session, and optionally per work part. */
  models?: StudioModels | null;
  delivery?: Partial<StudioDelivery>;
}

const HARNESS_ID = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Validate one model route. Harness and provider/model ids come from the live
 * catalog the picker read; this only rejects junk and bounds the strings, so a
 * route is never silently rewritten into a lookalike.
 */
export function normalizeStudioModelRef(input: unknown): StudioModelRef | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const harnessId = typeof raw.harnessId === "string" ? raw.harnessId.trim().toLowerCase() : "";
  const providerID = typeof raw.providerID === "string" ? raw.providerID.trim() : "";
  const modelID = typeof raw.modelID === "string" ? raw.modelID.trim() : "";
  if (!HARNESS_ID.test(harnessId) || !providerID || !modelID) return undefined;
  if (providerID.length > 120 || modelID.length > 200) return undefined;
  const variant = typeof raw.variant === "string" ? raw.variant.trim() : "";
  return {
    harnessId,
    providerID: clip(providerID, 120),
    modelID: clip(modelID, 200),
    ...(variant ? { variant: clip(variant, 60) } : {}),
  };
}

function normalizeStudioModels(input: StudioModels | null | undefined): StudioModels | undefined {
  if (!input) return undefined;
  const model: StudioModels = {};
  const fallback = normalizeStudioModelRef(input.default);
  if (fallback) model.default = fallback;
  const roles: Partial<Record<StudioWorkRole, StudioModelRef>> = {};
  for (const role of STUDIO_WORK_ROLES) {
    const route = normalizeStudioModelRef(input.roles?.[role]);
    if (route) roles[role] = route;
  }
  if (Object.keys(roles).length) model.roles = roles;
  return model.default || model.roles ? model : undefined;
}

/** Spreadable `models` field for `createStudioState`/parse results. */
function modelsField(input: StudioModels | null | undefined): Pick<StudioState, "models"> | Record<string, never> {
  const model = normalizeStudioModels(input);
  return model ? { models: model } : {};
}

/** Two routes point at the same model when harness, provider and id match. */
export function sameStudioModel(left: StudioModelRef | undefined, right: StudioModelRef | undefined): boolean {
  if (!left || !right) return left === right;
  return left.harnessId === right.harnessId && left.providerID === right.providerID && left.modelID === right.modelID;
}

/** "Harness provider/model" — a short, stable label for the brief and the UI. */
export function studioModelLabel(model: StudioModelRef): string {
  return `${model.harnessId} ${model.providerID}/${model.modelID}${model.variant ? ` (${model.variant})` : ""}`;
}

/** Validate a delivery spec; paths must stay inside the checkout. */
export function normalizeDelivery(input: Partial<StudioDelivery> | undefined): StudioDelivery | undefined {
  if (!input) return undefined;
  const height = DELIVERY_HEIGHTS.includes(Number(input.height) as never) ? Number(input.height) : 1080;
  const fps = DELIVERY_FPS.includes(Number(input.fps) as never) ? Number(input.fps) : 30;
  const outputPath = checkoutPath(input.outputPath, /\.mp4$/i, "outputPath");
  const reportPath = checkoutPath(input.reportPath, /\.md$/i, "reportPath");
  return {
    height, fps, matchSongLength: input.matchSongLength !== false,
    ...(outputPath ? { outputPath } : {}),
    ...(reportPath ? { reportPath } : {}),
  };
}

function checkoutPath(value: unknown, extension: RegExp, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const path = String(value).trim().replace(/^\.\//, "");
  const segments = path.split("/");
  if (!path || path.startsWith("/") || path.includes("\\") || segments.some((segment) => !segment || segment === ".." || segment === ".")
    || segments[0] === ".git" || !extension.test(path) || path.length > 200) {
    throw invalid(`${name} must be a relative ${extension.source.replace(/[\\$]/g, "")} path inside this folder`);
  }
  return path;
}

export function createStudioState(studioId: string, init: StudioInit, now = Date.now()): StudioState {
  const stages = Object.fromEntries(STAGE_IDS.map((stage) => [stage, { status: "pending" as StageStatus }])) as Record<StageId, StageState>;
  stages.brief = { status: "active", startedAt: now };
  const idea = clip(init.idea, 4000).trim();
  return {
    version: STUDIO_STATE_VERSION,
    id: normalizeStudioId(studioId),
    title: clip(init.title?.trim() || titleFromIdea(idea), 120),
    createdAt: now,
    updatedAt: now,
    brief: {
      idea,
      ...(init.style ? { style: clip(init.style, 600) } : {}),
      ...(init.mood ? { mood: clip(init.mood, 300) } : {}),
    },
    format: {
      aspect: oneOf(init.aspect, ASPECT_IDS, "16:9"),
      durationSec: clampNumber(init.durationSec ?? 60, 5, 600),
      ...(init.lyricsOverlay ? { lyricsOverlay: true } : {}),
    },
    effort: oneOf(init.effort, EFFORT_IDS, "balanced"),
    autonomy: oneOf(init.autonomy, AUTONOMY_MODES, "checkpoints"),
    ...modelsField(init.models),
    ...(init.mediaKind && MEDIA_KINDS.includes(init.mediaKind) ? { mediaKind: init.mediaKind } : {}),
    ...(init.dimension && VISUAL_DIMENSIONS.includes(init.dimension) ? { dimension: init.dimension } : {}),
    ...(init.moods?.length ? { moods: stringList(init.moods, 8, 40) } : {}),
    ...(init.delivery ? { delivery: normalizeDelivery(init.delivery)! } : {}),
    ...(init.audioPath ? { audio: { path: clip(init.audioPath, 500), name: init.audioPath.split("/").pop() ?? init.audioPath } } : {}),
    stages,
    scenes: [],
    renders: [],
    findings: [],
    activity: [{ at: now, role: "user", message: "Studio created", stage: "brief" }],
    approvals: {},
    qaRounds: 0,
  };
}

function titleFromIdea(idea: string): string {
  const first = idea.split(/[.!?\n]/)[0]?.trim() ?? "";
  return first ? first.slice(0, 60) : "Untitled video";
}

// --------------------------------------------------------------- patching

export const MAX_SCENES = 60;
export const MAX_ACTIVITY = 200;
export const MAX_FINDINGS = 120;
export const MAX_RENDERS = 30;

/** Agent/UI-writable changes. Server-maintained fields (scene revision,
 * hasCode, stillRevision, renders) are not part of the patch. */
export interface StudioPatch {
  title?: string;
  brief?: Partial<StudioBrief>;
  format?: Partial<StudioFormat>;
  effort?: EffortId;
  audio?: { path?: string; lyricsPath?: string } | null;
  styleGuide?: Partial<StyleGuide>;
  /** Upsert by id. `remove: true` deletes the scene. */
  scenes?: Array<Partial<Omit<StudioScene, "revision" | "hasCode" | "stillRevision">> & { id: string; remove?: boolean }>;
  /** Replace the scene order/set: ids not listed are removed. */
  sceneOrder?: string[];
  stages?: Partial<Record<StageId, { status?: StageStatus; note?: string }>>;
  findings?: Array<Partial<QaFinding> & { id?: string; message?: string }>;
  activity?: Array<{ role?: RoleId; message: string; stage?: StageId; sceneId?: string }>;
  approve?: "concept" | "final";
  qaRoundCompleted?: boolean;
  budgetUsd?: number | null;
  /**
   * Model settings. `default` replaces the session route; each key in `roles`
   * replaces that work part's route, and `null` clears it so the part follows
   * `default`. A survey of the whole settings object (no merge) also clears
   * entries the patch omits.
   */
  models?: { default?: StudioModelRef | null; roles?: Partial<Record<StudioWorkRole, StudioModelRef | null>> } | null;
  autonomy?: AutonomyMode;
  mediaKind?: MediaKind;
  dimension?: VisualDimension;
  moods?: string[];
  delivery?: Partial<StudioDelivery> | null;
}

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid-input" });

export function applyStudioPatch(
  state: StudioState,
  patch: StudioPatch,
  options: { now?: number; sessionId?: string; defaultRole?: RoleId } = {},
): StudioState {
  const now = options.now ?? Date.now();
  const next: StudioState = structuredClone(state);
  if (patch.title !== undefined) next.title = clip(String(patch.title), 120).trim() || next.title;
  if (patch.brief) {
    const brief = patch.brief;
    if (brief.idea !== undefined) next.brief.idea = clip(String(brief.idea), 4000);
    for (const key of ["audience", "mood", "style"] as const) {
      if (brief[key] !== undefined) next.brief[key] = clip(String(brief[key]), 600);
    }
    for (const key of ["mustHave", "avoid"] as const) {
      if (brief[key] !== undefined) next.brief[key] = stringList(brief[key], 20, 200);
    }
  }
  if (patch.format) {
    if (patch.format.aspect !== undefined) next.format.aspect = oneOf(patch.format.aspect, ASPECT_IDS, next.format.aspect);
    if (patch.format.durationSec !== undefined) next.format.durationSec = clampNumber(patch.format.durationSec, 5, 600);
    if (patch.format.lyricsOverlay !== undefined) next.format.lyricsOverlay = Boolean(patch.format.lyricsOverlay);
  }
  if (patch.effort !== undefined) next.effort = oneOf(patch.effort, EFFORT_IDS, next.effort);
  if (patch.autonomy !== undefined) next.autonomy = oneOf(patch.autonomy, AUTONOMY_MODES, next.autonomy);
  if (patch.models !== undefined) {
    if (patch.models === null) delete next.models;
    else {
      const model: StudioModels = { ...next.models };
      if (patch.models.default !== undefined) {
        const route = normalizeStudioModelRef(patch.models.default);
        if (route) model.default = route;
        else delete model.default;
      }
      const roles: Partial<Record<StudioWorkRole, StudioModelRef>> = { ...model.roles };
      for (const role of STUDIO_WORK_ROLES) {
        const input = patch.models.roles?.[role];
        if (input === undefined) continue;
        const route = normalizeStudioModelRef(input);
        if (route) roles[role] = route;
        else delete roles[role];
      }
      if (Object.keys(roles).length) model.roles = roles;
      else delete model.roles;
      if (model.default || model.roles) next.models = model;
      else delete next.models;
    }
  }
  if (patch.mediaKind !== undefined && MEDIA_KINDS.includes(patch.mediaKind)) next.mediaKind = patch.mediaKind;
  if (patch.dimension !== undefined && VISUAL_DIMENSIONS.includes(patch.dimension)) next.dimension = patch.dimension;
  if (patch.moods !== undefined) next.moods = stringList(patch.moods, 8, 40);
  if (patch.delivery === null) delete next.delivery;
  else if (patch.delivery) next.delivery = normalizeDelivery({ ...next.delivery, ...patch.delivery });
  if (patch.audio === null) delete next.audio;
  else if (patch.audio) {
    if (patch.audio.path !== undefined) {
      const path = clip(String(patch.audio.path), 500);
      if (next.audio?.path !== path) next.audio = { path, name: path.split("/").pop() ?? path };
    }
    if (patch.audio.lyricsPath !== undefined && next.audio) next.audio.lyricsPath = clip(String(patch.audio.lyricsPath), 500);
  }
  if (patch.styleGuide) {
    const guide: StyleGuide = next.styleGuide ?? { palette: [] };
    const input = patch.styleGuide;
    if (input.palette !== undefined) guide.palette = stringList(input.palette, 12, 40).filter(isCssColor);
    if (input.background !== undefined) guide.background = isCssColor(String(input.background)) ? String(input.background) : guide.background;
    if (input.typography !== undefined) guide.typography = clip(String(input.typography), 300);
    for (const key of ["motifs", "characters", "rules"] as const) {
      if (input[key] !== undefined) guide[key] = stringList(input[key], 16, 300);
    }
    next.styleGuide = guide;
  }
  if (patch.sceneOrder) {
    const order = patch.sceneOrder.filter(isSceneId);
    const byId = new Map(next.scenes.map((scene) => [scene.id, scene]));
    next.scenes = order.flatMap((id) => byId.get(id) ?? []);
  }
  for (const input of patch.scenes ?? []) {
    if (!isSceneId(input.id)) throw invalid(`invalid scene id "${String(input.id)}": use 1-40 lowercase letters, digits or dashes`);
    const index = next.scenes.findIndex((scene) => scene.id === input.id);
    if (input.remove) {
      if (index >= 0) next.scenes.splice(index, 1);
      continue;
    }
    const existing = index >= 0 ? next.scenes[index]! : undefined;
    if (!existing && next.scenes.length >= MAX_SCENES) throw invalid(`a studio holds at most ${MAX_SCENES} scenes`);
    const scene: StudioScene = existing ?? {
      id: input.id, title: input.id, start: 0, end: 0, renderer: "canvas2d", description: "", status: "planned", revision: 0,
    };
    if (input.title !== undefined) scene.title = clip(String(input.title), 120);
    if (input.start !== undefined) scene.start = round3(clampNumber(input.start, 0, 3600));
    if (input.end !== undefined) scene.end = round3(clampNumber(input.end, 0, 3600));
    if (input.renderer !== undefined) scene.renderer = oneOf(input.renderer, RENDERER_KINDS, scene.renderer);
    if (input.description !== undefined) scene.description = clip(String(input.description), 2000);
    if (input.section !== undefined) scene.section = clip(String(input.section), 60);
    if (input.status !== undefined) scene.status = oneOf(input.status, SCENE_STATUSES, scene.status);
    if (input.owner !== undefined) scene.owner = clip(String(input.owner), 80);
    if (input.notes !== undefined) scene.notes = clip(String(input.notes), 1000);
    if (input.transition !== undefined) {
      const transition = input.transition as Partial<StudioScene["transition"]> | null;
      if (!transition) delete scene.transition;
      else scene.transition = {
        kind: oneOf(transition.kind, TRANSITION_KINDS, "fade"),
        duration: round3(clampNumber(transition.duration ?? 0.5, 0, 4)),
      };
    }
    if (!existing) next.scenes.push(scene);
  }
  if (patch.scenes?.length) next.scenes.sort((a, b) => a.start - b.start);
  for (const [stage, change] of Object.entries(patch.stages ?? {}) as Array<[StageId, { status?: StageStatus; note?: string }]>) {
    if (!STAGE_IDS.includes(stage) || !change) continue;
    const current = next.stages[stage];
    if (change.status !== undefined) {
      const status = oneOf(change.status, STAGE_STATUSES, current.status);
      if (status === "done" && !stageReady(next, stage)) {
        const missing = stageCriteria(next, stage).filter((criterion) => !criterion.met).map((criterion) => criterion.id + (criterion.detail ? ` (${criterion.detail})` : ""));
        throw invalid(`stage "${stage}" is not ready: ${missing.join(", ")}`);
      }
      if (status !== current.status) {
        if (status === "active" && !current.startedAt) current.startedAt = now;
        if (status === "done" || status === "skipped") current.finishedAt = now;
        current.status = status;
      }
    }
    if (change.note !== undefined) current.note = clip(String(change.note), 500);
  }
  if (patch.approve === "concept") next.approvals.concept = now;
  if (patch.approve === "final") next.approvals.final = now;
  if (patch.qaRoundCompleted) next.qaRounds += 1;
  if (patch.budgetUsd !== undefined) {
    if (patch.budgetUsd === null) delete next.budgetUsd;
    else next.budgetUsd = clampNumber(patch.budgetUsd, 0, 10_000);
  }
  for (const input of patch.findings ?? []) {
    const existing = input.id ? next.findings.find((finding) => finding.id === input.id) : undefined;
    if (existing) {
      if (input.status) existing.status = oneOf(input.status, ["open", "fixed", "dismissed"] as const, existing.status);
      if (input.message) existing.message = clip(String(input.message), 500);
      continue;
    }
    if (!input.message) continue;
    next.findings.push({
      id: input.id && /^[a-z0-9-]{1,40}$/.test(input.id) ? input.id : `f-${now.toString(36)}-${next.findings.length}`,
      severity: oneOf(input.severity, ["info", "warn", "error"] as const, "warn"),
      message: clip(String(input.message), 500),
      ...(isSceneId(input.sceneId) ? { sceneId: input.sceneId } : {}),
      ...(typeof input.time === "number" && Number.isFinite(input.time) ? { time: round3(input.time) } : {}),
      source: oneOf(input.source, ["qa", "review", "user"] as const, "review"),
      status: oneOf(input.status, ["open", "fixed", "dismissed"] as const, "open"),
      at: now,
    });
  }
  if (next.findings.length > MAX_FINDINGS) next.findings = next.findings.slice(-MAX_FINDINGS);
  for (const entry of patch.activity ?? []) {
    if (!entry?.message) continue;
    pushActivity(next, {
      at: now,
      role: oneOf(entry.role, ROLE_IDS, options.defaultRole ?? "orchestrator"),
      message: clip(String(entry.message), 400),
      ...(entry.stage && STAGE_IDS.includes(entry.stage) ? { stage: entry.stage } : {}),
      ...(isSceneId(entry.sceneId) ? { sceneId: entry.sceneId } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    });
  }
  next.updatedAt = now;
  return next;
}

export function pushActivity(state: StudioState, entry: ActivityEntry): void {
  state.activity.push(entry);
  if (state.activity.length > MAX_ACTIVITY) state.activity.splice(0, state.activity.length - MAX_ACTIVITY);
}

/** Parse untrusted JSON from disk. Unknown/missing fields get safe defaults so
 * an older or hand-edited file never crashes the UI. */
export function parseStudioState(text: string, studioId?: string): StudioState {
  const raw = JSON.parse(text) as Partial<StudioState>;
  if (!raw || typeof raw !== "object") throw invalid("studio.json is not an object");
  const id = normalizeStudioId(raw.id ?? studioId);
  const base = createStudioState(id, { idea: typeof raw.brief?.idea === "string" ? raw.brief.idea : "" }, Number(raw.createdAt) || 0);
  const stages = { ...base.stages };
  for (const stage of STAGE_IDS) {
    const value = raw.stages?.[stage];
    if (value && STAGE_STATUSES.includes(value.status)) stages[stage] = { ...value };
  }
  return {
    ...base,
    ...raw,
    id,
    title: typeof raw.title === "string" ? raw.title : base.title,
    brief: { ...base.brief, ...(raw.brief ?? {}) },
    format: { ...base.format, ...(raw.format ?? {}) },
    effort: oneOf(raw.effort, EFFORT_IDS, "balanced"),
    stages,
    scenes: Array.isArray(raw.scenes) ? raw.scenes.filter((scene) => isSceneId(scene?.id)) : [],
    renders: Array.isArray(raw.renders) ? raw.renders : [],
    findings: Array.isArray(raw.findings) ? raw.findings : [],
    activity: Array.isArray(raw.activity) ? raw.activity : [],
    approvals: raw.approvals && typeof raw.approvals === "object" ? raw.approvals : {},
    autonomy: oneOf(raw.autonomy, AUTONOMY_MODES, "checkpoints"),
    ...modelsField(raw.models),
    qaRounds: Number(raw.qaRounds) || 0,
  };
}

// ---------------------------------------------------------------- prompts

/** Prompt the UI inserts when the user asks to rework one scene. */
export function sceneReworkPrompt(scene: Pick<StudioScene, "id" | "title" | "start" | "end">): string {
  return `[Creative Studio] Rework scene "${scene.title}" (${scene.id}, ${fmtTime(scene.start)}–${fmtTime(scene.end)}): `;
}

/** Per-turn model context for a Creative Studio session. */
export function studioTurnContext(session: { id: string }): string {
  const paths = studioPaths(session.id);
  return [
    "Creative Studio session. This chat owns one studio:",
    `studioId: ${session.id}`,
    `state: ${paths.state} (write it only through creative_studio_* tools)`,
    `scene code: ${paths.scenesDir}/<scene-id>.js (write with creative_scene_write)`,
    `Load the ${CREATIVE_STUDIO_SKILL_NAME} skill before working on the video and follow its stages, criteria and scene API.`,
    "Keep studio state current: stage statuses, scenes, activity entries for visible progress. The user works in the Studio, which usually covers this chat, so keep chat replies to a sentence or two.",
    "For clearly unrelated requests, behave normally.",
  ].join("\n");
}

// ---------------------------------------------------------------- helpers

export function fmtTime(seconds: number): string {
  const value = Math.max(0, seconds);
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest.toFixed(rest % 1 ? 1 : 0)}`;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function clampNumber(value: unknown, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw invalid(`expected a number between ${min} and ${max}`);
  return Math.min(max, Math.max(min, number));
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return typeof value === "string" && value.trim() ? [clip(value.trim(), maxLength)] : [];
  return value.map((item) => clip(String(item ?? "").trim(), maxLength)).filter(Boolean).slice(0, maxItems);
}

/** Colors end up in CSS and canvas fills: accept only plain, inert forms. */
export function isCssColor(value: string): boolean {
  return /^#[0-9a-f]{3,8}$/i.test(value)
    || /^(rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/+-]+\)$/i.test(value)
    || /^[a-z]{3,20}$/i.test(value);
}
