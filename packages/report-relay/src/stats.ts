import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Per-group activity the relay remembers so it can publish a daily
 *  `stats/YYYY-MM-DD.md` on the attachments branch without asking GitHub to
 *  count anything. Counters only: no report text, contact, settings, errors or
 *  screenshot bytes, and no install id ever leaves this file — the markdown
 *  carries counts and slugs, never a device or a person.
 *
 *  The window is short on purpose (14 days): the markdown file in the private
 *  repository is the long-term record, this file only has to render it. */
export const STATS_KEEP_DAYS = 14;
const MAX_DAYS = STATS_KEEP_DAYS + 1;
const MAX_GROUPS = 50;
const MAX_INSTALLS = 200;
const MAX_FINGERPRINTS = 500;
const MAX_KEYS = 12;
const MAX_VERSIONS = 24;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface GroupDay {
  /** New issues filed from this group. */
  created: number;
  /** Reports that joined an open issue as a comment. */
  added: number;
  screenshots: number;
  lowSignal: number;
  /** Distinct rotating install ids that reported, this group, this day. */
  installs: string[];
  platforms: Record<string, number>;
  versions: Record<string, number>;
}

export interface FingerprintStat {
  issue: number;
  groups: string[];
  reports: number;
}

export interface DayStats {
  groups: Record<string, GroupDay>;
  fingerprints: Record<string, FingerprintStat>;
}

export interface RecordInput {
  at: number;
  group: string;
  install: string;
  fingerprint: string;
  issue: number;
  result: "created" | "added";
  screenshot: boolean;
  lowSignal: boolean;
  platform: string;
  version: string;
}

export interface RenderedStats {
  date: string;
  markdown: string;
  /** What the file's content is; the upload is skipped when unchanged. */
  digest: string;
  /** Nothing to say in the window: no artifact is published. */
  empty: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000 ? value as number : 0;

const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, max) : [];

const counts = (value: unknown, max: number): Record<string, number> => {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (Object.keys(out).length >= max) break;
    if (typeof key === "string" && key.length > 0 && key.length <= 120) out[key] = count(entry);
  }
  return out;
};

const bump = (bag: Record<string, number>, key: string, max: number): void => {
  if (bag[key] !== undefined) { bag[key] = bag[key]! + 1; return; }
  if (Object.keys(bag).length < max) bag[key] = 1;
};

export const dayKey = (at: number): string => new Date(at).toISOString().slice(0, 10);

const emptyGroup = (): GroupDay => ({
  created: 0, added: 0, screenshots: 0, lowSignal: 0, installs: [], platforms: {}, versions: {},
});

/** The group slugs that filed this fingerprint within the kept window. */
export const groupsOf = (days: Iterable<DayStats>, fingerprint: string): string[] => {
  const out = new Set<string>();
  for (const day of days) for (const group of day.fingerprints[fingerprint]?.groups ?? []) out.add(group);
  return [...out].sort();
};

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

const key = (at: number): string => dayKey(at);

export class ReportStats {
  private readonly file: string | null;
  private readonly now: () => number;
  private days = new Map<string, DayStats>();
  private uploaded = new Map<string, string>();

  constructor(file: string | null, now: () => number) {
    this.file = file;
    this.now = now;
    this.load();
    this.prune(this.now());
  }

  /** One filed report. Recorded after GitHub answered, so a failed filing is
   *  never counted. */
  record(input: RecordInput): void {
    const day = this.day(key(input.at));
    const groups = day.groups;
    const group = groups[input.group] ?? (Object.keys(groups).length < MAX_GROUPS ? emptyGroup() : undefined);
    if (!group) return;
    groups[input.group] = group;
    if (input.result === "created") group.created++;
    else group.added++;
    if (input.screenshot) group.screenshots++;
    if (input.lowSignal) group.lowSignal++;
    if (input.install && group.installs.length < MAX_INSTALLS && !group.installs.includes(input.install)) {
      group.installs.push(input.install);
    }
    bump(group.platforms, input.platform, MAX_KEYS);
    bump(group.versions, input.version, MAX_VERSIONS);

    const known = day.fingerprints[input.fingerprint];
    if (known) {
      known.reports++;
      known.issue = input.issue;
      if (!known.groups.includes(input.group) && known.groups.length < MAX_GROUPS) known.groups.push(input.group);
    } else if (Object.keys(day.fingerprints).length < MAX_FINGERPRINTS) {
      day.fingerprints[input.fingerprint] = { issue: input.issue, groups: [input.group], reports: 1 };
    }
    this.save();
  }

  /** Group slugs that already reported this fingerprint in the kept window,
   *  for the "seen in groups" line of a repeat comment. */
  groupsFor(fingerprint: string): string[] {
    return groupsOf(this.days.values(), fingerprint);
  }

  prune(now: number): void {
    const cutoff = dayKey(now - STATS_KEEP_DAYS * 86_400_000);
    for (const day of [...this.days.keys()]) if (day < cutoff) this.days.delete(day);
    for (const day of [...this.uploaded.keys()]) if (day < cutoff) this.uploaded.delete(day);
    this.save();
  }

  /** The markdown the relay publishes for today, covering the trailing window. */
  render(now: number, windowDays = 7): RenderedStats {
    const date = dayKey(now);
    const window = Math.min(Math.max(1, Math.floor(windowDays)), STATS_KEEP_DAYS);
    const days: Array<{ date: string; stats: DayStats }> = [];
    for (let back = 0; back < window; back++) {
      const day = dayKey(now - back * 86_400_000);
      const stats = this.days.get(day);
      if (stats) days.push({ date: day, stats });
    }
    days.reverse();
    const markdown = renderMarkdown(date, days, window);
    const empty = days.every((day) => Object.keys(day.stats.groups).length === 0);
    return { date, markdown, digest: digestOf(markdown), empty };
  }

  /** True when the rendered file differs from what this date already got. */
  needsUpload(rendered: RenderedStats): boolean {
    return this.uploaded.get(rendered.date) !== rendered.digest;
  }

  markUploaded(rendered: RenderedStats): void {
    this.uploaded.set(rendered.date, rendered.digest);
    this.save();
  }

  private day(day: string): DayStats {
    let stats = this.days.get(day);
    if (!stats) {
      stats = { groups: {}, fingerprints: {} };
      this.days.set(day, stats);
      while (this.days.size > MAX_DAYS) {
        const oldest = this.days.keys().next().value;
        if (oldest === undefined) break;
        this.days.delete(oldest);
      }
    }
    return stats;
  }

  private load(): void {
    if (!this.file) return;
    let text: string;
    try { text = readFileSync(this.file, "utf8"); } catch { return; }
    if (text.length > MAX_FILE_BYTES) { this.setAside(); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { this.setAside(); return; }
    if (!isRecord(parsed)) { this.setAside(); return; }
    const days = parsed.days;
    const uploaded = parsed.uploaded;
    if (days !== undefined && !isRecord(days)) { this.setAside(); return; }
    if (uploaded !== undefined && !isRecord(uploaded)) { this.setAside(); return; }
    for (const [day, value] of Object.entries(isRecord(days) ? days : {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isRecord(value)) continue;
      const groups: Record<string, GroupDay> = {};
      for (const [group, entry] of Object.entries(isRecord(value.groups) ? value.groups : {})) {
        if (Object.keys(groups).length >= MAX_GROUPS || !isRecord(entry)) continue;
        groups[group] = {
          created: count(entry.created),
          added: count(entry.added),
          screenshots: count(entry.screenshots),
          lowSignal: count(entry.lowSignal),
          installs: strings(entry.installs, MAX_INSTALLS),
          platforms: counts(entry.platforms, MAX_KEYS),
          versions: counts(entry.versions, MAX_VERSIONS),
        };
      }
      const fingerprints: Record<string, FingerprintStat> = {};
      for (const [fingerprint, entry] of Object.entries(isRecord(value.fingerprints) ? value.fingerprints : {})) {
        if (Object.keys(fingerprints).length >= MAX_FINGERPRINTS || !isRecord(entry)) continue;
        if (!Number.isInteger(entry.issue)) continue;
        fingerprints[fingerprint] = {
          issue: entry.issue as number,
          groups: strings(entry.groups, MAX_GROUPS),
          reports: count(entry.reports),
        };
      }
      this.days.set(day, { groups, fingerprints });
    }
    for (const [day, value] of Object.entries(isRecord(uploaded) ? uploaded : {})) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof value === "string" && value.length <= 64) this.uploaded.set(day, value);
    }
    while (this.days.size > MAX_DAYS) {
      const oldest = this.days.keys().next().value;
      if (oldest === undefined) break;
      this.days.delete(oldest);
    }
  }

  private setAside(): void {
    if (!this.file) return;
    try { renameSync(this.file, `${this.file}.corrupt-${this.now()}`); } catch { /* best effort */ }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const body = JSON.stringify({
        days: Object.fromEntries(this.days),
        uploaded: Object.fromEntries(this.uploaded),
      });
      const temporary = `${this.file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
      writeFileSync(temporary, `${body}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch { /* best effort: a lost counter is one missing row, not a lost report */ }
  }
}

interface Totals {
  group: string;
  created: number;
  added: number;
  installDays: number;
  screenshots: number;
  lowSignal: number;
  platforms: Record<string, number>;
}

// Backslash first: a value ending in `\` would otherwise escape the escape and reopen the cell.
const cell = (value: string): string => value.replace(/[\\|]/g, "\\$&");
const percent = (part: number, whole: number): string =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
const perInstall = (reports: number, installDays: number): string =>
  installDays > 0 ? (reports / installDays).toFixed(2) : "—";

function aggregate(days: ReadonlyArray<{ date: string; stats: DayStats }>): Totals[] {
  const byGroup = new Map<string, Totals>();
  for (const { stats } of days) {
    for (const [group, entry] of Object.entries(stats.groups)) {
      const totals = byGroup.get(group) ?? { group, created: 0, added: 0, installDays: 0, screenshots: 0, lowSignal: 0, platforms: {} };
      totals.created += entry.created;
      totals.added += entry.added;
      // Distinct install ids per day: a rotating id cannot be counted once
      // across days, so the honest denominator is install-days.
      totals.installDays += entry.installs.length;
      totals.screenshots += entry.screenshots;
      totals.lowSignal += entry.lowSignal;
      for (const [platform, value] of Object.entries(entry.platforms)) totals.platforms[platform] = (totals.platforms[platform] ?? 0) + value;
      byGroup.set(group, totals);
    }
  }
  return [...byGroup.values()].sort((a, b) => (b.created + b.added) - (a.created + a.added) || a.group.localeCompare(b.group));
}

const platforms = (bag: Record<string, number>): string =>
  Object.entries(bag).sort((a, b) => b[1] - a[1]).map(([name, value]) => `${name} ${value}`).join(", ") || "—";

/** The published artifact. Deliberately prose-light and stable in shape so a
 *  person or the nightly triager can diff two days without parsing tricks. */
export function renderMarkdown(date: string, days: ReadonlyArray<{ date: string; stats: DayStats }>, windowDays: number): string {
  const from = days[0]?.date ?? date;
  const to = date;
  const lines: string[] = [];
  lines.push(`# Nightly report activity · ${date}`, "");
  lines.push(
    `Window: ${from} → ${to} (UTC, last ${windowDays} day${windowDays === 1 ? "" : "s"}). Written by the Polyth report relay`,
    "from the group tokens that filed each report. Groups are token identities; this file",
    "never names a person, a device, an install id or a report's text.",
    "",
    "`Install-days` counts distinct rotating install ids per day: it is the denominator for",
    "`Reports / install-day`, so a bigger group does not look like a buggier one.",
    "",
  );

  const totals = aggregate(days);
  if (totals.length === 0) {
    lines.push("No reports in the window.", "");
  } else {
    lines.push("## Groups", "");
    lines.push("| Group | Reports | New issues | Comments | Install-days | Reports / install-day | Screenshots | Low-signal | Platforms |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const totalsRow of totals) {
      const reports = totalsRow.created + totalsRow.added;
      lines.push(`| ${cell(totalsRow.group)} | ${reports} | ${totalsRow.created} | ${totalsRow.added} | ${totalsRow.installDays} | ${perInstall(reports, totalsRow.installDays)} | ${percent(totalsRow.screenshots, reports)} | ${percent(totalsRow.lowSignal, reports)} | ${cell(platforms(totalsRow.platforms))} |`);
    }
    lines.push("");

    lines.push("## By day", "");
    lines.push("| Date | Group | Reports | New issues | Comments | Install-days | Reports / install-day |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const day of days) {
      const rows = aggregate([day]);
      for (const row of rows) {
        const reports = row.created + row.added;
        lines.push(`| ${day.date} | ${cell(row.group)} | ${reports} | ${row.created} | ${row.added} | ${row.installDays} | ${perInstall(reports, row.installDays)} |`);
      }
    }
    lines.push("");

    // The comparison that matters: one problem, more than one group. That is
    // stronger evidence than the same number of reports from a single group.
    const shared: Array<{ fingerprint: string; issue: number; groups: string[]; reports: number }> = [];
    const merged = new Map<string, { issue: number; groups: Set<string>; reports: number }>();
    for (const day of days) {
      for (const [fingerprint, entry] of Object.entries(day.stats.fingerprints)) {
        const known = merged.get(fingerprint) ?? { issue: entry.issue, groups: new Set<string>(), reports: 0 };
        known.issue = entry.issue;
        known.reports += entry.reports;
        for (const group of entry.groups) known.groups.add(group);
        merged.set(fingerprint, known);
      }
    }
    for (const [fingerprint, entry] of merged) {
      if (entry.groups.size > 1) shared.push({ fingerprint, issue: entry.issue, groups: [...entry.groups].sort(), reports: entry.reports });
    }
    shared.sort((a, b) => b.groups.length - a.groups.length || a.issue - b.issue);
    lines.push("## Seen in more than one group", "");
    if (shared.length === 0) {
      lines.push("None: every problem in the window came from a single group.", "");
    } else {
      lines.push("| Issue | Fingerprint | Groups | Reports |");
      lines.push("| --- | --- | --- | --- |");
      for (const entry of shared) {
        lines.push(`| #${entry.issue} | \`${entry.fingerprint}\` | ${cell(entry.groups.join(", "))} | ${entry.reports} |`);
      }
      lines.push("");
      lines.push("A crash or data loss on two or more groups is the strongest signal in this file.", "");
    }
  }
  lines.push("---", "", "Generated by `polyth-report-relay`; see `packages/report-relay/README.md`.", "");
  return lines.join("\n");
}
