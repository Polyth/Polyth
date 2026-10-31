import type {
  AgentCapabilityContributionRegistry,
  RouteHandler,
  SpaceContext,
  ToolExecutionContext,
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
  pauseCoachSchedules,
  pauseUnownedCoachSchedules,
  registerCoachOnboardingCapabilities,
  type CoachOnboardingCapabilitySet,
  type CoachScheduleService,
} from "./onboarding.ts";
import { personalCoachProposalRoutes } from "./proposalRoutes.ts";
import { personalCoachReminderRoutes } from "./reminderRoutes.ts";
import { personalCoachResetRoute } from "./resetRoute.ts";
import { personalCoachRoutes } from "./routes.ts";
import { createPersonalCoachService, type PersonalCoachService } from "./service.ts";
import { personalCoachSessionRoute } from "./sessionRoute.ts";
import { personalCoachSetupRoute } from "./setupRoute.ts";

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
    people: () => host.people,
  });
  host.services.provide(serverServiceKey<PersonalCoachService>("personal-coach"), service);

  let routes: RouteHandler | null = null;
  const capabilities = new Map<string, CoachCapabilityBundle>();

  // Tools act for the person the turn answers, never for the Space: a turn
  // with no acting person (scheduled system work, an unowned session) is refused.
  const storeFor = (ctx: ToolExecutionContext): CoachStore => {
    const actor = ctx.actorUserId;
    if (!actor || !ctx.spaceId) {
      throw Object.assign(
        new Error("Personal Coach data belongs to a person; this turn has no acting person"),
        { code: "forbidden" },
      );
    }
    const person = host.personSpaceContext?.(actor, ctx.spaceId);
    if (!person) {
      throw Object.assign(new Error("Personal Coach: not a member of this Space"), { code: "forbidden" });
    }
    return service.forSpace(person);
  };

  const ensureCapabilities = async (
    space: Pick<SpaceContext, "spaceId">,
    projectId: string,
  ): Promise<void> => {
    if (capabilities.has(projectId)) return;
    // Validates that the project is this package's workspace in this Space. A
    // concurrent first Coach session may have registered while the await was
    // in flight; registration stays once.
    await service.workspaceProject(projectId, space.spaceId);
    if (capabilities.has(projectId)) return;
    const registry = host.services.require(
      serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
    );
    const publishProposal = async (proposal: CoachProposal, ctx: ToolExecutionContext): Promise<void> => {
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
    };
    const main: CoachCapabilitySet = registerCoachCapabilities({
      registry,
      space,
      projectId,
      storeFor,
      onProposalCreated: publishProposal,
    });
    const onboarding: CoachOnboardingCapabilitySet = registerCoachOnboardingCapabilities({
      registry,
      space,
      projectId,
      storeFor,
      schedule: () => host.services.get(serverServiceKey<CoachScheduleService>("agents")),
    });
    const insights: CoachInsightCapabilitySet = registerCoachInsightCapabilities({
      registry,
      space,
      projectId,
      storeFor,
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

  // Schedule is provided at registration but only builds its task store when
  // it is enabled (and may never be); until then it answers `unavailable`.
  const scheduledTasks = (schedule: CoachScheduleService | undefined): ReturnType<CoachScheduleService["list"]> => {
    try {
      return schedule?.list() ?? [];
    } catch (cause) {
      if ((cause as { code?: string }).code !== "unavailable") throw cause;
      return [];
    }
  };

  const pauseUnowned = (schedule: CoachScheduleService, projectId: string): void => {
    try {
      pauseUnownedCoachSchedules(schedule, projectId);
    } catch (cause) {
      if ((cause as { code?: string }).code !== "unavailable") throw cause;
    }
  };

  const restoreCapabilities = async (): Promise<void> => {
    const projectIds = new Set(
      (await host.store.projections())
        .map((projection) => projection.projectId)
        .filter((projectId) => projectId.startsWith("__polyth_pkg_")),
    );
    // Scheduled Coach work may outlive every visible Coach session, so the
    // schedule's durable target inventory is another recovery root when it is
    // already enabled; ownership is still verified below by workspace path.
    const schedule = host.services.get(serverServiceKey<CoachScheduleService>("agents"));
    for (const task of scheduledTasks(schedule)) {
      if (task.projectId.startsWith("__polyth_pkg_")) projectIds.add(task.projectId);
    }
    for (const projectId of projectIds) {
      const project = await host.projects.get(projectId);
      if (!project?.spaceId) continue;
      try {
        await service.workspaceProject(projectId, project.spaceId);
        await ensureCapabilities({ spaceId: project.spaceId }, projectId);
        if (schedule) pauseUnowned(schedule, projectId);
      } catch (cause) {
        if ((cause as { code?: string }).code !== "not-found") throw cause;
        // Another package owns this internal workspace.
      }
    }
  };

  const pauseOwnedSchedules = async (): Promise<void> => {
    const schedule = host.services.get(serverServiceKey<CoachScheduleService>("agents"));
    if (!schedule) return;
    let tasks: ReturnType<CoachScheduleService["list"]>;
    try {
      tasks = schedule.list();
    } catch (cause) {
      // A schedule that was never enabled has nothing running to pause.
      if ((cause as { code?: string }).code === "unavailable") return;
      throw cause;
    }
    const projectIds = new Set<string>(capabilities.keys());
    for (const task of tasks) {
      if (task.projectId.startsWith("__polyth_pkg_")) projectIds.add(task.projectId);
    }
    for (const projectId of projectIds) {
      try {
        // Path validation prevents another package's internal workspace from
        // being affected even if it happens to use the same schedule titles.
        await service.workspaceProject(projectId);
        pauseCoachSchedules(schedule, projectId);
      } catch (cause) {
        if ((cause as { code?: string }).code !== "not-found") throw cause;
      }
    }
  };

  return {
    remoteAccess: localOnlyRemoteAccess(["personal-coach"]),
    routes: async (request) => routes ? routes(request) : false,
    async onEnable() {
      const handlers = [
        personalCoachSessionRoute(host, { coach: service, ensureCapabilities }),
        personalCoachSetupRoute(host, {
          coach: service,
          ensureCapabilities,
          schedule: () => host.services.get(serverServiceKey<CoachScheduleService>("agents")),
        }),
        personalCoachReminderRoutes(host, {
          coach: service,
          ensureCapabilities,
          schedule: () => host.services.get(serverServiceKey<CoachScheduleService>("agents")),
        }),
        personalCoachResetRoute(host, {
          coach: service,
          schedule: () => host.services.get(serverServiceKey<CoachScheduleService>("agents")),
        }),
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
      await pauseOwnedSchedules();
      for (const capability of [...capabilities.values()].toReversed()) {
        await capability.dispose();
      }
      capabilities.clear();
      service.close();
    },
  };
}
