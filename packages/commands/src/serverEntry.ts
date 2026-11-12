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
import { harnessUsableByUser, type HarnessProvider, type HarnessRegistry } from "@polyth/contracts";
import { allowedHarnessesFor, hasInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import type {
  CapabilityInstallationScope,
  SkillCatalogInstallInput,
  SkillHarnessMode,
  SkillInstallationInput,
  SkillReachDefault,
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
import {
  createSkillService,
  renderSkillInvocation,
  resolveSkillInvocation,
  skillInvocationCommands,
  type SkillService,
} from "./skills.ts";
import { createSkillCatalog, type SkillCatalog } from "./skillCatalog.ts";
import { createSkillLibrary, type HarnessVisibility, type SkillLibrary } from "./skillLibrary.ts";
import { createSkillTools } from "./skillTools.ts";

type ContextualContribution = AgentCapabilityContribution & {
  resolveCapabilities(context: HarnessContext): readonly AgentCapabilityDescriptor[];
};
type ProvisioningService = {
  reconcileSpace?(space: Pick<SpaceContext, "spaceId">): Promise<unknown>;
};

export function withSkillInvocations(
  commands: CommandService,
  skills: SkillService,
): CommandService {
  return {
    ...commands,
    async expand(root, text, ctx = {}) {
      const regular = await commands.expand(root, text, ctx);
      if (
        regular.usedCommand
        || !ctx.space
        || !ctx.projectId
        || !/^\/[A-Za-z0-9_-]+(?:[ \t]|\n|$)/.test(text)
      ) {
        return regular;
      }
      const effective = await skills.list(ctx.space, ctx.projectId);
      const invocation = resolveSkillInvocation(text, effective);
      if (!invocation) return regular;

      // The base expansion already ran once above. Re-parse that result instead
      // of expanding again so a user-authored !shell line can never execute twice.
      const expandedInvocation = resolveSkillInvocation(regular.text, effective);
      return {
        text: renderSkillInvocation(
          invocation,
          expandedInvocation?.args ?? invocation.args,
          skills.agentInstructions(ctx.space, invocation.skill),
        ),
        raw: text,
        usedCommand: invocation.skill.name,
      };
    },
  };
}

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

const scopeFrom = (value: unknown): CapabilityInstallationScope => {
  if (value === "project" || value === "space") return value;
  throw Object.assign(new Error("scope must be project or space"), { code: "invalid-input" });
};
const required = (value: unknown, name: string): string => {
  if (typeof value === "string" && value) return value;
  throw Object.assign(new Error(`${name} is required`), { code: "invalid-input" });
};

/** The catalog and library routes. Every read and write goes through the
 * gateway-validated Space; the services apply the role checks. */
export function skillRoutes(deps: {
  catalog: SkillCatalog;
  library: SkillLibrary;
  space: SpaceContext;
  visible: HarnessVisibility;
}): RouteHandler {
  const { catalog, library, space, visible } = deps;
  return async (request) => {
    const { path, method, url, body, json } = request;
    const query = (name: string): string | undefined => url.searchParams.get(name) || undefined;
    if (method === "GET") {
      if (path === "/api/skills/catalog") {
        json(200, await catalog.list(space, query("projectId")));
        return true;
      }
      if (path === "/api/skills/catalog/skill") {
        json(200, await catalog.detail(space, required(query("id"), "id"), query("projectId")));
        return true;
      }
      if (path === "/api/skills/catalog/file") {
        json(200, await catalog.file(space, required(query("id"), "id"), required(query("path"), "path")));
        return true;
      }
      if (path === "/api/skills/library") {
        const fresh = query("fresh");
        const list = await library.list(space, query("projectId"), visible, fresh ? { fresh: fresh === "all" ? true : fresh } : {});
        json(200, { ...list, access: { ...list.access, nativePolicy: hasInstanceOwnerAuthority(request) } });
        return true;
      }
      if (path === "/api/skills/library/skill") {
        json(200, await library.detail(space, query("projectId"), required(query("name"), "name"), visible));
        return true;
      }
      if (path === "/api/skills/library/file") {
        json(200, await library.file(space, query("projectId"), required(query("name"), "name"), required(query("path"), "path"), visible));
        return true;
      }
      return false;
    }
    if (method === "DELETE" && path === "/api/skills/catalog/sources") {
      const input = await body();
      json(200, { ok: await catalog.removeSource(space, required(input.id, "id")) });
      return true;
    }
    if (method !== "POST") return false;
    const input = await body();
    const projectId = typeof input.projectId === "string" && input.projectId ? input.projectId : undefined;
    const owner = projectId ? { projectId } : {};
    if (path === "/api/skills/catalog/install") {
      const install: SkillCatalogInstallInput = {
        id: required(input.id, "id"),
        contentHash: required(input.contentHash, "contentHash"),
        scope: scopeFrom(input.scope),
        ...owner,
        ...(input.replace === true ? { replace: true } : {}),
      };
      json(200, await catalog.install(space, install));
      return true;
    }
    if (path === "/api/skills/catalog/sources") {
      json(200, await catalog.addSource(space, required(input.url, "url")));
      return true;
    }
    if (path === "/api/skills/catalog/refresh") {
      await catalog.refresh(space, typeof input.id === "string" && input.id ? input.id : undefined);
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/skills/library/adopt") {
      json(200, await library.adopt(space, {
        harnessId: required(input.harnessId, "harnessId"),
        name: required(input.name, "name"),
        scope: scopeFrom(input.scope),
        ...owner,
        ...(input.replace === true ? { replace: true } : {}),
      }, visible));
      return true;
    }
    if (path === "/api/skills/library/reach") {
      const rule = (value: unknown, name: string): { id: string; mode: SkillHarnessMode | null } | undefined => {
        if (value === undefined) return undefined;
        const item = value as { id?: unknown; mode?: unknown } | null;
        if (!item || typeof item.id !== "string" || !(item.mode === null || item.mode === "off" || item.mode === "on" || item.mode === "always")) {
          throw Object.assign(new Error(`${name} needs an id and a mode of off, on, always or null`), { code: "invalid-input" });
        }
        return { id: item.id, mode: item.mode };
      };
      if (input.default !== undefined && input.default !== "all" && input.default !== "some" && input.default !== "none") {
        throw Object.assign(new Error("default must be all, some or none"), { code: "invalid-input" });
      }
      const family = rule(input.family, "family");
      const harness = rule(input.harness, "harness");
      json(200, await library.setReach(space, {
        name: required(input.name, "name"),
        scope: scopeFrom(input.scope),
        ...owner,
        ...(input.default !== undefined ? { default: input.default as SkillReachDefault } : {}),
        ...(family ? { family } : {}),
        ...(harness ? { harness } : {}),
      }, visible));
      return true;
    }
    if (path === "/api/skills/library/update") {
      json(200, await library.update(space, scopeFrom(input.scope), required(input.name, "name"), projectId, visible));
      return true;
    }
    return false;
  };
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
  // Personal ("user") by default: shared project commands are an explicit,
  // admin-only choice.
  const scopeOf = (value: unknown): WriteScope => value === "project" ? "project" : "user";
  const callContext = { space: deps.space };
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
        if (
          input.disallowedTools !== undefined
          && (!Array.isArray(input.disallowedTools)
            || input.disallowedTools.some((name) => typeof name !== "string"))
        ) {
          throw Object.assign(new Error("disallowedTools must be an array of tool names"), { code: "invalid-input" });
        }
        const skillInput: SkillInstallationInput = {
          name: String(input.name ?? ""),
          description: String(input.description ?? ""),
          instructions: String(input.instructions ?? ""),
          ...(Array.isArray(input.disallowedTools)
            ? { disallowedTools: input.disallowedTools as string[] }
            : {}),
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
      const projectId = String(url.searchParams.get("projectId") ?? "");
      const root = await rootOf(projectId);
      const list = await deps.commands.list(root, callContext);
      if (path === "/api/commands") {
        const extensions = deps.extensionCommands ? await deps.extensionCommands() : [];
        const existingNames = new Set(
          [...list.commands, ...extensions].map((command) => command.name.toLowerCase()),
        );
        const skillCommands = skillInvocationCommands(
          await deps.skills.list(deps.space, projectId),
        ).filter((command) => !existingNames.has(command.name.toLowerCase()));
        json(200, [...list.commands, ...extensions, ...skillCommands]);
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
      }, callContext);
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/commands" && method === "DELETE") {
      json(200, { ok: await deps.commands.removeCommand(root, scope, String(input.name ?? ""), callContext) });
      return true;
    }
    if (path === "/api/snippets" && method === "POST") {
      await deps.commands.saveSnippet(root, scope, {
        alias: String(input.alias ?? ""),
        text: String(input.text ?? ""),
      }, callContext);
      json(200, { ok: true });
      return true;
    }
    if (path === "/api/snippets" && method === "DELETE") {
      json(200, { ok: await deps.commands.removeSnippet(root, scope, String(input.alias ?? ""), callContext) });
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // Personal commands live in the person's own storage, outside every Space.
  const baseCommands = createCommandService({
    personalDir: (userId) => host.people?.storage(userId, "commands").root,
  });

  const skills = createSkillService({
    storage: (space) => host.spaceStorage(space),
    projects: (space) => host.forSpace(space).projects,
    allowUserSkills: (space) => host.deployment === "local-trusted" && space.deployment === "local-trusted",
    legacy: baseCommands,
    onChanged: async (space) => {
      const provisioning = host.services.get(serverServiceKey<ProvisioningService>("harness.provisioning"));
      await provisioning?.reconcileSpace?.(space);
    },
  });
  const commands = withSkillInvocations(baseCommands, skills);
  host.services.provide(serverServiceKey<CommandService>("commands"), commands);
  host.services.provide(serverServiceKey<SkillService>("skills"), skills);

  const catalog = createSkillCatalog({ storage: (space) => host.spaceStorage(space), skills });
  const library = createSkillLibrary({
    skills,
    catalog,
    projects: (space) => host.forSpace(space).projects,
    registry: () => host.services.get(serverServiceKey<HarnessRegistry>("harnesses")),
  });
  // Another person's private account harness does not exist for this caller.
  const visibleTo = (space: SpaceContext) => (provider: HarnessProvider): boolean =>
    harnessUsableByUser(provider.descriptor, space.userId, allowedHarnessesFor({ space }), space.spaceId);
  // Single-person installs mint no person contexts: theirs is the system one.
  const personSpace = (ctx: { spaceId?: string; actorUserId?: string }): SpaceContext | undefined => {
    if (!ctx.spaceId || !ctx.actorUserId || ctx.actorUserId.startsWith("system:")) return undefined;
    const system = host.systemSpaceContext(ctx.spaceId);
    return host.personSpaceContext?.(ctx.actorUserId, ctx.spaceId) ?? (system.userId === ctx.actorUserId ? system : undefined);
  };

  let capabilityRegistration: Disposable | undefined;
  let toolRegistrations: Disposable[] = [];
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
      toolRegistrations = createSkillTools({
        skills,
        catalog,
        library,
        personSpace,
        readerSpace: (ctx) => {
          if (!ctx.spaceId) throw Object.assign(new Error("Skills need a Polyth Space"), { code: "forbidden" });
          return personSpace(ctx) ?? host.systemSpaceContext(ctx.spaceId);
        },
        visibleTo,
      }).map((tool) => registry.register("commands", tool));
    },
    async onDisable() {
      await capabilityRegistration?.dispose();
      capabilityRegistration = undefined;
      for (const registration of toolRegistrations) await registration.dispose();
      toolRegistrations = [];
    },
    routes: async (request) => {
      if (request.path.startsWith("/api/skills/")) {
        return skillRoutes({ catalog, library, space: request.space, visible: visibleTo(request.space) })(request);
      }
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
