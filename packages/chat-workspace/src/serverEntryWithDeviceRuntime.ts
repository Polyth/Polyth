import type { Server } from "node:http";
import type { ProfileRegistry } from "@polyth/browser";
import {
  serverServiceKey,
  type HttpServerContext,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import registerChatWorkspace from "./serverEntry.ts";
import type { ChatWorkspaceService } from "./service.ts";
import {
  createChatWorkspaceDeviceRuntimeRegistry,
  type ChatWorkspaceDeviceRuntimeRegistry,
} from "./deviceRuntimeRegistry.ts";
import { attachChatWorkspaceDeviceRuntimeWs } from "./deviceRuntimeWs.ts";
import { createChatWorkspaceLocalRuntimeRouter } from "./localRuntimeRoutes.ts";
import { createChatWorkspaceProviderActionRouter } from "./providerActionRoutes.ts";
import { loadProjectRuntimeBinding } from "./runtimeBinding.ts";
import { selectChatWorkspaceRuntime, type ChatWorkspaceRuntimeCapability } from "./runtime.ts";

export const chatWorkspaceDeviceRuntimeServiceKey =
  serverServiceKey<ChatWorkspaceDeviceRuntimeRegistry>("chat-workspace.device-runtime");

const STATUS: Record<string, number> = {
  "not-found": 404,
  "invalid-input": 400,
  unavailable: 503,
  timeout: 504,
  forbidden: 403,
  conflict: 409,
  "runtime-timeout": 504,
  "runtime-disconnected": 503,
  "local-runtime-only": 409,
  "desktop-runtime-unavailable": 503,
};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const base = registerChatWorkspace(host);
  const service = host.services.require(serverServiceKey<ChatWorkspaceService>("chat-workspace"));
  const remoteProfiles = host.services.get(serverServiceKey<ProfileRegistry>("browser.profiles")) ?? null;
  const registry = createChatWorkspaceDeviceRuntimeRegistry();
  host.services.provide(chatWorkspaceDeviceRuntimeServiceKey, registry);
  const localRouter = createChatWorkspaceLocalRuntimeRouter({
    host,
    service,
    remoteProfiles,
    registry,
  });
  const providerActionRouter = createChatWorkspaceProviderActionRouter({ host, service, registry });

  const contexts = new Set<HttpServerContext>();
  const attached = new Map<Server, () => void>();
  let enabled = false;

  const attach = (ctx: HttpServerContext): void => {
    if (attached.has(ctx.server)) return;
    const stop = attachChatWorkspaceDeviceRuntimeWs(ctx.server, {
      registry,
      authorize: ctx.authorize,
      identity: ctx.identity,
      refreshPrincipal: ctx.refreshPrincipal,
      pairedSockets: ctx.pairedSockets,
    });
    attached.set(ctx.server, stop);
  };

  const stopWorkers = (): void => {
    for (const stop of attached.values()) stop();
    attached.clear();
  };

  const projectIdFor = (request: Parameters<NonNullable<ServerPackage["routes"]>>[0]): string | null => {
    const pathMatch = request.path.match(/^\/api\/chat-workspace\/projects\/([^/]+)/);
    if (pathMatch?.[1]) return pathMatch[1];
    return request.url.searchParams.get("projectId");
  };

  const waitingForDesktop = async (
    request: Parameters<NonNullable<ServerPackage["routes"]>>[0],
  ): Promise<boolean> => {
    // Contributed routes see every request, so the gate must never answer for
    // another package's path (e.g. `/api/worktrees?projectId=…`).
    if (!request.path.startsWith("/api/chat-workspace/")) return false;
    const projectId = projectIdFor(request);
    if (!projectId) return false;
    const storage = host.spaceStorage(request.space);
    const binding = await loadProjectRuntimeBinding(storage, projectId);
    const remote = service.capability();
    const candidates: ChatWorkspaceRuntimeCapability[] = [
      ...registry.capabilities(),
      {
        kind: "server-remote",
        available: remote.available,
        ...(remote.reason ? { reason: remote.reason } : {}),
        localRendering: false,
        localProfileState: false,
      },
    ];
    return selectChatWorkspaceRuntime(candidates, binding.preference).waitingForDevice;
  };

  host.onHttpServer((ctx) => {
    contexts.add(ctx);
    if (enabled) attach(ctx);
  });

  return {
    ...base,
    routes: async (request) => {
      try {
        if (request.path === "/api/chat-workspace/device-runtimes" && request.method === "GET") {
          request.json(200, { runtimes: registry.capabilities() });
          return true;
        }
        if (await providerActionRouter.routes(request)) return true;
        if (await localRouter.routes(request)) return true;
        if (await waitingForDesktop(request)) {
          request.json(503, {
            error: "desktop-runtime-unavailable",
            message: "Chat Workspace is waiting for the selected Desktop browser runtime. Remote fallback is disabled.",
          });
          return true;
        }
        return base.routes ? base.routes(request) : false;
      } catch (error) {
        const failure = error as Error & { code?: string };
        request.json(STATUS[failure.code ?? ""] ?? 500, {
          error: failure.code ?? "internal",
          message: failure.message,
        });
        return true;
      }
    },
    async onEnable() {
      await base.onEnable?.();
      enabled = true;
      for (const ctx of contexts) attach(ctx);
    },
    async onDisable() {
      enabled = false;
      stopWorkers();
      await base.onDisable?.();
    },
    async stopIngress() {
      enabled = false;
      stopWorkers();
      providerActionRouter.dispose();
      localRouter.dispose();
      await base.stopIngress?.();
    },
  };
}
