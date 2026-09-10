import type {
  AgentCapabilityContributionRegistry,
  RouteHandler,
  SpaceContext,
} from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { registerCoachCapabilities, type CoachCapabilitySet } from "./capabilities.ts";
import type { CoachProposal, CoachStore } from "./index.ts";
import {
  registerCoachInsightCapabilities,
  type CoachInsightCapabilitySet,
} from "./insights.ts";
import { personalCoachInsightRoutes } from "./insightRoutes.ts";
import {
  registerCoachOnboardingCapabilities,
  type CoachOnboardingCapabilitySet,
  type CoachScheduleService,
} from "./onboarding.ts";
import { personalCoachProposalRoutes } from "./proposalRoutes.ts";
import { personalCoachRoutes } from "./routes.ts";
import { createPersonalCoachService, type PersonalCoachService } from "./service.ts";
import { personalCoachSessionRoute } from "./sessionRoute.ts";

export type { PersonalCoachService } from "./service.ts";

interface CoachCapabilityBundle {
  ids: string[];
  dispose(): Promise<void>;
}

function proposalSummary(proposal: CoachProposal): string {
  const value = proposal.type === "plan-change" ? proposal.payload.summary : proposal.payload.title;
  return typeof value === "string" && value.trim() ? value.trim() : "Coach proposal";
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const service = createPersonalCoachService({
    storageFor: (space) => host.spaceStorage(space),
    projects: host.projects,
  });
  host.services.provide(serverServiceKey<PersonalCoachService>("personal-coach"), service);

  let routes: RouteHandler | null = null;
  const capabilities = new Map<string, CoachCapabilityBundle>();

  const ensureCapabilities = (
    space: Pick<SpaceContext, "spaceId">,
    projectId: string,
    store: CoachStore,
  ): void => {
    if (capabilities.has(projectId)) return;
    const registry = host.services.require(
      serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
    );
    const main: CoachCapabilitySet = registerCoachCapabilities({
      registry,
      space,
      projectId,
      store,
      onProposalCreated: async (proposal, ctx) => {
        if (!ctx.sessionId) return;
        await host.events.append(
          ctx.sessionId,
          "coach/proposal-created",
          {
            proposalId: proposal.id,
            proposalType: proposal.type,
            summary: proposalSummary(proposal),
          },
          { ignorable: true, producerPlugin: "personal-coach" },
        );
      },
    });
    const onboarding: CoachOnboardingCapabilitySet = registerCoachOnboardingCapabilities({
      registry,
      space,
      projectId,
      store,
      schedule: () => host.services.get(serverServiceKey<CoachScheduleService>("schedule")),
    });
    const insights: CoachInsightCapabilitySet = registerCoachInsightCapabilities({
      registry,
      space,
      projectId,
      store,
      onInsightCreated: async (insight, ctx) => {
        if (!ctx.sessionId) return;
        await host.events.append(
          ctx.sessionId,
          "coach/insight-created",
          {
            insightId: insight.id,
            statement: insight.statement,
            confidence: insight.confidence,
            evidenceCount: insight.evidence.length,
          },
          { ignorable: true, producerPlugin: "personal-coach" },
        );
      },
    });
    capabilities.set(projectId, {
      ids: [...main.ids, ...onboarding.ids, ...insights.ids],
      async dispose() {
        await insights.dispose();
        await onboarding.dispose();
        await main.dispose();
      },
    });
  };

  const restoreCapabilities = async (): Promise<void> => {
    const projectIds = new Set(
      (await host.store.projections())
        .map((projection) => projection.projectId)
        .filter((projectId) => projectId.startsWith("__polyth_pkg_")),
    );
    // Scheduled Coach work may outlive every visible Coach session. Schedule is
    // provided during package registration, so its durable target inventory is
    // another recovery root; ownership is still verified below by workspace path.
    const schedule = host.services.get(serverServiceKey<CoachScheduleService>("schedule"));
    for (const task of schedule?.list() ?? []) {
      if (task.projectId.startsWith("__polyth_pkg_")) projectIds.add(task.projectId);
    }
    for (const projectId of projectIds) {
      const project = await host.projects.get(projectId);
      if (!project?.spaceId) continue;
      try {
        const store = await service.forWorkspaceProject(projectId, project.spaceId);
        ensureCapabilities({ spaceId: project.spaceId }, projectId, store);
      } catch (cause) {
        if ((cause as { code?: string }).code !== "not-found") throw cause;
        // Another package owns this internal workspace.
      }
    }
  };

  return {
    remoteAccess: localOnlyRemoteAccess(["personal-coach"]),
    routes: async (request) => routes ? routes(request) : false,
    async onEnable() {
      const handlers = [
        personalCoachSessionRoute(host, { coach: service, ensureCapabilities }),
        personalCoachProposalRoutes(service),
        personalCoachInsightRoutes(service),
        personalCoachRoutes(service),
      ];
      routes = async (request) => {
        for (const handler of handlers) {
          if (await handler(request)) return true;
        }
        return false;
      };
      await restoreCapabilities();
    },
    async onDisable() {
      routes = null;
      for (const capability of [...capabilities.values()].toReversed()) {
        await capability.dispose();
      }
      capabilities.clear();
      service.close();
    },
  };
}
