// Cron cadence (WP10). Thin wrapper over cron-parser (IANA time zones via its
// luxon backend) so validation, preview, and execution all share one code
// path — the preview a user sees is computed by the same function the
// executor calls, which is what makes DST gaps/folds deterministic.
import { CronExpressionParser } from "cron-parser";

const err = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

const isValidZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export interface CronValidation {
  ok: boolean;
  error?: string;
}

/** Validate a 5-field cron expression + zone. Rejects seconds fields, @aliases,
 *  unknown zones, and cadences faster than `minIntervalMinutes`. */
export function validateCron(
  expression: string,
  timeZone: string,
  opts: { minIntervalMinutes?: number } = {},
): CronValidation {
  const expr = expression.trim();
  if (!expr) return { ok: false, error: "cron expression is required" };
  if (expr.startsWith("@")) return { ok: false, error: "aliases like @daily are not supported; write the five fields" };
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, error: `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}` };
  }
  if (!isValidZone(timeZone)) return { ok: false, error: `unknown IANA time zone: ${timeZone}` };
  let it: ReturnType<typeof CronExpressionParser.parse>;
  try {
    it = CronExpressionParser.parse(expr, { tz: timeZone });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const min = opts.minIntervalMinutes ?? 1;
  if (min > 1) {
    try {
      const a = it.next().getTime();
      const b = it.next().getTime();
      if (b - a < min * 60_000) {
        return { ok: false, error: `cadence is faster than the ${min}-minute minimum` };
      }
    } catch { /* fewer than two future runs is fine (rare but valid) */ }
  }
  return { ok: true };
}

/** Next `count` run instants (epoch ms) after `from`. Spring-forward gaps are
 *  skipped, fall-back folds fire once at the first occurrence — cron-parser's
 *  zone arithmetic decides, and executor + preview both go through here. */
export function nextRuns(expression: string, timeZone: string, from: number, count: number): number[] {
  const v = validateCron(expression, timeZone);
  if (!v.ok) throw err(v.error!);
  const it = CronExpressionParser.parse(expression.trim(), { tz: timeZone, currentDate: new Date(from) });
  const out: number[] = [];
  for (let i = 0; i < Math.min(count, 100); i++) {
    try {
      out.push(it.next().getTime());
    } catch {
      break; // expression has no further occurrences
    }
  }
  return out;
}

export function nextRun(expression: string, timeZone: string, from: number): number | null {
  return nextRuns(expression, timeZone, from, 1)[0] ?? null;
}

// ---- human description ---------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const listNames = (spec: string, names: string[], offset: number): string | null => {
  // Handles plain lists/ranges of numerics for readable output; anything more
  // exotic falls back to the raw field text.
  if (spec === "*") return null;
  const parts = spec.split(",");
  const out: string[] = [];
  for (const p of parts) {
    const range = /^(\d+)-(\d+)$/.exec(p);
    if (range) {
      const a = names[Number(range[1]) - offset];
      const b = names[Number(range[2]) - offset];
      if (!a || !b) return spec;
      out.push(`${a} through ${b}`);
    } else if (/^\d+$/.test(p)) {
      const n = names[Number(p) - offset];
      if (!n) return spec;
      out.push(n);
    } else {
      return spec;
    }
  }
  return out.join(", ");
};

/** Best-effort English description ("At 09:00, Monday through Friday"). */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return expression;
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];

  let time: string;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    time = `At ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  } else if (/^\d+$/.test(min) && hour === "*") {
    time = `At minute ${min} of every hour`;
  } else if (min.startsWith("*/") && hour === "*") {
    time = `Every ${min.slice(2)} minutes`;
  } else if (/^\d+$/.test(min) && hour.startsWith("*/")) {
    time = `At minute ${min} every ${hour.slice(2)} hours`;
  } else {
    time = `At ${hour}:${min}`;
  }

  const parts = [time];
  const dowText = listNames(dow, DAYS, 0);
  if (dowText) parts.push(dowText);
  const domText = dom === "*" ? null : `day ${dom} of the month`;
  if (domText) parts.push(domText);
  const monthText = listNames(month, MONTHS, 1);
  if (monthText) parts.push(`in ${monthText}`);
  return parts.join(", ");
}
