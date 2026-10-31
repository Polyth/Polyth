// The usage-alert ledger: per `<source>/<window>`, what has already been
// announced in the current limit period, and which source problems were
// reported. Browser and server share it: the browser decides alerts against it,
// and the server keeps each person's copy so a new device, a reinstalled app or
// the phone app (whose shell starts with empty localStorage on every launch)
// does not repeat an alert the person has already seen. Pure, no I/O.

export interface AlertWindowMemo {
  /** `resetsAt` of the period the flags below belong to. */
  resetsAt?: number;
  /** Remaining fraction at the last evaluation, to spot a refill without a reset time. */
  remaining: number;
  /** Lowest low-remaining level already announced this period. */
  low?: number;
  /** Strongest pace reading already announced this period (1 elevated, 2 likely). */
  pace?: number;
  exhausted?: boolean;
  at: number;
}

export interface UsageAlertLedger {
  version: 1;
  windows: Record<string, AlertWindowMemo>;
  /** Source id → the problem already announced. */
  sources: Record<string, string>;
  /** When the evaluation that produced this ledger ran; orders `sources` in a merge. */
  at?: number;
}

export const emptyAlertLedger = (): UsageAlertLedger => ({ version: 1, windows: {}, sources: {} });

/** A later period: the reset moved on by more than provider jitter. */
export const NEW_PERIOD_SHIFT_MS = 10 * 60_000;
/** Usage only grows inside a period; a refill this large means it started over. */
export const REFILL_FRACTION = 0.05;
/** Memos for limits that stopped reporting are forgotten after this. */
export const LEDGER_RETENTION_MS = 35 * 86_400_000;
/** A stored ledger never holds more than this; extra entries are dropped. */
const MAX_LEDGER_WINDOWS = 512;
const MAX_LEDGER_SOURCES = 128;
const MAX_KEY_LENGTH = 300;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Accepts only a well-formed stored ledger; anything else starts fresh. */
export function parseAlertLedger(value: unknown): UsageAlertLedger {
  if (!value || typeof value !== "object") return emptyAlertLedger();
  const raw = value as Partial<UsageAlertLedger>;
  if (raw.version !== 1 || !raw.windows || typeof raw.windows !== "object" || !raw.sources || typeof raw.sources !== "object") {
    return emptyAlertLedger();
  }
  const windows: Record<string, AlertWindowMemo> = {};
  for (const [key, memo] of Object.entries(raw.windows).slice(0, MAX_LEDGER_WINDOWS)) {
    if (key.length > MAX_KEY_LENGTH || !memo || typeof memo !== "object" || !finite(memo.remaining) || !finite(memo.at)) continue;
    windows[key] = {
      remaining: memo.remaining,
      at: memo.at,
      ...(finite(memo.resetsAt) ? { resetsAt: memo.resetsAt } : {}),
      ...(finite(memo.low) ? { low: memo.low } : {}),
      ...(finite(memo.pace) ? { pace: memo.pace } : {}),
      ...(memo.exhausted === true ? { exhausted: true } : {}),
    };
  }
  const sources: Record<string, string> = {};
  for (const [key, problem] of Object.entries(raw.sources).slice(0, MAX_LEDGER_SOURCES)) {
    if (key.length <= MAX_KEY_LENGTH && typeof problem === "string" && problem.length <= 40) sources[key] = problem;
  }
  return { version: 1, windows, sources, ...(finite(raw.at) ? { at: raw.at } : {}) };
}

/**
 * Whether `next` belongs to a later period than `previous`: the reset moved on,
 * a reset passed without a new one, or the limit refilled.
 */
export function startsNewPeriod(
  previous: Pick<AlertWindowMemo, "resetsAt" | "remaining">,
  next: { resetsAt?: number | undefined; remaining: number },
  now: number,
): boolean {
  return (previous.resetsAt !== undefined && next.resetsAt !== undefined && next.resetsAt - previous.resetsAt > NEW_PERIOD_SHIFT_MS)
    || (previous.resetsAt !== undefined && next.resetsAt === undefined && now > previous.resetsAt)
    || next.remaining - previous.remaining >= REFILL_FRACTION;
}

const lower = (a: number | undefined, b: number | undefined) => a === undefined ? b : b === undefined ? a : Math.min(a, b);
const higher = (a: number | undefined, b: number | undefined) => a === undefined ? b : b === undefined ? a : Math.max(a, b);

function mergeMemo(a: AlertWindowMemo, b: AlertWindowMemo): AlertWindowMemo {
  // Two reset times name their periods directly; device clocks (`at`) only
  // order the memos when a reset time is missing.
  if (a.resetsAt !== undefined && b.resetsAt !== undefined && Math.abs(a.resetsAt - b.resetsAt) > NEW_PERIOD_SHIFT_MS) {
    return a.resetsAt > b.resetsAt ? a : b;
  }
  const [older, newer] = a.at > b.at ? [b, a] : [a, b];
  if (startsNewPeriod(older, newer, newer.at)) return newer;
  // The same period: everything either copy announced stays announced.
  const low = lower(older.low, newer.low);
  const pace = higher(older.pace, newer.pace);
  const { low: _low, pace: _pace, exhausted: _exhausted, ...rest } = newer;
  return {
    ...rest,
    ...(low !== undefined ? { low } : {}),
    ...(pace !== undefined ? { pace } : {}),
    ...(older.exhausted || newer.exhausted ? { exhausted: true } : {}),
  };
}

/**
 * One ledger from two copies of it (this device's and the person's stored one,
 * or two devices' writes). An announcement in the same period survives the
 * merge; a later period replaces an earlier one. Source problems come from the
 * newer copy, so a source that recovered is not remembered as still announced.
 */
export function mergeAlertLedgers(a: UsageAlertLedger, b: UsageAlertLedger, now?: number): UsageAlertLedger {
  const windows: Record<string, AlertWindowMemo> = {};
  for (const key of new Set([...Object.keys(a.windows), ...Object.keys(b.windows)])) {
    const left = a.windows[key];
    const right = b.windows[key];
    const memo = left && right ? mergeMemo(left, right) : (left ?? right)!;
    if (now !== undefined && now - memo.at >= LEDGER_RETENTION_MS) continue;
    windows[key] = memo;
  }
  const newer = (b.at ?? 0) > (a.at ?? 0) ? b : a;
  const at = higher(a.at, b.at);
  return { version: 1, windows, sources: { ...newer.sources }, ...(at !== undefined ? { at } : {}) };
}

/**
 * What a ledger has announced, without the readings that change on every
 * evaluation. Two ledgers with the same announcements need no write. The reset
 * time is coarse so provider jitter does not count as a change, while a new
 * period announced at the same level still does.
 */
export function alertLedgerAnnouncements(ledger: UsageAlertLedger): string {
  const windows = Object.keys(ledger.windows).sort().flatMap((key) => {
    const memo = ledger.windows[key]!;
    const period = memo.resetsAt === undefined ? null : Math.round(memo.resetsAt / NEW_PERIOD_SHIFT_MS);
    return memo.low === undefined && memo.pace === undefined && !memo.exhausted
      ? []
      : [[key, memo.low ?? null, memo.pace ?? null, memo.exhausted === true, period]];
  });
  const sources = Object.keys(ledger.sources).sort().map((key) => [key, ledger.sources[key]]);
  return JSON.stringify([windows, sources]);
}
