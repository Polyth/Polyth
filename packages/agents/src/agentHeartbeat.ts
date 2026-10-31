// Heartbeat: a light, frequent wake inside the agent's ongoing conversation.
// On every beat the agent walks its checklist and stays quiet unless something
// changed — the cheap way to be proactive. Pure and browser-safe: the service
// arms beats with it and the editor previews the same clock.

export interface AgentHeartbeat {
  /** Minutes between beats. */
  everyMinutes: number;
  /** Local active window in minutes after midnight, end exclusive. Both absent
   *  = around the clock; `activeTo` < `activeFrom` wraps past midnight. */
  activeFrom?: number;
  activeTo?: number;
  /** IANA zone of the active window. */
  timeZone: string;
  /** What to look at on every beat. Empty = the standing instructions. */
  checklist: string;
}

export const HEARTBEAT_MIN_MINUTES = 10;
export const HEARTBEAT_MAX_MINUTES = 24 * 60;
export const CHECKLIST_LIMIT = 2_000;
export const HEARTBEAT_STEPS = [15, 30, 60, 120, 240] as const;

const DAY = 24 * 60;

const err = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

function validZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Validate untrusted input into a heartbeat; throws `invalid-input`. */
export function validateHeartbeat(raw: unknown): AgentHeartbeat {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw err("heartbeat must be an object");
  const input = raw as Record<string, unknown>;
  const every = Number(input.everyMinutes);
  if (!Number.isInteger(every) || every < HEARTBEAT_MIN_MINUTES || every > HEARTBEAT_MAX_MINUTES) {
    throw err(`heartbeat.everyMinutes must be a whole number from ${HEARTBEAT_MIN_MINUTES} to ${HEARTBEAT_MAX_MINUTES}`);
  }
  if (!validZone(input.timeZone)) throw err("heartbeat.timeZone must be an IANA time zone");
  const hasFrom = input.activeFrom !== undefined && input.activeFrom !== null;
  const hasTo = input.activeTo !== undefined && input.activeTo !== null;
  if (hasFrom !== hasTo) throw err("heartbeat.activeFrom and activeTo go together");
  let window: Pick<AgentHeartbeat, "activeFrom" | "activeTo"> = {};
  if (hasFrom) {
    const from = Number(input.activeFrom);
    const to = Number(input.activeTo);
    if (!Number.isInteger(from) || from < 0 || from >= DAY) throw err("heartbeat.activeFrom must be minutes after midnight (0–1439)");
    if (!Number.isInteger(to) || to < 1 || to > DAY) throw err("heartbeat.activeTo must be minutes after midnight (1–1440)");
    if (from === to % DAY) throw err("heartbeat active hours must not be empty");
    window = { activeFrom: from, activeTo: to };
  }
  const checklist = typeof input.checklist === "string" ? input.checklist.replace(/\r\n/g, "\n").trim() : "";
  if (checklist.length > CHECKLIST_LIMIT) throw err(`heartbeat.checklist is limited to ${CHECKLIST_LIMIT} characters`);
  return { everyMinutes: every, ...window, timeZone: input.timeZone as string, checklist };
}

/** Local minutes after midnight of `at` in `timeZone`. */
export function minuteOfDay(at: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
    return (hour % 24) * 60 + minute;
  } catch {
    const date = new Date(at);
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

export function inActiveHours(minute: number, beat: Pick<AgentHeartbeat, "activeFrom" | "activeTo">): boolean {
  if (beat.activeFrom === undefined || beat.activeTo === undefined) return true;
  const from = beat.activeFrom;
  const to = beat.activeTo % DAY;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** `at`, or the start of the next active window after it. A daylight-saving
 *  shift is corrected by re-checking the landing minute. */
export function nextActiveTime(at: number, beat: AgentHeartbeat): number {
  let candidate = at;
  for (let guard = 0; guard < 4; guard += 1) {
    const minute = minuteOfDay(candidate, beat.timeZone);
    if (inActiveHours(minute, beat)) return candidate;
    const wait = ((beat.activeFrom! - minute) + DAY) % DAY || DAY;
    candidate = Math.floor(candidate / 60_000) * 60_000 + wait * 60_000;
  }
  return candidate;
}

/** When the next beat is due. Never in the past: beats missed while Polyth
 *  was not running are not caught up. */
export function computeNextBeat(
  task: { heartbeat?: AgentHeartbeat; enabled: boolean; tripped?: unknown; lastBeatAt?: number },
  now: number,
): number | null {
  const beat = task.heartbeat;
  if (!beat || !task.enabled || task.tripped) return null;
  const step = beat.everyMinutes * 60_000;
  const due = Math.max(now, (task.lastBeatAt ?? now) + step);
  return nextActiveTime(due, beat);
}

/** Beats in one day, for the editor's estimate. */
export function beatsPerDay(beat: Pick<AgentHeartbeat, "everyMinutes" | "activeFrom" | "activeTo">): number {
  const active = beat.activeFrom === undefined || beat.activeTo === undefined
    ? DAY
    : ((beat.activeTo % DAY) - beat.activeFrom + DAY) % DAY || DAY;
  return Math.max(1, Math.floor(active / beat.everyMinutes));
}

/** "08:00" for 480; the end of the day reads "24:00". */
export const clockOf = (minutes: number): string =>
  minutes >= DAY ? "24:00" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
