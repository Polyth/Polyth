import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  roleAtLeast,
  type Project,
  type ProjectPatch,
  type ProjectRemote,
  type ProjectService,
  type SpaceContext,
} from "@polyth/contracts";
import type { CanonicalResource } from "@polyth/control-plane/resources";
import type { ProjectRegistry } from "./projects.ts";
import { projectResourceReceipt } from "./resourceReceipts.ts";
import { canonicalSecurity } from "./runtimeSecurity.ts";

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

export function canonicalProjectService(
  ctx: SpaceContext,
  registry: ProjectRegistry,
): ProjectService {
  const base = registry.forSpace(ctx);
  const security = canonicalSecurity();
  if (!security) return base;

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
  }): Promise<Project> => {
    requireMutation();
    const existing = input.remote
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
      visibility: "space",
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

  return {
    ...base,
    async list() {
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
    },
    async get(id) {
      const project = await base.get(id);
      return project ? ensureActive(project) : undefined;
    },
    add: (path, name) => provision({ path, ...(name ? { name } : {}) }),
    create: (path, name) => provision({ path, createDirectory: true, ...(name ? { name } : {}) }),
    remove,
    ...(base.addRemote ? {
      addRemote: (path: string, remote: ProjectRemote, name?: string) =>
        provision({ path, remote, ...(name ? { name } : {}) }),
    } : {}),
    ...(base.update ? { update } : {}),
  };
}
