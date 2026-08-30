import { useMemo, useState } from "react";
import { displaySessionTitle } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { openSession } from "../../init.ts";
import { resolveSessionStatus } from "../../sessionStatus.ts";
import { setOverlay, setRailPlugin, setSidebarOpen, startNewSession, useStore } from "../../store.ts";
import { useResolvedCapabilities } from "../../capabilities.ts";
import { railIconFor } from "../../railIcons.ts";
import { ComposeIcon, IconButton, LayersIcon, MenuIcon } from "../ui/index.ts";
import Sheet, { SheetRow, SheetSection } from "./Sheet.tsx";

function SessionSwitcher({ onClose }: { onClose: () => void }) {
  const sessions = useStore((state) => state.sessions);
  const activeSessionId = useStore((state) => state.activeSessionId);
  const [query, setQuery] = useState("");
  const items = useMemo(() => sessions
    .filter((session) => session.status !== "archived" && session.title.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (b.lastTurnAt ?? b.updatedAt) - (a.lastTurnAt ?? a.updatedAt)), [query, sessions]);
  return (
    <Sheet title="Select a session" size="tall" className="mobile-session-switcher" onClose={onClose}
      search={{ value: query, onChange: setQuery, placeholder: "Search sessions...", role: "searchbox" }}>
      <SheetSection title="Recent">
        {items.map((session) => {
          const status = resolveSessionStatus(session);
          return <SheetRow key={session.id} title={displaySessionTitle(session.title, session.id)} meta={status.label}
            icon={<Icon.chat />} selected={session.id === activeSessionId} onClick={() => {
              void openSession(session.id);
              onClose();
            }} />;
        })}
        {items.length === 0 && <p className="sheet-empty">No matching sessions.</p>}
      </SheetSection>
    </Sheet>
  );
}

function Tools({ onClose }: { onClose: () => void }) {
  const capabilities = useResolvedCapabilities().filter((capability) => capability.descriptor.available());
  const groups = [
    ["Workspace", capabilities.filter((capability) => ["files", "git", "terminal", "browser"].includes(capability.descriptor.id))],
    ["Agent", capabilities.filter((capability) => ["workflow", "commands", "knowledge"].includes(capability.descriptor.id))],
    ["System", capabilities.filter((capability) => !["session", "files", "git", "terminal", "browser", "workflow", "commands", "knowledge"].includes(capability.descriptor.id))],
  ] as const;
  return (
    <Sheet title="Tools" size="tall" className="mobile-tools-sheet" onClose={onClose}
      footer={<button className="mobile-surface-footer" onClick={() => { onClose(); setOverlay("settings"); }}><Icon.sliders /> Customize tools</button>}>
      {groups.map(([title, items]) => items.length > 0 && <SheetSection key={title} title={title}>
        {items.map((capability) => {
          const CapabilityIcon = railIconFor(capability.descriptor.id);
          return <SheetRow key={capability.descriptor.id} title={capability.descriptor.label}
          icon={<CapabilityIcon />} trailing={<span className="mobile-surface-chevron"><Icon.chevronRight /></span>}
          onClick={() => { setSidebarOpen(false); setRailPlugin(null); capability.descriptor.open(); onClose(); }} />;
        })}
      </SheetSection>)}
    </Sheet>
  );
}

/** Phone chat is intentionally a small overlay, not a second application header. */
export default function MobileSessionHeader() {
  const projectId = useStore((state) => state.activeProjectId);
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const [surface, setSurface] = useState<"sessions" | "tools" | null>(null);
  const title = session ? displaySessionTitle(session.title, session.id) : "New chat";
  const status = session ? resolveSessionStatus(session) : null;
  return <>
    <div className="mobile-session-floats" aria-label="Chat navigation">
      <IconButton icon={MenuIcon} label="Open navigation" size="lg" variant="quiet" className="mobile-float-button" aria-expanded={sidebarOpen} onClick={() => {
        setRailPlugin(null);
        setSidebarOpen(true);
      }} />
      <button className="mobile-session-selector" aria-label={`Switch session, ${title}`} aria-haspopup="dialog" aria-expanded={surface === "sessions"} onClick={() => setSurface("sessions")}>
        {status && <span className={`mobile-session-status ${status.kind}`} aria-hidden="true" />}
        <span>{title}</span><Icon.chevronDown />
      </button>
      <div className="mobile-float-actions">
        <IconButton icon={ComposeIcon} label="New session" size="lg" variant="ghost" disabled={!projectId} onClick={() => projectId && startNewSession(projectId)} />
        <IconButton icon={LayersIcon} label="Open tools" size="lg" variant="ghost" aria-expanded={surface === "tools"} onClick={() => setSurface("tools")} />
      </div>
    </div>
    {surface === "sessions" && <SessionSwitcher onClose={() => setSurface(null)} />}
    {surface === "tools" && <Tools onClose={() => setSurface(null)} />}
  </>;
}
