import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionAssist, SessionEvent } from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";
import { isAssistConversationActivity } from "@polyth/session/next-action";

export interface RecapSettings {
  /** Quiet time after turn/stopped before a recap is generated. */
  idleSeconds: number;
}

const DEFAULT_RECAP_SETTINGS: RecapSettings = { idleSeconds: 120 };
const MIN_IDLE_SECONDS = 10;
const MAX_IDLE_SECONDS = 3600;
export const RECAP_MAX_WORDS = 20;

export interface RecapSettingsService {
  get(): RecapSettings;
  put(patch: Record<string, unknown>): RecapSettings;
}

/** Persist the former global assist quiet-time setting for a migration-safe
 * package extraction. Package enablement is now the only on/off switch. */
export function createRecapSettings(opts: { file: string }): RecapSettingsService {
  let current: RecapSettings = { ...DEFAULT_RECAP_SETTINGS };
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Record<string, unknown>;
    current = sanitize(raw, current);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && existsSync(opts.file)) {
      console.warn("[polyth] assist.json is unreadable; starting recap with defaults (file left untouched)");
    }
  }

  function sanitize(patch: Record<string, unknown>, base: RecapSettings): RecapSettings {
    const next = { ...base };
    if (patch.idleSeconds !== undefined) {
      const n = Number(patch.idleSeconds);
      if (!Number.isFinite(n)) {
        throw Object.assign(new Error("idleSeconds must be a number"), { code: "invalid-input" });
      }
      next.idleSeconds = Math.min(MAX_IDLE_SECONDS, Math.max(MIN_IDLE_SECONDS, Math.round(n)));
    }
    return next;
  }

  return {
    get: () => ({ ...current }),
    put: (patch) => {
      current = sanitize(patch, current);
      mkdirSync(dirname(opts.file), { recursive: true });
      atomicWriteSync(opts.file, JSON.stringify(current, null, 2));
      return { ...current };
    },
  };
}

export function capWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

export function isFresh(
  assist: { atSeq: number } | undefined,
  latestConversationSeq: number,
): boolean {
  return !!assist && assist.atSeq >= latestConversationSeq;
}

export function buildRecapPrompt(transcript: string): string {
  return [
    "You are reviewing a coding-assistant conversation that just went idle.",
    "Output EXACTLY two lines and nothing else:",
    `Recap: <what happened, at most ${RECAP_MAX_WORDS} words>`,
    "Suggestion: <ONE concrete next prompt the user could send, imperative, one sentence — or the single word none>",
    "",
    "Write `Suggestion: none` when the task is finished, the user closed the",
    "conversation, or nothing in the conversation grounds a next step. A recap",
    "with no suggestion is a complete and correct answer. Never invent work to",
    "fill the line: no \"add tests\" when the tests already passed, no",
    "\"implement it\" after it was implemented, no new requirements, no",
    "speculative cleanup, and no choice the user already made.",
    "Do not use tools. Do not wrap the answer in code fences.",
    "",
    "<conversation>",
    transcript,
    "</conversation>",
  ].join("\n");
}

const NO_SUGGESTION = /^(none|no suggestion|n\/a|-{1,2})\.?$/i;

export function parseRecapReply(raw: string): { recap: string; suggestion?: string } | null {
  const lines = raw
    .replace(/^\`\`\`[a-z]*\n?|\`\`\`$/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let recap = "";
  let suggestion = "";
  for (const line of lines) {
    const match = line.match(/^(recap|suggestion)\s*:\s*(.+)$/i);
    if (!match) continue;
    if (match[1]!.toLowerCase() === "recap" && !recap) recap = match[2]!.trim();
    else if (match[1]!.toLowerCase() === "suggestion" && !suggestion) suggestion = match[2]!.trim();
  }
  if (!recap && !suggestion && lines.length >= 2) {
    recap = lines[0]!;
    suggestion = lines[1]!;
  }
  if (!recap) return null;
  const capped = capWords(recap, RECAP_MAX_WORDS);
  return NO_SUGGESTION.test(suggestion) || !suggestion
    ? { recap: capped }
    : { recap: capped, suggestion };
}

export interface RecapService {
  onTurnCompleted(sessionId: string, userId?: string): void;
  stop(): void;
}

export function createRecapService(deps: {
  settings: () => RecapSettings;
  latestSeq(sessionId: string): Promise<number>;
  eventsAfter(sessionId: string, afterSeq: number): Promise<SessionEvent[]>;
  transcript(sessionId: string): Promise<string>;
  complete(sessionId: string, prompt: string, userId?: string): Promise<string>;
  save(sessionId: string, assist: SessionAssist): Promise<void>;
  now?(): number;
  onError?(sessionId: string, err: unknown): void;
}): RecapService {
  const now = deps.now ?? Date.now;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  let epoch = 0;

  const stablePassiveTail = async (sessionId: string, afterSeq: number): Promise<number | null> => {
    let cursor = afterSeq;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const trailing = await deps.eventsAfter(sessionId, cursor);
      if (trailing.some(isAssistConversationActivity)) return null;
      cursor = trailing.at(-1)?.seq ?? cursor;
      if ((await deps.latestSeq(sessionId)) === cursor) return cursor;
    }
    return null;
  };

  const fire = async (
    sessionId: string,
    seqAtSchedule: number,
    userId: string | undefined,
    scheduledEpoch: number,
  ) => {
    timers.delete(sessionId);
    if (scheduledEpoch !== epoch || inFlight.has(sessionId)) return;
    inFlight.add(sessionId);
    try {
      const atSeq = await stablePassiveTail(sessionId, seqAtSchedule);
      if (atSeq === null || scheduledEpoch !== epoch) return;
      const transcript = await deps.transcript(sessionId);
      if (!transcript.trim() || scheduledEpoch !== epoch) return;
      const parsed = parseRecapReply(
        await deps.complete(sessionId, buildRecapPrompt(transcript), userId),
      );
      if (!parsed || scheduledEpoch !== epoch) return;
      const finalAtSeq = await stablePassiveTail(sessionId, atSeq);
      if (finalAtSeq === null || scheduledEpoch !== epoch) return;
      await deps.save(sessionId, { ...parsed, atSeq: finalAtSeq, generatedAt: now() });
    } catch (err) {
      deps.onError?.(sessionId, err);
    } finally {
      inFlight.delete(sessionId);
    }
  };

  return {
    onTurnCompleted(sessionId, userId) {
      const existing = timers.get(sessionId);
      if (existing) clearTimeout(existing);
      const scheduledEpoch = epoch;
      void deps.latestSeq(sessionId).then((seq) => {
        if (scheduledEpoch !== epoch) return;
        const timer = setTimeout(
          () => void fire(sessionId, seq, userId, scheduledEpoch),
          deps.settings().idleSeconds * 1000,
        );
        timer.unref?.();
        timers.set(sessionId, timer);
      }).catch((err: unknown) => deps.onError?.(sessionId, err));
    },
    stop() {
      epoch += 1;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
