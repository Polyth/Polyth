import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The relay's small durable state: which `reportId` produced which issue
 *  (idempotency) and which fingerprint is filed under which issue (dedup).
 *  A JSON file rewritten atomically; entries expire after 30 days and each map
 *  keeps at most 20 000 entries, dropping the oldest. A corrupt file is moved
 *  aside and the relay starts empty. */
export interface ReportRecord {
  issue: number;
  result: "created" | "added";
  at: number;
}

export interface FingerprintRecord {
  issue: number;
  at: number;
}

const EXPIRY_MS = 30 * 86_400_000;
const MAX_ENTRIES = 20_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const entryTime = (value: unknown): number | null => {
  if (!isRecord(value) || !Number.isInteger(value.issue) || typeof value.at !== "number") return null;
  return value.at;
};

export class ReportState {
  private readonly file: string | null;
  private readonly now: () => number;
  private readonly reports = new Map<string, ReportRecord>();
  private readonly fingerprints = new Map<string, FingerprintRecord>();

  constructor(file: string | null, now: () => number) {
    this.file = file;
    this.now = now;
    this.load();
    this.prune(this.now());
  }

  report(reportId: string): ReportRecord | undefined {
    const record = this.reports.get(reportId);
    if (!record) return undefined;
    if (this.expired(record.at)) { this.reports.delete(reportId); return undefined; }
    return record;
  }

  fingerprint(key: string): FingerprintRecord | undefined {
    const record = this.fingerprints.get(key);
    if (!record) return undefined;
    if (this.expired(record.at)) { this.fingerprints.delete(key); return undefined; }
    return record;
  }

  rememberReport(reportId: string, record: ReportRecord): void {
    this.reports.delete(reportId);
    this.reports.set(reportId, record);
    this.trim(this.reports);
    this.save();
  }

  rememberFingerprint(key: string, issue: number, at: number): void {
    this.fingerprints.delete(key);
    this.fingerprints.set(key, { issue, at });
    this.trim(this.fingerprints);
    this.save();
  }

  prune(now: number): void {
    for (const [key, record] of this.reports) if (now - record.at >= EXPIRY_MS) this.reports.delete(key);
    for (const [key, record] of this.fingerprints) if (now - record.at >= EXPIRY_MS) this.fingerprints.delete(key);
    this.trim(this.reports);
    this.trim(this.fingerprints);
    this.save();
  }

  private expired(at: number): boolean {
    return this.now() - at >= EXPIRY_MS;
  }

  /** Keeps the newest MAX_ENTRIES: insertion order is oldest first because
   *  every write re-inserts the key. */
  private trim<T extends { at: number }>(map: Map<string, T>): void {
    while (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }

  private load(): void {
    if (!this.file) return;
    let text: string;
    try { text = readFileSync(this.file, "utf8"); } catch { return; }
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; } catch { this.setAside(); return; }
    if (!isRecord(parsed)) { this.setAside(); return; }
    const reports = parsed.reports;
    const fingerprints = parsed.fingerprints;
    if (reports !== undefined && !isRecord(reports)) { this.setAside(); return; }
    if (fingerprints !== undefined && !isRecord(fingerprints)) { this.setAside(); return; }
    for (const [key, value] of Object.entries(isRecord(reports) ? reports : {})) {
      const at = entryTime(value);
      const issue = isRecord(value) ? value.issue : undefined;
      const result = isRecord(value) ? value.result : undefined;
      if (at === null || !Number.isInteger(issue)) continue;
      if (result !== "created" && result !== "added") continue;
      this.reports.set(key, { issue: issue as number, result, at });
    }
    for (const [key, value] of Object.entries(isRecord(fingerprints) ? fingerprints : {})) {
      const at = entryTime(value);
      const issue = isRecord(value) ? value.issue : undefined;
      if (at === null || !Number.isInteger(issue)) continue;
      this.fingerprints.set(key, { issue: issue as number, at });
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
        reports: Object.fromEntries(this.reports),
        fingerprints: Object.fromEntries(this.fingerprints),
      });
      const temporary = `${this.file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
      writeFileSync(temporary, `${body}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch { /* state is best effort; a lost write costs one duplicate report */ }
  }
}
