// UX-MSG-ACTIONS pure module: purpose-and-target action names, copy payloads,
// timestamp formatting inputs, completed-turn footer math, seed provenance,
// and truthful availability presentation. DOM-free; used by Timeline, init,
// drafts, and tests. Copy/disclosure/formatting append no session event.
import type { AttachmentRef } from "@polyth/contracts";
import type { AssistantMsg, RenderModel, TurnState, UserMsg } from "./reduce.ts";
import { fmtCost, fmtTokens } from "./format.ts";

// ---- semantic times ----------------------------------------------------------

/** Valid ISO value for the <time dateTime> attribute. */
export const timeIso = (ms: number): string => new Date(ms).toISOString();

/** Visual short local time (browser locale decides 12/24-hour). */
export function timeShort(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(ms));
}

/** Full local date and time for accessible names. */
export function timeFull(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "medium" }).format(new Date(ms));
}

/** Assistant completion time: the final `assistant/message.time`, never the
 *  first streamed chunk. */
export const assistantTime = (m: AssistantMsg): number => m.completedAt ?? m.time;

// ---- accessible names ----------------------------------------------------------

export const sentName = (ms: number, locale?: string): string => `Sent ${timeFull(ms, locale)}`;
export const completedName = (ms: number, locale?: string): string => `Completed ${timeFull(ms, locale)}`;

export const revertActionName = (ms: number, locale?: string): string =>
  `Revert and edit user message sent ${timeFull(ms, locale)}`;
export const forkActionName = (ms: number, locale?: string): string =>
  `Fork and edit from user message sent ${timeFull(ms, locale)}`;

export function copyActionName(role: "user" | "assistant", format: "markdown" | "json"): string {
  const target = role === "user" ? "user message" : "assistant answer";
  return `Copy ${target} as ${format === "markdown" ? "Markdown" : "JSON"}`;
}

export const COPY_REASONING_NAME = "Copy reasoning for assistant answer";

export const reasoningToggleName = (open: boolean): string =>
  `${open ? "Hide" : "Show"} reasoning for assistant answer`;

/** Persistent touch entry: one named button per actionable message. */
export function actionsMenuName(m: UserMsg | AssistantMsg, locale?: string): string {
  return m.kind === "user"
    ? `Actions for user message sent ${timeFull(m.time, locale)}`
    : `Actions for assistant answer completed ${timeFull(assistantTime(m), locale)}`;
}

/** The single live-region announcement after a copy attempt. */
export function copyAnnouncement(kind: "markdown" | "json" | "reasoning" | "failed"): string {
  if (kind === "failed") return "Couldn’t copy message";
  if (kind === "reasoning") return "Reasoning copied";
  return kind === "markdown" ? "Message copied as Markdown" : "Message copied as JSON";
}

// ---- copy payloads ----------------------------------------------------------------

/** Markdown copy is the exact projected message text. */
export const copyMarkdown = (m: UserMsg | AssistantMsg): string => m.text;

/** Attachment fields safe to leave the app: no id, url, path, or range. */
export function sanitizeCopyAttachments(
  attachments: readonly AttachmentRef[] | undefined,
): Array<{ name: string; mime: string; size?: number; kind?: string }> | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((a) => ({
    name: a.name,
    mime: a.mime,
    ...(typeof a.size === "number" ? { size: a.size } : {}),
    ...(typeof a.kind === "string" ? { kind: a.kind } : {}),
  }));
}

/** Stable pretty-printed JSON copy: role, text, ISO time, numeric timeMs,
 *  sanitized visible attachments, and (assistant) the disclosed reasoning.
 *  Never backend ids, hidden reverted tails, or local provenance. */
export function copyJson(m: UserMsg | AssistantMsg): string {
  if (m.kind === "user") {
    const attachments = sanitizeCopyAttachments(m.attachments);
    return JSON.stringify(
      {
        role: "user",
        text: m.text,
        time: timeIso(m.time),
        timeMs: m.time,
        ...(attachments ? { attachments } : {}),
      },
      null,
      2,
    );
  }
  const at = assistantTime(m);
  return JSON.stringify(
    {
      role: "assistant",
      text: m.text,
      ...(m.reasoning !== "" ? { reasoning: m.reasoning } : {}),
      time: timeIso(at),
      timeMs: at,
    },
    null,
    2,
  );
}

// ---- completed-turn footer -----------------------------------------------------------

/** Rounded-seconds duration with normalized carry: 299.6s is "5m 0s", never
 *  "4m 60s". Hours drop the seconds ("1h 4m"). */
export function normalizedDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (s >= 60) return `${m}m ${sec}s`;
  return `${s}s`;
}

/** Wall-clock span of one terminal turn; null while working or when a copied
 *  or partial log carries a stop without a start (no "worked 0s"). */
export function turnDurationMs(t: TurnState | null): number | null {
  if (!t || t.status === "working") return null;
  if (t.startedAt === undefined || t.stoppedAt === undefined) return null;
  return Math.max(0, t.stoppedAt - t.startedAt);
}

/** The bottom footer belongs to one terminal visible turn: its own start/stop
 *  and its own usage — never lifetime totals combined with a pseudo-turn. */
export function turnFooterLine(model: Pick<RenderModel, "turn">): string | null {
  const t = model.turn;
  if (!t || t.status === "working") return null;
  const bits: string[] = [];
  if (t.model) bits.push(`${t.model.providerID}/${t.model.modelID}`);
  if (t.agent) bits.push(t.agent);
  const ms = turnDurationMs(t);
  if (ms !== null) bits.push(`worked ${normalizedDuration(ms)}`);
  const u = t.usage;
  if (u && (u.tokens.input > 0 || u.tokens.output > 0)) {
    bits.push(`${fmtTokens(u.tokens.input)} in · ${fmtTokens(u.tokens.output)} out`);
  }
  if (u && u.cost > 0) bits.push(fmtCost(u.cost));
  return bits.length > 0 ? bits.join(" · ") : null;
}

// ---- truthful availability -----------------------------------------------------------

export interface MutationGuards {
  turnWorking: boolean;
  /** Unresolved question or permission request. */
  pendingRequest: boolean;
  queuedCount: number;
  rewindActive: boolean;
  archived: boolean;
}

export type ActionAvailability = { enabled: true } | { enabled: false; reason: string };

function mutationAvailability(action: "Revert" | "Fork", g: MutationGuards): ActionAvailability {
  if (g.archived) return { enabled: false, reason: `${action} unavailable in an archived session` };
  // A pending request outranks the open turn it is blocking: "answer the
  // request" is the actionable reason, "a turn is running" is its symptom.
  if (g.pendingRequest) return { enabled: false, reason: `${action} unavailable while a request is waiting` };
  if (g.turnWorking) return { enabled: false, reason: `${action} unavailable while a turn is running` };
  if (g.queuedCount > 0) return { enabled: false, reason: `${action} unavailable while messages are queued` };
  if (g.rewindActive) return { enabled: false, reason: "Restore or replace the current revert first" };
  return { enabled: true };
}

export const revertAvailability = (g: MutationGuards): ActionAvailability => mutationAvailability("Revert", g);
/** Fork uses the same idle/waiting/queue/archive/active-rewind guards. */
export const forkAvailability = (g: MutationGuards): ActionAvailability => mutationAvailability("Fork", g);

export function guardsFromModel(
  model: Pick<RenderModel, "turn" | "permissions" | "questions" | "rewind">,
  opts: { queuedCount?: number; archived?: boolean } = {},
): MutationGuards {
  return {
    turnWorking: model.turn?.status === "working",
    pendingRequest:
      model.permissions.some((p) => p.status === "pending")
      || model.questions.some((q) => q.status === "pending"),
    queuedCount: opts.queuedCount ?? 0,
    rewindActive: model.rewind !== null,
    archived: opts.archived ?? false,
  };
}

/** Bounded, actionable message for a failed mutation (typed server errors). */
export function mutationErrorMessage(action: "revert" | "fork" | "restore", err: unknown): string {
  const verb = action === "revert" ? "Revert" : action === "fork" ? "Fork" : "Restore";
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
  if (code === "history-mismatch") {
    return `${verb} failed: the backend history didn’t match this session’s events. Nothing was changed.`;
  }
  if (code === "conflict") {
    return `${verb} isn’t available right now — the session state changed. Nothing was changed.`;
  }
  if (code === "unsupported") {
    return `${verb} isn’t supported by this backend. Nothing was changed.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Couldn’t ${action}: ${message}`;
}

// ---- seed provenance -------------------------------------------------------------------

/** Draft provenance record persisted next to the plain-text draft. `key`
 *  identifies which marker seeded the draft; `seedText` is the untouched
 *  seed so edited/cleared states are derivable without extra writes. */
export interface SeedRecord {
  key: string;
  seedText: string;
}

export const rewindSeedKey = (markerSeq: number): string => `rewind:${markerSeq}`;
export const forkSeedKey = (fromSessionId: string, sourceAtSeq?: number): string =>
  `fork:${fromSessionId}:${sourceAtSeq ?? "all"}`;

/** A marker seeds the composer at most once: a stored record for the same key
 *  means the seed was already applied (and possibly edited or cleared). */
export function shouldApplySeed(record: SeedRecord | null, key: string): boolean {
  return record === null || record.key !== key;
}

export type DraftState = "seed" | "edited" | "cleared" | "none";

/** Untouched seed vs deliberate edit vs deliberate clear, derived from the
 *  stored record and the current draft text. */
export function draftStateOf(record: SeedRecord | null, currentDraft: string): DraftState {
  if (record === null) return "none";
  if (currentDraft === record.seedText) return "seed";
  if (currentDraft === "") return "cleared";
  return "edited";
}
