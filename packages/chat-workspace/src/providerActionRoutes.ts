import type { RouteHandler } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import type { ChatWorkspaceService } from "./service.ts";
import type {
  ChatWorkspaceDeviceEvent,
  ChatWorkspaceHandoffAction,
} from "./deviceRuntimeProtocol.ts";
import type { ChatWorkspaceDeviceRuntimeRegistry } from "./deviceRuntimeRegistry.ts";
import type { ExternalChatHandoff } from "./providerAdapters.ts";
import { loadProjectRuntimeBinding } from "./runtimeBinding.ts";
import { selectChatWorkspaceRuntime, type ChatWorkspaceRuntimeCapability } from "./runtime.ts";
import { loadWorkspace } from "./storage.ts";

const MAX_PENDING_PER_PROJECT = 64;
const ACTION_TTL_MS = 30 * 60_000;
const CLAIM_TTL_MS = 30_000;
const SAFE_CONSUMER = /^[A-Za-z0-9._:-]{1,200}$/;

interface PendingProviderAction {
  sequence: number;
  eventId: string;
  deviceId: string;
  action: ChatWorkspaceHandoffAction;
  handoff: ExternalChatHandoff;
  createdAt: number;
  claimedBy?: string;
  claimUntil?: number;
}

export interface ChatWorkspaceProviderActionRouter {
  routes: RouteHandler;
  dispose(): void;
}

export function createChatWorkspaceProviderActionRouter(deps: {
  host: ServerPackageHost;
  service: ChatWorkspaceService;
  registry: ChatWorkspaceDeviceRuntimeRegistry;
}): ChatWorkspaceProviderActionRouter {
  const { host, service, registry } = deps;
  const pending = new Map<string, PendingProviderAction[]>();
  let nextSequence = 0;

  const queueKey = (deviceId: string, projectId: string): string => `${deviceId}:${projectId}`;

  const prune = (key: string, now = Date.now()): PendingProviderAction[] => {
    const list = (pending.get(key) ?? []).filter((item) => now - item.createdAt <= ACTION_TTL_MS);
    if (list.length === 0) pending.delete(key);
    else pending.set(key, list);
    return list;
  };

  const consumerId = (request: Parameters<RouteHandler>[0]): string | null => {
    const value = request.url.searchParams.get("consumerId")?.trim() ?? "";
    return SAFE_CONSUMER.test(value) ? value : null;
  };

  const selectedDesktopDevice = async (
    request: Parameters<RouteHandler>[0],
    projectId: string,
  ): Promise<string | null> => {
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
    const selection = selectChatWorkspaceRuntime(candidates, binding.preference).selected;
    return selection?.kind === "desktop-local" ? selection.deviceId ?? null : null;
  };

  const eventSub = registry.onEvent((deviceId, event: ChatWorkspaceDeviceEvent) => {
    if (event.kind !== "handoff") return;
    const key = queueKey(deviceId, event.handoff.projectId);
    const list = prune(key);
    if (list.some((item) => item.eventId === event.eventId)) return;
    nextSequence += 1;
    list.push({
      sequence: nextSequence,
      eventId: event.eventId,
      deviceId,
      action: event.action,
      handoff: event.handoff,
      createdAt: Date.now(),
    });
    if (list.length > MAX_PENDING_PER_PROJECT) list.splice(0, list.length - MAX_PENDING_PER_PROJECT);
    pending.set(key, list);
  });

  const routes: RouteHandler = async (request) => {
    let match = request.path.match(/^\/api\/chat-workspace\/projects\/([^/]+)\/provider-actions$/);
    if (match && request.method === "GET") {
      const projectId = match[1]!;
      const consumer = consumerId(request);
      if (!consumer) {
        request.json(400, { error: "invalid-input", message: "consumerId required" });
        return true;
      }
      const spaces = host.forSpace(request.space);
      const project = await spaces.projects.get(projectId);
      if (!project) {
        request.json(404, { error: "not-found", message: "project not found" });
        return true;
      }
      const deviceId = await selectedDesktopDevice(request, projectId);
      if (!deviceId) {
        request.json(200, { actions: [] });
        return true;
      }
      const workspace = await loadWorkspace(host.spaceStorage(request.space), projectId);
      const validTabs = new Map(workspace.tabs.map((tab) => [tab.id, tab.profileId]));
      const now = Date.now();
      const actions = prune(queueKey(deviceId, projectId), now)
        .filter((item) => validTabs.get(item.handoff.tabId) === item.handoff.profileId)
        .filter((item) => !item.claimedBy || item.claimedBy === consumer || (item.claimUntil ?? 0) <= now)
        .slice(0, 20);
      for (const item of actions) {
        item.claimedBy = consumer;
        item.claimUntil = now + CLAIM_TTL_MS;
      }
      request.json(200, {
        actions: actions.map(({ claimedBy: _claimedBy, claimUntil: _claimUntil, ...item }) => item),
      });
      return true;
    }

    match = request.path.match(/^\/api\/chat-workspace\/projects\/([^/]+)\/provider-actions\/([^/]+)\/ack$/);
    if (match && request.method === "POST") {
      const projectId = match[1]!;
      const eventId = match[2]!;
      const consumer = consumerId(request);
      if (!consumer) {
        request.json(400, { error: "invalid-input", message: "consumerId required" });
        return true;
      }
      const spaces = host.forSpace(request.space);
      const project = await spaces.projects.get(projectId);
      if (!project) {
        request.json(404, { error: "not-found", message: "project not found" });
        return true;
      }
      const deviceId = await selectedDesktopDevice(request, projectId);
      if (!deviceId) {
        request.json(409, { error: "runtime-changed", message: "Desktop runtime is no longer selected" });
        return true;
      }
      const key = queueKey(deviceId, projectId);
      const list = prune(key);
      const index = list.findIndex((item) => item.eventId === eventId);
      if (index >= 0) {
        const item = list[index]!;
        if (item.claimedBy && item.claimedBy !== consumer && (item.claimUntil ?? 0) > Date.now()) {
          request.json(409, { error: "action-claimed", message: "Provider action is claimed by another Polyth client" });
          return true;
        }
        list.splice(index, 1);
      }
      if (list.length === 0) pending.delete(key);
      else pending.set(key, list);
      request.json(200, { ok: true });
      return true;
    }

    return false;
  };

  return {
    routes,
    dispose() {
      eventSub.dispose();
      pending.clear();
    },
  };
}
