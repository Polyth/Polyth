import type {
  ChatProfileDto,
  ChatTabDto,
  ChatTabStateDto,
  ChatWorkspaceDto,
  JsonObject,
  RouteHandler,
  SpaceStorage,
} from "@polyth/contracts";
import type { ProfileRegistry } from "@polyth/browser";
import {
  MANUAL_ONLY_POLICY,
  checkUrl,
  isInternalBrowserUrl,
  newChatTabId,
  originOf,
} from "@polyth/browser";
import type { ServerPackageHost } from "@polyth/plugins";
import type { ChatWorkspaceService } from "./service.ts";
import type { ChatWorkspaceDeviceRuntimeRegistry } from "./deviceRuntimeRegistry.ts";
import {
  loadProjectRuntimeBinding,
  normalizeRuntimePreference,
  saveProjectRuntimeBinding,
} from "./runtimeBinding.ts";
import { selectChatWorkspaceRuntime, type ChatWorkspaceRuntimeCapability } from "./runtime.ts";
import { providerById } from "./providers.ts";
import {
  loadProfile,
  loadWorkspace,
  saveProfile,
  saveWorkspace,
} from "./storage.ts";

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const allowedOriginsFor = (profile: ChatProfileDto): string[] => {
  const provider = providerById(profile.providerId);
  const origins = [...(provider?.allowedOrigins ?? [])];
  const seed = profile.customUrl ?? provider?.homeUrl;
  if (seed && !/^about:/i.test(seed)) {
    const origin = originOf(seed);
    if (origin && !origins.some((item) => item.toLowerCase() === origin.toLowerCase())) origins.push(origin);
  }
  return origins;
};

const validateProfileUrl = async (profile: ChatProfileDto, raw: string): Promise<string> => {
  const provider = providerById(profile.providerId);
  const target = raw || profile.customUrl || provider?.homeUrl || "about:blank";
  if (isInternalBrowserUrl(target)) return target;
  const decision = await checkUrl(target, {
    allowedOrigins: allowedOriginsFor(profile),
    approvedOrigins: new Set(profile.approvedOrigins),
    privateNetwork: "explicit-only",
  });
  if (!decision.ok) throw err(decision.code, decision.reason);
  return target;
};

export interface ChatWorkspaceLocalRuntimeRouter {
  routes: RouteHandler;
  dispose(): void;
}

export function createChatWorkspaceLocalRuntimeRouter(deps: {
  host: ServerPackageHost;
  service: ChatWorkspaceService;
  remoteProfiles: ProfileRegistry | null;
  registry: ChatWorkspaceDeviceRuntimeRegistry;
}): ChatWorkspaceLocalRuntimeRouter {
  const { host, service, registry } = deps;
  const projectStorages = new Map<string, SpaceStorage>();
  const latestStates = new Map<string, ChatTabStateDto>();

  const remoteCapability = (): ChatWorkspaceRuntimeCapability => {
    const cap = service.capability();
    return {
      kind: "server-remote",
      available: cap.available,
      ...(cap.reason ? { reason: cap.reason } : {}),
      localRendering: false,
      localProfileState: false,
    };
  };

  const runtimeState = async (storage: SpaceStorage, projectId: string) => {
    const binding = await loadProjectRuntimeBinding(storage, projectId);
    const candidates = [...registry.capabilities(), remoteCapability()];
    const selection = selectChatWorkspaceRuntime(candidates, binding.preference);
    return { binding, candidates, selection };
  };

  const localDeviceFor = async (storage: SpaceStorage, projectId: string): Promise<string | null> => {
    const state = await runtimeState(storage, projectId);
    if (state.selection.selected?.kind === "desktop-local") {
      const deviceId = state.selection.selected.deviceId;
      if (!deviceId) throw err("unavailable", "selected Desktop runtime has no device identity");
      return deviceId;
    }
    if (state.selection.selected?.kind === "server-remote") return null;
    if (state.binding.preference.allowRemoteFallback || state.binding.preference.mode === "remote") {
      const remote = state.candidates.find((candidate) => candidate.kind === "server-remote");
      throw err(
        "desktop-runtime-unavailable",
        `No browser runtime is available: no Desktop runtime is connected and the remote browser is unavailable${remote?.reason ? ` (${remote.reason})` : ""}.`,
      );
    }
    throw err("desktop-runtime-unavailable", "Chat Workspace is waiting for the selected Desktop browser runtime. Remote fallback is disabled.");
  };

  const rememberProject = (deviceId: string, projectId: string, storage: SpaceStorage): void => {
    projectStorages.set(`${deviceId}:${projectId}`, storage);
  };

  const dispatch = async (
    deviceId: string,
    command: Parameters<ChatWorkspaceDeviceRuntimeRegistry["dispatch"]>[1],
  ): Promise<void> => {
    const ack = await registry.dispatch(deviceId, command);
    if (!ack.ok) throw err(ack.code ?? "runtime-error", ack.message ?? "Desktop runtime rejected command");
  };

  const dispatchProfile = async (deviceId: string, profile: ChatProfileDto): Promise<void> => {
    const provider = providerById(profile.providerId);
    const homeUrl = await validateProfileUrl(profile, profile.customUrl ?? provider?.homeUrl ?? "about:blank");
    await dispatch(deviceId, {
      kind: "profile.ensure",
      profileId: profile.id,
      providerId: profile.providerId,
      homeUrl,
      allowedOrigins: allowedOriginsFor(profile),
      approvedOrigins: profile.approvedOrigins,
    });
  };

  const dispatchTab = async (deviceId: string, projectId: string, tab: ChatTabDto): Promise<void> => {
    await dispatch(deviceId, {
      kind: "tab.ensure",
      projectId,
      tab: {
        id: tab.id,
        profileId: tab.profileId,
        url: tab.url,
        pinned: tab.pinned,
      },
    });
  };

  const updateTabState = async (deviceId: string, event: Extract<Parameters<Parameters<typeof registry.onEvent>[0]>[1], { kind: "tab.state" }>) => {
    const storage = projectStorages.get(`${deviceId}:${event.projectId}`);
    if (!storage) return;
    const workspace = await loadWorkspace(storage, event.projectId);
    const tab = workspace.tabs.find((item) => item.id === event.tabId);
    if (!tab) return;
    tab.url = event.url;
    tab.title = event.title || tab.title;
    tab.hibernated = event.hibernated;
    tab.lastActiveAt = Date.now();
    latestStates.set(event.tabId, {
      tab: { ...tab },
      loading: event.loading,
      canGoBack: true,
      canGoForward: true,
      pendingApproval: null,
      pendingPopups: [],
      pendingFileChooser: false,
      hibernated: event.hibernated,
      crashed: false,
      unreachable: false,
      profileRestarted: false,
      downloadBlocked: false,
      liveTabCount: workspace.tabs.filter((item) => !item.hibernated).length,
    });
    await saveWorkspace(storage, event.projectId, workspace);
  };

  const eventSub = registry.onEvent((deviceId, event) => {
    if (event.kind === "tab.state") void updateTabState(deviceId, event).catch(() => {});
    if (event.kind === "tab.closed") latestStates.delete(event.tabId);
  });

  const routes: RouteHandler = async (request) => {
    if (!request.path.startsWith("/api/chat-workspace/")) return false;
    const { method, path, url, body, json, space } = request;
    const storage = host.spaceStorage(space);
    const spaces = host.forSpace(space);
    const q = (key: string) => url.searchParams.get(key) ?? "";

    let match = path.match(/^\/api\/chat-workspace\/projects\/([^/]+)\/runtime$/);
    if (match) {
      const projectId = match[1]!;
      const project = await spaces.projects.get(projectId);
      if (!project) throw err("not-found", "project not found");
      if (method === "GET") {
        const state = await runtimeState(storage, projectId);
        json(200, state);
        return true;
      }
      if (method === "PUT") {
        const input = await body();
        const preference = normalizeRuntimePreference(input);
        const saved = await saveProjectRuntimeBinding(storage, projectId, preference);
        const state = await runtimeState(storage, projectId);
        json(200, { ...state, binding: saved });
        return true;
      }
    }

    match = path.match(/^\/api\/chat-workspace\/projects\/([^/]+)\/workspace$/);
    if (match && method === "GET") {
      const projectId = match[1]!;
      const deviceId = await localDeviceFor(storage, projectId);
      if (!deviceId) return false;
      rememberProject(deviceId, projectId, storage);
      json(200, await loadWorkspace(storage, projectId));
      return true;
    }

    match = path.match(/^\/api\/chat-workspace\/projects\/([^/]+)\/tabs$/);
    if (match && method === "POST") {
      const projectId = match[1]!;
      const deviceId = await localDeviceFor(storage, projectId);
      if (!deviceId) return false;
      const project = await spaces.projects.get(projectId);
      if (!project) throw err("not-found", "project not found");
      const input = await body() as JsonObject;
      const profileId = String(input.profileId ?? "");
      const profile = await loadProfile(storage, space.userId, profileId);
      if (!profile) throw err("not-found", `profile ${profileId} not found`);
      const targetUrl = await validateProfileUrl(profile, String(input.url ?? ""));
      const provider = providerById(profile.providerId);
      const tab: ChatTabDto = {
        id: newChatTabId(),
        profileId,
        url: targetUrl,
        title: provider?.name ?? "Chat",
        pinned: false,
        lastActiveAt: Date.now(),
        hibernated: false,
        contentAccess: MANUAL_ONLY_POLICY,
      };
      rememberProject(deviceId, projectId, storage);
      await dispatchProfile(deviceId, profile);
      await dispatchTab(deviceId, projectId, tab);
      const workspace = await loadWorkspace(storage, projectId);
      workspace.tabs.push(tab);
      workspace.order.push(tab.id);
      workspace.activeTabId = tab.id;
      await saveWorkspace(storage, projectId, workspace);
      profile.lastUsedAt = Date.now();
      await saveProfile(storage, space.userId, profile);
      json(200, tab);
      return true;
    }

    match = path.match(/^\/api\/chat-workspace\/tabs\/([^/]+)\/state$/);
    if (match && method === "GET") {
      const tabId = match[1]!;
      const projectId = q("projectId");
      if (!projectId) throw err("invalid-input", "projectId required");
      const deviceId = await localDeviceFor(storage, projectId);
      if (!deviceId) return false;
      const workspace = await loadWorkspace(storage, projectId);
      const tab = workspace.tabs.find((item) => item.id === tabId);
      if (!tab) throw err("not-found", `tab ${tabId} not found`);
      rememberProject(deviceId, projectId, storage);
      json(200, latestStates.get(tabId) ?? {
        tab,
        loading: false,
        canGoBack: true,
        canGoForward: true,
        pendingApproval: null,
        pendingPopups: [],
        pendingFileChooser: false,
        hibernated: tab.hibernated,
        crashed: false,
        unreachable: false,
        profileRestarted: false,
        downloadBlocked: false,
        liveTabCount: workspace.tabs.filter((item) => !item.hibernated).length,
      } satisfies ChatTabStateDto);
      return true;
    }

    const tabDelete = path.match(/^\/api\/chat-workspace\/tabs\/([^/]+)$/);
    if (tabDelete && method === "DELETE") {
      const tabId = tabDelete[1]!;
      const projectId = q("projectId");
      const deviceId = projectId ? await localDeviceFor(storage, projectId) : null;
      if (!deviceId) return false;
      const workspace = await loadWorkspace(storage, projectId);
      const tab = workspace.tabs.find((item) => item.id === tabId);
      if (!tab) throw err("not-found", `tab ${tabId} not found`);
      await dispatch(deviceId, { kind: "tab.close", projectId, tabId });
      workspace.tabs = workspace.tabs.filter((item) => item.id !== tabId);
      workspace.order = workspace.order.filter((id) => id !== tabId);
      if (workspace.activeTabId === tabId) workspace.activeTabId = workspace.order[0] ?? null;
      latestStates.delete(tabId);
      await saveWorkspace(storage, projectId, workspace);
      json(200, workspace);
      return true;
    }

    const tabAction = path.match(/^\/api\/chat-workspace\/tabs\/([^/]+)\/([^/]+)$/);
    if (tabAction && method === "POST") {
      const tabId = tabAction[1]!;
      const action = tabAction[2]!;
      const input = await body() as JsonObject;
      const projectId = q("projectId") || String(input.projectId ?? "");
      if (!projectId) throw err("invalid-input", "projectId required");
      const deviceId = await localDeviceFor(storage, projectId);
      if (!deviceId) return false;
      rememberProject(deviceId, projectId, storage);
      const workspace = await loadWorkspace(storage, projectId);
      const tab = workspace.tabs.find((item) => item.id === tabId);
      if (!tab) throw err("not-found", `tab ${tabId} not found`);

      if (action === "activate") {
        await dispatchProfile(deviceId, (await loadProfile(storage, space.userId, tab.profileId)) ?? (() => { throw err("not-found", `profile ${tab.profileId} not found`); })());
        await dispatchTab(deviceId, projectId, tab);
        await dispatch(deviceId, { kind: "tab.activate", projectId, tabId });
        workspace.activeTabId = tabId;
        tab.lastActiveAt = Date.now();
        await saveWorkspace(storage, projectId, workspace);
        json(200, workspace);
        return true;
      }
      if (action === "navigate") {
        const profile = await loadProfile(storage, space.userId, tab.profileId);
        if (!profile) throw err("not-found", `profile ${tab.profileId} not found`);
        const targetUrl = await validateProfileUrl(profile, String(input.url ?? ""));
        await dispatch(deviceId, { kind: "tab.navigate", projectId, tabId, url: targetUrl });
        tab.url = targetUrl;
        tab.lastActiveAt = Date.now();
        await saveWorkspace(storage, projectId, workspace);
        json(200, { ok: true, state: latestStates.get(tabId) ?? null });
        return true;
      }
      if (action === "back" || action === "forward" || action === "reload" || action === "stop") {
        await dispatch(deviceId, { kind: `tab.${action}` as "tab.back" | "tab.forward" | "tab.reload" | "tab.stop", projectId, tabId });
        json(200, { ok: true, state: latestStates.get(tabId) ?? null });
        return true;
      }
      if (action === "hibernate") {
        await dispatch(deviceId, { kind: "tab.hibernate", projectId, tabId });
        tab.hibernated = true;
        await saveWorkspace(storage, projectId, workspace);
        json(200, { ok: true });
        return true;
      }
      if (action === "restore") {
        await dispatchProfile(deviceId, (await loadProfile(storage, space.userId, tab.profileId)) ?? (() => { throw err("not-found", `profile ${tab.profileId} not found`); })());
        await dispatchTab(deviceId, projectId, tab);
        await dispatch(deviceId, { kind: "tab.restore", projectId, tabId, url: String(input.url ?? tab.url) });
        tab.hibernated = false;
        await saveWorkspace(storage, projectId, workspace);
        json(200, { ok: true });
        return true;
      }
      if (action === "pin") {
        const pinned = Boolean(input.pinned ?? true);
        await dispatch(deviceId, { kind: "tab.set-pinned", projectId, tabId, pinned });
        tab.pinned = pinned;
        await saveWorkspace(storage, projectId, workspace);
        json(200, workspace);
        return true;
      }
      if (action === "approve-origin") {
        const origin = String(input.origin ?? "");
        const mode = String(input.mode ?? "always") === "once" ? "once" : "always";
        if (!origin) throw err("invalid-input", "origin required");
        const profile = await loadProfile(storage, space.userId, tab.profileId);
        if (!profile) throw err("not-found", `profile ${tab.profileId} not found`);
        if (mode === "always" && !profile.approvedOrigins.includes(origin)) {
          profile.approvedOrigins.push(origin);
          await saveProfile(storage, space.userId, profile);
        }
        await dispatch(deviceId, {
          kind: "tab.approve-origin",
          projectId,
          tabId,
          origin,
          mode,
          ...(input.retryUrl ? { retryUrl: String(input.retryUrl) } : {}),
        });
        json(200, { ok: true });
        return true;
      }
      if (action === "pin") {
        const pinned = Boolean(input.pinned ?? true);
        await dispatch(deviceId, { kind: "tab.set-pinned", projectId, tabId, pinned });
        tab.pinned = pinned;
        await saveWorkspace(storage, projectId, workspace);
        json(200, workspace);
        return true;
      }
      if (action === "move") {
        workspace.order = workspace.order.filter((id) => id !== tabId);
        if (input.beforeId) {
          const index = workspace.order.indexOf(String(input.beforeId));
          workspace.order.splice(index < 0 ? workspace.order.length : index, 0, tabId);
        } else {
          const index = Math.max(0, Math.min(Number(input.index ?? workspace.order.length), workspace.order.length));
          workspace.order.splice(index, 0, tabId);
        }
        await saveWorkspace(storage, projectId, workspace);
        json(200, workspace);
        return true;
      }
      if (action === "close") {
        await dispatch(deviceId, { kind: "tab.close", projectId, tabId }).catch(() => {});
        workspace.tabs = workspace.tabs.filter((item) => item.id !== tabId);
        workspace.order = workspace.order.filter((id) => id !== tabId);
        if (workspace.activeTabId === tabId) workspace.activeTabId = workspace.order[0] ?? null;
        latestStates.delete(tabId);
        await saveWorkspace(storage, projectId, workspace);
        json(200, workspace);
        return true;
      }
      if (action === "close-others") {
        const remove = workspace.tabs.filter((item) => item.id !== tabId);
        await Promise.all(remove.map((item) => dispatch(deviceId, { kind: "tab.close", projectId, tabId: item.id }).catch(() => {})));
        for (const item of remove) latestStates.delete(item.id);
        workspace.tabs = workspace.tabs.filter((item) => item.id === tabId);
        workspace.order = [tabId];
        workspace.activeTabId = tabId;
        await saveWorkspace(storage, projectId, workspace);
        json(200, workspace);
        return true;
      }
      if (action === "duplicate") {
        const duplicate: ChatTabDto = {
          ...tab,
          id: newChatTabId(),
          pinned: false,
          lastActiveAt: Date.now(),
        };
        const profile = await loadProfile(storage, space.userId, duplicate.profileId);
        if (!profile) throw err("not-found", `profile ${duplicate.profileId} not found`);
        await dispatchProfile(deviceId, profile);
        await dispatchTab(deviceId, projectId, duplicate);
        workspace.tabs.push(duplicate);
        workspace.order.push(duplicate.id);
        workspace.activeTabId = duplicate.id;
        await saveWorkspace(storage, projectId, workspace);
        json(200, workspace);
        return true;
      }
      if (action === "change-profile") {
        const profileId = String(input.profileId ?? "");
        const profile = await loadProfile(storage, space.userId, profileId);
        if (!profile) throw err("not-found", `profile ${profileId} not found`);
        await dispatch(deviceId, { kind: "tab.close", projectId, tabId }).catch(() => {});
        tab.profileId = profileId;
        tab.url = await validateProfileUrl(profile, profile.customUrl ?? providerById(profile.providerId)?.homeUrl ?? "about:blank");
        await dispatchProfile(deviceId, profile);
        await dispatchTab(deviceId, projectId, tab);
        await saveWorkspace(storage, projectId, workspace);
        json(200, workspace);
        return true;
      }

      throw err("local-runtime-only", `tab action ${action} must execute on the Desktop browser surface`);
    }

    const localProjectId = q("projectId");
    if (localProjectId && await localDeviceFor(storage, localProjectId)) {
      // Clipboard/upload/popup/input routes from the legacy canvas are not valid
      // in local mode; swallowing them prevents accidental remote execution.
      throw err("local-runtime-only", "this Chat Workspace project is running on a Desktop device");
    }

    return false;
  };

  return {
    routes,
    dispose() {
      eventSub.dispose();
      projectStorages.clear();
      latestStates.clear();
    },
  };
}
