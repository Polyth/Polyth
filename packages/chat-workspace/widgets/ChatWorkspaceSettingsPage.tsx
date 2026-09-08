import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createApiTransport } from "@polyth/web-sdk";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { ChatProfileDto, ChatProviderDto, ChatWorkspaceSettingsDto } from "@polyth/contracts";
import { Row } from "../../../apps/web/src/components/settings/parts.tsx";
import Dialog from "../../../apps/web/src/components/a11y/Dialog.tsx";
import { Button, Menu, Select, Switch, TextInput, type MenuEntry } from "../../../apps/web/src/components/ui/index.ts";
import { formatRelativeTime } from "../../../apps/web/src/i18n/index.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import { CHAT_PROVIDERS } from "../src/providers.ts";
import { customProfileHost } from "./lib/profileHost.ts";

const api = createApiTransport();
const STREAM_QUALITY_OPTIONS = [
  { value: 40, label: "Low" },
  { value: 60, label: "Balanced" },
  { value: 80, label: "High" },
] as const;

function profileLastUsed(lastUsedAt: number): string {
  const deltaMs = Date.now() - lastUsedAt;
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return formatRelativeTime(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return formatRelativeTime(-hours, "hour");
  const days = Math.round(hours / 24);
  return formatRelativeTime(-days, "day");
}

function profileMeta(profile: ChatProfileDto, custom: boolean): string {
  const lastUsed = `Last used ${profileLastUsed(profile.lastUsedAt)}`;
  if (!custom) return lastUsed;
  const host = customProfileHost(profile.customUrl);
  return host ? `${host} · ${lastUsed}` : lastUsed;
}

export default function ChatWorkspaceSettingsPage(props: { host: WebPackageHost }) {
  const projectId = useStore((state) => state.activeProjectId);
  const [settings, setSettings] = useState<ChatWorkspaceSettingsDto | null>(null);
  const [profiles, setProfiles] = useState<ChatProfileDto[]>([]);
  const [providers] = useState<ChatProviderDto[]>(CHAT_PROVIDERS);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [clearId, setClearId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [menuProfileId, setMenuProfileId] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reloadProfiles = async () => {
    const profileRes = await api.get<{ profiles: ChatProfileDto[] }>("/api/chat-workspace/profiles");
    setProfiles(profileRes.profiles);
  };

  useEffect(() => {
    void Promise.all([
      api.get<ChatWorkspaceSettingsDto>("/api/chat-workspace/settings"),
      reloadProfiles(),
    ]).then(([nextSettings]) => {
      setSettings(nextSettings);
      loadedRef.current = true;
    });
  }, []);

  const persistSettings = useCallback(async (next: ChatWorkspaceSettingsDto) => {
    await api.put("/api/chat-workspace/settings", next);
  }, []);

  const updateSettings = useCallback((patch: Partial<ChatWorkspaceSettingsDto> | ((current: ChatWorkspaceSettingsDto) => ChatWorkspaceSettingsDto)) => {
    setSettings((current) => {
      if (!current) return current;
      const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
      if (loadedRef.current) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => { void persistSettings(next); }, 300);
      }
      return next;
    });
  }, [persistSettings]);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  const saveRename = async (profileId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    const updated = await api.patch<ChatProfileDto>(`/api/chat-workspace/profiles/${encodeURIComponent(profileId)}`, { name: trimmed });
    setProfiles((prev) => prev.map((profile) => (profile.id === profileId ? updated : profile)));
    setRenamingId(null);
  };

  const openProfile = async (profile: ChatProfileDto) => {
    if (!projectId) return;
    await api.post(
      `/api/chat-workspace/projects/${encodeURIComponent(projectId)}/tabs`,
      { profileId: profile.id, ...(profile.customUrl ? { url: profile.customUrl } : {}) },
    );
    props.host.navigation.openWorkspacePane("chat-workspace");
  };

  const clearProfileData = async (profileId: string) => {
    await api.post(`/api/chat-workspace/profiles/${encodeURIComponent(profileId)}/clear-data`, {});
    setClearId(null);
    await reloadProfiles();
  };

  const startRename = (profile: ChatProfileDto) => {
    setRenamingId(profile.id);
    setRenameValue(profile.name);
  };

  const onRenameKey = (event: KeyboardEvent<HTMLInputElement>, profileId: string) => {
    if (event.key === "Enter") void saveRename(profileId, renameValue);
    if (event.key === "Escape") setRenamingId(null);
  };

  if (!settings) return null;

  const catalogGroups = providers
    .filter((provider) => provider.id !== "custom")
    .map((provider) => ({
      provider,
      profiles: profiles.filter((profile) => profile.providerId === provider.id),
    }))
    .filter((group) => group.profiles.length > 0);

  const customProfiles = profiles.filter((profile) => profile.providerId === "custom");
  const hasProfiles = catalogGroups.length > 0 || customProfiles.length > 0;
  const clearProfile = clearId ? profiles.find((profile) => profile.id === clearId) : null;

  const profileMenuEntries = (profile: ChatProfileDto): MenuEntry[] => [
    { id: "open", label: "Open", disabled: !projectId, onSelect: () => void openProfile(profile) },
    { id: "rename", label: "Rename", onSelect: () => startRename(profile) },
    { id: "clear", label: "Clear site data", onSelect: () => setClearId(profile.id) },
    { id: "delete", label: "Delete", onSelect: () => setDeleteId(profile.id) },
  ];

  const renderProfileRow = (profile: ChatProfileDto, custom: boolean) => (
    <div key={profile.id} className="chat-workspace-profile-row">
      <div className="chat-workspace-profile-copy">
        {renamingId === profile.id ? (
          <TextInput
            uiSize="sm"
            value={renameValue}
            autoFocus
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={() => void saveRename(profile.id, renameValue)}
            onKeyDown={(event) => onRenameKey(event, profile.id)}
          />
        ) : (
          <strong>{profile.name}</strong>
        )}
        <span className="chat-workspace-profile-meta">{profileMeta(profile, custom)}</span>
      </div>
      <Menu
        label="Profile actions"
        open={menuProfileId === profile.id}
        onOpenChange={(open) => setMenuProfileId(open ? profile.id : null)}
        entries={profileMenuEntries(profile)}
        align="end"
      >
        {(trigger) => (
          <button {...trigger} type="button" className="chat-workspace-profile-more" aria-label={`Actions for ${profile.name}`}>
            ···
          </button>
        )}
      </Menu>
    </div>
  );

  return (
    <div className="chat-workspace-settings">
      <section className="settings-section" data-settings-item="chat-workspace.general">
        <div className="settings-section-head"><div><span>General</span></div></div>
        <p className="chat-workspace-settings-empty">Chat tabs are restored automatically when you reopen a project.</p>
      </section>

      <section className="settings-section" data-settings-item="chat-workspace.profiles">
        <div className="settings-section-head"><div><span>Profiles</span></div></div>
        {!hasProfiles ? (
          <p className="chat-workspace-settings-empty">No chat profiles yet — open a chat to create one.</p>
        ) : (
          <>
            {catalogGroups.map(({ provider, profiles: list }) => (
              <div key={provider.id} className="chat-workspace-settings-provider">
                <h4 className="chat-workspace-settings-provider-name">{provider.name}</h4>
                {list.map((profile) => renderProfileRow(profile, false))}
              </div>
            ))}
            {customProfiles.length > 0 ? (
              <div className="chat-workspace-settings-provider">
                <h4 className="chat-workspace-settings-provider-name">Custom chats</h4>
                {customProfiles.map((profile) => renderProfileRow(profile, true))}
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="settings-section" data-settings-item="chat-workspace.context-handoff">
        <div className="settings-section-head"><div><span>Context & handoff</span></div></div>
        <Row label="Default send target">
          <Select
            label="Default send target"
            ariaLabel="Default send target"
            value={settings.defaultTarget}
            options={[
              { value: "current-session", label: "Current session" },
              { value: "queue", label: "Queue" },
              { value: "new-session", label: "New session" },
              { value: "draft", label: "Draft only" },
            ]}
            onChange={(value) => updateSettings({ defaultTarget: value as ChatWorkspaceSettingsDto["defaultTarget"] })}
          />
        </Row>
        <Row label="Warn above">
          <input
            type="number"
            min={1}
            value={Math.round(settings.warnTokenThreshold / 1000)}
            onChange={(e) => updateSettings({ warnTokenThreshold: Number(e.target.value) * 1000 })}
          />
          <span>k tokens</span>
        </Row>
      </section>

      <section className="settings-section" data-settings-item="chat-workspace.performance">
        <div className="settings-section-head"><div><span>Performance</span></div></div>
        <Row label="Live tab limit">
          <input
            type="number"
            min={1}
            max={8}
            value={settings.liveTabLimit}
            onChange={(e) => updateSettings({ liveTabLimit: Number(e.target.value) })}
          />
        </Row>
        <Row label="Hibernate delay">
          <input
            type="number"
            min={1}
            value={Math.round(settings.hibernateDelayMs / 60_000)}
            onChange={(e) => updateSettings({ hibernateDelayMs: Number(e.target.value) * 60_000 })}
          />
          <span>minutes</span>
        </Row>
        <Row label="Streaming quality">
          <Select
            label="Streaming quality"
            ariaLabel="Streaming quality"
            value={String(settings.streamQuality)}
            options={STREAM_QUALITY_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
            onChange={(value) => updateSettings({ streamQuality: Number(value) })}
          />
        </Row>
      </section>

      {deleteId ? (
        <Dialog title="Delete profile" onClose={() => setDeleteId(null)}>
          <p>This removes local login/session data for this profile.</p>
          <p>It does not delete your account.</p>
          <div className="handoff-actions">
            <Button variant="ghost" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button variant="danger" onClick={async () => {
              await api.delete(`/api/chat-workspace/profiles/${encodeURIComponent(deleteId)}`);
              setProfiles((prev) => prev.filter((profile) => profile.id !== deleteId));
              setDeleteId(null);
            }}
            >
              Delete
            </Button>
          </div>
        </Dialog>
      ) : null}

      {clearProfile ? (
        <Dialog title={`Clear browser data for ${clearProfile.name}?`} onClose={() => setClearId(null)}>
          <p>This signs you out of this chat on this device.</p>
          <div className="handoff-actions">
            <Button variant="ghost" onClick={() => setClearId(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => void clearProfileData(clearProfile.id)}>Clear</Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
