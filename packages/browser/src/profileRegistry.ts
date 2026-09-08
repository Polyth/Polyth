// Profile registry for chat-workspace: one browser process per profile,
// many manual-only tabs, LRU hibernation, and agent API guard ids.
import { randomUUID } from "node:crypto";
import type { ContentAccessPolicy, Disposable } from "@polyth/contracts";
import type { ProfileContext, ProfileDriver, ProfilePage, ScreencastFrame } from "./profileDriver.ts";
import { MANUAL_ONLY_POLICY } from "./profileDriver.ts";
import { checkUrl, isInternalBrowserUrl, originOf, type PrivateNetworkPolicy, type UrlPolicyOptions } from "./policy.ts";

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export interface ProfileRegistryOptions {
  driver: ProfileDriver | null;
  unavailableReason?: string;
  liveTabLimit?: number;
  hibernateDelayMs?: number;
}

interface SpaceRuntimePolicy {
  liveTabLimit: number;
  hibernateDelayMs: number;
}

export interface ProfileOpenInput {
  profileId: string;
  userDataDir: string;
  allowedOrigins: ReadonlyArray<string>;
  approvedOrigins?: ReadonlySet<string>;
  privateNetwork?: PrivateNetworkPolicy;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  colorScheme?: import("@polyth/contracts").BrowserColorScheme;
}

export interface TabRecord {
  tabId: string;
  profileId: string;
  spaceKey: string;
  url: string;
  title: string;
  pinned: boolean;
  hibernated: boolean;
  lastActiveAt: number;
  contentAccess: ContentAccessPolicy;
}

export interface ProfileFrame {
  tabId: string;
  revision: number;
  mime: string;
  data: Uint8Array;
  width: number;
  height: number;
  popupId?: string;
}

export interface ProfileRegistryEvent {
  tabId: string;
  kind: string;
  message?: string;
  url?: string;
  origin?: string;
  reason?: string;
  popupId?: string;
  text?: string;
}

export interface ProfileRegistry {
  capability(): { available: boolean; engine: "chromium" | "fake" | null; reason?: string };
  isChatTab(id: string): boolean;
  listChatTabIds(): string[];
  registerTab(spaceKey: string, tabId: string, profileId: string, opts?: { pinned?: boolean }): TabRecord;
  unregisterTab(tabId: string): void;
  releaseTabPage(tabId: string): Promise<void>;
  getTab(tabId: string): TabRecord | null;
  touchTab(tabId: string): void;
  setPinned(tabId: string, pinned: boolean): void;
  openProfile(input: ProfileOpenInput): Promise<void>;
  closeProfile(profileId: string): Promise<void>;
  getPage(tabId: string): ProfilePage | null;
  ensureLive(tabId: string, url: string): Promise<TabRecord>;
  hibernateTab(tabId: string): Promise<TabRecord>;
  restoreTab(tabId: string, url: string): Promise<TabRecord>;
  approveOrigin(
    profileId: string,
    origin: string,
    mode: "once" | "always",
    persist: (origins: string[]) => Promise<void>,
  ): Promise<void>;
  setLiveTabLimit(spaceId: string, limit: number): void;
  setHibernateDelayMs(spaceId: string, ms: number): void;
  setActiveTab(tabId: string | null): void;
  onFrame(cb: (frame: ProfileFrame) => void): Disposable;
  onEvent(cb: (event: ProfileRegistryEvent) => void): Disposable;
  popupInput(tabId: string, popupId: string, input: Record<string, unknown>): Promise<void>;
  closePopup(tabId: string, popupId: string): Promise<void>;
  closeAll(): Promise<void>;
}

interface ProfileState {
  context: ProfileContext;
  allowedOrigins: string[];
  approvedOrigins: Set<string>;
  privateNetwork: PrivateNetworkPolicy;
  pages: Map<string, ProfilePage>;
}

const defaultPolicy = (): SpaceRuntimePolicy => ({
  liveTabLimit: 4,
  hibernateDelayMs: 15 * 60_000,
});

export function createProfileRegistry(opts: ProfileRegistryOptions): ProfileRegistry {
  const driver = opts.driver;
  const spacePolicies = new Map<string, SpaceRuntimePolicy>();
  const defaultLiveTabLimit = opts.liveTabLimit ?? 4;
  const defaultHibernateDelayMs = opts.hibernateDelayMs ?? 15 * 60_000;
  const activeTabBySpace = new Map<string, string | null>();
  const chatTabIds = new Set<string>();
  const tabs = new Map<string, TabRecord>();
  const profiles = new Map<string, ProfileState>();
  const frameRevisions = new Map<string, number>();
  const frameCbs = new Set<(f: ProfileFrame) => void>();
  const eventCbs = new Set<(e: ProfileRegistryEvent) => void>();
  const hibernateTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const emit = (event: ProfileRegistryEvent) => { for (const cb of [...eventCbs]) cb(event); };
  const emitFrame = (tabId: string, frame: ScreencastFrame, popupId?: string) => {
    const key = popupId ? `${tabId}:${popupId}` : tabId;
    const revision = (frameRevisions.get(key) ?? 0) + 1;
    frameRevisions.set(key, revision);
    const out: ProfileFrame = {
      tabId,
      revision,
      mime: frame.mime,
      data: frame.data,
      width: frame.width,
      height: frame.height,
      ...(popupId ? { popupId } : {}),
    };
    for (const cb of [...frameCbs]) cb(out);
  };

  const policyFor = (profile: ProfileState): UrlPolicyOptions => ({
    allowedOrigins: profile.allowedOrigins,
    approvedOrigins: profile.approvedOrigins,
    privateNetwork: profile.privateNetwork,
  });

  const spaceIdOf = (spaceKey: string): string => spaceKey.split(":")[0] ?? spaceKey;

  const policyForSpace = (spaceId: string): SpaceRuntimePolicy => {
    let policy = spacePolicies.get(spaceId);
    if (!policy) {
      policy = {
        liveTabLimit: defaultLiveTabLimit,
        hibernateDelayMs: defaultHibernateDelayMs,
      };
      spacePolicies.set(spaceId, policy);
    }
    return policy;
  };

  const activeTabInSpace = (spaceId: string): string | null => activeTabBySpace.get(spaceId) ?? null;

  const clearFrameRevisions = (tabId: string): void => {
    frameRevisions.delete(tabId);
    for (const key of [...frameRevisions.keys()]) {
      if (key.startsWith(`${tabId}:`)) frameRevisions.delete(key);
    }
  };

  const scheduleHibernate = (tabId: string): void => {
    const existing = hibernateTimers.get(tabId);
    if (existing) clearTimeout(existing);
    const tab = tabs.get(tabId);
    if (!tab) return;
    const spaceId = spaceIdOf(tab.spaceKey);
    if (tab.hibernated || tab.pinned || tabId === activeTabInSpace(spaceId)) return;
    const delay = policyForSpace(spaceId).hibernateDelayMs;
    const timer = setTimeout(() => {
      hibernateTimers.delete(tabId);
      const current = tabs.get(tabId);
      if (!current) return;
      const currentSpaceId = spaceIdOf(current.spaceKey);
      if (current.hibernated || current.pinned || tabId === activeTabInSpace(currentSpaceId)) return;
      void registry.hibernateTab(tabId).catch(() => {});
    }, delay);
    timer.unref?.();
    hibernateTimers.set(tabId, timer);
  };

  const liveTabsInSpace = (spaceId: string): TabRecord[] =>
    [...tabs.values()].filter((t) => !t.hibernated && spaceIdOf(t.spaceKey) === spaceId);

  const pickEvictionCandidate = (spaceKey: string, exceptTabId?: string): TabRecord | null => {
    const spaceId = spaceIdOf(spaceKey);
    const activeId = activeTabInSpace(spaceId);
    const candidates = liveTabsInSpace(spaceId)
      .filter((t) => t.tabId !== exceptTabId && !t.pinned && t.tabId !== activeId)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    return candidates[0] ?? null;
  };

  const registry: ProfileRegistry = {
    capability() {
      if (!driver) {
        return {
          available: false,
          engine: null,
          reason: opts.unavailableReason ?? "browser engine unavailable",
        };
      }
      return { available: true, engine: driver.engine };
    },

    isChatTab(id: string) {
      return chatTabIds.has(id);
    },

    listChatTabIds() {
      return [...chatTabIds];
    },

    registerTab(spaceKey, tabId, profileId, tabOpts = {}) {
      const record: TabRecord = {
        tabId,
        profileId,
        spaceKey,
        url: "about:blank",
        title: "",
        pinned: tabOpts.pinned ?? false,
        hibernated: false,
        lastActiveAt: Date.now(),
        contentAccess: MANUAL_ONLY_POLICY,
      };
      tabs.set(tabId, record);
      chatTabIds.add(tabId);
      return { ...record };
    },

    async releaseTabPage(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) return;
      const profile = profiles.get(tab.profileId);
      const page = profile?.pages.get(tabId);
      if (page) {
        await page.close();
        profile?.pages.delete(tabId);
      }
      clearFrameRevisions(tabId);
    },

    unregisterTab(tabId) {
      const tab = tabs.get(tabId);
      if (tab) {
        const spaceId = spaceIdOf(tab.spaceKey);
        if (activeTabInSpace(spaceId) === tabId) activeTabBySpace.delete(spaceId);
      }
      chatTabIds.delete(tabId);
      tabs.delete(tabId);
      clearFrameRevisions(tabId);
      const timer = hibernateTimers.get(tabId);
      if (timer) clearTimeout(timer);
      hibernateTimers.delete(tabId);
    },

    getTab(tabId) {
      const t = tabs.get(tabId);
      return t ? { ...t } : null;
    },

    touchTab(tabId) {
      const t = tabs.get(tabId);
      if (!t) return;
      t.lastActiveAt = Date.now();
      scheduleHibernate(tabId);
    },

    setPinned(tabId, pinned) {
      const t = tabs.get(tabId);
      if (!t) throw err("not-found", `tab ${tabId} not found`);
      t.pinned = pinned;
      scheduleHibernate(tabId);
    },

    async openProfile(input) {
      if (!driver) throw err("unavailable", registry.capability().reason ?? "unavailable");
      if (profiles.has(input.profileId)) return;
      const approved = new Set(input.approvedOrigins ?? []);
      const context = await driver.openProfile({
        profileId: input.profileId,
        userDataDir: input.userDataDir,
        viewport: {
          width: input.viewport?.width ?? 1280,
          height: input.viewport?.height ?? 800,
          deviceScaleFactor: input.viewport?.deviceScaleFactor ?? 1,
        },
        colorScheme: input.colorScheme ?? "no-preference",
        listedOrigins: [...input.allowedOrigins, ...(input.approvedOrigins ?? [])],
        guardNavigation: async (url, kind = "top-level") => {
          const profile = profiles.get(input.profileId);
          if (!profile) return;
          if (isInternalBrowserUrl(url)) return;
          const decision = await checkUrl(url, {
            ...policyFor(profile),
            purpose: kind === "top-level" ? "top-level" : "subresource",
          });
          if (decision.ok) return;
          throw err(decision.code, decision.reason);
        },
      });
      profiles.set(input.profileId, {
        context,
        allowedOrigins: [...input.allowedOrigins],
        approvedOrigins: approved,
        privateNetwork: input.privateNetwork ?? "allow",
        pages: new Map(),
      });
    },

    async closeProfile(profileId) {
      const profile = profiles.get(profileId);
      if (!profile) return;
      await profile.context.close();
      profiles.delete(profileId);
    },

    getPage(tabId) {
      const tab = tabs.get(tabId);
      if (!tab || tab.hibernated) return null;
      const profile = profiles.get(tab.profileId);
      if (!profile) return null;
      return profile.pages.get(tabId) ?? null;
    },

    async ensureLive(tabId, url) {
      const tab = tabs.get(tabId);
      if (!tab) throw err("not-found", `tab ${tabId} not found`);
      if (!tab.hibernated && registry.getPage(tabId)) {
        registry.touchTab(tabId);
        return { ...tab };
      }
      const spaceId = spaceIdOf(tab.spaceKey);
      const { liveTabLimit } = policyForSpace(spaceId);
      while (liveTabsInSpace(spaceId).length >= liveTabLimit) {
        const victim = pickEvictionCandidate(tab.spaceKey, tabId);
        if (!victim) break;
        emit({
          tabId: victim.tabId,
          kind: "hibernate-notice",
          message: `${victim.title || victim.tabId} will be hibernated to open ${tab.title || tabId}`,
        });
        await registry.hibernateTab(victim.tabId);
      }
      let profile = profiles.get(tab.profileId);
      if (!profile) throw err("not-found", `profile ${tab.profileId} not open`);
      let page = profile.pages.get(tabId);
      if (!page) {
        page = await profile.context.newPage(tabId);
        profile.pages.set(tabId, page);
        const bound = page;
        bound.onFrame((frame) => emitFrame(tabId, frame));
        bound.onPopupFrame = (popupId, frame) => emitFrame(tabId, frame, popupId);
        bound.onEvent((ev) => {
          emit({
            tabId,
            ...ev,
            ...(ev.kind === "approval-required" && ev.reason ? { message: ev.reason } : {}),
          });
          if (ev.kind === "navigation" && ev.url) {
            tab.url = ev.url;
            const nav = bound.current();
            if (nav.title) tab.title = nav.title;
          }
        });
      } else if (!page.onPopupFrame) {
        page.onPopupFrame = (popupId, frame) => emitFrame(tabId, frame, popupId);
      }
      if (tab.hibernated) {
        const nav = await page.restore(url || tab.url);
        tab.url = nav.url;
        tab.title = nav.title;
        tab.hibernated = false;
      } else if (url && url !== tab.url) {
        const nav = await page.goto(url);
        tab.url = nav.url;
        tab.title = nav.title;
      }
      registry.touchTab(tabId);
      return { ...tab };
    },

    async hibernateTab(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw err("not-found", `tab ${tabId} not found`);
      const profile = profiles.get(tab.profileId);
      const page = profile?.pages.get(tabId);
      if (page && !tab.hibernated) {
        const snap = await page.hibernate();
        tab.url = snap.url;
        tab.title = snap.title;
      }
      tab.hibernated = true;
      return { ...tab };
    },

    async restoreTab(tabId, url) {
      return registry.ensureLive(tabId, url);
    },

    async approveOrigin(profileId, origin, mode, persist) {
      const profile = profiles.get(profileId);
      if (!profile) throw err("not-found", `profile ${profileId} not found`);
      const o = originOf(origin);
      if (!o) throw err("invalid-input", `not a valid origin: ${origin}`);
      profile.approvedOrigins.add(o);
      if (mode === "always") await persist([...profile.approvedOrigins]);
    },

    setLiveTabLimit(spaceId, limit) {
      const policy = policyForSpace(spaceId);
      policy.liveTabLimit = Math.max(1, limit);
    },

    setHibernateDelayMs(spaceId, ms) {
      const policy = policyForSpace(spaceId);
      policy.hibernateDelayMs = Math.max(60_000, ms);
    },

    setActiveTab(tabId) {
      if (!tabId) return;
      const tab = tabs.get(tabId);
      if (!tab) return;
      const spaceId = spaceIdOf(tab.spaceKey);
      activeTabBySpace.set(spaceId, tabId);
      const timer = hibernateTimers.get(tabId);
      if (timer) clearTimeout(timer);
      hibernateTimers.delete(tabId);
    },

    onFrame(cb) {
      frameCbs.add(cb);
      return { dispose: () => { frameCbs.delete(cb); } };
    },

    onEvent(cb) {
      eventCbs.add(cb);
      return { dispose: () => { eventCbs.delete(cb); } };
    },

    async popupInput(tabId, popupId, input) {
      const page = registry.getPage(tabId);
      if (!page?.popupInput) throw err("not-found", `popup ${popupId} not found`);
      await page.popupInput(popupId, input);
    },

    async closePopup(tabId, popupId) {
      const page = registry.getPage(tabId);
      if (!page?.closePopup) throw err("not-found", `popup ${popupId} not found`);
      await page.closePopup(popupId);
    },

    async closeAll() {
      for (const timer of hibernateTimers.values()) clearTimeout(timer);
      hibernateTimers.clear();
      for (const tabId of [...tabs.keys()]) {
        await registry.releaseTabPage(tabId);
      }
      for (const profile of profiles.values()) await profile.context.close();
      profiles.clear();
      tabs.clear();
      chatTabIds.clear();
      frameRevisions.clear();
      activeTabBySpace.clear();
    },
  };

  return registry;
}

export function newChatTabId(): string {
  return randomUUID();
}
