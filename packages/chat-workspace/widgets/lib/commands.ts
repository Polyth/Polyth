import type { ApiTransport, WebPackageHost } from "@polyth/web-sdk";
import type { ChatProfileDto, ContextBundleDto } from "@polyth/contracts";
import { mergePresetSources, presetById } from "@polyth/handoff";
import { createHandoffClient } from "@polyth/handoff/web";
import { CHAT_PROVIDERS } from "../../src/providers.ts";
import type { CopyContextResult } from "./pendingCommands.ts";

export interface ChatWorkspaceCommandDeps {
  host: WebPackageHost;
  transport: ApiTransport;
  getProjectId(): string | null;
  getSessionId(): string | null;
  copyBundle(): CopyContextResult | Promise<CopyContextResult>;
  onPreparedBundle?(input: {
    bundle: ContextBundleDto;
    drawer: {
      presetId: string;
      presetLabel: string;
      instruction: string;
      presetSourceIds: string[];
    };
  }): void;
  onPasteOpen?(): void;
  onNoSession?(): void;
  onNoBundle?(): void;
}

export function mostRecentProfile(
  profiles: ChatProfileDto[],
  providerId: string,
): ChatProfileDto | undefined {
  return profiles
    .filter((p) => p.providerId === providerId)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
}

export function createChatWorkspaceCommands(deps: ChatWorkspaceCommandDeps) {
  const handoff = createHandoffClient(deps.transport, deps.host);

  const openPane = () => { deps.host.navigation.openWorkspacePane("chat-workspace"); };

  const requireSession = (): { projectId: string; sessionId: string } | null => {
    const projectId = deps.getProjectId();
    const sessionId = deps.getSessionId();
    if (!projectId || !sessionId) {
      deps.onNoSession?.();
      openPane();
      return null;
    }
    return { projectId, sessionId };
  };

  const openPreset = async (presetId: string) => {
    const ctx = requireSession();
    if (!ctx) return;
    const preset = presetById(presetId);
    if (!preset) return;
    const sources = mergePresetSources(presetId, preset.sources);
    const bundle = await handoff.createBundle({
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      presetId,
      label: preset.label,
      instruction: preset.instruction,
      sources,
    });
    deps.onPreparedBundle?.({
      bundle,
      drawer: {
        presetId,
        presetLabel: preset.label,
        instruction: preset.instruction,
        presetSourceIds: sources.map((s) => s.id),
      },
    });
    openPane();
  };

  const copyContext = async () => {
    openPane();
    const result = await deps.copyBundle();
    if (result === "unavailable") deps.onNoBundle?.();
  };

  const pasteResult = async () => {
    deps.onPasteOpen?.();
    openPane();
  };

  const openProviderTab = async (providerId: string, profileId?: string) => {
    const projectId = deps.getProjectId();
    if (!projectId) {
      openPane();
      return;
    }
    openPane();
    const [profRes, workspace] = await Promise.all([
      deps.transport.get<{ profiles: ChatProfileDto[] }>("/api/chat-workspace/profiles"),
      deps.transport.get<{ tabs: Array<{ id: string; profileId: string }>; activeTabId: string | null }>(
        `/api/chat-workspace/projects/${encodeURIComponent(projectId)}/workspace`,
      ),
    ]);
    if (profileId) {
      const existing = workspace.tabs.find((tab) => tab.profileId === profileId);
      if (existing) {
        await deps.transport.post(
          `/api/chat-workspace/tabs/${encodeURIComponent(existing.id)}/activate?projectId=${encodeURIComponent(projectId)}`,
        );
        return;
      }
      await deps.transport.post(
        `/api/chat-workspace/projects/${encodeURIComponent(projectId)}/tabs`,
        { profileId },
      );
      return;
    }
    const profiles = profRes.profiles.filter((p) => p.providerId === providerId);
    for (const tab of workspace.tabs) {
      const profile = profiles.find((p) => p.id === tab.profileId);
      if (profile) {
        await deps.transport.post(
          `/api/chat-workspace/tabs/${encodeURIComponent(tab.id)}/activate?projectId=${encodeURIComponent(projectId)}`,
        );
        return;
      }
    }
    let profile = mostRecentProfile(profRes.profiles, providerId);
    if (!profile) {
      profile = await deps.transport.post<ChatProfileDto>("/api/chat-workspace/profiles", { providerId });
    }
    await deps.transport.post(
      `/api/chat-workspace/projects/${encodeURIComponent(projectId)}/tabs`,
      { profileId: profile.id },
    );
  };

  return {
    openPane,
    openPreset,
    copyContext,
    pasteResult,
    openProviderTab,
    providerCommands: CHAT_PROVIDERS.filter((p) => p.id !== "custom").map((p) => ({
      id: `chat-workspace.open.${p.id}`,
      label: `Chat Workspace: Open ${p.name}`,
      group: "Chat Workspace",
      run: () => void openProviderTab(p.id),
    })),
  };
}
