// Where the time goes between the user falling silent and the reply becoming
// audible, per spoken turn. Each step is a mark taken where it happens in the
// controller; a turn counts only when every mark was seen, in order, so a
// number here is a measurement and never an estimate. Queued turns, commands
// and turns that were not sent are not measured: their wait is something else.
//
// The marks hold times only — no words — so the list may be kept on the
// device and shown in Settings.

export interface VoiceTurnLatency {
  /** When the reply became audible (ms since epoch). */
  at: number;
  /** Silence waited out before the turn ended (0 for a tap). */
  pause: number;
  /** End of turn → final transcript. */
  recognition: number;
  /** Final transcript → the agent's turn started. */
  sending: number;
  /** Turn started → first reply text that can be spoken. */
  agent: number;
  /** First reply text → audible (synthesis and playback start). */
  voice: number;
  /** End of speech → first sound of the reply. */
  total: number;
  /** An acknowledgement or remark was heard first, this long after speech ended. */
  firstSound?: number;
}

export interface LatencyTracker {
  /** The turn ended after `waitedMs` of silence: start measuring. */
  endOfTurn(waitedMs: number): void;
  transcript(): void;
  /** This turn is not measured (a command, nothing said, queued, not sent). */
  discard(): void;
  turnStarted(): void;
  firstText(): void;
  /** A sound that is not the reply (an acknowledgement, a remark) started. */
  sound(): void;
  /** The reply became audible; resolves the measurement when it is complete. */
  audible(): VoiceTurnLatency | null;
  recent(): readonly VoiceTurnLatency[];
}

/** Marks older than this belong to a turn that never answered. */
const STALE_MS = 120_000;
export const LATENCY_KEEP = 20;

interface Marks {
  speechEnd: number;
  endOfTurn: number;
  transcript?: number;
  turnStarted?: number;
  firstText?: number;
  sound?: number;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Read a stored list back, dropping anything that is not a measurement. */
export function parseLatencyList(raw: string | null | undefined): VoiceTurnLatency[] {
  try {
    const parsed = JSON.parse(raw ?? "") as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: VoiceTurnLatency[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const data = item as Record<string, unknown>;
      const { at, pause, recognition, sending, agent, voice, total, firstSound } = data;
      if (![at, pause, recognition, sending, agent, voice, total].every(finite)) continue;
      out.push({
        at: at as number, pause: pause as number, recognition: recognition as number, sending: sending as number,
        agent: agent as number, voice: voice as number, total: total as number,
        ...(finite(firstSound) ? { firstSound } : {}),
      });
    }
    return out.slice(-LATENCY_KEEP);
  } catch {
    return [];
  }
}

export function createLatencyTracker(options: {
  now(): number;
  initial?: readonly VoiceTurnLatency[];
  onChange?(list: readonly VoiceTurnLatency[]): void;
}): LatencyTracker {
  let marks: Marks | null = null;
  let list: VoiceTurnLatency[] = [...(options.initial ?? [])].slice(-LATENCY_KEEP);

  const live = (): Marks | null => {
    if (marks && options.now() - marks.endOfTurn > STALE_MS) marks = null;
    return marks;
  };

  return {
    endOfTurn(waitedMs) {
      const now = options.now();
      marks = { speechEnd: now - Math.max(0, waitedMs), endOfTurn: now };
    },
    transcript() {
      const current = live();
      if (current && current.transcript === undefined) current.transcript = options.now();
    },
    discard() {
      marks = null;
    },
    turnStarted() {
      const current = live();
      // A turn that starts before the words were final is someone else's.
      if (!current || current.transcript === undefined) return;
      if (current.turnStarted === undefined) current.turnStarted = options.now();
    },
    firstText() {
      const current = live();
      if (!current || current.turnStarted === undefined) return;
      if (current.firstText === undefined) current.firstText = options.now();
    },
    sound() {
      const current = live();
      if (current && current.transcript !== undefined && current.sound === undefined) current.sound = options.now();
    },
    audible() {
      const current = live();
      if (!current || current.transcript === undefined || current.turnStarted === undefined || current.firstText === undefined) {
        return null;
      }
      marks = null;
      const now = options.now();
      const entry: VoiceTurnLatency = {
        at: now,
        pause: current.endOfTurn - current.speechEnd,
        recognition: current.transcript - current.endOfTurn,
        sending: current.turnStarted - current.transcript,
        agent: current.firstText - current.turnStarted,
        voice: now - current.firstText,
        total: now - current.speechEnd,
        ...(current.sound !== undefined ? { firstSound: current.sound - current.speechEnd } : {}),
      };
      list = [...list, entry].slice(-LATENCY_KEEP);
      options.onChange?.(list);
      return entry;
    },
    recent: () => list,
  };
}

/** The mean of each step over `list`; null when it is empty. */
export function averageLatency(list: readonly VoiceTurnLatency[]): Omit<VoiceTurnLatency, "at" | "firstSound"> | null {
  if (!list.length) return null;
  const mean = (pick: (entry: VoiceTurnLatency) => number) =>
    Math.round(list.reduce((sum, entry) => sum + pick(entry), 0) / list.length);
  return {
    pause: mean((entry) => entry.pause),
    recognition: mean((entry) => entry.recognition),
    sending: mean((entry) => entry.sending),
    agent: mean((entry) => entry.agent),
    voice: mean((entry) => entry.voice),
    total: mean((entry) => entry.total),
  };
}
