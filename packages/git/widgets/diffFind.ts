// Find across a whole changeset. Diffs arrive one file at a time and are
// searched in time-boxed slices, so a 5k-line changeset never holds the main
// thread; the caller yields between slices. Pure: no DOM, no React.
import { parseDiffLines } from "./diffLines.ts";

export interface FindMatch {
  file: string;
  /** Index of the diff row inside the file's parsed lines. */
  line: number;
  start: number;
  length: number;
  /** Position among this file's matches, in reading order. */
  ord: number;
}

const SLICE_CHECK_EVERY = 128;

export class ChangesetSearch {
  readonly query: string;
  readonly matchCase: boolean;
  private readonly needle: string;
  private readonly order: string[];
  private readonly queue: { file: string; diff: string }[] = [];
  private readonly perFile = new Map<string, FindMatch[]>();
  private active: { file: string; lines: ReturnType<typeof parseDiffLines>; at: number; found: FindMatch[] } | null = null;
  /** Bumped whenever matches change, for cheap React invalidation. */
  version = 0;

  constructor(query: string, matchCase: boolean, order: readonly string[]) {
    this.query = query;
    this.matchCase = matchCase;
    this.needle = matchCase ? query : query.toLowerCase();
    this.order = [...order];
  }

  add(file: string, diff: string): void {
    if (this.perFile.has(file) || this.queue.some((item) => item.file === file) || this.active?.file === file) return;
    if (this.needle) this.queue.push({ file, diff }); else this.perFile.set(file, []);
  }

  get done(): boolean { return this.queue.length === 0 && this.active === null; }

  /** Search for up to `budgetMs`; true once everything queued is searched. */
  step(budgetMs: number, now: () => number = () => performance.now()): boolean {
    const end = now() + budgetMs;
    let sinceCheck = 0;
    while (this.queue.length > 0 || this.active) {
      if (!this.active) {
        const next = this.queue.shift()!;
        this.active = { file: next.file, lines: parseDiffLines(next.diff), at: 0, found: [] };
        if (now() >= end) return false;
      }
      const state = this.active;
      while (state.at < state.lines.length) {
        const row = state.lines[state.at]!;
        if (row.kind === "add" || row.kind === "del" || row.kind === "ctx") {
          const hay = this.matchCase ? row.text : row.text.toLowerCase();
          let from = 0;
          for (;;) {
            const found = hay.indexOf(this.needle, from);
            if (found < 0) break;
            state.found.push({ file: state.file, line: state.at, start: found, length: this.needle.length, ord: state.found.length });
            from = found + Math.max(1, this.needle.length);
          }
        }
        state.at += 1;
        if (++sinceCheck >= SLICE_CHECK_EVERY) {
          sinceCheck = 0;
          if (now() >= end) { this.version += 1; return false; }
        }
      }
      this.perFile.set(state.file, state.found);
      this.active = null;
      this.version += 1;
    }
    return true;
  }

  get total(): number {
    let sum = 0;
    for (const found of this.perFile.values()) sum += found.length;
    return sum;
  }

  /** Finished files' matches, files in the caller's order. */
  matches(): FindMatch[] {
    const out: FindMatch[] = [];
    for (const file of this.order) { const found = this.perFile.get(file); if (found) out.push(...found); }
    return out;
  }
}

/** Next/previous with wrap; -1 when there is nothing to land on. */
export function stepMatch(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return delta === 1 ? 0 : total - 1;
  return (current + delta + total) % total;
}
