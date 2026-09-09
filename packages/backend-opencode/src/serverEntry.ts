import type { AgentRuntime, HarnessContext, HarnessProvider, HarnessRegistry, ModelDescriptor, SpaceContext } from "@polyth/contracts";
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
  }>("models.visibility"));

  const runtime = async (context: HarnessContext): Promise<AgentRuntime> => {
    const engine = await pool(context);
    if (!context.remote) configureOpenCodeCapabilityDelivery(engine, context);
    return engine;
  };
  const harness = createOpenCodeHarness(runtime, releaseExecution);
  const applier = host.services.get(serverServiceKey<BackendConfigApplier>("plugins.config"));
  if (applier && typeof applier.applyBehavior === "function" && typeof applier.applyMcp === "function") {
    harness.provisioner = createOpenCodeProvisioner(applier);
  }
  const registration = registry.register(harness);
  const openCodeRuntime = (space: SpaceContext): Promise<AgentRuntime> =>
    pool(localOpenCodeAuthContext(space, host.storageDir));
  const auth = createProviderAuthController({
    runtime: openCodeRuntime,
    invalidateModels: () => catalog?.invalidateModels(),
  });
  const restart = events?.onRestart?.(async (runtime) => {
    const endpoint = await runtime.endpoint?.();
    auth.notifyRuntimeChange(endpoint);
  });

  return {
    remoteAccess: localOnlyRemoteAccess(["backend-opencode"]),
    routes: providerAuthRoutes({
      auth,
      runtime: openCodeRuntime,
      ...(catalog ? { catalog } : {}),
      ...(visibility ? { visibility } : {}),
    }),
    onDisable: () => {
      restart?.dispose();
      registration.dispose();
    },
  };
}
