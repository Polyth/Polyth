import type { JsonObject, ProjectService, SessionService, SpaceContext, SpaceStorage } from "@polyth/contracts";
import type {
  ContributionCompletion,
  ExternalResource,
  StructuredContext,
} from "@polyth/package-sdk";
import type {
  CapabilityConstraints,
  DeclaredCapability,
  PackageManifest,
} from "@polyth/package-sdk/manifest";
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
import type { InvocationLeaseIdentity, InvocationLeaseStore } from "./invocationLeases.ts";
import { kvDelete, kvGet, kvSet } from "./packageKv.ts";

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export interface PackageModelRequest {
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface PackageModelResult {
  text: string;
  modelClass: "utility";
  inputTruncated: boolean;
}

export interface PackageRpcDeps {
  space: SpaceContext;
  storage: SpaceStorage;
  sessions: SessionService;
  projects: ProjectService;
  appendEvent: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  manifest: PackageManifest;
  enabled: boolean;
  sessionId?: string;
  projectId?: string;
  log?: (line: string) => void;
  secrets?: PackageOpaqueVault;
  invocationLeases?: InvocationLeaseStore;
  invocationIdentity?: InvocationLeaseIdentity;
  generateModel?: (request: PackageModelRequest) => Promise<PackageModelResult>;
}

const intersectStrings = <T extends string>(
  declared: readonly T[] | undefined,
  granted: readonly T[] | undefined,
): T[] | undefined => {
  if (!declared && !granted) return undefined;
  if (!declared) return granted ? [...granted] : undefined;
  if (!granted) return undefined;
  const allowed = new Set<T>(declared);
  const values = granted.filter((item) => allowed.has(item));
  return values.length ? [...new Set(values)] : [];
};

function intersectConstraints(
  declared: CapabilityConstraints | undefined,
  granted: CapabilityConstraints | undefined,
): CapabilityConstraints | undefined {
  if (!declared && !granted) return undefined;
  if (!declared) return granted;
  if (!granted) return undefined;
  const origins = intersectStrings(declared.origins, granted.origins);
  const methods = intersectStrings(declared.methods, granted.methods);
  const modelClasses = intersectStrings(declared.modelClasses, granted.modelClasses);
  const maxOutputTokens = declared.maxOutputTokens === undefined
    ? granted.maxOutputTokens
    : granted.maxOutputTokens === undefined
      ? undefined
      : Math.min(declared.maxOutputTokens, granted.maxOutputTokens);
  return {
    ...(origins ? { origins } : {}),
    ...(methods ? { methods } : {}),
    ...(modelClasses ? { modelClasses } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

export function effectiveCapabilities(
  manifest: PackageManifest,
  storage: SpaceStorage,
): { granted: DeclaredCapability[]; names: Set<string> } {
  const declared = manifest.capabilities ?? [];
  const grants = readGrants(storage, manifest.id);
  const persisted = grantsAsDeclared(grants);
  const granted: DeclaredCapability[] = [];
  for (const capability of declared) {
    const grant = persisted.find((item) => item.name === capability.name);
    if (!grant) continue;
    const constraints = intersectConstraints(capability.constraints, grant.constraints);
    granted.push({
      name: capability.name,
      ...(constraints ? { constraints } : {}),
    });
  }
  return { granted, names: new Set(granted.map((item) => item.name)) };
}

function safeExternalResource(body: Record<string, unknown>, fallbackProvider: string): ExternalResource {
  const provider = typeof body.provider === "string" && body.provider.trim()
    ? body.provider.trim().slice(0, 120)
    : fallbackProvider;
  const resourceId = typeof body.resourceId === "string" ? body.resourceId.trim().slice(0, 240) : "";
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 240) : "";
  if (!resourceId || !title) fail("INVALID_REQUEST", "resourceId and title are required");
  const url = typeof body.url === "string" ? body.url.trim().slice(0, 2_000) : undefined;
  if (url && !/^https:\/\//i.test(url)) fail("INVALID_REQUEST", "resource URL must use https");
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata as ExternalResource["metadata"]
    : undefined;
  return {
    provider,
    resourceId,
    title,
    ...(typeof body.subtitle === "string" ? { subtitle: body.subtitle.slice(0, 240) } : {}),
    ...(url ? { url } : {}),
    ...(typeof body.summary === "string" ? { summary: body.summary.slice(0, 4_000) } : {}),
    ...(typeof body.text === "string" ? { text: body.text.slice(0, 16_000) } : {}),
    ...(typeof body.retrievedAt === "number" && Number.isFinite(body.retrievedAt) ? { retrievedAt: body.retrievedAt } : {}),
    ...(typeof body.freshUntil === "number" && Number.isFinite(body.freshUntil) ? { freshUntil: body.freshUntil } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function safeStructuredContext(body: Record<string, unknown>, fallbackProvider: string): StructuredContext {
  const provider = typeof body.provider === "string" && body.provider.trim()
    ? body.provider.trim().slice(0, 120)
    : fallbackProvider;
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim().slice(0, 240) : "";
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 240) : "";
  const summary = typeof body.summary === "string" ? body.summary.trim().slice(0, 4_000) : "";
  const content = typeof body.content === "string" ? body.content.slice(0, 24_000) : "";
  if (!sourceId || !title || !content.trim()) fail("INVALID_REQUEST", "sourceId, title and content are required");
  const uri = typeof body.uri === "string" ? body.uri.trim().slice(0, 2_000) : undefined;
  if (uri && !/^https:\/\//i.test(uri)) fail("INVALID_REQUEST", "context URI must use https");
  return {
    provider,
    sourceId,
    title,
    ...(uri ? { uri } : {}),
    retrievedAt: typeof body.retrievedAt === "number" && Number.isFinite(body.retrievedAt)
      ? body.retrievedAt
      : Date.now(),
    ...(typeof body.freshUntil === "number" && Number.isFinite(body.freshUntil) ? { freshUntil: body.freshUntil } : {}),
    summary,
    content,
    ...(body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? { metadata: body.metadata as StructuredContext["metadata"] }
      : {}),
  };
}

function assertCompletionBounds(completion: ContributionCompletion): void {
  const bytes = Buffer.byteLength(JSON.stringify(completion), "utf8");
  if (bytes > 128 * 1024) fail("INVALID_REQUEST", "contribution result exceeds size limit");
  if ((completion.result?.resources?.length ?? 0) > 20) fail("INVALID_REQUEST", "too many resources in contribution result");
  if ((completion.result?.context?.length ?? 0) > 12) fail("INVALID_REQUEST", "too many context items in contribution result");
}

export async function invokePackageRpc(
  deps: PackageRpcDeps,
  method: string,
  payload: unknown,
): Promise<unknown> {
  if (!deps.enabled) fail("PACKAGE_DISABLED", "package is disabled");
  const declared = deps.manifest.capabilities ?? [];
  const effective = effectiveCapabilities(deps.manifest, deps.storage);
  const requireCap = (name: string): DeclaredCapability => {
    if (!declared.some((cap) => cap.name === name)) {
      fail("CAPABILITY_UNDECLARED", `capability "${name}" is not declared`);
    }
    const capability = effective.granted.find((item) => item.name === name);
    if (!capability) fail("CAPABILITY_DENIED", `capability "${name}" is not granted`);
    return capability;
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
      case "contribution.complete": {
        if (!deps.invocationLeases || !deps.invocationIdentity) fail("HOST_UNAVAILABLE", "invocation authority is unavailable");
        const completion = body as unknown as ContributionCompletion;
        if (
          typeof completion.invocationId !== "string"
          || typeof completion.lease !== "string"
          || typeof completion.ok !== "boolean"
        ) {
          fail("INVALID_REQUEST", "contribution completion is invalid");
        }
        assertCompletionBounds(completion);
        deps.invocationLeases.complete(deps.invocationIdentity, completion);
        return { accepted: true };
      }
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
          provider: deps.manifest.id,
          sourceId: `legacy:${Date.now()}`,
          title: deps.manifest.display.name,
          summary: text.slice(0, 500),
          content: text,
          retrievedAt: Date.now(),
        });
        return { ok: true };
      }
      case "context.append": {
        requireCap("context.append");
        const sessionId = deps.sessionId;
        if (!sessionId || !await sessionOwned(sessionId)) fail("RESOURCE_NOT_FOUND", "session not found");
        const context = safeStructuredContext(body, deps.manifest.id);
        await deps.appendEvent(sessionId, "package/context", {
          packageId: deps.manifest.id,
          provider: context.provider,
          sourceId: context.sourceId,
          title: context.title,
          uri: context.uri ?? "",
          retrievedAt: context.retrievedAt,
          freshUntil: context.freshUntil ?? 0,
          summary: context.summary,
          content: context.content,
          metadata: (context.metadata ?? {}) as JsonObject,
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
        const resource = safeExternalResource(body, deps.manifest.id);
        const sessionId = deps.sessionId;
        if (!sessionId || !await sessionOwned(sessionId)) fail("RESOURCE_NOT_FOUND", "session not found");
        await deps.appendEvent(sessionId, "package/attached", {
          packageId: deps.manifest.id,
          provider: resource.provider,
          resourceId: resource.resourceId,
          title: resource.title,
          subtitle: resource.subtitle ?? "",
          url: resource.url ?? "",
          summary: resource.summary ?? "",
          text: resource.text ?? "",
          retrievedAt: resource.retrievedAt ?? Date.now(),
          freshUntil: resource.freshUntil ?? 0,
          metadata: (resource.metadata ?? {}) as JsonObject,
        });
        return { ok: true };
      }
      case "model.generate": {
        const capability = requireCap("model.generate");
        if (!deps.generateModel) fail("HOST_UNAVAILABLE", "model generation is unavailable");
        const classes = capability.constraints?.modelClasses ?? [];
        if (!classes.includes("utility")) fail("CAPABILITY_DENIED", "utility model generation is not granted");
        const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 24_000) : "";
        if (!prompt) fail("INVALID_REQUEST", "prompt is required");
        const grantedMax = capability.constraints?.maxOutputTokens ?? 1_024;
        const requestedMax = Number.isInteger(body.maxOutputTokens) ? Number(body.maxOutputTokens) : Math.min(1_024, grantedMax);
        const maxOutputTokens = Math.min(Math.max(requestedMax, 1), grantedMax, 4_096);
        const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 30_000, 1_000), 60_000);
        return deps.generateModel({ prompt, maxOutputTokens, timeoutMs });
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
        const network = requireCap("network.fetch");
        const url = typeof body.url === "string" ? body.url : "";
        const methodName = (typeof body.method === "string" ? body.method : "GET").toUpperCase();
        const allowedMethods = network.constraints?.methods;
        if (allowedMethods?.length && !allowedMethods.includes(methodName as NonNullable<CapabilityConstraints["methods"]>[number])) {
          fail("CAPABILITY_DENIED", `network method ${methodName} is not granted`);
        }
        const origins = network.constraints?.origins ?? [];
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
          method: methodName,
          headers: body.headers && typeof body.headers === "object"
            ? Object.fromEntries(
              Object.entries(body.headers as Record<string, unknown>)
                .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            )
            : undefined,
          body: typeof body.body === "string" ? body.body : undefined,
          ...(authorization ? { authorization } : {}),
        }, origins);
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
