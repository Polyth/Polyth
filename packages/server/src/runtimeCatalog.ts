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

  const loadModels = () => {
    if (models) return Promise.resolve(models);
    modelsPending ??= aggregateRuntimes(
      deps,
      (runtime) => runtime.models(),
      (model) => `${model.providerID}/${model.modelID}`,
    ).then((items) => {
      models = items;
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
    ).then((items) => {
      agents = items;
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
