import { roleAtLeast } from "@polyth/contracts";
import type {
  AgentCapabilityContributionRegistry,
  Disposable,
  RouteHandler,
  SecureSafeKind,
  SecureSafePatchInput,
  SecureSafeScope,
  SecureSafeService,
  SpaceContext,
  SpaceStorage,
} from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  SPACE_SECURE_SAFE,
  type ServerPackage,
  type ServerPackageHost,
  type SpaceSecureSafeRegistry,
} from "@polyth/plugins";
import {
  configureSecureSafePersonRouting,
  configureSecureSafeSpaceRouting,
  createSecureSafeService,
} from "./index.ts";
import { SECURE_SAFE_PACKAGE_ID, secureSafeSkill } from "./agentSkill.ts";
import { createCredentialVaultListAgentTool } from "./agentTool.ts";

const kind = (value: unknown): SecureSafeKind => {
  if (value === "env" || value === "token" || value === "password") return value;
  throw Object.assign(new Error("kind must be env, token, or password"), {
    code: "invalid-input",
  });
};

const scope = (value: unknown): SecureSafeScope => {
  if (value === "global" || value === "project") return value;
  throw Object.assign(new Error("scope must be global or project"), {
    code: "invalid-input",
  });
};

/** Space credentials are shared by every member, so only admins change them. */
const requireSpaceAdmin = (space: SpaceContext): void => {
  if (roleAtLeast(space.role, "admin")) return;
  throw Object.assign(new Error("Only Space admins can change Credential Vault entries"), {
    code: "forbidden",
    mutationOutcome: "not-started",
  });
};

const createInput = (input: Record<string, unknown>) => ({
  handle: String(input.handle ?? ""),
  label: String(input.label ?? ""),
  ...(input.purpose !== undefined ? { purpose: String(input.purpose) } : {}),
  ...(input.kind !== undefined ? { kind: kind(input.kind) } : {}),
  ...(input.scope !== undefined ? { scope: scope(input.scope) } : {}),
  ...(input.projectId !== undefined
    ? { projectId: String(input.projectId) }
    : {}),
  value: typeof input.value === "string" ? input.value : "",
});

const patchInput = (input: Record<string, unknown>): SecureSafePatchInput => ({
  ...(input.handle !== undefined ? { handle: String(input.handle) } : {}),
  ...(input.label !== undefined ? { label: String(input.label) } : {}),
  ...(input.purpose !== undefined ? { purpose: String(input.purpose) } : {}),
  ...(input.kind !== undefined ? { kind: kind(input.kind) } : {}),
  ...(input.scope !== undefined ? { scope: scope(input.scope) } : {}),
  ...(input.projectId !== undefined
    ? { projectId: input.projectId === null ? null : String(input.projectId) }
    : {}),
  ...(typeof input.value === "string" ? { value: input.value } : {}),
});

/**
 * `/api/secure-safe/personal[/:id]`: the signed-in person's own credentials.
 * Any active member manages their own; nobody — an admin included — lists or
 * changes someone else's through this route, because the owner is always
 * `rc.space.userId`, never request input.
 */
async function personalRoute(
  { path, method, body, json, space }: Parameters<RouteHandler>[0],
  resolvePersonal: (space: SpaceContext) => SecureSafeService | undefined,
): Promise<boolean> {
  const match = path.match(/^\/api\/secure-safe\/personal(?:\/([^/]+))?$/);
  if (!match) return false;
  const safe = resolvePersonal(space);
  if (!safe) {
    throw Object.assign(new Error("Personal credentials need a signed-in person"), {
      code: "unsupported",
      mutationOutcome: "not-started",
    });
  }
  const id = match[1] === undefined ? undefined : decodeURIComponent(match[1]);
  if (id === undefined && method === "GET") {
    json(200, safe.list());
    return true;
  }
  if (id === undefined && method === "POST") {
    json(200, await safe.create(createInput(await body())));
    return true;
  }
  if (id !== undefined && method === "PATCH") {
    json(200, await safe.update(id, patchInput(await body())));
    return true;
  }
  if (id !== undefined && method === "DELETE") {
    json(200, { ok: await safe.remove(id) });
    return true;
  }
  return false;
}

function routeWith(
  resolveSafe: (space: SpaceContext) => SecureSafeService,
  resolvePersonal: (space: SpaceContext) => SecureSafeService | undefined = () => undefined,
): RouteHandler {
  return async (rc) => {
    const { path, method, body, json, space } = rc;
    if (path === "/api/secure-safe/access" && method === "GET") {
      // What the signed-in person may do here; no entry metadata.
      json(200, {
        canManageSpace: roleAtLeast(space.role, "admin"),
        personal: resolvePersonal(space) !== undefined,
      });
      return true;
    }
    if (await personalRoute(rc, resolvePersonal)) return true;
    const safe = resolveSafe(space);
    if (path === "/api/secure-safe" && method === "GET") {
      json(200, safe.list());
      return true;
    }
    if (path === "/api/secure-safe/forbidden-config" && method === "GET") {
      json(200, safe.manifest());
      return true;
    }
    if (path === "/api/secure-safe" && method === "POST") {
      requireSpaceAdmin(space);
      json(200, await safe.create(createInput(await body())));
      return true;
    }
    const match = path.match(/^\/api\/secure-safe\/([^/]+)$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]!);
    if (method === "PATCH") {
      requireSpaceAdmin(space);
      json(200, await safe.update(id, patchInput(await body())));
      return true;
    }
    if (method === "DELETE") {
      requireSpaceAdmin(space);
      json(200, { ok: await safe.remove(id) });
      return true;
    }
    return false;
  };
}

/** Legacy/test helper for a pre-resolved safe. Production uses Space routing. */
export function secureSafeRoutes(
  safe: SecureSafeService,
  personal?: (space: SpaceContext) => SecureSafeService | undefined,
): RouteHandler {
  return routeWith(() => safe, personal);
}

export interface CredentialVaultRegistry extends SpaceSecureSafeRegistry {
  /** The person's own store, only while they are an active member of `spaceId`. */
  forPerson(spaceId: string, userId: string): SecureSafeService | undefined;
}

export function createSpaceSafeRegistry(host: ServerPackageHost): CredentialVaultRegistry {
  const safes = new Map<string, SecureSafeService>();
  const rootsBySpace = new Map<string, string>();

  // Person stores are the people host's own (person, package) Credential
  // Vault partitions (`people/<userId>/vault/secure-safe`): one physical
  // store per directory, dropped by the host when the account is deleted.
  const forPerson = (spaceId: string, userId: string): SecureSafeService | undefined => {
    const people = host.people;
    if (!people?.credentialVault || typeof userId !== "string" || !userId) return undefined;
    if (!people.isMember(userId, spaceId)) return undefined;
    try {
      return people.credentialVault(userId, SECURE_SAFE_PACKAGE_ID);
    } catch {
      // `system:*` principals and malformed ids are not people.
      return undefined;
    }
  };

  const forStorage = (spaceId: string, storage: SpaceStorage): SecureSafeService => {
    const root = storage.path("secure-safe");
    rootsBySpace.set(spaceId, root);
    let safe = safes.get(root);
    if (!safe) {
      safe = createSecureSafeService({
        dataDir: root,
        localOnly: true,
        migrateLegacyOpaque: true,
        personal: (userId) => forPerson(spaceId, userId),
      });
      safes.set(root, safe);
    }
    return safe;
  };

  return {
    forPerson,
    forSpace(space) {
      return forStorage(space.spaceId, host.spaceStorage(space));
    },
    forSpaceId(spaceId) {
      const known = rootsBySpace.get(spaceId);
      if (known) return safes.get(known);
      try {
        // Agent tools receive a server-issued Space grant but not the original
        // HTTP request. Resolve that grant through the host's trusted system
        // seam rather than depending on a prior browser/UI route.
        return forStorage(spaceId, host.spaceStorage(host.systemSpaceContext(spaceId)));
      } catch {
        // Test/minimal hosts may not expose a system context; the package
        // manager fallback keeps those callers compatible.
      }
      const view = host.packageSpaces?.().find((item) => item.spaceId === spaceId);
      return view ? forStorage(spaceId, view.storage) : undefined;
    },
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const spaces = createSpaceSafeRegistry(host);
  host.services.provide(SPACE_SECURE_SAFE, spaces);
  configureSecureSafeSpaceRouting((space) => spaces.forSpace(space));
  configureSecureSafePersonRouting((space, userId) => spaces.forPerson(space.spaceId, userId));
  const routes = routeWith(
    (space) => spaces.forSpace(space),
    (space) => spaces.forPerson(space.spaceId, space.userId),
  );
  let capabilityRegistrations: Disposable[] | undefined;
  return {
    remoteAccess: localOnlyRemoteAccess(["secure-safe"]),
    routes,
    onEnable() {
      if (capabilityRegistrations) return;
      const capabilities = host.services.require(
        serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
      );
      capabilityRegistrations = [
        // Deployment skill: available in every Space/project, not a
        // project-owned managed skill. Teaches agents the sensitive-data
        // contract and usage.
        capabilities.register(SECURE_SAFE_PACKAGE_ID, secureSafeSkill),
        // This project-scoped tool gets the active, server-authorized Space
        // from ToolExecutionContext; model input cannot select a tenant.
        capabilities.register(
          SECURE_SAFE_PACKAGE_ID,
          createCredentialVaultListAgentTool(
            (spaceId) => spaces.forSpaceId(spaceId),
            (spaceId, userId) => spaces.forPerson(spaceId, userId),
          ),
        ),
      ];
    },
    async onDisable() {
      for (const registration of capabilityRegistrations?.toReversed() ?? []) {
        await registration.dispose();
      }
      capabilityRegistrations = undefined;
    },
  };
}
