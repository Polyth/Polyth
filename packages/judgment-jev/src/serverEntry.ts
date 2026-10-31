import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync, localOnlyRemoteAccess, SPACE_SECURE_SAFE, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { JudgmentExecutionError } from "@polyth/judgment";
import { JUDGMENT_SERVICE, type JudgmentServerContext } from "@polyth/judgment/server";
import { createJevJudgmentEngine, discoverJevModels, JEV_ENGINE_METADATA, JEV_PROVIDER, JEV_ROUTES, jevRoute, type JevJudgmentAdapterOptions, type JevRoute } from "./adapter.ts";
import { routeModel } from "./routes.ts";
import type { ModelDescriptor } from "@polyth/contracts";

/** v1 held one TypeSafe handle; v2 holds one handle per route. Discovered models are TypeSafe's account catalog. */
interface Saved { version: 2; credentials: Record<string, string>; models?: ModelDescriptor[] }

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let unregister: (() => void) | undefined;
  const catalogs = new Map<string, ModelDescriptor[]>();
  const revisions = new Map<string, number>();
  const key = (ctx: JudgmentServerContext) => JSON.stringify([ctx.space.spaceId, ctx.projectId]);
  const path = (ctx: JudgmentServerContext) => join(host.spaceStorage(ctx.space).packageDir("judgment-jev"), `${encodeURIComponent(ctx.projectId)}.json`);
  const saved = (ctx: JudgmentServerContext): Saved => {
    try {
      const data = JSON.parse(readFileSync(path(ctx), "utf8"));
      const credentials: unknown = data.version === 1 ? (data.secretHandle === undefined ? {} : { [JEV_PROVIDER.id]: data.secretHandle }) : data.credentials;
      if ((data.version !== 1 && data.version !== 2) || !credentials || typeof credentials !== "object" || Array.isArray(credentials)
        || Object.entries(credentials).some(([id, handle]) => jevRoute(id)?.credential !== "required" || typeof handle !== "string" || !handle || handle.length > 128)) throw new Error();
      if (data.models !== undefined && (!Array.isArray(data.models) || data.models.length > 1_000
        || data.models.some((model: ModelDescriptor) => !model || model.providerID !== JEV_PROVIDER.id
          || typeof model.modelID !== "string" || !/^[A-Za-z0-9._:/-]{1,200}$/.test(model.modelID)))) throw new Error();
      return { version: 2, credentials: credentials as Record<string, string>, ...(data.models ? { models: data.models } : {}) };
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { version: 2, credentials: {} };
      throw new JudgmentExecutionError("provider-unavailable");
    }
  };
  const write = (ctx: JudgmentServerContext, next: Saved) => atomicWriteSync(path(ctx), JSON.stringify(next), 0o600);
  const handles = (ctx: JudgmentServerContext) => host.services.get(SPACE_SECURE_SAFE)?.forSpace(ctx.space).list()
    .filter((entry) => entry.scope !== "project" || entry.projectId === ctx.projectId).map(({ handle, label }) => ({ handle, label })) ?? [];
  /** A route is ready when it needs no credential, or its saved handle still resolves in this Space and project. */
  const ready = (ctx: JudgmentServerContext, route: JevRoute, credentials = saved(ctx).credentials, known = handles(ctx)) =>
    route.credential === "none" || (!!credentials[route.provider.id] && known.some((entry) => entry.handle === credentials[route.provider.id]));
  const modelsFor = (ctx: JudgmentServerContext) => {
    const discovered = catalogs.get(key(ctx)) ?? saved(ctx).models;
    return JEV_ROUTES.flatMap((route) => route.discovery && discovered ? discovered : [routeModel(route)]);
  };
  const automatic = (ctx: JudgmentServerContext) => {
    const credentials = saved(ctx).credentials, known = handles(ctx);
    return JEV_ROUTES.find((route) => route.automatic && ready(ctx, route, credentials, known)) ?? JEV_ROUTES[0]!;
  };
  const options = (ctx: JudgmentServerContext): JevJudgmentAdapterOptions => ({
    models: modelsFor(ctx),
    automaticProviderId: automatic(ctx).provider.id,
    async withCredential(use, route) {
      // Revalidate at use time: a saved handle or runtime never grants cross-Space/project authority.
      if (!await host.forSpace(ctx.space).projects.get(ctx.projectId)) throw new JudgmentExecutionError("provider-unavailable");
      const secretHandle = saved(ctx).credentials[route.provider.id];
      const vault = host.services.get(SPACE_SECURE_SAFE)?.forSpace(ctx.space);
      if (!secretHandle || !vault?.useCredential) throw new JudgmentExecutionError("provider-unavailable");
      let entered = false;
      try { await vault.useCredential({ projectId: ctx.projectId, handle: secretHandle }, async (secret) => { entered = true; await use(secret); }); }
      catch (error) { if (entered || error instanceof JudgmentExecutionError) throw error; throw new JudgmentExecutionError("provider-unavailable"); }
    },
  });
  return {
    remoteAccess: localOnlyRemoteAccess(["judgment-jev"]),
    onEnable() {
      if (unregister) return;
      const judgment = host.services.get(JUDGMENT_SERVICE);
      if (!judgment) return;
      unregister = judgment.registerEngine({
        metadata: JEV_ENGINE_METADATA,
        create: (ctx) => createJevJudgmentEngine(options(ctx)),
        catalog(ctx) {
          const credentials = saved(ctx).credentials, known = handles(ctx), models = modelsFor(ctx);
          return JEV_ROUTES.map((route) => {
            const connected = ready(ctx, route, credentials, known);
            return { provider: { ...route.provider }, status: connected ? "available" : "authentication-required",
              description: route.description, credential: route.credential, endpoint: new URL(route.baseURL).host,
              automatic: route.automatic, discovery: route.discovery,
              models: models.filter((model) => model.providerID === route.provider.id).map((model) => ({ ...model, connected })) };
          });
        },
        settings(ctx) {
          const credentials = saved(ctx).credentials;
          return { secretHandle: credentials[JEV_PROVIDER.id], credentials, handles: handles(ctx) };
        },
        async configure(ctx, settings) {
          if (!await host.forSpace(ctx.space).projects.get(ctx.projectId)) throw new JudgmentExecutionError("provider-unavailable");
          const route = jevRoute(settings.providerId ?? JEV_PROVIDER.id);
          if (route?.credential !== "required") throw new JudgmentExecutionError("provider-unavailable");
          if (settings.secretHandle && !handles(ctx).some((entry) => entry.handle === settings.secretHandle)) throw new JudgmentExecutionError("provider-unavailable");
          const current = saved(ctx), { [route.provider.id]: _previous, ...rest } = current.credentials;
          const credentials = settings.secretHandle ? { ...rest, [route.provider.id]: settings.secretHandle } : rest;
          // A new account may see different models: the TypeSafe catalog belongs to the credential that listed it.
          const keepModels = !route.discovery && current.models;
          write(ctx, { version: 2, credentials, ...(keepModels ? { models: current.models } : {}) });
          if (route.discovery) { catalogs.delete(key(ctx)); revisions.set(key(ctx), (revisions.get(key(ctx)) ?? 0) + 1); }
        },
        async refresh(ctx, signal, providerId) {
          const route = jevRoute(providerId ?? JEV_PROVIDER.id);
          if (!route) throw new JudgmentExecutionError("provider-unavailable");
          if (!route.discovery) return;
          const id = key(ctx), revision = (revisions.get(id) ?? 0) + 1;
          revisions.set(id, revision);
          const models = await discoverJevModels(options(ctx), signal, route.provider.id);
          if (!signal.aborted && revisions.get(id) === revision) {
            write(ctx, { ...saved(ctx), models });
            catalogs.set(id, models);
          }
        },
      });
    },
    onDisable() { unregister?.(); unregister = undefined; catalogs.clear(); revisions.clear(); },
  };
}
