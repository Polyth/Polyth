import { deriveProviderStatus, type AgentRuntime, type HarnessConfigurationMetadata, type HarnessContext, type HarnessProvider, type HarnessProvisioningQuery, type HarnessRegistry, type ModelDescriptor, type RouteHandler, type RouteRequest, type SpaceContext } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackageHost,
} from "@polyth/plugins";
import { configureOpenCodeCapabilityDelivery } from "./capabilityDelivery.ts";
import { createOpenCodeHarness } from "./harness.ts";
import { FREE_PICK_PROVIDER_ID } from "./freeModelPicks.ts";
import { configureFreeModelUtility } from "./freeModelEvidence.ts";
import { createOpenCodeNativePlugins } from "./nativePlugins.ts";
import { createOpenCodeProvisioner } from "./provisioner.ts";
import type { BackendConfigApplier } from "./config.ts";
import { createProviderAuthController } from "./providerAuth.ts";
import { providerAuthRoutes } from "./providerAuthRoutes.ts";
import { localOpenCodeAuthContext } from "./providerAuthTarget.ts";

/** A bundled (downloaded) OpenCode is Polyth's automatic fallback runtime, not
 *  a harness the user installed and authorized on the host. Registering it with
 *  a lower Auto priority lets the registry probe the host's own enabled,
 *  authenticated harnesses first and keep this runtime for when none is
 *  runnable. An explicit pin or a saved preference still overrides it. */
const BUNDLED_OPENCODE_FALLBACK_PRIORITY = 1000;

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
  let registration: ReturnType<HarnessRegistry["register"]> | undefined;
  let restart: { dispose(): void } | undefined;
  let openCodeRuntime: ((space: SpaceContext) => Promise<AgentRuntime>) | undefined;
  let authRoutes: RouteHandler | undefined;
  let freeModelUtility: { dispose(): void } | undefined;
  let admin: {
    catalog?: { invalidateModels(): void; models(): Promise<ModelDescriptor[]> };
    visibility?: {
      catalog(models: ModelDescriptor[], userId?: string): Array<{ id: string; connected: boolean }>;
      available(
        models: ModelDescriptor[],
        live: readonly import("@polyth/contracts").AvailableProviderDescriptor[],
        authMethodIds: readonly string[],
      ): import("@polyth/contracts").AvailableProviderDescriptor[];
      seed?(): Promise<void>;
    };
  } | undefined;
  return {
    remoteAccess: localOnlyRemoteAccess(["backend-opencode"]),
    routes: async (request: RouteRequest) => {
      if (!authRoutes || !openCodeRuntime || !admin) return false;
      // OpenCode provider administration must not wait for generic multi-harness
      // catalog aggregation. Query the host-global OpenCode authority directly.
      if (request.path === "/api/opencode/providers" && request.method === "GET") {
        if (request.url.searchParams.get("refresh") === "1") admin.catalog?.invalidateModels();
        await admin.visibility?.seed?.();
        const runtime = await openCodeRuntime(request.space);
        // Free auto-picks route to models listed under their real provider;
        // they are not a provider anyone administers.
        const models = (await runtime.models())
          .filter((model) => model.providerID !== FREE_PICK_PROVIDER_ID)
          .map((model) => ({
            ...model,
            harnessId: "opencode",
          }));
        request.json(200, admin.visibility?.catalog(models, request.space.userId) ?? catalogFromOpenCodeModels(models));
        return true;
      }
      return authRoutes(request);
    },
    onEnable() {
      if (registration) return;
      const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
      const pool = host.services.require(
        serverServiceKey<(context: HarnessContext) => Promise<AgentRuntime>>("opencode.runtime"),
      );
      const releaseExecution = host.services.get(
        serverServiceKey<NonNullable<HarnessProvider["releaseExecution"]>>("opencode.runtime.release-execution"),
      );
      const binarySource = host.services.get(
        serverServiceKey<"bundled" | "configured">("opencode.binary-source"),
      );
      const events = host.services.get(serverServiceKey<{
        onRestart(listener: (runtime: AgentRuntime) => void | Promise<void>): { dispose(): void };
      }>("opencode.runtime.events"));
      const catalog = host.services.get(serverServiceKey<{
        invalidateModels(): void;
        models(): Promise<ModelDescriptor[]>;
      }>("runtime.catalog"));
      const visibility = host.services.get(serverServiceKey<{
        catalog(models: ModelDescriptor[], userId?: string): Array<{ id: string; connected: boolean }>;
        available(
          models: ModelDescriptor[],
          live: readonly import("@polyth/contracts").AvailableProviderDescriptor[],
          authMethodIds: readonly string[],
        ): import("@polyth/contracts").AvailableProviderDescriptor[];
        seed?(): Promise<void>;
      }>("models.visibility"));
      const resolvedAdmin = {
        ...(catalog ? { catalog } : {}),
        ...(visibility ? { visibility } : {}),
      };
      const runtime = async (context: HarnessContext): Promise<AgentRuntime> => {
        const engine = await pool(context);
        if (!context.remote) configureOpenCodeCapabilityDelivery(engine, context);
        return engine;
      };
      const runtimeForSpace = (space: SpaceContext): Promise<AgentRuntime> =>
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
        return runtimeForSpace(context.space);
      }, async (context) => {
        const queueStatus = host.services.get(serverServiceKey<(target: HarnessContext) => HarnessConfigurationMetadata | undefined>("opencode.configuration-status"));
        const queued = queueStatus?.(context);
        if (queued) return queued;
        // Hosted and remote targets cannot read the local deployment-global queue.
        // Fall back to the scoped capability records, still without constructing
        // OpenCode, so pending state remains Space/project isolated.
        const query = host.services.get(serverServiceKey<HarnessProvisioningQuery>("harness.provisioning"));
        if (!query) return {};
        const records = query.status(context, "opencode").flatMap((row) => row.records);
        const pending = records.filter((record) => record.status === "pending" || record.status === "pending-restart");
        return {
          pendingChanges: pending.length,
          restartRequired: pending.some((record) => record.status === "pending-restart"),
        };
      });
      // The downloaded runtime is the automatic baseline, not a reason to ignore
      // a harness the user already installed and authorized in the system.
      if (binarySource === "bundled") harness.descriptor.priority = BUNDLED_OPENCODE_FALLBACK_PRIORITY;
      const applier = host.services.get(serverServiceKey<BackendConfigApplier>("plugins.config"));
      if (applier && typeof applier.applyBehavior === "function" && typeof applier.applyMcp === "function") {
        harness.provisioner = createOpenCodeProvisioner(applier);
      }
      // The same deferred applier as the legacy plugin route, so native plugin
      // changes share its pending-restart staging.
      if (applier && typeof applier.listPlugins === "function" && typeof applier.applyPlugins === "function"
        && typeof applier.removePlugin === "function") {
        harness.plugins = createOpenCodeNativePlugins({ harnessId: harness.descriptor.id, config: applier });
      }
      const auth = createProviderAuthController({
        runtime: runtimeForSpace,
        invalidateModels: () => resolvedAdmin.catalog?.invalidateModels(),
      });
      const enabledAuthRoutes = providerAuthRoutes({
        auth,
        runtime: runtimeForSpace,
        ...(resolvedAdmin.visibility ? { visibility: resolvedAdmin.visibility } : {}),
      });
      let restartSubscription: { dispose(): void } | undefined;
      try {
        restartSubscription = events?.onRestart?.(async (runtime) => {
          const endpoint = await runtime.endpoint?.();
          auth.notifyRuntimeChange(endpoint);
        });
        registration = registry.register(harness);
      } catch (error) {
        restartSubscription?.dispose();
        throw error;
      }
      admin = resolvedAdmin;
      // Free auto-picks measure models with ordinary host one-shot turns.
      freeModelUtility = configureFreeModelUtility((runtime, turn) => host.oneShot(runtime, {
        cwd: turn.cwd,
        prompt: turn.prompt,
        model: turn.model,
        purpose: turn.purpose,
        timeoutMs: turn.timeoutMs,
      }));
      openCodeRuntime = runtimeForSpace;
      authRoutes = enabledAuthRoutes;
      restart = restartSubscription;
    },
    async onDisable() {
      await registration?.dispose();
      registration = undefined;
      restart?.dispose();
      restart = undefined;
      freeModelUtility?.dispose();
      freeModelUtility = undefined;
      authRoutes = undefined;
      openCodeRuntime = undefined;
      admin = undefined;
    },
  };
}
