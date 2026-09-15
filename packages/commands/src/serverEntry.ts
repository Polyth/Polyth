import type {
  AgentCapabilityContribution,
  AgentCapabilityContributionRegistry,
  AgentCapabilityDescriptor,
  Disposable,
  HarnessContext,
  ProjectService,
  RouteHandler,
  SpaceContext,
} from "@polyth/contracts";
import type {
  CapabilityInstallationScope,
  SkillInstallationInput,
} from "@polyth/contracts/capability-installations";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type PluginRegistry,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createCommandService, type CommandService, type WriteScope } from "./index.ts";
import {
  extensionCommandId,
  type SlashCommand,
} from "./catalog.ts";
import { createSkillService, type SkillService } from "./skills.ts";

type ContextualContribution = AgentCapabilityContribution & {
  resolveCapabilities(context: HarnessContext): readonly AgentCapabilityDescriptor[];
};
type ProvisioningService = {
  reconcileSpace?(space: Pick<SpaceContext, "spaceId">): Promise<unknown>;
};

function extensionCommandsForSpace(
  host: ServerPackageHost,
  space: SpaceContext,
): SlashCommand[] {
  const registry = host.services.get(serverServiceKey<PluginRegistry>("plugins.managed"));
  if (!registry) return [];
  const storage = host.spaceStorage(space);
  const out: SlashCommand[] = [];
  for (const plugin of registry.list(storage)) {
    if (!plugin.enabled || plugin.status !== "ready" || plugin.runtimeKind !== "sandboxed") continue;
    const manifest = registry.canonicalManifest(plugin.id);
    if (manifest.manifestVersion !== 2) continue;
    for (const command of manifest.contributes?.commands ?? []) {
      out.push({
        id: extensionCommandId({ packageId: plugin.id, contributionId: command.id }),
        name: command.name,
        description: command.description,
        prompt: "",
        scope: "builtin",
        // Keep the REST DTO compatible with pre-v2 command consumers. The
        // host-reserved id, not a widened owner field, carries extension identity.
        owner: "builtin",
      });
    }
  }
  return out;
}

export function snippetRoutes(deps: {
  projects: ProjectService;
  commands: CommandService;
  skills: SkillService;
  space: SpaceContext;
  extensionCommands?: () => readonly SlashCommand[] | Promise<readonly SlashCommand[]>;
}): RouteHandler {
  const rootOf = async (projectId: unknown): Promise<string> => {
    if (!projectId) {
      throw Object.assign(new Error("projectId required"), { code: "invalid-path" });
    }
    const project = await deps.projects.get(String(projectId));
    if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
    return project.path;
  };
  const scopeOf = (value: unknown): WriteScope => value === "user" ? "user" : "project";
  const installationScope = (value: unknown): CapabilityInstallationScope => {
    if (value === "project" || value === "space") return value;
    throw Object.assign(new Error("scope must be project or space"), { code: "invalid-input" });
  };

  return async ({ path, method, url, body, json }) => {
    if (path !== "/api/commands" && path !== "/api/snippets" && path !== "/api/skills") return false;

    if (path === "/api/skills") {
      if (method === "GET") {
        const projectId = url.searchParams.get("projectId") || undefined;
        json(200, await deps.skills.list(deps.space, projectId));
        return true;
      }
      if (method !== "POST" && method !== "DELETE") return false;
      const input = await body();
      const scope = installationScope(input.scope);
      const projectId = typeof input.projectId === "string" && input.projectId ? input.projectId : undefined;
      if (method === "POST") {
        const skillInput: SkillInstallationInput = {
          name: String(input.name ?? ""),
          description: String(input.description ?? ""),
          instructions: String(input.instructions ?? ""),
          ...(input.expectedRevision !== undefined
            ? { expectedRevision: Number(input.expectedRevision) }
            : {}),
        };
        json(200, await deps.skills.save(deps.space, scope, skillInput, projectId));
        return true;
      }
      const expectedRevision = input.expectedRevision === undefined
        ? undefined
        : Number(input.expectedRevision);
      json(200, {
        ok: await deps.skills.remove(
          deps.space,
          scope,
          String(input.name ?? ""),
          projectId,
          expectedRevision,
        ),
      });
      return true;
    }

    if (method === "GET") {
      const root = await rootOf(url.searchParams.get("projectId"));
      const list = await deps.commands.list(root);
      if (path === "/api/commands") {
        const extensions = deps.extensionCommands ? await deps.extensionCommands() : [];
        json(200, [...list.commands, ...extensions]);
      } else {
        json(200, list.snippets);
      }
      return true;
    }
    if (method !== "POST" && method !== "DELETE") return false;
    const input = await body();
    const root = await rootOf(input.projectId);
    const scope = scopeOf(input.scope);
    if (path === "/api/commands" && method === "POST") {
      await deps.commands.saveCommand(root, scope, {
        name: String(input.name ?? ""),
        prompt: String(input.prompt ?? ""),
        ...(input.description ? { description: String(input.description) } : {}),
        ...(input.agent ? { agent: String(input.agent) } : {}),
        ...(input.model ? { model: String(input.model) } : {}),
      });
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/commands" && method === "DELETE") {
      json(200, { ok: await deps.commands.removeCommand(root, scope, String(input.name ?? "")) });
      return true;
    }
    if (path === "/api/snippets" && method === "POST") {
      await deps.commands.saveSnippet(root, scope, {
        alias: String(input.alias ?? ""),
        text: String(input.text ?? ""),
      });
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/snippets" && method === "DELETE") {
      json(200, { ok: await deps.commands.removeSnippet(root, scope, String(input.alias ?? "")) });
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const commands = createCommandService();
  host.services.provide(serverServiceKey<CommandService>("commands"), commands);

  const skills = createSkillService({
    storage: (space) => host.spaceStorage(space),
    projects: (space) => host.forSpace(space).projects,
    allowUserSkills: (space) => host.deployment === "local-trusted" && space.deployment === "local-trusted",
    legacy: commands,
    onChanged: async (space) => {
      const provisioning = host.services.get(serverServiceKey<ProvisioningService>("harness.provisioning"));
      await provisioning?.reconcileSpace?.(space);
    },
  });
  host.services.provide(serverServiceKey<SkillService>("skills"), skills);

  let capabilityRegistration: Disposable | undefined;
  return {
    remoteAccess: localOnlyRemoteAccess(["commands"]),
    onEnable() {
      if (capabilityRegistration) return;
      const registry = host.services.require(
        serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
      );
      capabilityRegistration = registry.register("commands", {
        descriptor: {
          id: "commands.skills.contextual",
          kind: "context",
          owner: "commands",
          scope: "space",
          revision: "1",
          title: "Managed skills",
          text: "",
        },
        resolveCapabilities: (context: HarnessContext) => skills.managedCapabilities(context),
      } as ContextualContribution);
    },
    async onDisable() {
      await capabilityRegistration?.dispose();
      capabilityRegistration = undefined;
    },
    routes: async (request) => {
      if (request.path !== "/api/commands" && request.path !== "/api/snippets" && request.path !== "/api/skills") {
        return false;
      }
      const { projects } = host.forSpace(request.space);
      return snippetRoutes({
        projects,
        commands,
        skills,
        space: request.space,
        extensionCommands: () => extensionCommandsForSpace(host, request.space),
      })(request);
    },
  };
}
