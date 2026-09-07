// Generated-walkthrough jobs (WP11). The source diff is captured before
// generation and digested; results cache by digest + prompt version + model so
// a retry never re-bills. `walkthrough/generated` is appended to the session
// event log BEFORE the job flips to ready (invariant: log before display).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite } from "@polyth/plugins";
import type { GeneratedWalkthroughDto, GeneratedWalkthroughStage, JsonObject, SessionEvent, WalkthroughSource } from "@polyth/contracts";
import {
  WALKTHROUGH_PROMPT_VERSION, buildWalkthroughPrompt, heuristicStages,
  parseGeneratedStages, parseUnifiedDiffText, sourceDigestOf,
} from "./index.ts";

export interface WalkthroughJobDeps {
  /** Capture the immutable source diff for a walkthrough source. */
  captureDiff: (source: WalkthroughSource) => Promise<string>;
  /** Model call (one-shot). Absent → heuristic stages with honest labels. */
  generate?: (source: WalkthroughSource, prompt: string, signal?: AbortSignal) => Promise<string>;
  /** Append to the session log; used only when the job carries a sessionId. */
  append?: (sessionId: string, type: string, data: JsonObject) => Promise<SessionEvent>;
  cacheFile?: string;
  modelId?: string;
  /** Global prompt budget calculated from the selected model's context/output limits. */
  inputBudget?: (source: WalkthroughSource) => Promise<number>;
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
const MAX_CACHE_ENTRIES = 128;

export function createWalkthroughJobService(deps: WalkthroughJobDeps): WalkthroughJobService {
  const jobs = new Map<string, GeneratedWalkthroughDto>();
  const cancelled = new Set<string>();
  const settlers = new Map<string, Promise<void>>();
  const captures = new Map<string, Promise<{ diff: string; digest: string }>>();
  const inFlight = new Map<string, {
    controller: AbortController;
    jobs: Set<string>;
    promise: Promise<GeneratedWalkthroughStage[]>;
  }>();

  // ---- disk cache keyed by digest + prompt version + model -----------------
  let cache: Record<string, CacheEntry> = {};
  if (deps.cacheFile) {
    try {
      cache = JSON.parse(readFileSync(deps.cacheFile, "utf8")) as Record<string, CacheEntry>;
    } catch { /* first run or corrupt cache: start empty */ }
  }
  const cacheKey = (digest: string): string =>
    `${digest}:v${WALKTHROUGH_PROMPT_VERSION}:${deps.modelId ?? (deps.generate ? "default" : "heuristic")}`;
  let cacheWrite: Promise<void> = Promise.resolve();
  const saveCache = () => {
    if (!deps.cacheFile) return;
    // Ready delivery never waits for a whole-cache rewrite. Serialised atomic
    // replacements retain crash safety without blocking the request path.
    const snapshot = JSON.stringify(cache);
    const file = deps.cacheFile;
    cacheWrite = cacheWrite.catch(() => {}).then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true });
        await atomicWrite(file, snapshot);
      } catch { /* cache is best-effort */ }
    });
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

  const stagesFor = (
    key: string,
    source: WalkthroughSource,
    files: ReturnType<typeof parseUnifiedDiffText>,
    prompt: string,
    jobId: string,
  ): Promise<GeneratedWalkthroughStage[]> => {
    const active = inFlight.get(key);
    if (active) {
      active.jobs.add(jobId);
      return active.promise;
    }
    const controller = new AbortController();
    const promise = (async () => {
      if (!deps.generate) return heuristicStages(files);
      const raw = await deps.generate(source, prompt, controller.signal);
      const parsed = parseGeneratedStages(raw, files);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.stages;
    })().finally(() => { inFlight.delete(key); });
    inFlight.set(key, { controller, jobs: new Set([jobId]), promise });
    return promise;
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

      const inputBudget = deps.inputBudget ? await deps.inputBudget(job.source) : undefined;
      const stages = await stagesFor(key, job.source, files, buildWalkthroughPrompt(files, inputBudget), job.id);
      if (cancelled.has(job.id)) { job.status = "failed"; job.error = "cancelled"; return; }
      cache[key] = { stages, createdAt: Date.now() };
      const oldest = Object.entries(cache)
        .sort(([, a], [, b]) => a.createdAt - b.createdAt)
        .slice(0, Math.max(0, Object.keys(cache).length - MAX_CACHE_ENTRIES));
      for (const [oldKey] of oldest) delete cache[oldKey];
      saveCache();
      await finishReady(job, stages, sessionId);
    } catch (e) {
      if (cancelled.has(job.id)) {
        job.status = "failed";
        job.error = "cancelled";
        return;
      }
      job.status = "failed";
      job.error = e instanceof Error ? e.message : String(e);
    }
  };

  return {
    async create(source, sessionId) {
      const sourceKey = JSON.stringify(source);
      let capture = captures.get(sourceKey);
      if (!capture) {
        capture = deps.captureDiff(source).then((diff) => ({ diff, digest: sourceDigestOf(diff) }));
        captures.set(sourceKey, capture);
        void capture.finally(() => { captures.delete(sourceKey); });
      }
      const { diff, digest } = await capture;
      if (!diff.trim()) {
        const empty: GeneratedWalkthroughDto = {
          id: randomUUID(), source, sourceDigest: digest,
          status: "failed", stages: [], error: "no changes in the selected source", createdAt: Date.now(),
        };
        jobs.set(empty.id, empty);
        settlers.set(empty.id, Promise.resolve());
        return empty;
      }
      const job: GeneratedWalkthroughDto = {
        id: randomUUID(), source, sourceDigest: digest,
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
        const flight = inFlight.get(cacheKey(job.sourceDigest));
        if (flight) {
          flight.jobs.delete(id);
          if (flight.jobs.size === 0) flight.controller.abort();
        }
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

    settled: async (id) => {
      await (settlers.get(id) ?? Promise.resolve());
      // Test/administrative hook only; normal readiness never awaits disk.
      await cacheWrite;
    },
  };
}
