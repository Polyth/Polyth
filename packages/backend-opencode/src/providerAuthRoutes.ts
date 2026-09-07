import type {
  AgentRuntime,
  AvailableProviderDescriptor,
  ModelDescriptor,
  RouteHandler,
  SpaceContext,
} from "@polyth/contracts";
import { allowsInteractiveProviderAuth } from "@polyth/contracts";
import { assertInteractiveProviderAuth } from "./providerAuthTarget.ts";
import type { ProviderAuthController } from "./providerAuth.ts";

interface CatalogService {
  invalidateModels(): void;
  models(): Promise<ModelDescriptor[]>;
}

interface VisibilityService {
  catalog(models: ModelDescriptor[]): Array<{ id: string; connected: boolean }>;
  available(
    models: ModelDescriptor[],
    live: readonly AvailableProviderDescriptor[],
    authMethodIds: readonly string[],
  ): AvailableProviderDescriptor[];
}

const optionalStringRecord = (value: unknown, label: string): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error(`${label} must be an object of strings`), { code: "invalid-input" });
  }
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => !key || typeof item !== "string")) {
    throw Object.assign(new Error(`${label} must be an object of strings`), { code: "invalid-input" });
  }
  return Object.fromEntries(entries);
};

const optionalProviderCall = <T>(
  call: (() => Promise<T>) | undefined,
  fallback: T,
): Promise<T> => call
  ? call().catch((error: unknown) => {
      const code = (error as { code?: unknown }).code;
      if (code === "unsupported" || code === "capability-unsupported") return fallback;
      throw error;
    })
  : Promise.resolve(fallback);

export function providerAuthRoutes(deps: {
  auth: ProviderAuthController;
  runtime(space: SpaceContext): Promise<AgentRuntime>;
  catalog?: CatalogService;
  visibility?: VisibilityService;
}): RouteHandler {
  const connectedIds = async (rt: AgentRuntime): Promise<Set<string>> => {
    try {
      const models = await rt.models();
      return new Set(
        models.filter((model) => model.connected !== false).map((model) => model.providerID),
      );
    } catch {
      return new Set();
    }
  };

  return async ({ path, method, json, body, space }) => {
    if (!path.startsWith("/api/providers")) return false;
    const runtime = () => deps.runtime(space);

    if (path === "/api/providers/available" && method === "GET") {
      if (!deps.visibility || !deps.catalog) return false;
      const rt = await runtime();
      const [live, authCaps, allModels] = await Promise.all([
        optionalProviderCall(rt.listAllProviders ? () => rt.listAllProviders!() : undefined, []),
        deps.auth.capabilities(new Set(), space).catch(() => ({ providers: {} as Record<string, unknown> })),
        deps.catalog.models().catch((): ModelDescriptor[] => []),
      ]);
      json(200, deps.visibility.available(allModels, live, Object.keys(authCaps.providers)));
      return true;
    }
    if (path === "/api/providers/auth-capabilities" && method === "GET") {
      const connected = allowsInteractiveProviderAuth(space.deployment)
        ? await connectedIds(await runtime())
        : new Set<string>();
      json(200, await deps.auth.capabilities(connected, space));
      return true;
    }
    if (path === "/api/providers/auth/well-known/preview" && method === "POST") {
      assertInteractiveProviderAuth(space);
      const input = await body();
      if (typeof input.origin !== "string" || !input.origin.trim()) {
        throw Object.assign(new Error("origin is required"), { code: "AUTH_INPUT_INVALID", field: "origin" });
      }
      json(200, await deps.auth.previewWellKnown(input.origin, space));
      return true;
    }
    if (path === "/api/providers/auth/well-known/execute" && method === "POST") {
      assertInteractiveProviderAuth(space);
      const input = await body();
      if (typeof input.origin !== "string" || typeof input.hash !== "string" || input.confirm !== true) {
        throw Object.assign(new Error("reviewed origin, hash, and confirm=true are required"), { code: "AUTH_INPUT_INVALID" });
      }
      json(200, await deps.auth.executeWellKnown(input.origin, input.hash, space));
      return true;
    }

    let match = path.match(/^\/api\/providers\/auth\/attempts\/([^/]+)$/);
    if (match && method === "GET") {
      const attempt = deps.auth.getAttempt(decodeURIComponent(match[1]!), space);
      if (!attempt) throw Object.assign(new Error("Sign-in attempt was not found."), { code: "AUTH_SESSION_STALE" });
      json(200, attempt);
      return true;
    }
    if (match && method === "DELETE") {
      assertInteractiveProviderAuth(space);
      json(200, deps.auth.cancelAttempt(decodeURIComponent(match[1]!), space));
      return true;
    }
    match = path.match(/^\/api\/providers\/auth\/attempts\/([^/]+)\/complete$/);
    if (match && method === "POST") {
      assertInteractiveProviderAuth(space);
      const input = await body();
      const code = typeof input.code === "string" ? input.code : undefined;
      if (code !== undefined && !code.trim()) {
        throw Object.assign(new Error("code must be a non-empty string"), { code: "AUTH_INPUT_INVALID", field: "code" });
      }
      json(200, await deps.auth.completeAttempt(decodeURIComponent(match[1]!), code, space));
      return true;
    }

    match = path.match(/^\/api\/providers\/([^/]+)\/auth$/);
    if (match && method === "GET") {
      const providerId = decodeURIComponent(match[1]!);
      const connected = allowsInteractiveProviderAuth(space.deployment)
        ? (await connectedIds(await runtime())).has(providerId)
        : false;
      json(200, await deps.auth.view(providerId, connected, space));
      return true;
    }
    match = path.match(/^\/api\/providers\/([^/]+)\/auth\/attempts$/);
    if (match && method === "POST") {
      assertInteractiveProviderAuth(space);
      const providerId = decodeURIComponent(match[1]!);
      const input = await body();
      if (typeof input.methodId !== "string" || !input.methodId) {
        throw Object.assign(new Error("methodId is required"), { code: "AUTH_INPUT_INVALID", field: "methodId" });
      }
      json(200, await deps.auth.startAttempt({
        providerId,
        methodId: input.methodId,
        inputs: optionalStringRecord(input.inputs, "inputs"),
        ...(typeof input.revision === "string" && input.revision ? { revision: input.revision } : {}),
        browserLocality: "unknown",
        space,
      }));
      return true;
    }
    match = path.match(/^\/api\/providers\/([^/]+)\/disconnect$/);
    if (match && method === "POST") {
      assertInteractiveProviderAuth(space);
      json(200, await deps.auth.disconnect(decodeURIComponent(match[1]!), space));
      return true;
    }
    return false;
  };
}
