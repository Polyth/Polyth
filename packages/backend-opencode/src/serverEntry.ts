import { deriveProviderStatus, type AgentRuntime, type HarnessContext, type HarnessProvider, type HarnessRegistry, type ModelDescriptor, type RouteRequest, type SpaceContext } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackageHost,
} from "@polyth/plugins";
import { configureOpenCodeCapabilityDelivery } from "./capabilityDelivery.ts";
import { createOpenCodeHarness } from "./harness.ts";
import { createOpenCodeProvisioner } from "./provisioner.ts";
import type { BackendConfigApplier } from "./config.ts";
import { createProviderAuthController } from "./providerAuth.ts";
import { providerAuthRoutes } from "./providerAuthRoutes.ts";
import { localOpenCodeAuthContext } from "./providerAuthTarget.ts";

/** Last-resort grouping when visibility is not on the service seam. Never
 *  drop a live OpenCode catalog into `[]` — that reads as "no models" in UI. */
export function catalogFromOpenCodeModels(models: ModelDescriptor[]) {
  const byProvider = new Map<string, {
    id: string;
    name: string;
    origin: "builtin";
    enabled: boolean;
    configured: boolean;
    editable: boolean;
    removable: boolean;
    status: ReturnType<typeof deriveProviderStatus>;
    hasCredential: boolean;
    connected: boolean;
    models: Array<{
      providerID: string;
      modelID: string;
      key: string;
      name: string;
      providerName?: string;
      context?: number;
      connected: boolean;
      enabled: boolean;
    }>;
  }>();
  for (const model of models) {
    if (model.connected === false) continue;
    const id = model.providerID;
    let entry = byProvider.get(id);
    if (!entry) {
      entry = {
        id,
        name: model.providerName ?? id,
        origin: "builtin",
        enabled: true,
        configured: true,
        editable: false,
        removable: false,
        status: "ready",
        hasCredential: false,
        connected: true,
        models: [],
      };
      byProvider.set(id, entry);
    }
    const key = `${model.providerID}/${model.modelID}`;
    if (entry.models.some((item) => item.key === key)) continue;
    entry.models.push({
      providerID: model.providerID,
      modelID: model.modelID,
      key,
      name: model.name || model.modelID,
      ...(model.providerName ? { providerName: model.providerName } : {}),
      ...(model.context !== undefined ? { context: model.context } : {}),
      connected: true,
      enabled: true,
    });
  }
  return [...byProvider.values()].map((entry) => ({
    ...entry,
    status: deriveProviderStatus({
      enabled: entry.enabled,
      configured: entry.configured,
      hasCredential: entry.hasCredential,
      connected: entry.connected,
    }),
  }));
}

export default function registerPackage(host: ServerPackageHost) {
  const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
  const pool = host.services.require(
    serverServiceKey<(context: HarnessContext) => Promise<AgentRuntime>>("opencode.runtime"),
  );
  const releaseExecution = host.services.get(
    serverServiceKey<NonNullable<HarnessProvider["releaseExecution"]>>("opencode.runtime.release-execution"),
  );
  const events = host.services.get(serverServiceKey<{
    onRestart(listener: (runtime: AgentRuntime) => void | Promise<void>): { dispose(): void };
  }>("opencode.runtime.events"));
  const catalog = host.services.get(serverServiceKey<{
    invalidateModels(): void;
    models(): Promise<ModelDescriptor[]>;
  }>("runtime.catalog"));
  const visibility = host.services.get(serverServiceKey<{
    catalog(models: ModelDescriptor[]): Array<{ id: string; connected: boolean }>;
    available(
      models: ModelDescriptor[],
      live: readonly import("@polyth/contracts").AvailableProviderDescriptor[],
      authMethodIds: readonly string[],
    ): import("@polyth/contracts").AvailableProviderDescriptor[];
    seed?(): Promise<void>;
  }>("models.visibility"));

  const runtime = async (context: HarnessContext): Promise<AgentRuntime> => {
    const engine = await pool(context);
    if (!context.remote) configureOpenCodeCapabilityDelivery(engine, context);
    return engine;
  };
  const openCodeRuntime = (space: SpaceContext): Promise<AgentRuntime> =>
    pool(localOpenCodeAuthContext(space, host.storageDir));
  const harness = createOpenCodeHarness(runtime, releaseExecution, (context, primaryError) => {
    // This sentinel has its own pool key, runtime directory and authority
    // state. It can enumerate host-global OpenCode providers when a project
    // executor remains correctly fenced by an unverified release. Never use a
    // local catalog as evidence about a remote host, and never let this seam
    // participate in execution/session creation.
    if (
      context.remote
      || !context.space
      || (primaryError as { code?: string })?.code !== "outcome-unknown"
    ) throw primaryError;
    return openCodeRuntime(context.space);
  });
  const applier = host.services.get(serverServiceKey<BackendConfigApplier>("plugins.config"));
  if (applier && typeof applier.applyBehavior === "function" && typeof applier.applyMcp === "function") {
    harness.provisioner = createOpenCodeProvisioner(applier);
  }
  const registration = registry.register(harness);
  const auth = createProviderAuthController({
    runtime: openCodeRuntime,
    invalidateModels: () => catalog?.invalidateModels(),
  });
  const authRoutes = providerAuthRoutes({
    auth,
    runtime: openCodeRuntime,
    ...(catalog ? { catalog } : {}),
    ...(visibility ? { visibility } : {}),
  });
  const restart = events?.onRestart?.(async (runtime) => {
    const endpoint = await runtime.endpoint?.();
    auth.notifyRuntimeChange(endpoint);
  });

  return {
    remoteAccess: localOnlyRemoteAccess(["backend-opencode"]),
    routes: async (request: RouteRequest) => {
      // OpenCode provider administration must not wait for generic multi-harness
      // catalog aggregation. Query the host-global OpenCode authority directly.
      if (request.path === "/api/opencode/providers" && request.method === "GET") {
        if (request.url.searchParams.get("refresh") === "1") catalog?.invalidateModels();
        await visibility?.seed?.();
        const runtime = await openCodeRuntime(request.space);
        const models = (await runtime.models()).map((model) => ({
          ...model,
          harnessId: "opencode",
        }));
        request.json(200, visibility?.catalog(models) ?? catalogFromOpenCodeModels(models));
        return true;
      }
      return authRoutes(request);
    },
    onDisable: () => {
      restart?.dispose();
      registration.dispose();
    },
  };
}
