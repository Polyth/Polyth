import type {
  AgentDescriptor,
  HarnessSnapshot,
  ModelDescriptor,
  ProjectService,
} from "@polyth/contracts";
import { dedupeModelDescriptors } from "@polyth/contracts/model-context";
import type { RuntimePool } from "./sessions.ts";
import { aggregateRuntimes } from "./runtimeAggregate.ts";

export interface RuntimeCatalogReadOptions {
  /**
   * Oldest server copy this caller may act on. An older copy, or one a
   * degraded or still-revalidating harness left incomplete, is re-read
   * through the harness registry first; the registry's own TTLs still apply.
   * Omitted: the server-lifetime copy, dropped only by invalidation.
   */
  maxAgeMs?: number;
}

export interface RuntimeCatalog {
  models(options?: RuntimeCatalogReadOptions): Promise<ModelDescriptor[]>;
  agents(): Promise<AgentDescriptor[]>;
  patchAgent(agent: AgentDescriptor): void;
  /** Drop model metadata after provider/auth/config changes. */
  invalidateModels(): void;
  /**
   * A provider or runtime said a selected model is unknown or unavailable.
   * Providers add and retire models without telling anyone, so this is the
   * catalog's self-healing signal: drop the cached lists and force one native
   * rediscovery of that harness. Throttled per harness; returns whether this
   * signal started a refresh.
   */
  modelsStale(signal: ModelCatalogStaleSignal): boolean;
}

export interface ModelCatalogStaleSignal {
  harnessId?: string;
  /** Project context the failure happened in; the catalog authority is used otherwise. */
  projectId?: string;
  reason: "turn-model-unavailable" | "preflight-invalid-model" | "small-model-invalid-model";
}

/** One forced rediscovery per harness per window: a session that keeps hitting
 * the same retired model must not turn every failed turn into a discovery. */
export const MODEL_CATALOG_STALE_COOLDOWN_MS = 60_000;

type CatalogSnapshot = {
  models: ModelDescriptor[];
  agents: AgentDescriptor[];
  modelsOk: boolean;
  agentsOk: boolean;
  /** Every enabled harness answered with current, authoritative detail. */
  complete: boolean;
};

type SnapshotRuntimePool = RuntimePool & {
  /** Harness-registry metadata seam exposed by createHarnessPool. */
  harnessSnapshots?(
    projectId: string,
    cwd?: string,
    options?: { harnessId?: string; force?: boolean; detail?: boolean },
  ): Promise<HarnessSnapshot[]>;
};

const dedupeAgents = (items: AgentDescriptor[]): AgentDescriptor[] => {
  const seen = new Set<string>();
  return items.filter((agent) => {
    const key = `${agent.harnessId ?? "legacy"}/${agent.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const snapshotCatalog = (snapshots: HarnessSnapshot[]): Pick<CatalogSnapshot, "models" | "agents"> => {
  const models: ModelDescriptor[] = [];
  const agents: AgentDescriptor[] = [];
  for (const snapshot of snapshots) {
    if (!snapshot.policy.enabled) continue;
    const harnessId = snapshot.identity.id;
    for (const model of snapshot.catalog?.models ?? []) {
      models.push({ ...model, harnessId: model.harnessId ?? harnessId });
    }
    for (const agent of snapshot.catalog?.agents ?? snapshot.catalog?.roles ?? []) {
      agents.push({ ...agent, harnessId: agent.harnessId ?? harnessId });
    }
  }
  // Pass every native row to the shared merge before enrichment so duplicate
  // rows can contribute an agreed limit or a durable conflict marker.
  return { models, agents: dedupeAgents(agents) };
};

const authoritativeDetail = (snapshot: HarnessSnapshot): boolean =>
  snapshot.stale !== true
  && snapshot.availability.state !== "degraded"
  && snapshot.availability.state !== "offline";

/**
 * Global model/agent metadata is read from the harness registry in one project
 * context. First load cheap summaries, then detail only enabled harnesses in
 * parallel. Registry TTL/singleflight makes cost bounded by harness count and
 * never by unrelated project count; models and agents share this same load.
 *
 * Older/tests-only RuntimePool implementations without the snapshot seam fall
 * back to the bounded runtime aggregator for compatibility.
 */
export function createRuntimeCatalog(deps: {
  projects: ProjectService;
  runtimes: RuntimePool;
  enrichModels?: (models: readonly ModelDescriptor[]) => Promise<readonly ModelDescriptor[]>;
  onModelsInvalidated?(): void;
  /** Drop every registry snapshot of one harness (all project contexts). */
  invalidateHarness?(harnessId: string): void;
  now?: () => number;
}): RuntimeCatalog {
  let models: ModelDescriptor[] | undefined;
  /** When the cached models were requested; absent for an incomplete load. */
  let modelsAt: number | undefined;
  let agents: AgentDescriptor[] | undefined;
  let pending: Promise<CatalogSnapshot> | undefined;
  let modelEpoch = 0;
  const staleSignalAt = new Map<string, number>();
  const now = deps.now ?? Date.now;

  const catalogAuthority = async (): Promise<{ projectId: string; cwd?: string }> => {
    const projects = await deps.projects.list();
    const authority = projects.find((project) => !project.remote) ?? projects[0];
    return { projectId: authority?.id ?? "__default__", ...(authority?.path ? { cwd: authority.path } : {}) };
  };

  const invalidateModels = (): void => {
    modelEpoch += 1;
    models = undefined;
    modelsAt = undefined;
    deps.onModelsInvalidated?.();
  };

  const enrichModels = async (models: readonly ModelDescriptor[]): Promise<ModelDescriptor[]> => {
    const native = dedupeModelDescriptors(models);
    if (!deps.enrichModels || !native.some((model) => model.context === undefined && model.contextStatus !== "conflict")) return native;
    try {
      return dedupeModelDescriptors(await deps.enrichModels(native));
    } catch {
      // Context metadata improves presentation but must never erase a valid
      // harness catalog or block session work.
      return native;
    }
  };

  const loadFallback = (): Promise<CatalogSnapshot> => aggregateRuntimes(
    deps,
    async (runtime) => {
      const [modelResult, agentResult] = await Promise.allSettled([
        runtime.models(),
        runtime.agents(),
      ]);
      if (modelResult.status === "rejected" && agentResult.status === "rejected") {
        throw modelResult.reason;
      }
      return [{
        models: modelResult.status === "fulfilled"
          ? modelResult.value.map((model) => ({
              ...model,
              ...(runtime.harnessId ? { harnessId: runtime.harnessId } : {}),
            }))
          : [],
        agents: agentResult.status === "fulfilled"
          ? agentResult.value.map((agent) => ({
              ...agent,
              ...(runtime.harnessId ? { harnessId: runtime.harnessId } : {}),
            }))
          : [],
        modelsOk: modelResult.status === "fulfilled",
        agentsOk: agentResult.status === "fulfilled",
      }];
    },
    (snapshot) => JSON.stringify([
      snapshot.models.map((model) => [model.harnessId, model.providerID, model.modelID, model.context ?? null, model.contextStatus ?? null]),
      snapshot.agents.map((agent) => [agent.harnessId, agent.name]),
    ]),
  ).then(({ items, complete }) => {
    // Cache only a fan-out every representative answered. A runtime that is
    // still starting would otherwise stay hidden until restart; a partial
    // answer is served but asked again on the next read.
    const modelsOk = complete && items.length > 0 && items.every((item) => item.modelsOk);
    return {
      models: dedupeModelDescriptors(items.flatMap((item) => item.models)),
      agents: dedupeAgents(items.flatMap((item) => item.agents)),
      modelsOk,
      agentsOk: complete && items.length > 0 && items.every((item) => item.agentsOk),
      complete: modelsOk,
    };
  });

  /** `refresh` skips the cached copy but still joins a load in flight: one
   *  that started after the caller's cutoff is new enough to share. */
  const load = (refresh = false): Promise<CatalogSnapshot> => {
    if (!refresh && models !== undefined && agents !== undefined) {
      return Promise.resolve({ models, agents, modelsOk: true, agentsOk: true, complete: modelsAt !== undefined });
    }
    if (pending) return pending;
    const requestedModelEpoch = modelEpoch;
    const requestedAt = now();
    const pool = deps.runtimes as SnapshotRuntimePool;
    let run!: Promise<CatalogSnapshot>;
    run = (async () => {
      if (!pool.harnessSnapshots) return loadFallback();
      const harnessSnapshots = pool.harnessSnapshots;
      const { projectId, cwd } = await catalogAuthority();
      const summaries = await harnessSnapshots(projectId, cwd);
      const enabled = summaries.filter((snapshot) => snapshot.policy.enabled);
      const detailed = await Promise.allSettled(enabled.map(async (summary) => {
        const rows = await harnessSnapshots(projectId, cwd, {
          harnessId: summary.identity.id,
          detail: true,
        });
        return rows[0] ?? summary;
      }));
      const fulfilled = detailed.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []);
      const data = snapshotCatalog(fulfilled);
      const complete = enabled.length === 0
        || (fulfilled.length === enabled.length && fulfilled.every(authoritativeDetail));
      // A non-empty partial snapshot is useful and safe to keep as a fallback.
      // An empty degraded cold snapshot is not: retry later instead of freezing
      // "no models" until restart.
      return {
        ...data,
        models: dedupeModelDescriptors(data.models),
        modelsOk: data.models.length > 0 || complete,
        agentsOk: data.agents.length > 0 || complete,
        complete,
      };
    })().then((snapshot) => {
      // An invalidation that races this request owns the newer truth. Keep the
      // response usable by its caller, but never republish it into the cache.
      if (snapshot.modelsOk && requestedModelEpoch === modelEpoch) {
        models = snapshot.models;
        // A partial copy (a harness served a stale presentation while its
        // registry entry revalidates, or failed) is cached for ordinary
        // readers, but a bounded-age reader asks again.
        modelsAt = snapshot.complete ? requestedAt : undefined;
      }
      if (snapshot.agentsOk) agents = snapshot.agents;
      return snapshot;
    }).finally(() => {
      if (pending === run) pending = undefined;
    });
    pending = run;
    return run;
  };

  return {
    async models(options = {}) {
      // Cache native discovery only. The context owner must recheck its TTL and
      // failure backoff instead of turning temporary public metadata permanent.
      const { maxAgeMs } = options;
      const expired = maxAgeMs !== undefined && models !== undefined
        && (modelsAt === undefined || now() - modelsAt > maxAgeMs);
      if (!expired) return enrichModels(models ?? (await load()).models);
      const reread = await load(true);
      // A re-read that found nothing must not hide the last good list.
      return enrichModels(reread.modelsOk ? reread.models : models ?? reread.models);
    },
    async agents() {
      if (agents !== undefined) return agents;
      return (await load()).agents;
    },
    invalidateModels,
    modelsStale(signal) {
      const key = signal.harnessId ?? "*";
      const at = now();
      const last = staleSignalAt.get(key);
      if (last !== undefined && at - last < MODEL_CATALOG_STALE_COOLDOWN_MS) return false;
      staleSignalAt.set(key, at);
      // Synchronous half first: by the time the caller's refusal or terminal
      // event reaches a client, no cached list can answer its catalog re-read.
      if (signal.harnessId) deps.invalidateHarness?.(signal.harnessId);
      invalidateModels();
      const pool = deps.runtimes as SnapshotRuntimePool;
      const harnessId = signal.harnessId;
      if (!harnessId || !pool.harnessSnapshots) return true;
      const harnessSnapshots = pool.harnessSnapshots;
      // A forced probe also drops adapter-owned discovery caches, which the
      // registry invalidation above cannot reach.
      void (async () => {
        const authority = await catalogAuthority();
        const contexts = signal.projectId && signal.projectId !== authority.projectId
          ? [{ projectId: signal.projectId }, authority]
          : [authority];
        await Promise.allSettled(contexts.map((context) =>
          harnessSnapshots(context.projectId, context.cwd, { harnessId, force: true, detail: true })));
        // A catalog load that raced the rediscovery may have read the old
        // adapter cache; fence it without re-dropping registry snapshots.
        modelEpoch += 1;
        models = undefined;
        modelsAt = undefined;
      })().catch((error: unknown) => {
        console.warn("[polyth] stale model catalog rediscovery failed", error);
      });
      return true;
    },
    patchAgent(agent) {
      if (!agents) return;
      const harnessId = agent.harnessId ?? "legacy";
      const index = agents.findIndex((candidate) =>
        (candidate.harnessId ?? "legacy") === harnessId && candidate.name === agent.name);
      agents = index < 0
        ? [...agents, agent]
        : agents.map((candidate, at) => at === index ? agent : candidate);
    },
  };
}
