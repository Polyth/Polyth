// Plans and start history. Host logins are deployment-wide, so these are too: one
// account has one schedule, whoever set it.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type { PingRecord } from "./decide.ts";
import { parsePlan, type WindowPlan } from "./plan.ts";

export interface StoredPlan {
  plan: WindowPlan;
  /** The Space it was saved from: a harness that runs in a project uses one of its. */
  spaceId: string;
  updatedBy: string;
  updatedAt: number;
  /** The private login this plan was made for. A plan never follows an account id
   *  to another person. */
  ownerUserId?: string;
}

/** Per meter; enough to read back a week of one-a-window starts. */
const MAX_RECORDS = 40;

const meterKey = (sourceId: string, meterId: string): string => `${sourceId}\u0000${meterId}`;

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

const write = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteSync(file, JSON.stringify(value));
};

export interface PlanStore {
  plan(sourceId: string): StoredPlan | undefined;
  savePlan(sourceId: string, stored: StoredPlan): void;
  records(sourceId: string, meterId: string): readonly PingRecord[];
  /** Adds a record, or replaces the one with its id; persisted before returning. */
  putRecord(sourceId: string, meterId: string, record: PingRecord): void;
}

export function createPlanStore(dir: string): PlanStore {
  const plansFile = join(dir, "plans-v1.json");
  const historyFile = join(dir, "history-v1.json");
  const plans = new Map<string, StoredPlan>();
  const history = new Map<string, PingRecord[]>();

  const rawPlans = (readJson(plansFile) as { plans?: Record<string, StoredPlan> } | undefined)?.plans;
  for (const [sourceId, stored] of Object.entries(rawPlans ?? {})) {
    try {
      if (typeof stored.spaceId !== "string" || typeof stored.updatedBy !== "string") continue;
      plans.set(sourceId, {
        plan: parsePlan(stored.plan),
        spaceId: stored.spaceId,
        updatedBy: stored.updatedBy,
        updatedAt: Number.isFinite(stored.updatedAt) ? stored.updatedAt : 0,
        ...(typeof stored.ownerUserId === "string" ? { ownerUserId: stored.ownerUserId } : {}),
      });
    } catch {
      // A plan this version cannot read stays unset rather than running wrong.
    }
  }
  const rawHistory = (readJson(historyFile) as { records?: Record<string, PingRecord[]> } | undefined)?.records;
  for (const [key, records] of Object.entries(rawHistory ?? {})) {
    if (Array.isArray(records)) history.set(key, records.slice(0, MAX_RECORDS));
  }

  return {
    plan: (sourceId) => plans.get(sourceId),
    savePlan(sourceId, stored) {
      plans.set(sourceId, stored);
      write(plansFile, { version: 1, plans: Object.fromEntries(plans) });
    },
    records: (sourceId, meterId) => history.get(meterKey(sourceId, meterId)) ?? [],
    putRecord(sourceId, meterId, record) {
      const key = meterKey(sourceId, meterId);
      const list = history.get(key) ?? [];
      const index = list.findIndex((row) => row.id === record.id);
      const next = index >= 0 ? list.map((row, at) => (at === index ? record : row)) : [record, ...list];
      history.set(key, next.slice(0, MAX_RECORDS));
      write(historyFile, { version: 1, records: Object.fromEntries(history) });
    },
  };
}
