// Generated-walkthrough jobs (WP11). The source diff is captured before
// generation and digested; results cache by digest + prompt version + model so
// a retry never re-bills. `walkthrough/generated` is appended to the session
// event log BEFORE the job flips to ready (invariant: log before display).
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GeneratedWalkthroughDto, GeneratedWalkthroughStage, JsonObject, SessionEvent, WalkthroughSource } from "@polyth/contracts";
import {
  WALKTHROUGH_PROMPT_VERSION, buildWalkthroughPrompt, heuristicStages,
  parseGeneratedStages, parseUnifiedDiffText, sourceDigestOf,
} from "@polyth/walkthrough";

export interface WalkthroughJobDeps {
  /** Capture the immutable source diff for a walkthrough source. */
  captureDiff: (source: WalkthroughSource) => Promise<string>;
  /** Model call (one-shot). Absent → heuristic stages with honest labels. */
  generate?: (source: WalkthroughSource, prompt: string) => Promise<string>;
  /** Append to the session log; used only when the job carries a sessionId. */
  append?: (sessionId: string, type: string, data: JsonObject) => Promise<SessionEvent>;
  cacheFile?: string;
  modelId?: string;
}

export interface WalkthroughJobService {
  create(source: WalkthroughSource, sessionId?: string): Promise<GeneratedWalkthroughDto>;
  get(id: string): GeneratedWalkthroughDto | null;
  cancel(id: string): GeneratedWalkthroughDto | null;
  sourceStatus(id: string): Promise<{ stale: boolean; sourceDigest: string; currentDigest: string }>;
  list(): GeneratedWalkthroughDto[];
  /** test hook: resolves when the job with this id has settled */
  settled(id: string): Promise<void>;
}

interface CacheEntry { stages: GeneratedWalkthroughStage[]; createdAt: number }

export function createWalkthroughJobService(deps: WalkthroughJobDeps): WalkthroughJobService {
  const jobs = new Map<string, GeneratedWalkthroughDto>();
  const cancelled = new Set<string>();
  const settlers = new Map<string, Promise<void>>();

  // ---- disk cache keyed by digest + prompt version + model -----------------
  let cache: Record<string, CacheEntry> = {};
  if (deps.cacheFile) {
    try {
      cache = JSON.parse(readFileSync(deps.cacheFile, "utf8")) as Record<string, CacheEntry>;
    } catch { /* first run or corrupt cache: start empty */ }
  }
  const cacheKey = (digest: string): string =>
    `${digest}:v${WALKTHROUGH_PROMPT_VERSION}:${deps.modelId ?? (deps.generate ? "default" : "heuristic")}`;
  const saveCache = () => {
    if (!deps.cacheFile) return;
    try {
      mkdirSync(dirname(deps.cacheFile), { recursive: true });
      writeFileSync(deps.cacheFile, JSON.stringify(cache));
    } catch { /* cache is best-effort */ }
  };

  const finishReady = async (
    job: GeneratedWalkthroughDto,
    stages: GeneratedWalkthroughStage[],
    sessionId?: string,
  ) => {
    // log BEFORE the dto becomes visible as ready
    if (sessionId && deps.append) {
      await deps.append(sessionId, "walkthrough/generated", {
        walkthroughId: job.id,
        sourceDigest: job.sourceDigest,
        stages: stages as unknown as JsonObject[],
      });
    }
    job.stages = stages;
    job.status = "ready";
  };

  const run = async (job: GeneratedWalkthroughDto, diff: string, sessionId?: string): Promise<void> => {
    try {
      job.status = "running";
      const files = parseUnifiedDiffText(diff);
      const key = cacheKey(job.sourceDigest);
      const hit = cache[key];
      if (hit) {
        if (cancelled.has(job.id)) { job.status = "failed"; job.error = "cancelled"; return; }
        await finishReady(job, hit.stages, sessionId);
        return;
      }

      let stages: GeneratedWalkthroughStage[];
      if (deps.generate) {
        const raw = await deps.generate(job.source, buildWalkthroughPrompt(files));
        if (cancelled.has(job.id)) { job.status = "failed"; job.error = "cancelled"; return; }
        const parsed = parseGeneratedStages(raw, files);
        if (!parsed.ok) { job.status = "failed"; job.error = parsed.error; return; }
        stages = parsed.stages;
      } else {
        stages = heuristicStages(files);
      }
      if (cancelled.has(job.id)) { job.status = "failed"; job.error = "cancelled"; return; }
      cache[key] = { stages, createdAt: Date.now() };
      saveCache();
      await finishReady(job, stages, sessionId);
    } catch (e) {
      job.status = "failed";
      job.error = e instanceof Error ? e.message : String(e);
    }
  };

  return {
    async create(source, sessionId) {
      const diff = await deps.captureDiff(source);
      if (!diff.trim()) {
        const empty: GeneratedWalkthroughDto = {
          id: randomUUID(), source, sourceDigest: sourceDigestOf(diff),
          status: "failed", stages: [], error: "no changes in the selected source", createdAt: Date.now(),
        };
        jobs.set(empty.id, empty);
        settlers.set(empty.id, Promise.resolve());
        return empty;
      }
      const job: GeneratedWalkthroughDto = {
        id: randomUUID(), source, sourceDigest: sourceDigestOf(diff),
        status: "queued", stages: [], createdAt: Date.now(),
      };
      jobs.set(job.id, job);
      settlers.set(job.id, run(job, diff, sessionId));
      return job;
    },

    get: (id) => jobs.get(id) ?? null,

    cancel(id) {
      const job = jobs.get(id);
      if (!job) return null;
      if (job.status === "queued" || job.status === "running") {
        cancelled.add(id);
        job.status = "failed";
        job.error = "cancelled";
      }
      return job;
    },

    async sourceStatus(id) {
      const job = jobs.get(id);
      if (!job) throw Object.assign(new Error("unknown walkthrough"), { code: "not-found" });
      const currentDigest = sourceDigestOf(await deps.captureDiff(job.source));
      return { stale: currentDigest !== job.sourceDigest, sourceDigest: job.sourceDigest, currentDigest };
    },

    list: () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt),

    settled: (id) => settlers.get(id) ?? Promise.resolve(),
  };
}
