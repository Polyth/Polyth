import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ProfilePage, ProfileRegistry } from "@polyth/browser";
import type {
  ChatWorkspaceDeviceAck,
  ChatWorkspaceDeviceCommand,
  ChatWorkspaceDeviceEvent,
} from "./deviceRuntimeProtocol.ts";
import { buildExternalChatHandoff, providerAdapter } from "./providerAdapters.ts";
import { providerById } from "./providers.ts";

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;

interface LocalProfileConfig {
  providerId: string;
  homeUrl: string;
  allowedOrigins: string[];
  approvedOrigins: Set<string>;
}

export interface ChatWorkspaceDeviceWorkerRuntime {
  execute(command: ChatWorkspaceDeviceCommand): Promise<ChatWorkspaceDeviceAck>;
  close(): Promise<void>;
}

export function createChatWorkspaceDeviceWorkerRuntime(opts: {
  profiles: ProfileRegistry;
  dataDir: string;
  emit(event: ChatWorkspaceDeviceEvent): void;
}): ChatWorkspaceDeviceWorkerRuntime {
  const { profiles } = opts;
  const profileConfigs = new Map<string, LocalProfileConfig>();
  const tabProjects = new Map<string, string>();
  const activeTabByProject = new Map<string, string>();
  const disposals: Array<{ dispose(): void }> = [];

  const safeId = (value: string, label: string): string => {
    if (!SAFE_ID.test(value)) throw err("invalid-input", `${label} is not a safe local runtime id`);
    return value;
  };

  const emitTabState = (tabId: string): void => {
    const projectId = tabProjects.get(tabId);
    const tab = profiles.getTab(tabId);
    if (!projectId || !tab) return;
    const page = profiles.getPage(tabId);
    const current = page?.current();
    opts.emit({
      kind: "tab.state",
      projectId,
      tabId,
      url: current?.url ?? tab.url,
      title: current?.title ?? tab.title,
      loading: current?.loading ?? false,
      hibernated: tab.hibernated,
    });
  };

  const installProviderControls = async (tabId: string): Promise<void> => {
    const tab = profiles.getTab(tabId);
    const projectId = tabProjects.get(tabId);
    const page = profiles.getPage(tabId);
    if (!tab || !projectId || !page?.installManualHandoffControls) return;
    const profile = profileConfigs.get(tab.profileId);
    if (!profile) return;
    const adapter = providerAdapter(profile.providerId);
    if (!adapter || adapter.assistantMessageSelectors.length === 0) return;
    const providerName = providerById(profile.providerId)?.name ?? profile.providerId;

    await page.installManualHandoffControls({
      assistantMessageSelectors: adapter.assistantMessageSelectors,
      streamingSelectors: adapter.streamingSelectors,
      actions: [
        { id: "add-to-agent", label: "Add to agent" },
        { id: "ask-agent", label: "Ask agent" },
        { id: "new-agent-chat", label: "New chat" },
      ],
    }, (event) => {
      const currentProject = tabProjects.get(tabId);
      const currentTab = profiles.getTab(tabId);
      if (!currentProject || !currentTab || currentTab.profileId !== tab.profileId) return;
      opts.emit({
        kind: "handoff",
        eventId: randomUUID(),
        action: event.action,
        handoff: buildExternalChatHandoff({
          providerId: profile.providerId,
          providerName,
          profileId: tab.profileId,
          tabId,
          projectId: currentProject,
          url: event.url,
          title: event.title,
          scope: event.scope,
          text: event.text,
        }),
      });
    });
  };

  const setPageVisible = (page: ProfilePage | null, visible: boolean): void => {
    page?.setStreamVisible(visible);
  };

  const activateLocalTab = async (projectId: string, tabId: string): Promise<void> => {
    const previous = activeTabByProject.get(projectId);
    if (previous && previous !== tabId) setPageVisible(profiles.getPage(previous), false);
    const tab = profiles.getTab(tabId);
    if (!tab) throw err("not-found", `local tab ${tabId} not found`);
    profiles.setActiveTab(tabId);
    profiles.touchTab(tabId);
    await profiles.ensureLive(tabId, tab.url);
    await installProviderControls(tabId);
    setPageVisible(profiles.getPage(tabId), true);
    activeTabByProject.set(projectId, tabId);
  };

  disposals.push(profiles.onEvent((event) => {
    if (!tabProjects.has(event.tabId)) return;
    if (event.kind === "navigation" || event.kind === "loading") {
      emitTabState(event.tabId);
      return;
    }
    if (event.kind === "crash") {
      opts.emit({
        kind: "runtime.error",
        tabId: event.tabId,
        code: "page-crashed",
        message: event.message ?? "Chat Workspace page crashed",
      });
    }
  }));

  const ack = (requestId: string): ChatWorkspaceDeviceAck => ({ requestId, ok: true });

  const ensureProfile = async (command: Extract<ChatWorkspaceDeviceCommand, { kind: "profile.ensure" }>): Promise<void> => {
    const profileId = safeId(command.profileId, "profileId");
    const existing = profileConfigs.get(profileId);
    const next: LocalProfileConfig = {
      providerId: command.providerId,
      homeUrl: command.homeUrl,
      allowedOrigins: [...new Set(command.allowedOrigins)],
      approvedOrigins: new Set(command.approvedOrigins),
    };
    if (existing) {
      existing.providerId = next.providerId;
      existing.homeUrl = next.homeUrl;
      existing.allowedOrigins = next.allowedOrigins;
      existing.approvedOrigins = next.approvedOrigins;
      return;
    }
    profileConfigs.set(profileId, next);
    await profiles.openProfile({
      profileId,
      userDataDir: join(opts.dataDir, "profiles", profileId, "chromium"),
      allowedOrigins: next.allowedOrigins,
      approvedOrigins: next.approvedOrigins,
      privateNetwork: "explicit-only",
    });
  };

  const ensureTab = async (command: Extract<ChatWorkspaceDeviceCommand, { kind: "tab.ensure" }>): Promise<void> => {
    const tabId = safeId(command.tab.id, "tabId");
    const profileId = safeId(command.tab.profileId, "profileId");
    const config = profileConfigs.get(profileId);
    if (!config) throw err("profile-not-ready", `local profile ${profileId} has not been ensured`);
    if (!profiles.getTab(tabId)) {
      profiles.registerTab(`device:${command.projectId}`, tabId, profileId, { pinned: command.tab.pinned });
    } else {
      profiles.setPinned(tabId, command.tab.pinned);
    }
    tabProjects.set(tabId, command.projectId);
    await profiles.ensureLive(tabId, command.tab.url || config.homeUrl);
    await activateLocalTab(command.projectId, tabId);
    emitTabState(tabId);
  };

  const livePage = (tabId: string) => {
    const page = profiles.getPage(tabId);
    if (!page) throw err("not-found", `local tab ${tabId} is not live`);
    return page;
  };

  return {
    async execute(command) {
      try {
        switch (command.kind) {
          case "profile.ensure":
            await ensureProfile(command);
            break;
          case "profile.close":
            await profiles.closeProfile(safeId(command.profileId, "profileId"));
            profileConfigs.delete(command.profileId);
            break;
          case "tab.ensure":
            await ensureTab(command);
            break;
          case "tab.activate": {
            const tab = profiles.getTab(command.tabId);
            if (!tab) throw err("not-found", `local tab ${command.tabId} not found`);
            tabProjects.set(command.tabId, command.projectId);
            await activateLocalTab(command.projectId, command.tabId);
            emitTabState(command.tabId);
            break;
          }
          case "tab.navigate":
            tabProjects.set(command.tabId, command.projectId);
            await livePage(command.tabId).goto(command.url);
            await installProviderControls(command.tabId);
            emitTabState(command.tabId);
            break;
          case "tab.back":
            await livePage(command.tabId).back();
            emitTabState(command.tabId);
            break;
          case "tab.forward":
            await livePage(command.tabId).forward();
            emitTabState(command.tabId);
            break;
          case "tab.reload":
            await livePage(command.tabId).reload();
            emitTabState(command.tabId);
            break;
          case "tab.stop":
            await livePage(command.tabId).stop();
            emitTabState(command.tabId);
            break;
          case "tab.hibernate": {
            const projectId = tabProjects.get(command.tabId) ?? command.projectId;
            if (activeTabByProject.get(projectId) === command.tabId) activeTabByProject.delete(projectId);
            await profiles.hibernateTab(command.tabId);
            emitTabState(command.tabId);
            break;
          }
          case "tab.restore":
            await profiles.restoreTab(command.tabId, command.url);
            await activateLocalTab(command.projectId, command.tabId);
            emitTabState(command.tabId);
            break;
          case "tab.set-pinned":
            if (!profiles.getTab(command.tabId)) throw err("not-found", `local tab ${command.tabId} not found`);
            profiles.setPinned(command.tabId, command.pinned);
            tabProjects.set(command.tabId, command.projectId);
            emitTabState(command.tabId);
            break;
          case "tab.approve-origin": {
            const tab = profiles.getTab(command.tabId);
            if (!tab) throw err("not-found", `local tab ${command.tabId} not found`);
            const config = profileConfigs.get(tab.profileId);
            if (!config) throw err("profile-not-ready", `local profile ${tab.profileId} is not ready`);
            await profiles.approveOrigin(tab.profileId, command.origin, command.mode, async (origins) => {
              config.approvedOrigins = new Set(origins);
            });
            if (command.retryUrl) await livePage(command.tabId).goto(command.retryUrl);
            await installProviderControls(command.tabId);
            emitTabState(command.tabId);
            break;
          }
          case "tab.extract": {
            const tab = profiles.getTab(command.tabId);
            if (!tab) throw err("not-found", `local tab ${command.tabId} not found`);
            const profile = profileConfigs.get(tab.profileId);
            if (!profile) throw err("profile-not-ready", `local profile ${tab.profileId} is not ready`);
            const page = livePage(command.tabId);
            const adapter = providerAdapter(profile.providerId);
            const extracted = page.extractManualHandoff
              ? await page.extractManualHandoff({
                  scope: command.scope,
                  assistantMessageSelectors: adapter?.assistantMessageSelectors ?? [],
                  ...(command.responseId ? { responseId: command.responseId } : {}),
                })
              : {
                  text: await page.copySelection(),
                  scope: "selection" as const,
                  ...page.current(),
                };
            if (!extracted.text.trim()) throw err("empty-selection", "no external chat text is available for handoff");
            opts.emit({
              kind: "handoff",
              eventId: randomUUID(),
              action: "add-to-agent",
              handoff: buildExternalChatHandoff({
                providerId: profile.providerId,
                providerName: providerById(profile.providerId)?.name ?? profile.providerId,
                profileId: tab.profileId,
                tabId: command.tabId,
                projectId: command.projectId,
                url: extracted.url,
                title: extracted.title,
                scope: extracted.scope,
                text: extracted.text,
              }),
            });
            break;
          }
          case "tab.close": {
            const projectId = tabProjects.get(command.tabId) ?? command.projectId;
            if (activeTabByProject.get(projectId) === command.tabId) activeTabByProject.delete(projectId);
            await profiles.releaseTabPage(command.tabId);
            profiles.unregisterTab(command.tabId);
            tabProjects.delete(command.tabId);
            opts.emit({ kind: "tab.closed", projectId: command.projectId, tabId: command.tabId });
            break;
          }
        }
        return ack(command.requestId);
      } catch (error) {
        const failure = error as Error & { code?: string };
        return {
          requestId: command.requestId,
          ok: false,
          code: failure.code ?? "runtime-error",
          message: failure.message,
        };
      }
    },

    async close() {
      for (const disposal of disposals.splice(0)) disposal.dispose();
      activeTabByProject.clear();
      tabProjects.clear();
      profileConfigs.clear();
      await profiles.closeAll();
    },
  };
}
