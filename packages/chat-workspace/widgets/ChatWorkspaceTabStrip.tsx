import { useEffect, useRef, useState } from "react";
import type { ChatProfileDto, ChatProviderDto, ChatTabDto } from "@polyth/contracts";
import type { ApiTransport } from "@polyth/web-sdk";
import {
  Button,
  Dialog,
  Menu,
  Popover,
  TextInput,
  Textarea,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import { compactDomain } from "./lib/viewportGeometry.ts";
import { providerGlyph } from "./lib/providerGlyph.ts";
import {
  buildAddMenuEntries,
  buildStripMenuEntries,
  buildTabContextMenuEntries,
} from "./lib/tabMenus.ts";
import { closeTab, postTabAction, workspaceFromDto } from "./lib/workspaceClient.ts";

export { providerGlyph };

export function CustomChatDialog(props: {
  open: boolean;
  profiles: ChatProfileDto[];
  onClose(): void;
  onAdd(input: { name: string; url: string; profileId?: string; approvedOrigins?: string[] }): void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [profileId, setProfileId] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [origins, setOrigins] = useState("");
  if (!props.open) return null;
  const submit = () => {
    if (!name.trim() || !url.trim()) return;
    props.onAdd({
      name: name.trim(),
      url: url.trim(),
      ...(mode === "existing" && profileId ? { profileId } : {}),
      ...(origins.trim() ? { approvedOrigins: origins.split("\n").map((l) => l.trim()).filter(Boolean) } : {}),
    });
    props.onClose();
  };
  return (
    <Dialog title="Add custom chat" onClose={props.onClose}>
      <div className="chat-workspace-custom-form">
        <label>Name<TextInput value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>URL<TextInput value={url} onChange={(e) => setUrl(e.target.value)} /></label>
        <fieldset>
          <label><input type="radio" checked={mode === "new"} onChange={() => setMode("new")} /> ● New isolated profile</label>
          <label><input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} /> ○ Existing profile…</label>
        </fieldset>
        <button type="button" className="chat-workspace-advanced-toggle" onClick={() => setAdvanced((v) => !v)}>Advanced</button>
        {advanced ? (
          <label>Allowed origins<Textarea value={origins} onChange={(e) => setOrigins(e.target.value)} rows={4} /></label>
        ) : null}
        <Button onClick={submit}>Add</Button>
      </div>
    </Dialog>
  );
}

export function ChatWorkspaceEmptyState(props: {
  providers: ChatProviderDto[];
  onOpenProvider(id: string): void;
  onCustom(): void;
}) {
  return (
    <div className="chat-workspace-empty">
      <h2 className="chat-workspace-empty-title">Chat Workspace</h2>
      <p className="chat-workspace-empty-copy">Use the AI chats you already have.</p>
      <div className="chat-workspace-empty-providers">
        {props.providers.filter((p) => p.id !== "custom").map((provider) => (
          <button
            key={provider.id}
            type="button"
            className="chat-workspace-empty-provider"
            onClick={() => props.onOpenProvider(provider.id)}
          >
            <span className="chat-workspace-empty-glyph" aria-hidden>{providerGlyph(provider.id)}</span>
            <span>{provider.name}</span>
          </button>
        ))}
      </div>
      <button type="button" className="chat-workspace-empty-custom" onClick={props.onCustom}>+ Custom chat</button>
    </div>
  );
}

interface ContextMenuState {
  tabId: string;
  x: number;
  y: number;
}

export function ChatWorkspaceTabStrip(props: {
  transport: ApiTransport;
  projectId: string;
  tabs: ChatTabDto[];
  order: string[];
  activeTabId: string | null;
  providers: ChatProviderDto[];
  profiles: ChatProfileDto[];
  onSelect(tabId: string): void;
  onWorkspaceChange(workspace: { tabs: ChatTabDto[]; order: string[]; activeTabId: string | null }): void;
  onOpenProvider(providerId: string, url?: string, profileId?: string): void;
  onCustomOpen(): void;
  addPopoverOpen?: boolean;
  onAddPopoverOpenChange?(open: boolean): void;
  closeMenus?: boolean;
}) {
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [profilePickerTabId, setProfilePickerTabId] = useState<string | null>(null);
  const [addOpenInternal, setAddOpenInternal] = useState(false);
  const [stripOpen, setStripOpen] = useState(false);
  const [narrowOpen, setNarrowOpen] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const [address, setAddress] = useState("");
  const narrowRef = useRef<HTMLButtonElement>(null);
  const ctxTabRef = useRef<HTMLElement | null>(null);
  const addOpen = props.addPopoverOpen ?? addOpenInternal;
  const setAddOpen = (open: boolean) => {
    if (props.onAddPopoverOpenChange) props.onAddPopoverOpenChange(open);
    else setAddOpenInternal(open);
  };

  const closeAllMenus = () => {
    setCtxMenu(null);
    setStripOpen(false);
    setAddOpen(false);
    setNarrowOpen(false);
    setAddressOpen(false);
  };

  useEffect(() => {
    if (props.closeMenus) closeAllMenus();
  }, [props.closeMenus]);

  const ordered = props.order.map((id) => props.tabs.find((t) => t.id === id)).filter((t): t is ChatTabDto => !!t);
  const active = ordered.find((t) => t.id === props.activeTabId) ?? null;
  const activeProfile = active ? props.profiles.find((p) => p.id === active.profileId) : null;

  const applyWorkspace = (workspace: { tabs: ChatTabDto[]; order: string[]; activeTabId: string | null }) => {
    props.onWorkspaceChange(workspace);
  };

  const tabAction = async (tabId: string, action: string, body?: Record<string, unknown>) => {
    const workspace = await postTabAction(props.transport, props.projectId, tabId, action, body);
    if (workspace) applyWorkspace(workspaceFromDto(workspace));
  };

  const handleCloseTab = async (tabId: string) => {
    const workspace = await closeTab(props.transport, props.projectId, tabId);
    applyWorkspace(workspaceFromDto(workspace));
  };

  const moveTab = async (tabId: string, direction: "left" | "right") => {
    const idx = props.order.indexOf(tabId);
    const swap = direction === "left" ? idx - 1 : idx + 1;
    if (idx < 0 || swap < 0 || swap >= props.order.length) return;
    const beforeId = direction === "right" ? props.order[swap + 1] ?? undefined : props.order[swap];
    await tabAction(tabId, "move", beforeId ? { beforeId } : { index: swap });
  };

  const changeProfile = async (tabId: string, profileId: string) => {
    setProfilePickerTabId(null);
    setCtxMenu(null);
    await tabAction(tabId, "change-profile", { profileId });
  };

  const selectTab = async (tabId: string) => {
    props.onSelect(tabId);
    await tabAction(tabId, "activate");
  };

  const runCtx = async (action: string) => {
    const tab = props.tabs.find((t) => t.id === ctxMenu?.tabId);
    if (!tab) return;
    if (action === "change-profile") {
      setProfilePickerTabId(tab.id);
      return;
    }
    setCtxMenu(null);
    if (action === "reload") await tabAction(tab.id, "reload");
    if (action === "duplicate") await tabAction(tab.id, "duplicate");
    if (action === "move-left") await moveTab(tab.id, "left");
    if (action === "move-right") await moveTab(tab.id, "right");
    if (action === "external") window.open(tab.url, "_blank");
    if (action === "copy") void navigator.clipboard.writeText(tab.url);
    if (action === "pin") await tabAction(tab.id, "pin", { pinned: !tab.pinned });
    if (action === "close") await handleCloseTab(tab.id);
    if (action === "close-others") await tabAction(tab.id, "close-others");
  };

  const ctxTab = ctxMenu ? props.tabs.find((t) => t.id === ctxMenu.tabId) : null;
  const ctxProfile = ctxTab ? props.profiles.find((p) => p.id === ctxTab.profileId) : null;
  const ctxProviderProfiles = ctxProfile
    ? props.profiles.filter((p) => p.providerId === ctxProfile.providerId)
    : [];

  const recentProfiles = [...props.profiles].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 6);

  const ctxEntries: MenuEntry[] = ctxTab
    ? buildTabContextMenuEntries({
      tab: ctxTab,
      hasMultipleProfiles: ctxProviderProfiles.length > 1,
      onAction: (action) => { void runCtx(action); },
    })
    : [];

  const addEntries = buildAddMenuEntries({
    recentProfiles,
    providers: props.providers,
    onOpenProvider: props.onOpenProvider,
    onCustomOpen: props.onCustomOpen,
    close: () => setAddOpen(false),
  });

  const stripEntries = active ? buildStripMenuEntries({
    domainLabel: compactDomain(active.url),
    addressOpen,
    onBack: () => { if (active) void tabAction(active.id, "back"); setStripOpen(false); },
    onForward: () => { if (active) void tabAction(active.id, "forward"); setStripOpen(false); },
    onReload: () => { if (active) void tabAction(active.id, "reload"); setStripOpen(false); },
    onShowAddress: () => {
      if (active) setAddress(active.url);
      setAddressOpen(true);
    },
    onCopyUrl: () => {
      if (active) void navigator.clipboard.writeText(active.url);
      setStripOpen(false);
    },
    onOpenExternal: () => {
      if (active) window.open(active.url, "_blank");
      setStripOpen(false);
    },
  }) : [];

  const openContextMenu = (tabId: string, clientX: number, clientY: number, target: HTMLElement) => {
    closeAllMenus();
    ctxTabRef.current = target;
    setCtxMenu({ tabId, x: clientX, y: clientY });
  };

  return (
    <div className="chat-workspace-tabstrip">
      <button
        ref={narrowRef}
        type="button"
        className="chat-workspace-tab-active-dropdown"
        aria-label="Tabs"
        onClick={() => setNarrowOpen((v) => !v)}
      >
        {active?.title || activeProfile?.name || "Chat"} ▾
      </button>
      <Popover open={narrowOpen} onClose={() => setNarrowOpen(false)} anchorRef={narrowRef}>
        <div className="chat-workspace-open-popover">
          {ordered.map((tab) => {
            const profile = props.profiles.find((p) => p.id === tab.profileId);
            return (
              <button
                key={tab.id}
                type="button"
                className="chat-workspace-popover-item"
                onClick={() => { void selectTab(tab.id); setNarrowOpen(false); }}
              >
                {providerGlyph(profile?.providerId ?? "custom")} {tab.title || profile?.name || "Chat"}
              </button>
            );
          })}
          <button type="button" className="chat-workspace-popover-item" onClick={() => { setNarrowOpen(false); setAddOpen(true); }}>+</button>
        </div>
      </Popover>
      <div className="chat-workspace-tabstrip-scroll">
        {ordered.map((tab) => {
          const profile = props.profiles.find((p) => p.id === tab.profileId);
          return (
            <button
              key={tab.id}
              type="button"
              className={`chat-workspace-tab ${tab.id === props.activeTabId ? "is-active" : ""}`}
                onClick={() => { void selectTab(tab.id); }}
              onContextMenu={(e) => {
                e.preventDefault();
                openContextMenu(tab.id, e.clientX, e.clientY, e.currentTarget);
              }}
            >
              <span className="chat-workspace-tab-glyph">{providerGlyph(profile?.providerId ?? "custom")}</span>
              <span className="chat-workspace-tab-title">{tab.title || profile?.name || "Chat"}</span>
              {tab.pinned ? <span className="chat-workspace-tab-pin" aria-hidden>•</span> : null}
              <span className="chat-workspace-tab-close" role="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); void handleCloseTab(tab.id); }}>×</span>
            </button>
          );
        })}
      </div>
      <Menu
        label="Open chat"
        title="Open chat"
        open={addOpen}
        onOpenChange={(open) => {
          if (open) {
            setCtxMenu(null);
            setNarrowOpen(false);
          }
          setAddOpen(open);
        }}
        align="end"
        className="chat-workspace-menu"
        entries={addEntries}
      >
        {(trigger) => (
          <button
            {...trigger}
            type="button"
            className="chat-workspace-tab-add"
            aria-label="Open chat"
          >
            +
          </button>
        )}
      </Menu>
      <Menu
        label="Tab strip actions"
        title="More"
        open={stripOpen}
        onOpenChange={(open) => {
          if (open) {
            setCtxMenu(null);
            setNarrowOpen(false);
            setAddOpen(false);
          }
          setStripOpen(open);
          if (!open) setAddressOpen(false);
        }}
        align="end"
        className="chat-workspace-menu"
        entries={stripEntries}
        footer={addressOpen && active ? (
          <div className="chat-workspace-address-footer">
            <TextInput
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void tabAction(active.id, "navigate", { url: address });
                  setAddressOpen(false);
                  setStripOpen(false);
                }
                if (e.key === "Escape") setAddressOpen(false);
              }}
              autoFocus
            />
          </div>
        ) : null}
      >
        {(trigger) => (
          <button
            {...trigger}
            type="button"
            className="chat-workspace-tab-more"
            aria-label="More"
          >
            ···
          </button>
        )}
      </Menu>
      <Menu
        key={ctxMenu ? `${ctxMenu.tabId}:${ctxMenu.x}:${ctxMenu.y}` : "closed"}
        label="Tab context menu"
        open={ctxMenu !== null}
        onOpenChange={(open) => { if (!open) setCtxMenu(null); }}
        className="chat-workspace-menu"
        entries={ctxEntries}
        returnFocusRef={ctxTabRef}
      >
        {(trigger) => (
          <button
            {...trigger}
            type="button"
            className="chat-workspace-ctx-anchor"
            tabIndex={-1}
            aria-hidden="true"
            style={{
              position: "fixed",
              left: ctxMenu?.x ?? 0,
              top: ctxMenu?.y ?? 0,
              width: 1,
              height: 1,
              padding: 0,
              margin: 0,
              overflow: "hidden",
              opacity: 0,
              pointerEvents: "none",
            }}
          />
        )}
      </Menu>
      {profilePickerTabId ? (
        <Dialog title="Change profile" onClose={() => { setProfilePickerTabId(null); setCtxMenu(null); }}>
          <div className="chat-workspace-profile-picker">
            {ctxProviderProfiles.map((p) => (
              <button key={p.id} type="button" className="chat-workspace-popover-item" onClick={() => void changeProfile(profilePickerTabId, p.id)}>
                {p.name}
              </button>
            ))}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
