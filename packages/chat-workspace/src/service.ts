import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  ChatProfileDto,
  ChatTabDto,
  ChatTabEventDto,
  ChatTabStateDto,
  ChatWorkspaceDto,
  ChatWorkspaceSettingsDto,
  ContentAccessPolicy,
  SpaceContext,
} from "@polyth/contracts";
import type { ProfileRegistry, ProfileRegistryEvent, ProfileFrame, ProfilePage } from "@polyth/browser";
import { MANUAL_ONLY_POLICY, newChatTabId, originOf, checkUrl, isInternalBrowserUrl } from "@polyth/browser";
import { CHAT_PROVIDERS, providerById } from "./providers.ts";
import {
  deleteProfile,
  err,
  listProfiles,
  loadProfile,
  loadSettings,
  loadWorkspace,
  profileRoot,
  saveProfile,
  saveSettings,
  saveWorkspace,
  spaceKey,
} from "./storage.ts";

interface TabOverlayState {
  pendingApproval?: { origin: string; reason: string; url?: string } | null;
  pendingPopups: Array<{ popupId: string; url?: string }>;
  pendingFileChooser: boolean;
  crashed: boolean;
  unreachable: boolean;
  profileRestarted: boolean;
  downloadBlocked: boolean;
}

function emptyOverlay(): TabOverlayState {
  return {
    pendingPopups: [],
    pendingFileChooser: false,
    crashed: false,
    unreachable: false,
    profileRestarted: false,
    downloadBlocked: false,
  };
}

function allowedOriginsFor(
  provider: ReturnType<typeof providerById>,
  profile: ChatProfileDto,
): string[] {
  const origins = [...(provider?.allowedOrigins ?? [])];
  const seed = profile.customUrl ?? provider?.homeUrl;
  if (seed && !/^about:/i.test(seed)) {
    const origin = originOf(seed);
    if (origin && !origins.some((item) => item.toLowerCase() === origin)) origins.push(origin);
  }
  return origins;
}

async function resolveProfileUrl(
  provider: ReturnType<typeof providerById>,
  profile: ChatProfileDto,
  preferred: string,
): Promise<string> {
  const fallback = profile.customUrl || provider?.homeUrl || "about:blank";
  if (!preferred || preferred === fallback || /^about:/i.test(preferred)) return preferred || fallback;
  const decision = await checkUrl(preferred, {
    allowedOrigins: allowedOriginsFor(provider, profile),
    approvedOrigins: new Set(profile.approvedOrigins),
    privateNetwork: "explicit-only",
  });
  return decision.ok ? preferred : fallback;
}

export interface ChatWorkspaceService {
  capability(): { available: boolean; reason?: string };
  listProviders(): typeof CHAT_PROVIDERS;
  getSettings(storage: import("@polyth/contracts").SpaceStorage): Promise<ChatWorkspaceSettingsDto>;
  putSettings(
    ctx: SpaceContext,
    storage: import("@polyth/contracts").SpaceStorage,
    settings: ChatWorkspaceSettingsDto,
  ): Promise<ChatWorkspaceSettingsDto>;
  listProfiles(ctx: SpaceContext, storage: import("@polyth/contracts").SpaceStorage): Promise<ChatProfileDto[]>;
  createProfile(ctx: SpaceContext, storage: import("@polyth/contracts").SpaceStorage, input: { providerId: string; name?: string; customUrl?: string }): Promise<ChatProfileDto>;
  patchProfile(ctx: SpaceContext, storage: import("@polyth/contracts").SpaceStorage, id: string, patch: Partial<Pick<ChatProfileDto, "name" | "approvedOrigins">>): Promise<ChatProfileDto>;
  deleteProfile(ctx: SpaceContext, storage: import("@polyth/contracts").SpaceStorage, id: string): Promise<void>;
  clearProfileData(ctx: SpaceContext, storage: import("@polyth/contracts").SpaceStorage, id: string): Promise<void>;
  getWorkspace(storage: import("@polyth/contracts").SpaceStorage, projectId: string, ctx?: SpaceContext): Promise<ChatWorkspaceDto>;
  createTab(input: {
    ctx: SpaceContext;
    storage: import("@polyth/contracts").SpaceStorage;
    projectId: string;
    profileId: string;
    url?: string;
  }): Promise<ChatTabDto>;
  resolveTab(ctx: SpaceContext, storage: import("@polyth/contracts").SpaceStorage, projectId: string, tabId: string): Promise<{ tab: ChatTabDto; profile: ChatProfileDto }>;
  getTabState(tabId: string): ChatTabStateDto | null;
  tabSpaceId(tabId: string): string | undefined;
  liveTabCount(): number;
  setTabStream(tabId: string, visible: boolean, quality?: number): void;
  wakeTab(
    ctx: SpaceContext,
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
    tabId: string,
  ): Promise<ProfilePage | null>;
  activateTab(
    ctx: SpaceContext,
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
    tabId: string,
  ): Promise<ChatWorkspaceDto>;
  closeTab(
    ctx: SpaceContext,
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
    tabId: string,
  ): Promise<ChatWorkspaceDto>;
  closeOthers(
    ctx: SpaceContext,
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
    tabId: string,
  ): Promise<ChatWorkspaceDto>;
  moveTab(
    ctx: SpaceContext,
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
    tabId: string,
    input: { beforeId?: string; index?: number },
  ): Promise<ChatWorkspaceDto>;
  pinTab(
    ctx: SpaceContext,
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
    tabId: string,
    pinned: boolean,
  ): Promise<ChatWorkspaceDto>;
  changeProfile(
    ctx: SpaceContext,
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
    tabId: string,
    profileId: string,
  ): Promise<ChatWorkspaceDto>;
  duplicateTab(
    ctx: SpaceContext,
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
    tabId: string,
  ): Promise<ChatWorkspaceDto>;
  syncTabNavigation(
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
    tabId: string,
    url: string,
    title?: string,
  ): Promise<void>;
  onFrame(cb: (frame: ProfileFrame) => void): { dispose(): void };
  onEvent(cb: (event: ChatTabEventDto) => void): { dispose(): void };
}

export function createChatWorkspaceService(profiles: ProfileRegistry | null): ChatWorkspaceService {
  const tabSpaces = new Map<string, string>();
  const tabProjects = new Map<string, string>();
  const overlays = new Map<string, TabOverlayState>();
  const tabEventCbs = new Set<(event: ChatTabEventDto) => void>();
  const pendingNav = new Map<string, { projectId: string; url: string; title?: string }>();

  const overlayFor = (tabId: string): TabOverlayState => {
    let state = overlays.get(tabId);
    if (!state) {
      state = emptyOverlay();
      overlays.set(tabId, state);
    }
    return state;
  };

  const applyEvent = (event: ProfileRegistryEvent): void => {
    const state = overlayFor(event.tabId);
    switch (event.kind) {
      case "approval-required":
        state.pendingApproval = {
          origin: event.origin ?? "",
          reason: event.message ?? event.reason ?? "",
          ...(event.url ? { url: event.url } : {}),
        };
        break;
      case "popup-opened":
        if (event.popupId) state.pendingPopups.push({ popupId: event.popupId, ...(event.url ? { url: event.url } : {}) });
        break;
      case "popup-closed":
        if (event.popupId) state.pendingPopups = state.pendingPopups.filter((p) => p.popupId !== event.popupId);
        break;
      case "file-chooser-opened":
        state.pendingFileChooser = true;
        break;
      case "download-blocked":
        state.downloadBlocked = true;
        break;
      case "crash":
        state.crashed = true;
        break;
      case "navigation":
        state.unreachable = false;
        state.crashed = false;
        if (event.url) {
          const runtime = profiles?.getTab(event.tabId);
          const projectId = tabProjects.get(event.tabId)
            ?? (runtime ? runtime.spaceKey.split(":").slice(1).join(":") : undefined);
          if (projectId) {
            pendingNav.set(event.tabId, { projectId, url: event.url, title: runtime?.title });
            tabEventCbs.forEach((cb) => cb({
              tabId: event.tabId,
              kind: "navigation",
              url: event.url,
            }));
          }
        }
        break;
      default:
        break;
    }
  };

  if (profiles) {
    profiles.onEvent((event) => { applyEvent(event); });
  }

  const findTab = async (
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
    tabId: string,
  ): Promise<{ workspace: ChatWorkspaceDto; tab: ChatTabDto } | null> => {
    const workspace = await loadWorkspace(storage, projectId);
    const tab = workspace.tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    return { workspace, tab };
  };

  const registerPersistedTab = (ctx: SpaceContext, projectId: string, tab: ChatTabDto): void => {
    if (!profiles || profiles.getTab(tab.id)) {
      tabProjects.set(tab.id, projectId);
      tabSpaces.set(tab.id, ctx.spaceId);
      return;
    }
    profiles.registerTab(spaceKey(ctx.spaceId, projectId), tab.id, tab.profileId, { pinned: tab.pinned });
    tabSpaces.set(tab.id, ctx.spaceId);
    tabProjects.set(tab.id, projectId);
    overlays.set(tab.id, emptyOverlay());
  };

  const mergePendingNavigation = (projectId: string, workspace: ChatWorkspaceDto): boolean => {
    let changed = false;
    for (const tab of workspace.tabs) {
      const pending = pendingNav.get(tab.id);
      if (!pending || pending.projectId !== projectId) continue;
      tab.url = pending.url;
      if (pending.title) tab.title = pending.title;
      const runtime = profiles?.getTab(tab.id);
      if (runtime) {
        tab.url = runtime.url;
        tab.title = runtime.title;
      }
      pendingNav.delete(tab.id);
      changed = true;
    }
    return changed;
  };

  const persistWorkspace = async (
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
    workspace: ChatWorkspaceDto,
  ): Promise<ChatWorkspaceDto> => {
    mergePendingNavigation(projectId, workspace);
    for (const tab of workspace.tabs) {
      const synced = syncRuntimeTab(tab);
      tab.url = synced.url;
      tab.title = synced.title;
      tab.pinned = synced.pinned;
      tab.hibernated = synced.hibernated;
      tab.lastActiveAt = synced.lastActiveAt;
    }
    await saveWorkspace(storage, projectId, workspace);
    return workspace;
  };

  const syncRuntimeTab = (tab: ChatTabDto): ChatTabDto => {
    const runtime = profiles?.getTab(tab.id);
    if (!runtime) return tab;
    return {
      ...tab,
      url: runtime.url || tab.url,
      title: runtime.title || tab.title,
      pinned: runtime.pinned,
      hibernated: runtime.hibernated,
      lastActiveAt: runtime.lastActiveAt,
    };
  };

  const workspaceWithRuntime = async (
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
  ): Promise<ChatWorkspaceDto> => {
    const workspace = await loadWorkspace(storage, projectId);
    mergePendingNavigation(projectId, workspace);
    return {
      ...workspace,
      tabs: workspace.tabs.map(syncRuntimeTab),
    };
  };

  const ensureTabsRegistered = async (
    ctx: SpaceContext,
    storage: import("@polyth/contracts").SpaceStorage,
    projectId: string,
  ): Promise<void> => {
    if (!profiles) return;
    const workspace = await loadWorkspace(storage, projectId);
    for (const tab of workspace.tabs) registerPersistedTab(ctx, projectId, tab);
  };

  return {
    capability() {
      const cap = profiles?.capability();
      if (!cap?.available) {
        return { available: false, reason: cap?.reason ?? "browser runtime unavailable" };
      }
      return { available: true };
    },

    listProviders() {
      return CHAT_PROVIDERS;
    },

    getSettings: loadSettings,
    putSettings: async (ctx, storage, settings) => {
      await saveSettings(storage, settings);
      profiles?.setLiveTabLimit(ctx.spaceId, settings.liveTabLimit);
      profiles?.setHibernateDelayMs(ctx.spaceId, settings.hibernateDelayMs);
      return settings;
    },

    listProfiles: (ctx, storage) => listProfiles(storage, ctx.userId),

    async createProfile(ctx, storage, input) {
      const provider = providerById(input.providerId);
      if (!provider) throw err("invalid-input", `unknown provider ${input.providerId}`);
      if (input.customUrl) {
        const origin = originOf(input.customUrl);
        const decision = await checkUrl(input.customUrl, {
          privateNetwork: "explicit-only",
          ...(origin ? { allowedOrigins: [origin] } : {}),
        });
        if (!decision.ok) throw err(decision.code, decision.reason);
      }
      const profile: ChatProfileDto = {
        id: randomUUID(),
        providerId: input.providerId,
        name: input.name ?? "Personal",
        ...(input.customUrl ? { customUrl: input.customUrl } : {}),
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        approvedOrigins: [],
      };
      await saveProfile(storage, ctx.userId, profile);
      return profile;
    },

    async patchProfile(ctx, storage, id, patch) {
      const profile = await loadProfile(storage, ctx.userId, id);
      if (!profile) throw err("not-found", `profile ${id} not found`);
      if (patch.name !== undefined) profile.name = patch.name;
      if (patch.approvedOrigins !== undefined) profile.approvedOrigins = patch.approvedOrigins;
      await saveProfile(storage, ctx.userId, profile);
      return profile;
    },

    async deleteProfile(ctx, storage, id) {
      if (!(await loadProfile(storage, ctx.userId, id))) throw err("not-found", `profile ${id} not found`);
      const projectsRoot = storage.path(join("packages", "chat-workspace", "projects"));
      const { readdir } = await import("node:fs/promises");
      let projectIds: string[] = [];
      try {
        projectIds = await readdir(projectsRoot);
      } catch {
        projectIds = [];
      }
      for (const projectId of projectIds) {
        const workspace = await loadWorkspace(storage, projectId);
        const affected = workspace.tabs.filter((t) => t.profileId === id);
        if (affected.length === 0) continue;
        for (const tab of affected) {
          await profiles?.releaseTabPage(tab.id);
          profiles?.unregisterTab(tab.id);
          tabSpaces.delete(tab.id);
          tabProjects.delete(tab.id);
          overlays.delete(tab.id);
          pendingNav.delete(tab.id);
        }
        workspace.tabs = workspace.tabs.filter((t) => t.profileId !== id);
        workspace.order = workspace.order.filter((tid) => workspace.tabs.some((t) => t.id === tid));
        if (workspace.activeTabId && !workspace.tabs.some((t) => t.id === workspace.activeTabId)) {
          workspace.activeTabId = workspace.order[0] ?? null;
        }
        await saveWorkspace(storage, projectId, workspace);
      }
      await profiles?.closeProfile(id);
      await deleteProfile(storage, ctx.userId, id);
    },

    async clearProfileData(ctx, storage, id) {
      const profile = await loadProfile(storage, ctx.userId, id);
      if (!profile) throw err("not-found", `profile ${id} not found`);
      await profiles?.closeProfile(id);
      const { rm, mkdir } = await import("node:fs/promises");
      await rm(join(profileRoot(storage, ctx.userId, id), "chromium"), { recursive: true, force: true });
      await mkdir(join(profileRoot(storage, ctx.userId, id), "chromium"), { recursive: true });
    },

    getWorkspace: async (storage, projectId, ctx) => {
      if (ctx) await ensureTabsRegistered(ctx, storage, projectId);
      return workspaceWithRuntime(storage, projectId);
    },

    async createTab({ ctx, storage, projectId, profileId, url }) {
      if (!profiles) throw err("unavailable", "browser runtime unavailable");
      const profile = await loadProfile(storage, ctx.userId, profileId);
      if (!profile) throw err("not-found", `profile ${profileId} not found`);
      const provider = providerById(profile.providerId);
      const targetUrl = url ?? profile.customUrl ?? provider?.homeUrl ?? "about:blank";
      if (!isInternalBrowserUrl(targetUrl)) {
        const decision = await checkUrl(targetUrl, {
          allowedOrigins: allowedOriginsFor(provider, profile),
          approvedOrigins: new Set(profile.approvedOrigins),
          privateNetwork: "explicit-only",
        });
        if (!decision.ok) throw err(decision.code, decision.reason);
      }
      const tabId = newChatTabId();
      profiles.registerTab(spaceKey(ctx.spaceId, projectId), tabId, profileId);
      tabSpaces.set(tabId, ctx.spaceId);
      overlays.set(tabId, emptyOverlay());
      const userDataDir = join(profileRoot(storage, ctx.userId, profileId), "chromium");
      await profiles.openProfile({
        profileId,
        userDataDir,
        allowedOrigins: allowedOriginsFor(provider, profile),
        approvedOrigins: new Set(profile.approvedOrigins),
        privateNetwork: "explicit-only",
      });
      const live = await profiles.ensureLive(tabId, targetUrl);
      const tab: ChatTabDto = {
        id: tabId,
        profileId,
        url: live.url,
        title: live.title || provider?.name || "Chat",
        pinned: false,
        lastActiveAt: Date.now(),
        hibernated: false,
        contentAccess: MANUAL_ONLY_POLICY as ContentAccessPolicy,
      };
      const workspace = await loadWorkspace(storage, projectId);
      workspace.tabs.push(tab);
      workspace.order.push(tabId);
      workspace.activeTabId = tabId;
      profiles?.setActiveTab(tabId);
      await persistWorkspace(storage, projectId, workspace);
      profile.lastUsedAt = Date.now();
      await saveProfile(storage, ctx.userId, profile);
      return tab;
    },

    async resolveTab(ctx, storage, projectId, tabId) {
      const found = await findTab(storage, projectId, tabId);
      if (!found) throw err("not-found", `tab ${tabId} not found`);
      registerPersistedTab(ctx, projectId, found.tab);
      const profile = await loadProfile(storage, ctx.userId, found.tab.profileId);
      if (!profile) throw err("not-found", `profile ${found.tab.profileId} not found`);
      return { tab: found.tab, profile };
    },

    getTabState(tabId) {
      const tab = profiles?.getTab(tabId);
      if (!tab) return null;
      const page = profiles?.getPage(tabId);
      const overlay = overlayFor(tabId);
      return {
        tab: {
          id: tab.tabId,
          profileId: tab.profileId,
          url: tab.url,
          title: tab.title,
          pinned: tab.pinned,
          lastActiveAt: tab.lastActiveAt,
          hibernated: tab.hibernated,
          contentAccess: tab.contentAccess,
        },
        loading: page?.current().loading ?? false,
        canGoBack: true,
        canGoForward: true,
        pendingApproval: overlay.pendingApproval ?? null,
        pendingPopups: overlay.pendingPopups,
        pendingFileChooser: overlay.pendingFileChooser,
        hibernated: tab.hibernated,
        crashed: overlay.crashed,
        unreachable: overlay.unreachable,
        profileRestarted: overlay.profileRestarted,
        downloadBlocked: overlay.downloadBlocked,
        liveTabCount: profiles ? profiles.listChatTabIds().filter((id) => !profiles.getTab(id)?.hibernated).length : 0,
      };
    },

    tabSpaceId(tabId) {
      const fromMap = tabSpaces.get(tabId);
      if (fromMap) return fromMap;
      const tab = profiles?.getTab(tabId);
      if (!tab) return undefined;
      const [spaceId] = tab.spaceKey.split(":");
      return spaceId || undefined;
    },

    liveTabCount() {
      if (!profiles) return 0;
      return profiles.listChatTabIds().filter((id) => !profiles.getTab(id)?.hibernated).length;
    },

    setTabStream(tabId, visible, quality = 60) {
      if (!profiles) return;
      const tab = profiles.getTab(tabId);
      if (!tab) return;
      const apply = (page: NonNullable<ReturnType<ProfileRegistry["getPage"]>>) => {
        if (visible) {
          void page.startScreencast({ quality, maxWidth: 1280, maxHeight: 800 }).then(() => {
            page.setStreamVisible(true);
          });
        } else {
          page.setStreamVisible(false);
        }
      };
      const page = profiles.getPage(tabId);
      if (page) {
        apply(page);
        return;
      }
      if (!visible) return;
      void profiles.ensureLive(tabId, tab.url).then(() => {
        const livePage = profiles.getPage(tabId);
        if (livePage) apply(livePage);
      }).catch(() => {});
    },

    async syncTabNavigation(storage, projectId, tabId, url, title) {
      const workspace = await loadWorkspace(storage, projectId);
      const tab = workspace.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      tab.url = url;
      if (title) tab.title = title;
      await saveWorkspace(storage, projectId, workspace);
      pendingNav.delete(tabId);
    },

    async activateTab(ctx, storage, projectId, tabId) {
      const { tab } = await this.resolveTab(ctx, storage, projectId, tabId);
      const workspace = await loadWorkspace(storage, projectId);
      workspace.activeTabId = tabId;
      const idx = workspace.tabs.findIndex((t) => t.id === tabId);
      if (idx >= 0) {
        workspace.tabs[idx] = { ...workspace.tabs[idx]!, lastActiveAt: Date.now() };
      }
      profiles?.setActiveTab(tabId);
      profiles?.touchTab(tabId);
      await profiles?.ensureLive(tabId, tab.url);
      const page = profiles?.getPage(tabId);
      page?.setStreamVisible(true);
      return persistWorkspace(storage, projectId, workspace);
    },

    async closeTab(ctx, storage, projectId, tabId) {
      await this.resolveTab(ctx, storage, projectId, tabId);
      const workspace = await loadWorkspace(storage, projectId);
      workspace.tabs = workspace.tabs.filter((t) => t.id !== tabId);
      workspace.order = workspace.order.filter((id) => id !== tabId);
      if (workspace.activeTabId === tabId) {
        workspace.activeTabId = workspace.order[0] ?? null;
        if (workspace.activeTabId) profiles?.setActiveTab(workspace.activeTabId);
      }
      await profiles?.releaseTabPage(tabId);
      profiles?.unregisterTab(tabId);
      tabSpaces.delete(tabId);
      tabProjects.delete(tabId);
      overlays.delete(tabId);
      pendingNav.delete(tabId);
      return persistWorkspace(storage, projectId, workspace);
    },

    async closeOthers(ctx, storage, projectId, tabId) {
      await this.resolveTab(ctx, storage, projectId, tabId);
      const workspace = await loadWorkspace(storage, projectId);
      const keep = new Set([tabId]);
      for (const tab of workspace.tabs) {
        if (keep.has(tab.id)) continue;
        await profiles?.releaseTabPage(tab.id);
        profiles?.unregisterTab(tab.id);
        tabSpaces.delete(tab.id);
        tabProjects.delete(tab.id);
        overlays.delete(tab.id);
        pendingNav.delete(tab.id);
      }
      workspace.tabs = workspace.tabs.filter((t) => keep.has(t.id));
      workspace.order = workspace.order.filter((id) => keep.has(id));
      workspace.activeTabId = tabId;
      profiles?.setActiveTab(tabId);
      return persistWorkspace(storage, projectId, workspace);
    },

    async moveTab(ctx, storage, projectId, tabId, input) {
      await this.resolveTab(ctx, storage, projectId, tabId);
      const workspace = await loadWorkspace(storage, projectId);
      const order = [...workspace.order];
      const from = order.indexOf(tabId);
      if (from < 0) throw err("not-found", `tab ${tabId} not in order`);
      order.splice(from, 1);
      if (input.beforeId) {
        const to = order.indexOf(input.beforeId);
        if (to < 0) throw err("not-found", `tab ${input.beforeId} not in order`);
        order.splice(to, 0, tabId);
      } else if (input.index !== undefined) {
        const idx = Math.max(0, Math.min(order.length, Math.round(input.index)));
        order.splice(idx, 0, tabId);
      } else {
        order.push(tabId);
      }
      workspace.order = order;
      return persistWorkspace(storage, projectId, workspace);
    },

    async pinTab(ctx, storage, projectId, tabId, pinned) {
      await this.resolveTab(ctx, storage, projectId, tabId);
      profiles?.setPinned(tabId, pinned);
      const workspace = await loadWorkspace(storage, projectId);
      workspace.tabs = workspace.tabs.map((t) => (t.id === tabId ? { ...t, pinned } : t));
      return persistWorkspace(storage, projectId, workspace);
    },

    async changeProfile(ctx, storage, projectId, tabId, profileId) {
      const { tab } = await this.resolveTab(ctx, storage, projectId, tabId);
      const profile = await loadProfile(storage, ctx.userId, profileId);
      if (!profile) throw err("not-found", `profile ${profileId} not found`);
      const provider = providerById(profile.providerId);
      const targetUrl = await resolveProfileUrl(
        provider,
        profile,
        tab.url || profile.customUrl || provider?.homeUrl || "about:blank",
      );
      const workspaceBefore = await loadWorkspace(storage, projectId);
      const wasActive = workspaceBefore.activeTabId === tabId;
      await profiles?.releaseTabPage(tabId);
      profiles?.unregisterTab(tabId);
      profiles?.registerTab(spaceKey(ctx.spaceId, projectId), tabId, profileId, { pinned: tab.pinned });
      tabSpaces.set(tabId, ctx.spaceId);
      tabProjects.set(tabId, projectId);
      overlays.set(tabId, emptyOverlay());
      const userDataDir = join(profileRoot(storage, ctx.userId, profileId), "chromium");
      await profiles?.openProfile({
        profileId,
        userDataDir,
        allowedOrigins: allowedOriginsFor(provider, profile),
        approvedOrigins: new Set(profile.approvedOrigins),
        privateNetwork: "explicit-only",
      });
      const live = await profiles!.ensureLive(tabId, targetUrl);
      if (wasActive) profiles?.setActiveTab(tabId);
      const workspace = await loadWorkspace(storage, projectId);
      workspace.tabs = workspace.tabs.map((t) => (
        t.id === tabId
          ? {
            ...t,
            profileId,
            url: live.url,
            title: live.title || provider?.name || t.title,
            lastActiveAt: Date.now(),
          }
          : t
      ));
      profile.lastUsedAt = Date.now();
      await saveProfile(storage, ctx.userId, profile);
      return persistWorkspace(storage, projectId, workspace);
    },

    async duplicateTab(ctx, storage, projectId, tabId) {
      const { tab, profile } = await this.resolveTab(ctx, storage, projectId, tabId);
      const newTab = await this.createTab({
        ctx,
        storage,
        projectId,
        profileId: tab.profileId,
        url: tab.url || profile.customUrl,
      });
      const workspace = await loadWorkspace(storage, projectId);
      const order = [...workspace.order];
      const after = order.indexOf(tabId);
      if (after >= 0) order.splice(after + 1, 0, newTab.id);
      else order.push(newTab.id);
      workspace.order = order;
      workspace.activeTabId = newTab.id;
      profiles?.setActiveTab(newTab.id);
      return persistWorkspace(storage, projectId, workspace);
    },

    async wakeTab(ctx, storage, projectId, tabId) {
      if (!profiles) return null;
      const { tab, profile } = await this.resolveTab(ctx, storage, projectId, tabId);
      const provider = providerById(profile.providerId);
      const targetUrl = tab.url || profile.customUrl || provider?.homeUrl || "about:blank";
      const userDataDir = join(profileRoot(storage, ctx.userId, profile.id), "chromium");
      await profiles.openProfile({
        profileId: profile.id,
        userDataDir,
        allowedOrigins: allowedOriginsFor(provider, profile),
        approvedOrigins: new Set(profile.approvedOrigins),
        privateNetwork: "explicit-only",
      });
      await profiles.ensureLive(tabId, targetUrl);
      return profiles.getPage(tabId);
    },

    onFrame(cb) {
      return profiles?.onFrame(cb) ?? { dispose: () => {} };
    },

    onEvent(cb) {
      tabEventCbs.add(cb);
      const sub = profiles?.onEvent((event) => {
        cb({
          tabId: event.tabId,
          kind: event.kind,
          ...(event.url ? { url: event.url } : {}),
          ...(event.message ? { message: event.message } : {}),
        });
      });
      return {
        dispose: () => {
          tabEventCbs.delete(cb);
          sub?.dispose();
        },
      };
    },
  };
}

export { MANUAL_ONLY_POLICY };
