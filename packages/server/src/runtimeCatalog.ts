import type { AgentDescriptor, ModelDescriptor, ProjectService } from "@polyth/contracts";
import type { RuntimePool } from "./sessions.ts";
import { aggregateRuntimes } from "./runtimeAggregate.ts";

export interface RuntimeCatalog {
  models(): Promise<ModelDescriptor[]>;
  agents(): Promise<AgentDescriptor[]>;
  patchAgent(agent: AgentDescriptor): void;
}

/**
 * OpenCode's provider endpoint may initialize provider plugins and perform
 * network discovery. Keep one raw catalog snapshot for the server lifetime so
 * opening Settings never fans out to every project runtime again.
 */
export function createRuntimeCatalog(deps: {
  projects: ProjectService;
  runtimes: RuntimePool;
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

  const loadModels = () => {
    if (models) return Promise.resolve(models);
    modelsPending ??= aggregateRuntimes(
      deps,
      (runtime) => runtime.models(),
      (model) => `${model.providerID}/${model.modelID}`,
    ).then(({ items, complete }) => {
      modelAttempts += 1;
      if (items.length > 0 && (complete || modelAttempts >= MAX_PARTIAL_ATTEMPTS)) {
        models = items;
      }
      return items;
    }).finally(() => { modelsPending = undefined; });
    return modelsPending;
  };

  const loadAgents = () => {
    if (agents) return Promise.resolve(agents);
    agentsPending ??= aggregateRuntimes(
      deps,
      (runtime) => runtime.agents(),
      (agent) => agent.name,
    ).then(({ items, complete }) => {
      agentAttempts += 1;
      if (items.length > 0 && (complete || agentAttempts >= MAX_PARTIAL_ATTEMPTS)) {
        agents = items;
      }
      return items;
    }).finally(() => { agentsPending = undefined; });
    return agentsPending;
  };

  return {
    models: loadModels,
    agents: loadAgents,
    patchAgent(agent) {
      if (!agents) return;
      const index = agents.findIndex((candidate) => candidate.name === agent.name);
      agents = index < 0
        ? [...agents, agent]
        : agents.map((candidate, at) => at === index ? agent : candidate);
    },
  };
}
