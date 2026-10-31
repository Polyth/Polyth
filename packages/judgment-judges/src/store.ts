// Space-owned persistence: `spaceStorage(space).packageDir("judgment-judges")`
// holds judges.json (versioned, revisioned, atomically replaced) and
// usage.json (today's call count per judge). Synchronous file I/O keeps every
// read-modify-write atomic within the single server thread.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import { JUDGE_ID, MAX_JUDGES, validateJudgeInput, type JudgeDefinition, type JudgeInput, type JudgeFailure, type JudgeUsage } from "./types.ts";

export interface StoredJudges { version: 1; revision: number; judges: JudgeDefinition[] }
interface StoredUsage { version: 1; judges: Record<string, JudgeUsage> }

const corrupt = () => Object.assign(new Error("Judges storage is unreadable"), { code: "internal" });
const conflict = () => Object.assign(new Error("Judges changed; reload before saving"), { code: "conflict" });
const notFound = () => Object.assign(new Error("Judge not found"), { code: "not-found" });

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw corrupt();
  }
}

export function readJudges(file: string): StoredJudges {
  const raw = readJson(file) as Partial<StoredJudges> | undefined;
  if (raw === undefined) return { version: 1, revision: 0, judges: [] };
  if (!raw || raw.version !== 1 || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || !Array.isArray(raw.judges)) throw corrupt();
  // Corrupt stored judges fail loudly instead of silently resetting the list.
  const judges = raw.judges.map((judge) => {
    if (!judge || typeof judge !== "object" || !JUDGE_ID.test(judge.id) || !Number.isSafeInteger(judge.createdAt) || !Number.isSafeInteger(judge.updatedAt)) throw corrupt();
    const { id, createdAt, updatedAt, ownerUserId, ...input } = judge;
    if (ownerUserId !== undefined && !ownerId(ownerUserId)) throw corrupt();
    try { return { ...validateJudgeInput(input), id, createdAt, updatedAt, ...(ownerUserId ? { ownerUserId } : {}) }; } catch { throw corrupt(); }
  });
  return { version: 1, revision: raw.revision as number, judges };
}

/** A person id as the host mints it; never a system principal. */
const ownerId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const owner = (ownerUserId: string | undefined) => (ownerId(ownerUserId) ? { ownerUserId } : {});

const write = (file: string, next: StoredJudges) => { atomicWriteSync(file, `${JSON.stringify(next)}\n`, 0o600); return next; };
const checkRevision = (current: StoredJudges, expected: unknown) => {
  if (!Number.isSafeInteger(expected) || current.revision !== expected) throw conflict();
};

/** `ownerUserId` is the signed-in person saving the judge: its actions run as them. */
export function createJudge(file: string, expectedRevision: unknown, input: unknown, now = Date.now(), ownerUserId?: string): { store: StoredJudges; judge: JudgeDefinition } {
  const valid = validateJudgeInput(input);
  const current = readJudges(file);
  checkRevision(current, expectedRevision);
  if (current.judges.length >= MAX_JUDGES) throw Object.assign(new Error(`At most ${MAX_JUDGES} judges per Space`), { code: "invalid-input" });
  let id: string;
  do id = `j${randomBytes(6).toString("hex")}`; while (current.judges.some((judge) => judge.id === id));
  const judge: JudgeDefinition = { ...valid, id, createdAt: now, updatedAt: now, ...owner(ownerUserId) };
  return { store: write(file, { ...current, revision: current.revision + 1, judges: [...current.judges, judge] }), judge };
}

/** Whoever saves a judge becomes its owner: the policy they saved acts with their access, never with someone else's. */
export function updateJudge(file: string, expectedRevision: unknown, id: string, input: unknown, now = Date.now(), ownerUserId?: string): StoredJudges {
  const valid: JudgeInput = validateJudgeInput(input);
  const current = readJudges(file);
  checkRevision(current, expectedRevision);
  const existing = current.judges.find((judge) => judge.id === id);
  if (!existing) throw notFound();
  return write(file, { ...current, revision: current.revision + 1,
    judges: current.judges.map((judge) => (judge.id === id ? { ...valid, id, createdAt: existing.createdAt, updatedAt: now, ...owner(ownerUserId) } : judge)) });
}

export function deleteJudge(file: string, expectedRevision: unknown, id: string): StoredJudges {
  const current = readJudges(file);
  checkRevision(current, expectedRevision);
  if (!current.judges.some((judge) => judge.id === id)) throw notFound();
  return write(file, { ...current, revision: current.revision + 1, judges: current.judges.filter((judge) => judge.id !== id) });
}

export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** The ledger, or undefined when it is unreadable. A damaged ledger never lifts a cap. */
function readUsage(file: string): StoredUsage | undefined {
  let raw: Partial<StoredUsage> | undefined;
  try { raw = readJson(file) as Partial<StoredUsage> | undefined; } catch { return undefined; }
  if (raw === undefined) return { version: 1, judges: {} };
  if (!raw || raw.version !== 1 || !raw.judges || typeof raw.judges !== "object" || Array.isArray(raw.judges)) return undefined;
  return raw as StoredUsage;
}

/** Today's usage of every judge; stale days read as zero. */
export function usageToday(file: string, now = Date.now()): Record<string, JudgeUsage> {
  const day = utcDay(now), usage = readUsage(file);
  if (!usage) return {};
  return Object.fromEntries(Object.entries(usage.judges)
    .filter(([id, entry]) => JUDGE_ID.test(id) && entry && entry.day === day && Number.isSafeInteger(entry.count))
    .map(([id, entry]) => [id, { day, count: entry.count, ...(validFailure(entry.failure) ? { failure: { reason: entry.failure.reason, at: entry.failure.at } } : {}) }]));
}

const validFailure = (value: unknown): value is JudgeFailure => !!value && typeof value === "object"
  && typeof (value as JudgeFailure).reason === "string" && /^[a-z-]{1,40}$/.test((value as JudgeFailure).reason)
  && Number.isSafeInteger((value as JudgeFailure).at);

/**
 * Remembers why the judge's call just now got no answer (a Judgment failure
 * reason, never evidence), or clears it after an answer. Only today's row,
 * which `reserveCall` wrote first, is touched: it never changes a count.
 */
export function noteOutcome(file: string, judgeId: string, failure: string | undefined, now = Date.now()): void {
  const usage = readUsage(file);
  const entry = usage?.judges[judgeId];
  if (!usage || !entry || entry.day !== utcDay(now) || (!failure && !entry.failure)) return;
  const { failure: _previous, ...rest } = entry;
  const next: JudgeUsage = failure ? { ...rest, failure: { reason: failure, at: now } } : rest;
  atomicWriteSync(file, `${JSON.stringify({ version: 1, judges: { ...usage.judges, [judgeId]: next } })}\n`, 0o600);
}

/**
 * Reserves one Judgment call for `judgeId` today. Returns false (and writes
 * nothing) when the cap is reached or the ledger is unreadable. Calls are
 * counted when reserved, not refunded on failure: a failed call may still cost.
 */
export function reserveCall(file: string, judgeId: string, cap: number, now = Date.now()): boolean {
  const usage = readUsage(file);
  if (!usage) return false;
  const day = utcDay(now);
  const entry = usage.judges[judgeId];
  const count = entry && entry.day === day && Number.isSafeInteger(entry.count) ? entry.count : 0;
  if (count >= cap) return false;
  const judges: Record<string, JudgeUsage> = {};
  // Drop yesterday's rows while writing today's.
  for (const [id, value] of Object.entries(usage.judges)) if (JUDGE_ID.test(id) && value?.day === day) judges[id] = value;
  judges[judgeId] = { ...(entry?.day === day ? entry : {}), day, count: count + 1 };
  atomicWriteSync(file, `${JSON.stringify({ version: 1, judges })}\n`, 0o600);
  return true;
}
