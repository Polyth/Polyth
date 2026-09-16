import { useCallback, useEffect, useState } from "react";
import type { ChatProfileDto, ChatProviderDto, ChatTabDto, ChatWorkspaceSettingsDto, ContextBundleDto, HandoffBundleStaleDto } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
import { ApiError } from "@polyth/web-sdk";
import type { WebPackageHost } from "@polyth/web-sdk";
import { mostRecentProfile } from "./lib/commands.ts";
import { workspaceFromDto } from "./lib/workspaceClient.ts";
import { presetById, mergePresetSources, bundleCopyText } from "@polyth/handoff";
import { createHandoffClient, hashText, noteNewSessionHandoffPending, SendSheet } from "@polyth/handoff/web";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { useStore, getState } from "../../../apps/web/src/store.ts";
import { ChatWorkspaceDock } from "./ChatWorkspaceDock.tsx";
import {
  ChatWorkspaceEmptyState,
  ChatWorkspaceTabStrip,
  CustomChatDialog,
} from "./ChatWorkspaceTabStrip.tsx";
import {
  ChatWorkspaceViewport,
  ViewportFailure,
  type ChatWorkspaceSelectionAction,
} from "./ChatWorkspaceViewport.tsx";
import {
  registerChatWorkspaceCommandConsumer,
  type ChatWorkspacePendingCommand,
} from "./lib/pendingCommands.ts";

const transport = createApiTransport();

export default function ChatWorkspaceView(props: {
  host: WebPackageHost;
  active: boolean;
}) {
  const { active } = props;
  const handoff = createHandoffClient(transport, props.host);
  const projectId = useStore((s) => s.activeProjectId);
  const sessionId = useStore((s) => s.activeSessionId);
  const sessionTitle = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.title ?? "Session");
  const models = useStore((s) => s.models);
  const [changedFiles, setChangedFiles] = useState<string[]>([]);
  const [providers, setProviders] = useState<ChatProviderDto[]>([]);
  const [profiles, setProfiles] = useState<ChatProfileDto[]>([]);
  const [tabs, setTabs] = useState<ChatTabDto[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ChatWorkspaceSettingsDto | null>(null);
  const [bundle, setBundle] = useState<ContextBundleDto | null>(null);
  const [stale, setStale] = useState<HandoffBundleStaleDto | null>(null);
  const [copied, setCopied] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [browserOk, setBrowserOk] = useState(true);
  const [profileLocked, setProfileLocked] = useState(false);
  const [addPopoverOpen, setAddPopoverOpen] = useState(false);
  const [drawer, setDrawer] = useState<{
    open: boolean;
    presetId: string;
    presetLabel: string;
    instruction: string;
    presetSourceIds: string[];
  } | null>(null);
  const [mismatchKept, setMismatchKept] = useState(false);
  const [bundleNotice, setBundleNotice] = useState<string | null>(null);
  const [excludedSectionIds, setExcludedSectionIds] = useState<Set<string>>(new Set());
  const [harnessName, setHarnessName] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    const [provRes, profRes, workspace, cap, wsSettings] = await Promise.all([
      transport.get<{ providers: ChatProviderDto[] }>("/api/chat-workspace/providers"),
      transport.get<{ profiles: ChatProfileDto[] }>("/api/chat-workspace/profiles"),
      transport.get<{ tabs: ChatTabDto[]; activeTabId: string | null; order: string[] }>(
        `/api/chat-workspace/projects/${encodeURIComponent(projectId)}/workspace`,
      ),
      transport.get<{ available: boolean; reason?: string }>("/api/chat-workspace/capability"),
      transport.get<ChatWorkspaceSettingsDto>("/api/chat-workspace/settings"),
    ]);
    setProviders(provRes.providers);
    setProfiles(profRes.profiles);
    setTabs(workspace.tabs);
    setOrder(workspace.order.length ? workspace.order : workspace.tabs.map((t) => t.id));
    setActiveTabId(workspace.activeTabId);
    setBrowserOk(cap.available);
    setSettings(wsSettings);
  }, [projectId]);

  // A missing browser runtime is a state to show, not an unhandled rejection.
  useEffect(() => {
    void load().catch((error) => setBundleNotice(error instanceof Error ? error.message : String(error)));
  }, [load]);

  useEffect(() => {
    if (!sessionId) {
      setHarnessName(null);
      return;
    }
    const session = getState().sessions.find((item) => item.id === sessionId);
    if (!session?.resolvedHarnessId) {
      setHarnessName(null);
      return;
    }
    void transport.get<Array<{ id: string; name: string }>>("/api/harnesses")
      .then((rows) => setHarnessName(rows.find((row) => row.id === session.resolvedHarnessId)?.name ?? null))
      .catch(() => setHarnessName(null));
  }, [sessionId]);

  useEffect(() => {
    if (!projectId) return;
    void transport.get<{ staged: Array<{ path: string }>; unstaged: Array<{ path: string }>; untracked: string[] }>(
      `/api/git/status?projectId=${encodeURIComponent(projectId)}`,
    ).then((status) => {
      const paths = [
        ...status.staged.map((f) => f.path),
        ...status.unstaged.map((f) => f.path),
        ...status.untracked,
      ];
      setChangedFiles([...new Set(paths)]);
    }).catch(() => setChangedFiles([]));
  }, [projectId]);

  useEffect(() => {
    setMismatchKept(false);
  }, [bundle?.id, sessionId]);

  useEffect(() => {
    if (!bundle || !projectId || !sessionId) return;
    void handoff.checkStale(projectId, sessionId, bundle.id).then(setStale);
  }, [bundle, projectId, sessionId, handoff]);

  const applyWorkspace = (workspace: { tabs: ChatTabDto[]; order: string[]; activeTabId: string | null }) => {
    setTabs(workspace.tabs);
    setOrder(workspace.order);
    setActiveTabId(workspace.activeTabId);
  };

  const openProvider = async (providerId: string, url?: string, custom?: { name: string; url: string; profileId?: string; approvedOrigins?: string[] }) => {
    if (!projectId) return;
    let profileId = custom?.profileId;
    try {
      if (!profileId) {
        let profile = custom
          ? undefined
          : mostRecentProfile(profiles, providerId);
        if (!profile) {
          profile = await transport.post<ChatProfileDto>("/api/chat-workspace/profiles", {
            providerId,
            ...(custom ? { name: custom.name, customUrl: custom.url } : {}),
          });
          setProfiles((prev) => [...prev, profile!]);
        }
        profileId = profile.id;
        if (custom?.approvedOrigins?.length) {
          await transport.patch(`/api/chat-workspace/profiles/${encodeURIComponent(profileId)}`, { approvedOrigins: custom.approvedOrigins });
        }
      }
      await transport.post<ChatTabDto>(
        `/api/chat-workspace/projects/${encodeURIComponent(projectId)}/tabs`,
        { profileId, ...(url || custom?.url ? { url: url ?? custom?.url } : {}) },
      );
      const workspace = await transport.get<{ tabs: ChatTabDto[]; activeTabId: string | null; order: string[] }>(
        `/api/chat-workspace/projects/${encodeURIComponent(projectId)}/workspace`,
      );
      applyWorkspace(workspaceFromDto(workspace));
    } catch (error) {
      if (error instanceof ApiError && error.code === "profile-locked") {
        setProfileLocked(true);
        return;
      }
      setBundleNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const buildPreset = async (presetId: string, label: string, instruction: string, sourceIds: string[]) => {
    if (!projectId || !sessionId) return;
    const preset = presetById(presetId);
    const created = await handoff.createBundle({
      projectId,
      sessionId,
      presetId,
      label: preset?.label ?? label,
      instruction: instruction || preset?.instruction || "",
      sources: mergePresetSources(presetId, sourceIds.map((id) => ({ id }))),
      ...(settings?.warnTokenThreshold !== undefined ? { warnTokenThreshold: settings.warnTokenThreshold } : {}),
    });
    setBundle(created);
    setCopied(false);
    return created;
  };

  const copyBundleToClipboard = useCallback(async (): Promise<boolean> => {
    if (!bundle) {
      setBundleNotice("Prepare context first — open Chat Workspace and build a bundle.");
      props.host.navigation.openWorkspacePane("chat-workspace");
      return false;
    }
    const text = bundleCopyText(bundle, excludedSectionIds);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setBundleNotice(null);
    return true;
  }, [bundle, excludedSectionIds, props.host]);

  useEffect(() => {
    if (!projectId) {
      registerChatWorkspaceCommandConsumer(null);
      return;
    }
    const applyCommand = (command: ChatWorkspacePendingCommand) => {
      switch (command.kind) {
        case "show-prepared-bundle":
          setBundle(command.bundle);
          setExcludedSectionIds(new Set());
          setCopied(false);
          setBundleNotice(null);
          setDrawer({
            open: true,
            presetId: command.presetId,
            presetLabel: command.presetLabel,
            instruction: command.instruction,
            presetSourceIds: command.presetSourceIds,
          });
          break;
        case "set-bundle":
          setBundle(command.bundle);
          setExcludedSectionIds(new Set());
          setCopied(false);
          setBundleNotice(null);
          break;
        case "open-drawer":
          setDrawer({ open: true, ...command });
          break;
        case "open-paste":
          void navigator.clipboard.readText().then((text) => {
            setPasteText(text);
            setSendOpen(true);
          });
          break;
        case "copy-bundle":
          void copyBundleToClipboard();
          break;
        case "notify":
          setBundleNotice(command.message);
          break;
        default:
          break;
      }
    };
    registerChatWorkspaceCommandConsumer({
      projectId,
      sessionId,
      apply: applyCommand,
    });
    return () => { registerChatWorkspaceCommandConsumer(null); };
  }, [projectId, sessionId, copyBundleToClipboard]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeProfile = activeTab ? profiles.find((p) => p.id === activeTab.profileId) : null;
  const providerName = activeProfile
    ? (providers.find((p) => p.id === activeProfile.providerId)?.name ?? activeTab?.title ?? "chat")
    : "chat";
  const providerId = activeProfile?.providerId ?? "custom";

  const handoffSelection = async (rawText: string, action: ChatWorkspaceSelectionAction) => {
    if (!projectId) return;
    const text = rawText.replace(/\r\n?/g, "\n").trim();
    if (!text) return;
    const currentSession = sessionId ? getState().sessions.find((item) => item.id === sessionId) ?? null : null;
    const provenance = {
      sourceKind: "chat-workspace" as const,
      provider: providerName,
      profileName: activeProfile?.name ?? "Personal",
    };
    const source = `External ${providerName} chat${activeTab?.title ? ` — ${activeTab.title}` : ""}`;
    const payload = action === "ask-agent"
      ? `Review the following ${source} selection in the context of this project. Verify it rather than assuming it is correct.\n\n${text}`
      : `${source}\n\n${text}`;
    const target = action === "new-agent-chat"
      ? "new-session"
      : handoff.defaultTarget(currentSession);

    await handoff.executeTarget(target, projectId, sessionId, payload);
    if (target === "new-session") {
      noteNewSessionHandoffPending(projectId, provenance, payload);
    } else if (sessionId) {
      await handoff.recordImport(sessionId, provenance, hashText(payload));
    }
    setBundleNotice(action === "new-agent-chat" ? "Started a new Polyth chat from the selection." : "Added the selection to Polyth.");
  };

  if (!projectId) {
    return <EmptyState title="Chat Workspace" description="Open a project to use Chat Workspace." />;
  }

  if (!browserOk) {
    return (
      <div className="chat-workspace">
        <ViewportFailure
          title="Chat Workspace needs a browser runtime."
          body="Chromium was not found."
          actions={[
            { label: "Configure browser", onClick: () => props.host.navigation.openSettingsPage("browser") },
            { label: "Open externally", onClick: () => activeTab && window.open(activeTab.url, "_blank") },
          ]}
        />
      </div>
    );
  }

  return (
    <div className="chat-workspace">
      <ChatWorkspaceTabStrip
        transport={transport}
        projectId={projectId}
        tabs={tabs}
        order={order}
        activeTabId={activeTabId}
        providers={providers}
        profiles={profiles}
        onSelect={setActiveTabId}
        onWorkspaceChange={applyWorkspace}
        onOpenProvider={(id, url, profileId) => void openProvider(id, url, profileId ? { name: "", url: url ?? "", profileId } : undefined)}
        onCustomOpen={() => setCustomOpen(true)}
        addPopoverOpen={addPopoverOpen}
        onAddPopoverOpenChange={setAddPopoverOpen}
        closeMenus={Boolean(drawer?.open || sendOpen)}
      />
      {tabs.length === 0 ? (
        <div className="chat-workspace-viewport">
          <ChatWorkspaceEmptyState
            providers={providers}
            onOpenProvider={(id) => void openProvider(id)}
            onCustom={() => setCustomOpen(true)}
          />
        </div>
      ) : (
        <ChatWorkspaceViewport
          transport={transport}
          projectId={projectId}
          tabId={activeTabId}
          visible={active}
          quality={settings?.streamQuality ?? 60}
          providerName={providerName}
          loading={activeTab?.hibernated}
          profileLocked={profileLocked}
          onProfileLockedChange={setProfileLocked}
          onOpenProfileChooser={() => setAddPopoverOpen(true)}
          onHandoffSelection={handoffSelection}
        />
      )}
      <ChatWorkspaceDock
        client={handoff}
        projectId={projectId}
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        providerId={providerId}
        providerName={providerName}
        tabTitle={activeTab?.title ?? activeProfile?.name ?? null}
        bundle={bundle}
        excludedSectionIds={excludedSectionIds}
        changedFiles={changedFiles}
        warnTokenThreshold={settings?.warnTokenThreshold}
        stale={stale}
        copied={copied}
        drawer={drawer}
        onExcludedSectionsChange={setExcludedSectionIds}
        onOpenDrawer={(input) => setDrawer({ open: true, ...input })}
        onCloseDrawer={() => setDrawer(null)}
        onBundle={(next) => { setBundle(next); setExcludedSectionIds(new Set()); }}
        onCopied={setCopied}
        onPasteResult={async () => {
          setPasteText(await navigator.clipboard.readText());
          setSendOpen(true);
        }}
        onBuild={(presetId, label, instruction, sourceIds) => void buildPreset(presetId, label, instruction, sourceIds)}
        mismatchKept={mismatchKept}
        onKeepMismatch={() => setMismatchKept(true)}
        onDiscardBundle={() => { setBundle(null); setCopied(false); }}
        onRegenerateMismatch={() => {
          if (!bundle) return;
          const preset = presetById(bundle.presetId);
          void buildPreset(
            bundle.presetId,
            preset?.label ?? bundle.label,
            preset?.instruction ?? bundle.instruction,
            preset?.sources.map((source) => source.id) ?? [],
          );
        }}
      />
      {bundleNotice ? <p className="chat-workspace-notice">{bundleNotice}</p> : null}
      <CustomChatDialog
        open={customOpen}
        profiles={profiles}
        onClose={() => setCustomOpen(false)}
        onAdd={(input) => void openProvider("custom", input.url, input)}
      />
      {sendOpen ? (
        <SendSheet
          client={handoff}
          projectId={projectId}
          session={sessionId ? getState().sessions.find((s) => s.id === sessionId) ?? null : null}
          sessionId={sessionId}
          harnessName={harnessName}
          models={models}
          text={pasteText}
          preferredTarget={settings?.defaultTarget}
          provenance={{
            sourceKind: "chat-workspace",
            provider: providerName,
            profileName: activeProfile?.name ?? "Personal",
            ...(bundle ? { bundleId: bundle.id, bundleLabel: bundle.label } : {}),
          }}
          onClose={() => setSendOpen(false)}
        />
      ) : null}
    </div>
  );
}
