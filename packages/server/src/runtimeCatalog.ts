import type {
  AgentDescriptor,
  AgentRuntime,
  ModelDescriptor,
  ProjectService,
} from "@polyth/contracts";
import type { RuntimePool } from "./sessions.ts";
import { aggregateRuntimes } from "./runtimeAggregate.ts";

export interface RuntimeCatalog {
  models(): Promise<ModelDescriptor[]>;
  agents(): Promise<AgentDescriptor[]>;
  patchAgent(agent: AgentDescriptor): void;
  /** Drop the cached model snapshot so the next models() call re-fans-out.
   *  Used right after a provider connects/disconnects so Settings reflects
   *  it immediately instead of waiting for a restart. */
  invalidateModels(): void;
}

/**
 * OpenCode's provider endpoint may initialize provider plugins and perform
 * network discovery. Keep one raw catalog snapshot for the server lifetime so
 * opening Settings never fans out to every project runtime again.
 */
export function createRuntimeCatalog(deps: {
  projects: ProjectService;
  runtimes: RuntimePool;
  onModelsInvalidated?(): void;
}): RuntimeCatalog {
  let models: ModelDescriptor[] | undefined;
  let agents: AgentDescriptor[] | undefined;
  let modelsPending: Promise<ModelDescriptor[]> | undefined;
  let agentsPending: Promise<AgentDescriptor[]> | undefined;
  let modelAttempts = 0;
  let agentAttempts = 0;

  // A cold-boot fan-out settles before every project's runtime has finished
  // spawning, so it can be empty OR partial — e.g. only the always-free
  // `opencode` provider answered while the credentialed ones warm up. Freezing
  // that for the server lifetime is what makes "only OpenCode Zen models show"
  // survive until a restart. Cache only a complete fan-out; keep retrying
  // otherwise, but stop after a few tries so one permanently unreachable
  // project can't force a full fan-out on every Settings open.
  const MAX_PARTIAL_ATTEMPTS = 8;

  const incremental = <T,>(
    fetch: (runtime: AgentRuntime) => Promise<T[]>,
    key: (item: T) => string,
  ): { first: Promise<T[]>; full: Promise<{ items: T[]; complete: boolean }> } => {
    let settled = false;
    let scheduled = false;
    let resolveFirst!: (items: T[]) => void;
    let rejectFirst!: (error: unknown) => void;
    const first = new Promise<T[]>((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });
    const finish = (items: T[]): void => {
      if (settled) return;
      settled = true;
      resolveFirst(items);
    };
    const full = aggregateRuntimes(deps, fetch, key, (items) => {
      if (items.length === 0 || settled || scheduled) return;
      scheduled = true;
      // Give an already-finishing fan-out one turn to preserve its complete,
      // stable ordering. A genuinely slow sibling no longer blocks the first
      // usable catalog response.
      setImmediate(() => finish(items));
    });
    void full.then(
      (result) => finish(result.items),
      (error) => {
        if (!settled) {
          settled = true;
          rejectFirst(error);
        }
      },
    );
    return { first, full };
  };

  const loadModels = () => {
    if (models) return Promise.resolve(models);
    if (modelsPending) return modelsPending;
    const loading = incremental<ModelDescriptor>(
      async (runtime) => (await runtime.models()).map((model) => ({
        ...model,
        ...(runtime.harnessId ? { harnessId: runtime.harnessId } : {}),
      })),
      (model) => `${model.harnessId ?? "legacy"}/${model.providerID}/${model.modelID}`,
    );
    const pending = loading.first;
    modelsPending = pending;
    void loading.full.then(({ items, complete }) => {
      modelAttempts += 1;
      if (items.length > 0 && (complete || modelAttempts >= MAX_PARTIAL_ATTEMPTS)) {
        models = items;
      }
    }).catch(() => {}).finally(() => {
      if (modelsPending === pending) modelsPending = undefined;
    });
    return pending;
  };

  const loadAgents = () => {
    if (agents) return Promise.resolve(agents);
    if (agentsPending) return agentsPending;
    const loading = incremental<AgentDescriptor>(
      async (runtime) => (await runtime.agents()).map((agent) => ({
        ...agent,
        ...(runtime.harnessId ? { harnessId: runtime.harnessId } : {}),
      })),
      (agent) => `${agent.harnessId ?? "legacy"}/${agent.name}`,
    );
    const pending = loading.first;
    agentsPending = pending;
    void loading.full.then(({ items, complete }) => {
      agentAttempts += 1;
      if (items.length > 0 && (complete || agentAttempts >= MAX_PARTIAL_ATTEMPTS)) {
        agents = items;
      }
    }).catch(() => {}).finally(() => {
      if (agentsPending === pending) agentsPending = undefined;
    });
    return pending;
  };

  return {
    models: loadModels,
    agents: loadAgents,
    invalidateModels() {
      models = undefined;
      modelsPending = undefined;
      modelAttempts = 0;
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
