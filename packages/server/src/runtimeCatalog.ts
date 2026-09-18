import type {
  AgentDescriptor,
  HarnessSnapshot,
  ModelDescriptor,
  ProjectService,
} from "@polyth/contracts";
import type { RuntimePool } from "./sessions.ts";
import { aggregateRuntimes } from "./runtimeAggregate.ts";

export interface RuntimeCatalog {
  models(): Promise<ModelDescriptor[]>;
  agents(): Promise<AgentDescriptor[]>;
  patchAgent(agent: AgentDescriptor): void;
  /** Drop model metadata after provider/auth/config changes. */
  invalidateModels(): void;
}

type CatalogSnapshot = {
  models: ModelDescriptor[];
  agents: AgentDescriptor[];
  modelsOk: boolean;
  agentsOk: boolean;
};

type SnapshotRuntimePool = RuntimePool & {
  /** Harness-registry metadata seam exposed by createHarnessPool. */
  harnessSnapshots?(
    projectId: string,
    cwd?: string,
    options?: { harnessId?: string; force?: boolean; detail?: boolean },
  ): Promise<HarnessSnapshot[]>;
};

const dedupeModels = (items: ModelDescriptor[]): ModelDescriptor[] => {
  const seen = new Set<string>();
  return items.filter((model) => {
    const key = `${model.harnessId ?? "legacy"}/${model.providerID}/${model.modelID}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

const snapshotCatalog = (snapshots: HarnessSnapshot[]): Omit<CatalogSnapshot, "modelsOk" | "agentsOk"> => {
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
  return { models: dedupeModels(models), agents: dedupeAgents(agents) };
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
  onModelsInvalidated?(): void;
}): RuntimeCatalog {
  let models: ModelDescriptor[] | undefined;
  let agents: AgentDescriptor[] | undefined;
  let pending: Promise<CatalogSnapshot> | undefined;
  let modelEpoch = 0;

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
      snapshot.models.map((model) => [model.harnessId, model.providerID, model.modelID]),
      snapshot.agents.map((agent) => [agent.harnessId, agent.name]),
    ]),
  ).then(({ items }) => ({
    models: dedupeModels(items.flatMap((item) => item.models)),
    agents: dedupeAgents(items.flatMap((item) => item.agents)),
    modelsOk: items.some((item) => item.modelsOk),
    agentsOk: items.some((item) => item.agentsOk),
  }));

  const load = (): Promise<CatalogSnapshot> => {
    if (models !== undefined && agents !== undefined) {
      return Promise.resolve({ models, agents, modelsOk: true, agentsOk: true });
    }
    if (pending) return pending;
    const requestedModelEpoch = modelEpoch;
    const pool = deps.runtimes as SnapshotRuntimePool;
    let run!: Promise<CatalogSnapshot>;
    run = (async () => {
      if (!pool.harnessSnapshots) return loadFallback();
      const harnessSnapshots = pool.harnessSnapshots;
      const projects = await deps.projects.list();
      const authority = projects.find((project) => !project.remote) ?? projects[0];
      const projectId = authority?.id ?? "__default__";
      const cwd = authority?.path;
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
        modelsOk: data.models.length > 0 || complete,
        agentsOk: data.agents.length > 0 || complete,
      };
    })().then((snapshot) => {
      // An invalidation that races this request owns the newer truth. Keep the
      // response usable by its caller, but never republish it into the cache.
      if (snapshot.modelsOk && requestedModelEpoch === modelEpoch) models = snapshot.models;
      if (snapshot.agentsOk) agents = snapshot.agents;
      return snapshot;
    }).finally(() => {
      if (pending === run) pending = undefined;
    });
    pending = run;
    return run;
  };

  return {
    async models() {
      if (models !== undefined) return models;
      return (await load()).models;
    },
    async agents() {
      if (agents !== undefined) return agents;
      return (await load()).agents;
    },
    invalidateModels() {
      modelEpoch += 1;
      models = undefined;
      deps.onModelsInvalidated?.();
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
