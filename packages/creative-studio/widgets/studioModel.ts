// Pure derivations for the studio surface: what the studio is doing, what the
// person should do next and how a request is phrased for the agent. No React,
// so the decisions are unit-tested without rendering.
import { conversationMessages } from "@polyth/session/conversation";
import type { SessionEvent } from "@polyth/contracts";
import {
  currentStage,
  EFFORT_PROFILES,
  effectiveDuration,
  fmtTime,
  needsConceptApproval,
  renderIsCurrent,
  STAGE_IDS,
  stageCriteria,
  type RenderJob,
  type StageId,
  type StudioScene,
  type StudioState,
} from "../src/index.ts";

export const STUDIO_VIEWS = ["scenes", "sound", "export", "review", "progress"] as const;
export type StudioViewId = typeof STUDIO_VIEWS[number];

/** The view that shows the work of a stage. */
export function viewForStage(stage: StageId): StudioViewId {
  switch (stage) {
    case "brief": return "sound";
    case "concept":
    case "production": return "scenes";
    case "review": return "review";
    default: return "export";
  }
}

/** Agent activity as the studio presents it. */
export type AgentState = "working" | "needs-you" | "idle" | "offline";

export interface SessionLike {
  status?: string;
  attention?: { questions?: number; permissions?: number };
}

export function agentState(session: SessionLike | undefined): AgentState {
  if (!session || session.status === "archived") return "offline";
  const asks = (session.attention?.questions ?? 0) + (session.attention?.permissions ?? 0);
  if (session.status === "waiting" || asks > 0) return "needs-you";
  if (session.status === "working" || session.status === "reconciling" || session.status === "epoch-pending") return "working";
  // idle, finished, failed and unknown all wait for the next message; a new
  // send is also the recovery path of an unknown runtime.
  return "idle";
}

/** Bounded progress inside a stage, for the pipeline label and bar. */
export interface StageProgress { done: number; total: number }

export function stageProgress(state: StudioState, stage: StageId): StageProgress {
  const scenes = state.scenes;
  const running = (kind: RenderJob["kind"]) => state.renders.find((job) => job.status === "running" && job.kind === kind);
  switch (stage) {
    case "concept":
      return { done: scenes.filter((scene) => scene.description.trim().length >= 12).length, total: Math.max(scenes.length, 1) };
    case "production":
      return { done: scenes.filter((scene) => scene.hasCode && scene.stillRevision === scene.revision && !scene.lastError).length, total: Math.max(scenes.length, 1) };
    case "assembly": {
      const job = running("preview");
      return job ? { done: Math.round(job.progress * 100), total: 100 } : criteriaProgress(state, stage);
    }
    case "review":
      return { done: Math.min(state.qaRounds, EFFORT_PROFILES[state.effort].qaRounds), total: Math.max(EFFORT_PROFILES[state.effort].qaRounds, 1) };
    case "export": {
      const job = running("final");
      return job ? { done: Math.round(job.progress * 100), total: 100 } : criteriaProgress(state, stage);
    }
    default:
      return criteriaProgress(state, stage);
  }
}

function criteriaProgress(state: StudioState, stage: StageId): StageProgress {
  const criteria = stageCriteria(state, stage);
  return { done: criteria.filter((criterion) => criterion.met).length, total: Math.max(criteria.length, 1) };
}

/** Stages finished or skipped. */
export const stagesDone = (state: StudioState): number =>
  STAGE_IDS.filter((id) => state.stages[id].status === "done" || state.stages[id].status === "skipped").length;

/** The studio is finished: export done with a current, verified final. */
export function isDelivered(state: StudioState): boolean {
  const final = latestDone(state, "final");
  return state.stages.export.status === "done" || Boolean(final && renderIsCurrent(state, final) && final.verification?.ok);
}

export function latestDone(state: StudioState, kind: "preview" | "final"): RenderJob | undefined {
  return state.renders.filter((job) => job.kind === kind && job.status === "done" && job.output).at(-1);
}

export const runningRender = (state: StudioState): RenderJob | undefined =>
  state.renders.find((job) => job.status === "running");

export const openFindings = (state: StudioState) =>
  state.findings.filter((finding) => finding.status === "open")
    .toSorted((a, b) => ["error", "warn", "info"].indexOf(a.severity) - ["error", "warn", "info"].indexOf(b.severity));

export const awaitingApproval = (state: StudioState): boolean =>
  state.stages.concept.status === "awaiting-approval" && !state.approvals.concept && needsConceptApproval(state);

/** The one thing the person should look at now, or null while the agent simply works. */
export type MomentKind = "needs-you" | "approve" | "rendering" | "delivered" | "issues" | "failed" | "paused";

export interface Moment {
  kind: MomentKind;
  /** Values for the copy template of this kind. */
  values: Record<string, string | number>;
  job?: RenderJob;
}

export function nextMoment(state: StudioState, agent: AgentState): Moment | null {
  if (agent === "needs-you") return { kind: "needs-you", values: {} };
  if (awaitingApproval(state)) {
    return { kind: "approve", values: { count: state.scenes.length, length: clockTime(effectiveDuration(state)) } };
  }
  const job = runningRender(state);
  if (job) return { kind: "rendering", values: { percent: Math.round(job.progress * 100) }, job };
  if (isDelivered(state)) {
    const final = latestDone(state, "final");
    return { kind: "delivered", values: { length: clockTime(final?.verification?.durationSec ?? effectiveDuration(state)) }, ...(final ? { job: final } : {}) };
  }
  const errors = openFindings(state).filter((finding) => finding.severity === "error").length;
  if (errors > 0 && agent !== "working") return { kind: "issues", values: { count: errors } };
  const failed = state.renders.at(-1);
  if (failed && failed.status === "failed" && agent !== "working") return { kind: "failed", values: { error: failed.error ?? "" }, job: failed };
  const blocked = STAGE_IDS.find((stage) => state.stages[stage].status === "blocked");
  if (blocked && agent !== "working") return { kind: "failed", values: { error: state.stages[blocked].note ?? "" } };
  if (agent === "idle") return { kind: "paused", values: { stage: currentStage(state) } };
  return null;
}

/** Scene under the playhead (scenes are sorted by start). */
export function sceneAt(scenes: readonly StudioScene[], time: number): StudioScene | undefined {
  let found: StudioScene | undefined;
  for (const scene of scenes) {
    if (scene.start <= time + 1e-6) found = scene;
    else break;
  }
  return found;
}

export const sortedScenes = (state: StudioState): StudioScene[] => state.scenes.toSorted((a, b) => a.start - b.start);

/** Player clock text: whole seconds, never "0:42.7". */
export function clockTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds + 1e-6));
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
}

/** A request typed in the studio, phrased for the agent. */
export function studioRequest(text: string, scene?: Pick<StudioScene, "id" | "title" | "start" | "end"> | null): string {
  const body = text.trim();
  if (!scene) return `[Creative Studio] ${body}`;
  return `[Creative Studio] Change scene "${scene.title}" (${scene.id}, ${fmtTime(scene.start)}–${fmtTime(scene.end)}): ${body}`;
}

export const CONTINUE_REQUEST = "[Creative Studio] Continue the video from where you stopped. Read the studio state first.";
export const fixRequest = (message: string, where?: string) =>
  `[Creative Studio] Fix this issue: ${message}${where ? ` (${where})` : ""}`;

/** What the agent said, newest first: replies the person may not have read
 * in a chat the studio covers. Studio-generated prompts are not repeated. */
export interface AgentNote { id: string; seq: number; text: string; time: number; finalized: boolean }

export function agentNotes(events: readonly SessionEvent[], limit = 4): AgentNote[] {
  if (!events.length) return [];
  return conversationMessages(events)
    .filter((message) => message.role === "assistant" && message.finalized && message.text.trim())
    .slice(-limit)
    .toReversed()
    .map((message) => ({ id: message.id, seq: message.eventSeq, text: message.text.trim(), time: message.time, finalized: message.finalized }));
}
