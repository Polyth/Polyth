import type { JsonObject, ProjectService, SessionService, SpaceContext, SpaceStorage } from "@polyth/contracts";
import type { DeclaredCapability, PackageManifestV1 } from "@polyth/package-sdk/manifest";
import { brokerFetch } from "./networkBroker.ts";
import {
  assertApprovedConnection,
  assertConnectionOrigin,
  connectionAuthorization,
  disconnectConnection,
  listPublicConnections,
} from "./connections.ts";
import type { PackageOpaqueVault } from "./connections.ts";
import { grantsAsDeclared, readGrants } from "./grants.ts";
import { kvDelete, kvGet, kvSet } from "./packageKv.ts";

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export interface PackageRpcDeps {
  space: SpaceContext;
  storage: SpaceStorage;
  sessions: SessionService;
  projects: ProjectService;
  appendEvent: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  manifest: PackageManifestV1;
  enabled: boolean;
  sessionId?: string;
  projectId?: string;
  log?: (line: string) => void;
  secrets?: PackageOpaqueVault;
}

export function effectiveCapabilities(
  manifest: PackageManifestV1,
  storage: SpaceStorage,
): { granted: DeclaredCapability[]; names: Set<string>; origins: string[] } {
  const declared = manifest.capabilities ?? [];
  const grants = readGrants(storage, manifest.id);
  const granted = grantsAsDeclared(grants).filter((item) =>
    declared.some((cap) => cap.name === item.name));
  const names = new Set(granted.map((item) => item.name));
  const network = granted.find((item) => item.name === "network.fetch");
  const declaredNetwork = declared.find((item) => item.name === "network.fetch");
  const allowed = new Set(declaredNetwork?.constraints?.origins ?? []);
  const origins = (network?.constraints?.origins ?? []).filter((origin) => allowed.has(origin));
  return { granted, names, origins };
}

export async function invokePackageRpc(
  deps: PackageRpcDeps,
  method: string,
  payload: unknown,
): Promise<unknown> {
  if (!deps.enabled) fail("PACKAGE_DISABLED", "package is disabled");
  const declared = deps.manifest.capabilities ?? [];
  const effective = effectiveCapabilities(deps.manifest, deps.storage);
  const requireCap = (name: string): void => {
    if (!declared.some((cap) => cap.name === name)) {
      fail("CAPABILITY_UNDECLARED", `capability "${name}" is not declared`);
    }
    if (!effective.names.has(name)) fail("CAPABILITY_DENIED", `capability "${name}" is not granted`);
  };
  const body = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};

  const sessionOwned = async (sessionId: string): Promise<boolean> => {
    try {
      const snap = await deps.sessions.snapshot(sessionId);
      return snap.spaceId === deps.space.spaceId;
    } catch {
      return false;
    }
  };

  try {
    switch (method) {
      case "session.read": {
        requireCap("session.read");
        if (!deps.sessionId) return null;
        const snap = await deps.sessions.snapshot(deps.sessionId);
        if (snap.spaceId !== deps.space.spaceId) return null;
        return {
          id: snap.id,
          title: snap.title,
          busy: snap.status === "working" || snap.status === "waiting" || snap.status === "reconciling",
        };
      }
      case "session.appendContext": {
        requireCap("session.appendContext");
        const sessionId = deps.sessionId;
        const text = typeof body.text === "string" ? body.text.slice(0, 8_000) : "";
        if (typeof sessionId !== "string" || !sessionId || !text.trim()) {
          return fail("INVALID_REQUEST", "session and text are required");
        }
        if (!await sessionOwned(sessionId)) fail("RESOURCE_NOT_FOUND", "session not found");
        await deps.appendEvent(sessionId, "package/context", {
          packageId: deps.manifest.id,
          title: deps.manifest.display.name,
          text,
        });
        return { ok: true };
      }
      case "project.readMetadata": {
        requireCap("project.readMetadata");
        if (!deps.projectId) return null;
        const project = await deps.projects.get(deps.projectId);
        if (!project || project.spaceId !== deps.space.spaceId) return null;
        return { id: project.id, name: project.name };
      }
      case "attachments.create": {
        requireCap("attachments.create");
        const title = typeof body.title === "string" ? body.title.slice(0, 200) : "";
        const text = typeof body.text === "string" ? body.text.slice(0, 8_000) : "";
        const sessionId = deps.sessionId;
        if (typeof sessionId !== "string" || !sessionId || !title) {
          return fail("INVALID_REQUEST", "session and title are required");
        }
        if (!await sessionOwned(sessionId)) fail("RESOURCE_NOT_FOUND", "session not found");
        await deps.appendEvent(sessionId, "package/attached", {
          packageId: deps.manifest.id,
          resourceId: typeof body.resourceId === "string" ? body.resourceId.slice(0, 200) : "",
          title,
          subtitle: typeof body.subtitle === "string" ? body.subtitle.slice(0, 200) : "",
          url: typeof body.url === "string" ? body.url.slice(0, 2_000) : "",
          kind: typeof body.kind === "string" ? body.kind.slice(0, 64) : "context",
          text,
        });
        return { ok: true };
      }
      case "storage.get": {
        requireCap("storage.package");
        return kvGet(deps.storage, deps.manifest.id, String(body.key ?? ""));
      }
      case "storage.set": {
        requireCap("storage.package");
        kvSet(deps.storage, deps.manifest.id, String(body.key ?? ""), String(body.value ?? ""));
        return { ok: true };
      }
      case "storage.delete": {
        requireCap("storage.package");
        kvDelete(deps.storage, deps.manifest.id, String(body.key ?? ""));
        return { ok: true };
      }
      case "network.fetch": {
        requireCap("network.fetch");
        const url = typeof body.url === "string" ? body.url : "";
        const connectionId = typeof body.connectionId === "string" ? body.connectionId : undefined;
        const spec = connectionId
          ? (deps.manifest.connections ?? []).find((item) => item.id === connectionId)
          : undefined;
        if (connectionId && !spec) fail("RESOURCE_NOT_FOUND", "connection is not declared");
        if (spec) {
          requireCap("auth.connection");
          assertApprovedConnection(deps.storage, deps.manifest.id, spec);
          assertConnectionOrigin(spec, url);
        }
        const authorization = spec
          ? await connectionAuthorization({
            storage: deps.storage,
            spaceId: deps.space.spaceId,
            vault: deps.secrets ?? fail("HOST_UNAVAILABLE", "secret vault is unavailable"),
          }, deps.manifest.id, spec)
          : null;
        if (connectionId && !authorization) fail("CONNECTION_REQUIRED", "connection is not connected");
        return brokerFetch({
          url,
          method: typeof body.method === "string" ? body.method : "GET",
          headers: body.headers && typeof body.headers === "object"
            ? Object.fromEntries(
              Object.entries(body.headers as Record<string, unknown>)
                .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            )
            : undefined,
          body: typeof body.body === "string" ? body.body : undefined,
          ...(authorization ? { authorization } : {}),
        }, effective.origins);
      }
      case "auth.connection": {
        requireCap("auth.connection");
        const id = String(body.id ?? "");
        const spec = (deps.manifest.connections ?? []).find((item) => item.id === id);
        if (!spec) return fail("RESOURCE_NOT_FOUND", "connection is not declared");
        return listPublicConnections(deps.storage, deps.manifest.id, [spec])[0];
      }
      case "auth.connect": {
        requireCap("auth.connection");
        if (body.token !== undefined) {
          return fail("INVALID_REQUEST", "credentials are collected by the host, not the package");
        }
        return fail("INVALID_REQUEST", "connections are completed by the host");
      }
      case "auth.disconnect": {
        requireCap("auth.connection");
        const id = String(body.id ?? "");
        const spec = (deps.manifest.connections ?? []).find((item) => item.id === id);
        if (!spec) return fail("RESOURCE_NOT_FOUND", "connection is not declared");
        return disconnectConnection({
          storage: deps.storage,
          spaceId: deps.space.spaceId,
          vault: deps.secrets ?? fail("HOST_UNAVAILABLE", "secret vault is unavailable"),
        }, deps.manifest.id, spec);
      }
      default:
        return fail("INVALID_REQUEST", `unknown method "${method}"`);
    }
  } catch (cause) {
    deps.log?.(`${method} failed: ${(cause as Error).message}`);
    throw cause;
  }
}
