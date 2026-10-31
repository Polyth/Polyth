import type {
  ModelDescriptor,
  ProviderConfigPort,
  RouteHandler,
} from "@polyth/contracts";
import { requireInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import { serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import {
  validateAuthMode,
  validateHeaderPatch,
  validateProtocol,
  type CustomProviderInput,
} from "./customProvider.ts";
import { createProviderManager, type VisibilityPort } from "./providerManager.ts";

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const parseInput = (body: Record<string, unknown>): CustomProviderInput => {
  const protocol = validateProtocol(body.protocol);
  const authMode = validateAuthMode(body.authMode);
  const headerPatch = body.headerPatch !== undefined
    ? validateHeaderPatch(body.headerPatch)
    : body.headers !== undefined
      ? validateHeaderPatch({ set: body.headers })
      : undefined;
  return {
    ...(asString(body.id) ? { id: asString(body.id) } : {}),
    name: asString(body.name) ?? asString(body.displayName) ?? "",
    baseURL: asString(body.baseURL) ?? asString(body.baseUrl) ?? "",
    protocol,
    authMode,
    ...(asString(body.apiKey) ? { apiKey: asString(body.apiKey) } : {}),
    ...(headerPatch ? { headerPatch } : {}),
  };
};

const errorStatus = (code: string | undefined): number => {
  if (code === "invalid-input") return 400;
  if (code === "auth-rejected") return 401;
  if (code === "not-found") return 404;
  if (code === "conflict") return 409;
  if (code === "unsupported" || code === "capability-unsupported") return 501;
  if (code === "invalid-response") return 502;
  if (code === "unavailable" || code === "unreachable" || code === "cancelled") return 503;
  return 500;
};

const reservedProviderIds = async (host: ServerPackageHost): Promise<Set<string>> => {
  const ids = new Set<string>();
  try {
    const rt = await host.runtimes.forProject("__default__");
    const [catalogue, methods] = await Promise.all([
      rt.listAllProviders ? rt.listAllProviders().catch(() => []) : Promise.resolve([]),
      rt.providerAuthMethods ? rt.providerAuthMethods().catch(() => ({})) : Promise.resolve({}),
    ]);
    for (const provider of catalogue) if (provider.id) ids.add(provider.id);
    for (const id of Object.keys(methods)) ids.add(id);
  } catch {
    /* uniqueness still uses live models + config keys */
  }
  return ids;
};

export function customProviderRoutes(host: ServerPackageHost, listModels: () => Promise<ModelDescriptor[]>): RouteHandler {
  const manager = () => {
    const visibility = host.services.require(serverServiceKey<VisibilityPort>("models.visibility"));
    const config = host.services.require(serverServiceKey<ProviderConfigPort>("plugins.config"));
    const invalidate = host.services.get(serverServiceKey<() => void>("models.invalidate-catalog"));
    return createProviderManager({
      visibility,
      config,
      runtime: () => host.runtimes.forProject("__default__"),
      invalidateCatalog: () => { invalidate?.(); },
    });
  };

  return async (request) => {
    const { path, method, body, json } = request;
    if (!path.startsWith("/api/providers/custom")) return false;
    requireInstanceOwnerAuthority(request, "custom provider changes require the instance owner");
    try {
      if (path === "/api/providers/custom" && method === "POST") {
        const input = parseInput(await body());
        const created = await manager().createCustom(
          input,
          await listModels().catch((): ModelDescriptor[] => []),
          await reservedProviderIds(host),
        );
        json(200, {
          ok: true,
          id: created.id,
          ...(created.discovered !== undefined ? { discovered: created.discovered } : {}),
        });
        return true;
      }
      let match = path.match(/^\/api\/providers\/custom\/([^/]+)$/);
      if (match && method === "PATCH") {
        const id = decodeURIComponent(match[1]!);
        await manager().updateCustom(id, parseInput(await body()));
        json(200, { ok: true, id });
        return true;
      }
      if (match && method === "DELETE") {
        const id = decodeURIComponent(match[1]!);
        const input = await body().catch(() => ({} as Record<string, unknown>));
        await manager().removeManaged(id, { deleteCredentials: input.deleteCredentials !== false });
        json(200, { ok: true, id });
        return true;
      }
      match = path.match(/^\/api\/providers\/custom\/([^/]+)\/discover$/);
      if (match && method === "POST") {
        const id = decodeURIComponent(match[1]!);
        const input = await body().catch(() => ({} as Record<string, unknown>));
        const result = await manager().discover(id, {
          ...(asString(input.apiKey) ? { apiKey: asString(input.apiKey) } : {}),
        });
        json(200, {
          ok: true,
          models: result.models,
          ...(result.unsupported ? { unsupported: true } : {}),
          ...(result.message ? { message: result.message } : {}),
        });
        return true;
      }
      match = path.match(/^\/api\/providers\/custom\/([^/]+)\/models$/);
      if (match && method === "POST") {
        const id = decodeURIComponent(match[1]!);
        const input = await body();
        const modelId = asString(input.id) ?? asString(input.modelID) ?? "";
        await manager().addManualModel(id, {
          id: modelId,
          ...(asString(input.name) ? { name: asString(input.name) } : {}),
          ...(typeof input.context === "number" ? { context: input.context } : {}),
          ...(typeof input.output === "number" ? { output: input.output } : {}),
        });
        json(200, { ok: true, id, modelID: modelId });
        return true;
      }
      match = path.match(/^\/api\/providers\/custom\/([^/]+)\/models\/([^/]+)$/);
      if (match && method === "DELETE") {
        const id = decodeURIComponent(match[1]!);
        const modelId = decodeURIComponent(match[2]!);
        await manager().removeConfiguredModel(id, modelId);
        json(200, { ok: true, id, modelID: modelId });
        return true;
      }
      return false;
    } catch (e) {
      const err = e as Error & { code?: string };
      json(errorStatus(err.code), { error: err.code ?? "unavailable", message: err.message });
      return true;
    }
  };
}
