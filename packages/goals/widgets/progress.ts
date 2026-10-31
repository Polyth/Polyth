/** The latest Judgment progress of a goal as a whole percentage, read
 * defensively from the server's goal state or a goal/* event snapshot
 * (`lastProgress`, a fraction in [0, 1]). Absent when the last audit was not
 * judged. */
export function goalProgressPercent(source: unknown): number | undefined {
  const value = source && typeof source === "object" ? (source as { lastProgress?: unknown }).lastProgress : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? Math.round(value * 100) : undefined;
}
