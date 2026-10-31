// The wizard's model and the brief it generates. Browser-safe and pure, so the
// UI previews exactly the text the agent will receive, and tests pin it.
//
// The brief follows the shape of a good hand-written production request:
// what to make, the song and its notes, the exact deliverable, the working
// mode, the rules, how to verify, and the report. Every section is derived from
// the spec; nothing is hard-coded per user.
import {
  CREATIVE_STUDIO_SKILL_NAME,
  fmtTime,
  frameSize,
  STUDIO_WORK_ROLES,
  studioModelLabel,
  type AspectId,
  type AutonomyMode,
  type EffortId,
  type MediaKind,
  type StudioInit,
  type StudioModels,
  type StudioWorkRole,
  type VisualDimension,
} from "./index.ts";

export const USER_LEVELS = ["quick", "guided", "expert"] as const;
export type UserLevel = typeof USER_LEVELS[number];

export const MOOD_IDS = ["energetic", "dreamy", "dark", "playful", "epic", "minimal", "nostalgic", "surreal"] as const;
export type MoodId = typeof MOOD_IDS[number];

export interface MediaRules {
  /** Keep every file inside this project folder. */
  keepInFolder: boolean;
  /** Only free tools already installed on this machine. */
  installedToolsOnly: boolean;
  /** No downloaded footage or artwork. */
  noDownloadedAssets: boolean;
  /** Fonts must be open-licensed with the licence file kept. */
  openFonts: boolean;
  /** The agent cannot hear or watch; it must not claim to. */
  honestPerception: boolean;
  /** Check the final file plays to the end and stays in sync. */
  verifyPlayback: boolean;
}

export interface MediaSpec {
  kind: MediaKind;
  idea: string;
  dimension: VisualDimension;
  moods: MoodId[];
  styleNotes: string;
  audioPath?: string;
  lyricsPath?: string;
  /** Folder/README describing the song (story, lyrics, measurements). */
  songNotesPath?: string;
  /** README listing tools available on this machine. */
  toolsNotesPath?: string;
  durationMode: "song" | "custom";
  durationSec: number;
  aspect: AspectId;
  height: number;
  fps: number;
  effort: EffortId;
  autonomy: AutonomyMode;
  /** Model for the studio session, and optional Expert per-work-part routes. */
  models: StudioModels;
  lyricsOverlay: boolean;
  outputPath: string;
  report: boolean;
  reportPath: string;
  rules: MediaRules;
  extraInstructions: string;
}

export interface MediaPreset {
  kind: MediaKind;
  dimension: VisualDimension;
  moods: MoodId[];
  lyricsOverlay: boolean;
  aspect: AspectId;
  durationMode: "song" | "custom";
  durationSec: number;
  /** One English sentence describing the deliverable's genre for the brief. */
  genre: string;
}

export const MEDIA_PRESETS: Readonly<Record<MediaKind, MediaPreset>> = {
  story: {
    kind: "story", dimension: "mixed", moods: ["epic"], lyricsOverlay: false, aspect: "16:9", durationMode: "song", durationSec: 180,
    genre: "a full music video like a real official music video that tells a story with characters, a setting and an arc that follows the song",
  },
  dance: {
    kind: "dance", dimension: "mixed", moods: ["energetic"], lyricsOverlay: false, aspect: "16:9", durationMode: "song", durationSec: 180,
    genre: "a full music video like a real official music video with a lot of dance: choreographed characters, crowds or shapes moving exactly on the beat",
  },
  lyric: {
    kind: "lyric", dimension: "2d", moods: ["minimal"], lyricsOverlay: true, aspect: "16:9", durationMode: "song", durationSec: 180,
    genre: "a lyric video where the words are the hero: expressive kinetic typography timed to the vocals",
  },
  visualizer: {
    kind: "visualizer", dimension: "3d", moods: ["dreamy"], lyricsOverlay: false, aspect: "16:9", durationMode: "song", durationSec: 180,
    genre: "an audio visualizer: an evolving abstract world that reacts to beats, bass and energy and changes with every section",
  },
  teaser: {
    kind: "teaser", dimension: "mixed", moods: ["energetic"], lyricsOverlay: false, aspect: "9:16", durationMode: "custom", durationSec: 15,
    genre: "a short vertical teaser for social media built around the song's strongest hook, designed to stop the scroll in the first second",
  },
};

export const DEFAULT_RULES: MediaRules = {
  keepInFolder: true,
  installedToolsOnly: true,
  noDownloadedAssets: true,
  openFonts: true,
  honestPerception: true,
  verifyPlayback: true,
};

export function defaultSpec(kind: MediaKind = "story"): MediaSpec {
  const preset = MEDIA_PRESETS[kind];
  return {
    kind,
    idea: "",
    dimension: preset.dimension,
    moods: [...preset.moods],
    styleNotes: "",
    durationMode: preset.durationMode,
    durationSec: preset.durationSec,
    aspect: preset.aspect,
    height: 1080,
    fps: 30,
    effort: "balanced",
    autonomy: "checkpoints",
    models: {},
    lyricsOverlay: preset.lyricsOverlay,
    outputPath: "final/music-video.mp4",
    report: true,
    reportPath: "report.md",
    rules: { ...DEFAULT_RULES },
    extraInstructions: "",
  };
}

/** Switch media kind: apply the preset's look and format, keep what the user wrote. */
export function applyPreset(spec: MediaSpec, kind: MediaKind): MediaSpec {
  const preset = MEDIA_PRESETS[kind];
  return {
    ...spec,
    kind,
    dimension: preset.dimension,
    moods: [...preset.moods],
    lyricsOverlay: preset.lyricsOverlay,
    aspect: preset.aspect,
    durationMode: preset.durationMode,
    durationSec: preset.durationSec,
    outputPath: kind === "teaser" ? "final/teaser.mp4" : kind === "lyric" ? "final/lyric-video.mp4" : spec.outputPath.startsWith("final/") ? "final/music-video.mp4" : spec.outputPath,
  };
}

export interface SpecProblem { field: keyof MediaSpec; message: "idea" | "duration" | "path" }

export function specProblems(spec: MediaSpec): SpecProblem[] {
  const problems: SpecProblem[] = [];
  if (spec.idea.trim().length < 12) problems.push({ field: "idea", message: "idea" });
  if (spec.durationMode === "custom" && !(spec.durationSec >= 5 && spec.durationSec <= 600)) problems.push({ field: "durationSec", message: "duration" });
  if (!/^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[\w .\/-]+\.mp4$/i.test(spec.outputPath)) problems.push({ field: "outputPath", message: "path" });
  if (spec.report && !/^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[\w .\/-]+\.md$/i.test(spec.reportPath)) problems.push({ field: "reportPath", message: "path" });
  return problems;
}

/** Studio init derived from the spec (what the server stores). */
export function specToInit(spec: MediaSpec): StudioInit {
  return {
    idea: spec.idea.trim(),
    effort: spec.effort,
    aspect: spec.aspect,
    durationSec: spec.durationSec,
    lyricsOverlay: spec.lyricsOverlay,
    mediaKind: spec.kind,
    dimension: spec.dimension,
    moods: spec.moods,
    autonomy: spec.autonomy,
    ...(spec.models.default || spec.models.roles ? { models: spec.models } : {}),
    ...(spec.styleNotes.trim() ? { style: spec.styleNotes.trim() } : {}),
    ...(spec.audioPath ? { audioPath: spec.audioPath } : {}),
    delivery: {
      height: spec.height,
      fps: spec.fps,
      matchSongLength: spec.durationMode === "song",
      outputPath: spec.outputPath,
      ...(spec.report ? { reportPath: spec.reportPath } : {}),
    },
  };
}

const DIMENSION_TEXT: Record<VisualDimension, string> = {
  "2d": "It should be 2D",
  "3d": "It should be 3D",
  mixed: "It can be 2D, 3D or both",
};

export interface BriefOptions {
  studioId?: string;
  /** The studio uploads these right after the brief creates the chat (a
   * studio started without a chat cannot upload before its checkout exists). */
  uploading?: { song?: boolean; lyrics?: boolean };
}

/**
 * The kickoff brief. English on purpose — it is an instruction to an agent;
 * the user's own idea and notes are quoted as written.
 */
export function buildBrief(spec: MediaSpec, options: BriefOptions = {}): string {
  const preset = MEDIA_PRESETS[spec.kind];
  const size = frameSize(spec.aspect, spec.height);
  const lines: string[] = [];
  const add = (...items: string[]) => lines.push(...items);

  add("[Creative Studio] New media", "", "What I want:");
  add(`${capitalize(preset.genre)}, made as motion graphics only. No filmed footage. ${DIMENSION_TEXT[spec.dimension]}. What matters to me is that it's creative and unique.`);
  if (spec.idea.trim()) add("", "My idea:", quote(spec.idea));
  const look = [spec.moods.length ? `Mood: ${spec.moods.join(", ")}.` : "", spec.styleNotes.trim() ? `Look and feel: ${spec.styleNotes.trim()}` : ""].filter(Boolean);
  if (look.length) add("", ...look);

  add("", "The song:");
  add(spec.audioPath
    ? `- The song file is ${spec.audioPath}.`
    : options.uploading?.song
      ? "- The Studio is uploading the song into this studio's audio folder right now. Before analyzing, read creative_studio_state until it lists the song; it takes a few seconds."
      : "- The song will be added in the Studio panel; wait for it before analyzing.");
  if (spec.songNotesPath) add(`- Read ${spec.songNotesPath} first. It explains what the song is about and may include the lyrics and measurements of the music.`);
  if (spec.lyricsPath) add(`- Lyrics: ${spec.lyricsPath}${/\.lrc$/i.test(spec.lyricsPath) ? " (timed)." : "."}`);
  else if (options.uploading?.lyrics) add("- The Studio is adding the lyrics to the same folder; creative_audio_analyze uses them once the studio state lists them.");
  add("- Run creative_audio_analyze for beats, bars, sections, accents, loud and quiet parts, instrument activity and lyric timing; build the timing on that data.");
  if (spec.toolsNotesPath) add(`- ${spec.toolsNotesPath} lists ready-made tools and what is installed on this machine. Using them is optional.`);

  add("", "Deliver:");
  const length = spec.durationMode === "song" ? "the same length as the song file" : `exactly ${fmtTime(spec.durationSec)} long, starting at the beginning of the song`;
  add(`- One finished video: ${spec.outputPath}, ${size.width}×${size.height}, ${spec.fps} fps, H.264 yuv420p with AAC audio, ${length}.`);
  if (spec.lyricsOverlay) add("- Show the lyrics on screen in sync with the vocals.");
  if (spec.report) add(`- ${spec.reportPath}: what you made and the idea behind it, how you made it, what you checked, and anything you could not do.`);

  add("", "How to work:");
  add(spec.autonomy === "autonomous"
    ? "- Work on your own from start to finish. Don't stop to ask me for approval; deliver the finished video."
    : "- Show me the storyboard in the Studio panel and wait for my approval before building scenes. After that, work on your own to the finished video.");
  add(`- Depth: ${spec.effort} (see the skill's effort profiles for scenes, review rounds and parallel builders).`);

  const routing = modelRoutingLines(spec.models);
  if (routing.length) {
    add("", "Models (use agent.models for the live catalog, then pass these routes to agent.spawn):", ...routing);
  }

  const rules = spec.rules;
  const ruleLines = [
    rules.keepInFolder ? "- Keep all your work inside this folder." : "",
    rules.installedToolsOnly ? "- Use only free tools already installed on this machine." : "",
    rules.noDownloadedAssets ? "- Don't download footage or artwork; draw everything in code." : "",
    rules.openFonts ? "- Fonts must be open-licensed (for example OFL), with the licence file kept next to the font." : "",
    rules.honestPerception ? "- You can't hear the audio or watch the video. Don't say you listened to or watched something you didn't; rely on the analysis, stills and contact sheets." : "",
  ].filter(Boolean);
  if (ruleLines.length) add("", "Rules:", ...ruleLines);

  if (rules.verifyPlayback) {
    add("", "Before you finish:", "- Check that the file plays to the end and that the music is in sync with the song file (creative_render_wait reports the server's verification of the final file).");
  }
  if (spec.extraInstructions.trim()) add("", "Also:", spec.extraInstructions.trim());

  const settings = { ...(options.studioId ? { studioId: options.studioId } : {}), ...specToInit(spec) };
  add("", "Studio settings (pass to creative_studio_init unchanged):", "```json", JSON.stringify(settings, null, 2), "```");
  add(`Follow the ${CREATIVE_STUDIO_SKILL_NAME} skill and keep studio state current so I can watch progress.`);
  return lines.join("\n");
}

function quote(text: string): string {
  return text.trim().split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

/** Work-part names as the user reads them in the picker. */
export const WORK_ROLE_LABELS: Readonly<Record<StudioWorkRole, string>> = {
  plan: "plan and storyboard",
  descriptions: "scene descriptions",
  code: "scene code",
  review: "review and fixes",
  report: "delivery report",
};

/**
 * The model section of the brief. One line per work part that has its own
 * route, plus the session default. A part without a route is not listed, so
 * the agent keeps the skill's normal behaviour (the orchestrator's own model,
 * or whatever fits the delegated child).
 */
export function modelRoutingLines(models: StudioModels): string[] {
  const lines: string[] = [];
  if (models.default) lines.push(`- The session itself runs on ${studioModelLabel(models.default)}.`);
  for (const role of STUDIO_WORK_ROLES) {
    const route = models.roles?.[role];
    if (route) lines.push(`- ${WORK_ROLE_LABELS[role]}: ${studioModelLabel(route)}.`);
  }
  if (lines.length) lines.push("- Give each delegated worker its part's route on agent.spawn; do not substitute another model.");
  return lines;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
