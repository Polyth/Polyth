// F9 small-model idle assist: after a turn completes and the session stays
// quiet, generate a <=20-word recap and ONE suggested follow-up. The result is
// stored on the projection keyed to the log tail seq (never the event log —
// nothing here is model-visible unless the user actually sends the
// suggestion), so ANY new event makes it stale. Hard settings switch: disabled
// means nothing is generated at all. One flight per session bounds token spend.
import type { SessionAssist } from "@polyth/contracts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AssistSettings {
  enabled: boolean;
  /** Quiet time after turn/stopped before a recap is generated. */
  idleSeconds: number;
}

export const DEFAULT_ASSIST_SETTINGS: AssistSettings = { enabled: false, idleSeconds: 120 };
const MIN_IDLE_SECONDS = 10;
const MAX_IDLE_SECONDS = 3600;
export const RECAP_MAX_WORDS = 20;

export interface AssistSettingsService {
  get(): AssistSettings;
  put(patch: Record<string, unknown>): AssistSettings;
}

/** Token-spend switch persisted server-side: `data/assist.json`. */
export function createAssistSettings(opts: { file: string }): AssistSettingsService {
  let current: AssistSettings = { ...DEFAULT_ASSIST_SETTINGS };
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Record<string, unknown>;
    current = sanitize(raw, current);
  } catch { /* first run */ }

  function sanitize(patch: Record<string, unknown>, base: AssistSettings): AssistSettings {
    const next = { ...base };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (patch.idleSeconds !== undefined) {
      const n = Number(patch.idleSeconds);
      if (!Number.isFinite(n)) throw Object.assign(new Error("idleSeconds must be a number"), { code: "invalid-input" });
      next.idleSeconds = Math.min(MAX_IDLE_SECONDS, Math.max(MIN_IDLE_SECONDS, Math.round(n)));
    }
    return next;
  }

  return {
    get: () => ({ ...current }),
    put: (patch) => {
      current = sanitize(patch, current);
      mkdirSync(dirname(opts.file), { recursive: true });
      writeFileSync(opts.file, JSON.stringify(current, null, 2));
      return { ...current };
    },
  };
}

// ------------------------------------------------------------- pure helpers

/** Hard cap on the recap length even if the model ignores the instruction. */
export function capWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

/** An assist is fresh only while the log has not grown past the seq it was keyed to. */
export function isFresh(assist: { atSeq: number } | undefined, latestSeq: number): boolean {
  return !!assist && assist.atSeq === latestSeq;
}

export function buildAssistPrompt(transcript: string): string {
  return [
    "You are reviewing a coding-assistant conversation that just went idle.",
    `Output EXACTLY two lines and nothing else:`,
    `Recap: <what happened, at most ${RECAP_MAX_WORDS} words>`,
    "Suggestion: <ONE concrete next prompt the user could send, imperative, one sentence>",
    "Do not use tools. Do not wrap the answer in code fences.",
    "",
    "<conversation>",
    transcript,
    "</conversation>",
  ].join("\n");
}

/** Tolerant two-line parse; null when the model reply is unusable. */
export function parseAssistReply(raw: string): { recap: string; suggestion: string } | null {
  const lines = raw.replace(/^```[a-z]*\n?|```$/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  let recap = "";
  let suggestion = "";
  for (const line of lines) {
    const m = line.match(/^(recap|suggestion)\s*:\s*(.+)$/i);
    if (!m) continue;
    if (m[1]!.toLowerCase() === "recap" && !recap) recap = m[2]!.trim();
    else if (m[1]!.toLowerCase() === "suggestion" && !suggestion) suggestion = m[2]!.trim();
  }
  // fall back to "first two non-empty lines" for label-less replies
  if (!recap && !suggestion && lines.length >= 2) {
    recap = lines[0]!;
    suggestion = lines[1]!;
  }
  if (!recap || !suggestion) return null;
  return { recap: capWords(recap, RECAP_MAX_WORDS), suggestion };
}

export function buildNotePrompt(transcript: string): string {
  return [
    "Distill the coding-assistant conversation below into a project note.",
    "Line 1: a <=60 character title. Then a blank line, then a concise markdown",
    "body capturing decisions, changes made, and open items. No preamble.",
    "Do not use tools. Do not wrap the answer in code fences.",
    "",
    "<conversation>",
    transcript,
    "</conversation>",
  ].join("\n");
}

export function parseNoteReply(raw: string): { title: string; body: string } {
  const clean = raw.replace(/^```[a-z]*\n?|```$/g, "").trim();
  const nl = clean.indexOf("\n");
  if (nl === -1) return { title: clean.slice(0, 60), body: "" };
  return { title: clean.slice(0, nl).trim().slice(0, 120), body: clean.slice(nl + 1).trim() };
}

// ------------------------------------------------------------- service

export interface AssistService {
  /** Called on every completed turn; schedules a debounced generation. */
  onTurnCompleted(sessionId: string): void;
  /** Cancel all pending timers (shutdown). */
  stop(): void;
}

export function createAssistService(deps: {
  settings: () => AssistSettings;
  latestSeq(sessionId: string): Promise<number>;
  transcript(sessionId: string): Promise<string>;
  /** One-shot small-model completion on the session's runtime. */
  complete(sessionId: string, prompt: string): Promise<string>;
  /** Persist onto the projection + broadcast (never the event log). */
  save(sessionId: string, assist: SessionAssist): Promise<void>;
  now?(): number;
  onError?(sessionId: string, err: unknown): void;
}): AssistService {
  const now = deps.now ?? Date.now;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();

  const fire = async (sessionId: string, seqAtSchedule: number) => {
    timers.delete(sessionId);
    if (inFlight.has(sessionId)) return; // one flight per session
    if (!deps.settings().enabled) return; // switch may have flipped while waiting
    inFlight.add(sessionId);
    try {
      // still quiet? any event since scheduling means this recap is already stale
      if ((await deps.latestSeq(sessionId)) !== seqAtSchedule) return;
      const transcript = await deps.transcript(sessionId);
      if (!transcript.trim()) return;
      const parsed = parseAssistReply(await deps.complete(sessionId, buildAssistPrompt(transcript)));
      if (!parsed) return;
      // re-check after the (slow) model call so a mid-generation event wins
      if ((await deps.latestSeq(sessionId)) !== seqAtSchedule) return;
      await deps.save(sessionId, { ...parsed, atSeq: seqAtSchedule, generatedAt: now() });
    } catch (err) {
      deps.onError?.(sessionId, err);
    } finally {
      inFlight.delete(sessionId);
    }
  };

  return {
    onTurnCompleted(sessionId) {
      const s = deps.settings();
      if (!s.enabled) return; // hard switch: nothing scheduled at all
      const existing = timers.get(sessionId);
      if (existing) clearTimeout(existing);
      void deps.latestSeq(sessionId).then((seq) => {
        const t = setTimeout(() => void fire(sessionId, seq), s.idleSeconds * 1000);
        t.unref?.();
        timers.set(sessionId, t);
      }).catch((err: unknown) => deps.onError?.(sessionId, err));
    },
    stop() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
