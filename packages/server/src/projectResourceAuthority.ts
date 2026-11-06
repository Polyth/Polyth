import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  roleAtLeast,
  type Project,
  type ProjectComposition,
  type ProjectPatch,
  type ProjectRemote,
  type ProjectService,
  type SpaceContext,
} from "@polyth/contracts";
import type { CanonicalResource } from "@polyth/control-plane/resources";
import { resolveInside } from "@polyth/tenancy";
import {
  discardManagedFolder,
  managedOperationKey,
  managedProjectPath,
  parseManagedProjectInput,
  type ManagedProjectRequest,
} from "./managedProjects.ts";
import type { ProjectRegistry } from "./projects.ts";
import { projectResourceReceipt } from "./resourceReceipts.ts";
import { canonicalSecurity } from "./runtimeSecurity.ts";
import { projectPresence } from "./sessionSharing.ts";

const RUNTIME_SYSTEM_PRINCIPAL_ID = "system:polyth-runtime";
const PACKAGE_WORKSPACE_ID = /^__polyth_pkg_[a-f0-9]{32}$/;

const recovery = (): Error => Object.assign(
  new Error("Project domain state does not match the canonical resource authority"),
  { code: "recovery-required" },
);
const forbidden = (): Error => Object.assign(
  new Error("Space member access is required to modify projects"),
  { code: "forbidden" },
);

const PERSONAL_PROJECT_NAME = "Personal";
const MAX_PERSONAL_NAME = 120;

/** `<space>/personal/<hash of the person>`: inside the Space's own storage,
 *  so it goes with the Space, and keyed by a digest so no principal id text
 *  becomes a path component. Created on demand; never client-chosen. */
export function personalProjectPath(ctx: Pick<SpaceContext, "storageDir" | "userId">): string {
  const digest = createHash("sha256").update(ctx.userId).digest("hex").slice(0, 32);
  const relative = join("personal", digest);
  const dir = resolveInside(ctx.storageDir, relative);
  mkdirSync(dir, { recursive: true });
  // Re-check after creation: a symlink planted in between must not move it out.
  return resolveInside(ctx.storageDir, relative);
}

/** `<space>/personal/<hash of the person>/rooms/<hash of the project>`: inside
 *  the person's own folder, so it can be neither probed nor registered by
 *  anyone else (`reservedForPersonal`). Never client-chosen. */
export function privateRoomPath(ctx: Pick<SpaceContext, "storageDir" | "userId">, parentProjectId: string): string {
  const person = createHash("sha256").update(ctx.userId).digest("hex").slice(0, 32);
  const project = createHash("sha256").update(parentProjectId).digest("hex").slice(0, 32);
  const relative = join("personal", person, "rooms", project);
  const dir = resolveInside(ctx.storageDir, relative);
  mkdirSync(dir, { recursive: true });
  return resolveInside(ctx.storageDir, relative);
}

const personalName = (name: string | undefined): string => {
  const trimmed = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  return trimmed && trimmed.length <= MAX_PERSONAL_NAME ? trimmed : PERSONAL_PROJECT_NAME;
};

/** Only a human member starts with a personal project; the runtime and
 *  other system principals work inside projects people chose. */
const assertPersonalCaller = (ctx: SpaceContext): void => {
  if (ctx.userId.startsWith("system:")) {
    throw Object.assign(new Error("a personal project belongs to a person"), { code: "forbidden" });
  }
  if (!roleAtLeast(ctx.role, "member")) throw forbidden();
};

const personalRefused = (): Error => Object.assign(
  new Error("a personal project is only created before any other project exists"),
  { code: "conflict" },
);

/** One Polyth-folder create: a resend returns the first project, and a folder
 *  the provisioning step did not end up using is taken back. */
async function createManagedProject(
  ctx: SpaceContext,
  registry: ProjectRegistry,
  request: ManagedProjectRequest,
  provision: (input: { path: string; name: string; composition?: ProjectComposition; managedOperation: string }) => Promise<Project>,
  settled: (project: Project) => Project = (project) => project,
): Promise<Project> {
  const managedOperation = managedOperationKey(ctx.userId, request.clientOperationId);
  const earlier = registry.managedProject(ctx.spaceId, managedOperation);
  if (earlier) return settled(earlier);
  const path = managedProjectPath(ctx, request.name, (candidate) => registry.localPathRegistered(candidate));
  try {
    const project = await provision({
      path,
      name: request.name,
      ...(request.composition ? { composition: request.composition } : {}),
      managedOperation,
    });
    if (resolve(project.path) !== resolve(path)) discardManagedFolder(path);
    return project;
  } catch (cause) {
    discardManagedFolder(path);
    throw cause;
  }
}

export function canonicalProjectService(
  ctx: SpaceContext,
  registry: ProjectRegistry,
): ProjectService {
  const base = registry.forSpace(ctx);
  const security = canonicalSecurity();
  if (!security) {
    return {
      ...base,
      // One person has nobody to keep a project private from.
      privateRooms: async () => [],
      listForShell: () => base.list(),
      async createManaged(input) {
        if (!roleAtLeast(ctx.role, "member")) throw forbidden();
        return createManagedProject(ctx, registry, parseManagedProjectInput(input), (provisioned) => registry.provision({
          id: randomUUID(),
          spaceId: ctx.spaceId,
          ...provisioned,
        }));
      },
      async ensurePersonal(name) {
        assertPersonalCaller(ctx);
        const existing = registry.personalProject(ctx.spaceId, ctx.userId);
        if (existing) return existing;
        // Without the resource authority there is no owner-only visibility;
        // someone else's personal project still never counts as "another".
        if ((await base.list()).some((project) => !project.personal)) throw personalRefused();
        return registry.provision({
          id: randomUUID(),
          spaceId: ctx.spaceId,
          path: personalProjectPath(ctx),
          name: personalName(name),
          personalOwner: ctx.userId,
        });
      },
    };
  }

  const org = security.control.get<{ id: string }>(
    "SELECT org_id AS id FROM spaces WHERE id=?",
    ctx.spaceId,
  );
  if (!org) throw recovery();
  const scope = { orgId: org.id, spaceId: ctx.spaceId };

  const requireMutation = (): void => {
    if (!roleAtLeast(ctx.role, "member")) throw forbidden();
  };
  const row = (id: string): CanonicalResource | undefined => security.resources.resource(id);
  const assertScope = (resource: CanonicalResource): void => {
    if (resource.kind !== "project" || resource.orgId !== org.id || resource.spaceId !== ctx.spaceId) throw recovery();
  };
  const requireReadable = (resourceId: string): CanonicalResource => security.resourceAccess.requireReadable({
    resourceId,
    principalId: ctx.userId,
    orgId: org.id,
    spaceId: ctx.spaceId,
  });
  const transition = (
    id: string,
    from: "active" | "deleting",
    to: "active" | "deleting" | "deleted",
    expectedRevision: number,
    action: string,
    bumpAccess: boolean,
  ): CanonicalResource => security.resourceLifecycle.transition({
    resourceId: id,
    kind: "project",
    orgId: org.id,
    spaceId: ctx.spaceId,
    from: [from],
    to,
    expectedRevision,
    actor: ctx.userId,
    action,
    bumpAccess,
  });

  const restoreDeleting = (resource: CanonicalResource): CanonicalResource => {
    assertScope(resource);
    if (resource.lifecycle !== "deleting") return resource;
    return transition(resource.id, "deleting", "active", resource.revision, "resource.delete-rolled-back", true);
  };
  const finalizeDeleted = (resource: CanonicalResource): CanonicalResource => {
    assertScope(resource);
    if (resource.lifecycle === "deleted") return resource;
    if (resource.lifecycle !== "deleting") throw recovery();
    return transition(resource.id, "deleting", "deleted", resource.revision, "resource.deleted", false);
  };

  const adoptSystemPackageWorkspace = (project: Project): Project => {
    if (ctx.userId !== RUNTIME_SYSTEM_PRINCIPAL_ID || !PACKAGE_WORKSPACE_ID.test(project.id)
      || project.spaceId !== ctx.spaceId || project.remote) throw recovery();
    const principal = security.control.get<{ kind: string; status: string }>(
      "SELECT kind,status FROM principals WHERE id=?",
      RUNTIME_SYSTEM_PRINCIPAL_ID,
    );
    if (principal?.kind !== "system" || principal.status !== "active") throw recovery();

    const operationId = randomUUID();
    const begun = security.resources.begin({
      operationId,
      resourceId: project.id,
      kind: "project",
      orgId: org.id,
      spaceId: ctx.spaceId,
      ownerPrincipalId: RUNTIME_SYSTEM_PRINCIPAL_ID,
      createdBy: RUNTIME_SYSTEM_PRINCIPAL_ID,
      visibility: "space",
    });
    try {
      security.resources.recordDomainReady(operationId, projectResourceReceipt(project));
      const current = security.resources.resource(project.id);
      if (!current) throw recovery();
      security.resources.activate(operationId, current.revision);
      const active = security.resources.active(project.id, scope);
      if (!active || active.kind !== "project") throw recovery();
      requireReadable(project.id);
      return project;
    } catch (cause) {
      const current = security.resources.resource(project.id);
      if (current && current.id === begun.resource.id
        && (current.lifecycle === "provisioning" || current.lifecycle === "quarantined")) {
        try { security.resources.quarantineUnknown(operationId, current.revision); } catch { /* preserve failure */ }
      }
      throw cause;
    }
  };

  const ensureActive = (project: Project): Project => {
    if (project.spaceId !== ctx.spaceId) throw recovery();
    let resource = row(project.id);
    if (!resource) {
      if (ctx.userId === RUNTIME_SYSTEM_PRINCIPAL_ID && PACKAGE_WORKSPACE_ID.test(project.id)) {
        return adoptSystemPackageWorkspace(project);
      }
      throw recovery();
    }
    assertScope(resource);
    if (resource.lifecycle === "active") {
      requireReadable(project.id);
      return project;
    }
    if (resource.lifecycle === "deleting") {
      resource = restoreDeleting(resource);
      if (resource.lifecycle === "active") {
        requireReadable(project.id);
        return project;
      }
    }
    if (resource.lifecycle === "provisioning" || resource.lifecycle === "quarantined") {
      const saga = security.resources.pending().find((candidate) => candidate.resourceId === project.id);
      if (!saga) throw recovery();
      security.resources.recordDomainReady(saga.operationId, projectResourceReceipt(project));
      resource = security.resources.resource(project.id);
      if (!resource) throw recovery();
      security.resources.activate(saga.operationId, resource.revision);
      const active = security.resources.active(project.id, scope);
      if (active?.kind === "project") {
        requireReadable(project.id);
        return project;
      }
    }
    throw recovery();
  };

  const existingLocal = async (path: string): Promise<Project | undefined> => {
    const absolute = resolve(path);
    return (await base.list()).find((project) => !project.remote && resolve(project.path) === absolute);
  };
  const existingRemote = async (path: string, remote: ProjectRemote): Promise<Project | undefined> =>
    (await base.list()).find((project) => project.path === path && project.remote?.connectionId === remote.connectionId);

  const provision = async (input: {
    path: string;
    name?: string;
    createDirectory?: boolean;
    remote?: ProjectRemote;
    /** A personal project: owner-only (`private`) from its first revision. */
    personal?: true;
    /** The caller's private room in this project: owner-only as well. */
    roomOf?: string;
    composition?: ProjectComposition;
    managedOperation?: string;
  }): Promise<Project> => {
    requireMutation();
    // Before any lookup: a personal folder answers the same whether or not
    // it exists, so its path can be neither probed nor squatted on.
    if (!input.personal && !input.roomOf && !input.remote && registry.reservedForPersonal(input.path)) {
      throw Object.assign(new Error("this folder is reserved for a personal project"), { code: "invalid-path" });
    }
    // The same answer whether or not it exists. A parent of the data folder is
    // fine: the file views don't show what's inside it. A Polyth-folder project
    // (`managedOperation`) is exempt like personal projects and rooms: the
    // server picked its folder, which on a server lies in Space storage.
    if (!input.personal && !input.roomOf && !input.managedOperation && !input.remote && registry.holdsServerData(input.path)) {
      throw Object.assign(new Error("this folder holds Polyth's own data"), { code: "invalid-path" });
    }
    const existing = input.personal
      ? registry.personalProject(ctx.spaceId, ctx.userId)
      : input.roomOf
        ? registry.privateRoom(ctx.spaceId, input.roomOf, ctx.userId)
      : input.remote
        ? await existingRemote(input.path, input.remote)
        : await existingLocal(input.path);
    if (existing) return ensureActive(existing);

    const resourceId = randomUUID();
    const operationId = randomUUID();
    const begun = security.resources.begin({
      operationId,
      resourceId,
      kind: "project",
      orgId: org.id,
      spaceId: ctx.spaceId,
      ownerPrincipalId: ctx.userId,
      createdBy: ctx.userId,
      visibility: input.personal || input.roomOf ? "private" : "space",
    });
    let domain: Project | undefined;
    try {
      domain = await registry.provision({
        id: resourceId,
        spaceId: ctx.spaceId,
        path: input.path,
        ...(input.name ? { name: input.name } : {}),
        ...(input.createDirectory ? { createDirectory: true } : {}),
        ...(input.remote ? { remote: input.remote } : {}),
        ...(input.personal ? { personalOwner: ctx.userId } : {}),
        ...(input.roomOf ? { room: { owner: ctx.userId, parentId: input.roomOf } } : {}),
        ...(input.composition ? { composition: input.composition } : {}),
        ...(input.managedOperation ? { managedOperation: input.managedOperation } : {}),
      });
      if (domain.id !== resourceId) {
        security.resources.abortMissingDomain(operationId, begun.resource.revision);
        return ensureActive(domain);
      }
      security.resources.recordDomainReady(operationId, projectResourceReceipt(domain));
      const current = security.resources.resource(resourceId);
      if (!current) throw recovery();
      security.resources.activate(operationId, current.revision);
      return ensureActive(domain);
    } catch (cause) {
      if (!domain) {
        const current = security.resources.resource(resourceId);
        if (current && (current.lifecycle === "provisioning" || current.lifecycle === "quarantined")) {
          try { security.resources.abortMissingDomain(operationId, current.revision); } catch { /* preserve original */ }
        }
      }
      throw cause;
    }
  };

  const remove = async (id: string): Promise<void> => {
    requireMutation();
    const project = await base.get(id);
    let resource = row(id);
    if (!project) {
      if (resource) {
        assertScope(resource);
        if (resource.lifecycle === "deleting") { finalizeDeleted(resource); return; }
      }
      await base.remove(id);
      return;
    }
    ensureActive(project);
    resource = row(id);
    if (!resource || resource.lifecycle !== "active") throw recovery();
    const deleting = transition(id, "active", "deleting", resource.revision, "resource.deleting", true);
    try {
      await base.remove(id);
    } catch (cause) {
      try { restoreDeleting(row(id) ?? deleting); } catch { /* recovery will fail closed */ }
      throw cause;
    }
    finalizeDeleted(row(id) ?? deleting);
  };

  const update = async (id: string, patch: ProjectPatch): Promise<Project> => {
    requireMutation();
    const project = await base.get(id);
    if (!project) return base.update!(id, patch);
    ensureActive(project);
    return base.update!(id, patch);
  };

  const list = async (): Promise<Project[]> => {
    const projects = await base.list();
    const visible: Project[] = [];
    for (const project of projects) {
      try { visible.push(ensureActive(project)); }
      catch (cause) {
        if ((cause as { code?: unknown } | null)?.code === "not-found") continue;
        throw cause;
      }
    }
    return visible;
  };

  const isTrustedServerWork = ctx.userId.startsWith("system:");
  /** Active members who can open a project, the reader included. */
  const audienceOf = (projectId: string): string[] => security.control.all<{ id: string }>(
    `SELECT m.principal_id AS id FROM space_memberships m JOIN principals p ON p.id=m.principal_id
      WHERE m.space_id=? AND m.state='active' AND m.role IN ('owner','admin','member','viewer')
        AND (m.expires_at_ms IS NULL OR m.expires_at_ms>?) AND p.kind='user' AND p.status='active'`,
    ctx.spaceId,
    Date.now(),
  ).map((member) => member.id).filter((id) => security.resourceAccess.access({
    resourceId: projectId, principalId: id, orgId: org.id, spaceId: ctx.spaceId,
  }) !== undefined);

  return {
    ...base,
    list,
    async privateRooms(parentProjectId) {
      const rooms = await base.privateRooms!(parentProjectId);
      const readable: Project[] = [];
      for (const room of rooms) {
        const resource = row(room.id);
        if (!resource) continue;
        if (!isTrustedServerWork && resource.ownerPrincipalId !== ctx.userId) continue;
        try { readable.push(ensureActive(room)); }
        catch (cause) {
          if ((cause as { code?: unknown } | null)?.code === "not-found") continue;
          throw cause;
        }
      }
      return readable;
    },
    async listForShell() {
      const projects = await list();
      const rooms = (await Promise.all(projects.map(async (project) => {
        const own = registry.privateRoom(ctx.spaceId, project.id, ctx.userId);
        if (!own) return undefined;
        try { return ensureActive(own); }
        catch (cause) {
          if ((cause as { code?: unknown } | null)?.code === "not-found") return undefined;
          throw cause;
        }
      }))).filter((room): room is Project => room !== undefined);
      const presence = projectPresence(ctx.spaceId);
      return [...projects.map((project) => {
        const others = audienceOf(project.id).filter((id) => id !== ctx.userId);
        if (others.length === 0) return project;
        const here = presence(project.id);
        return { ...project, sharedWith: others.length, ...(others.some((id) => here.has(id)) ? { othersHere: true } : {}) };
      }), ...rooms];
    },
    async ensurePrivateRoom(parentProjectId) {
      assertPersonalCaller(ctx);
      // Unreadable or foreign reads exactly like a missing project.
      const parent = await base.get(parentProjectId);
      if (!parent) throw Object.assign(new Error("project not found"), { code: "not-found" });
      ensureActive(parent);
      if (parent.parentProjectId || parent.personal) {
        throw Object.assign(new Error("this project is already private to its owner"), { code: "conflict" });
      }
      const existing = registry.privateRoom(ctx.spaceId, parentProjectId, ctx.userId);
      if (existing) return ensureActive(existing);
      return provision({ path: privateRoomPath(ctx, parentProjectId), name: parent.name, roomOf: parentProjectId });
    },
    async get(id) {
      const project = await base.get(id);
      return project ? ensureActive(project) : undefined;
    },
    async ensurePersonal(name) {
      assertPersonalCaller(ctx);
      const existing = registry.personalProject(ctx.spaceId, ctx.userId);
      if (existing) return ensureActive(existing);
      // Another person's personal project is invisible here, so it never
      // counts; a project this person can open does.
      if ((await list()).length > 0) throw personalRefused();
      return provision({ path: personalProjectPath(ctx), name: personalName(name), personal: true });
    },
    ...(base.getPresentationSettings ? {
      getPresentationSettings: async (id: string) => {
        const project = await base.get(id);
        if (project) ensureActive(project);
        return base.getPresentationSettings!(id);
      },
    } : {}),
    ...(base.putPresentationSettings ? {
      putPresentationSettings: async (...args: Parameters<NonNullable<ProjectService["putPresentationSettings"]>>) => {
        requireMutation();
        const project = await base.get(args[0]);
        if (project) ensureActive(project);
        return base.putPresentationSettings!(...args);
      },
    } : {}),
    add: (path, name) => provision({ path, ...(name ? { name } : {}) }),
    create: (path, name) => provision({ path, createDirectory: true, ...(name ? { name } : {}) }),
    async createManaged(input) {
      requireMutation();
      return createManagedProject(ctx, registry, parseManagedProjectInput(input), provision, ensureActive);
    },
    remove,
    ...(base.addRemote ? {
      addRemote: (path: string, remote: ProjectRemote, name?: string) =>
        provision({ path, remote, ...(name ? { name } : {}) }),
    } : {}),
    ...(base.update ? { update } : {}),
  };
}
