// OC-style settings: modal with a left page nav and one focused page at a
// time. Plugins inject extra pages through the "settings.pages" slot.
import { useMemo, useState, type ReactNode } from "react";
import { setOverlay } from "../store.ts";
import { listSlots } from "../slots.ts";
import { usePrefs } from "../prefs.ts";
import {
  AgentsPage, AppearancePage, BehaviorPage, ChatPage, GeneralPage, GitPage,
  McpPage, NotificationsPage, PluginsPage, ProjectsPage, UsagePage,
} from "./settings/pages.tsx";
import ShortcutsPage from "./settings/ShortcutsPage.tsx";
import ModelsPage from "./settings/ModelsPage.tsx";
import VoicePage from "./settings/VoicePage.tsx";
import IntegrationsPage from "./settings/IntegrationsPage.tsx";
import SessionsPage from "./settings/SessionsPage.tsx";
import CommandsPage from "./settings/CommandsPage.tsx";

interface PageDef {
  id: string;
  label: string;
  render: () => ReactNode;
}

const BUILTIN: PageDef[] = [
  { id: "general", label: "General", render: () => <GeneralPage /> },
  { id: "appearance", label: "Appearance", render: () => <AppearancePage /> },
  { id: "chat", label: "Chat", render: () => <ChatPage /> },
  { id: "notifications", label: "Notifications", render: () => <NotificationsPage /> },
  { id: "sessions", label: "Sessions", render: () => <SessionsPage /> },
  { id: "shortcuts", label: "Shortcuts", render: () => <ShortcutsPage /> },
  { id: "voice", label: "Voice", render: () => <VoicePage /> },
  { id: "integrations", label: "Integrations", render: () => <IntegrationsPage /> },
  { id: "usage", label: "Usage", render: () => <UsagePage /> },
  { id: "projects", label: "Projects", render: () => <ProjectsPage /> },
  { id: "git", label: "Git", render: () => <GitPage /> },
  { id: "models", label: "Providers & Models", render: () => <ModelsPage /> },
  { id: "agents", label: "Agents", render: () => <AgentsPage /> },
  { id: "behavior", label: "Behavior", render: () => <BehaviorPage /> },
  { id: "commands", label: "Commands", render: () => <CommandsPage /> },
  { id: "mcp", label: "MCP", render: () => <McpPage /> },
  { id: "plugins", label: "Plugins", render: () => <PluginsPage /> },
];

export default function SettingsView() {
  const prefs = usePrefs();
  const [active, setActive] = useState("general");
  const [filter, setFilter] = useState("");

  // Plugin-contributed pages (settings.pages slot): one nav entry per item.
  const pages = useMemo<PageDef[]>(() => {
    const extra = listSlots("settings.pages").map((item): PageDef => ({
      id: `slot:${item.id}`,
      label: item.id.replace(/^[^.]*\./, "").replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      render: () => <>{item.render({ prefs })}</>,
    }));
    return [...BUILTIN, ...extra];
  }, [prefs]);

  const shown = filter.trim()
    ? pages.filter((p) => p.label.toLowerCase().includes(filter.trim().toLowerCase()))
    : pages;
  const current = pages.find((p) => p.id === active) ?? shown[0] ?? pages[0]!;

  return (
    <div className="overlay" onClick={() => setOverlay(null)}>
      <div className="settings settings-shell" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="settings-nav">
          <div className="settings-nav-head">
            <h2>Settings</h2>
          </div>
          <input
            className="settings-nav-search"
            value={filter}
            placeholder="Search settings…"
            onChange={(e) => setFilter(e.target.value)}
          />
          <nav className="settings-nav-list" aria-label="Settings pages">
            {shown.map((p) => (
              <button
                key={p.id}
                className={`settings-nav-item ${current.id === p.id ? "active" : ""}`}
                aria-current={current.id === p.id ? "page" : undefined}
                onClick={() => { setActive(p.id); }}
              >
                {p.label}
              </button>
            ))}
            {shown.length === 0 && <div className="palette-empty">No matches</div>}
          </nav>
        </div>
        <div className="settings-pane">
          <div className="settings-pane-head">
            <span className="settings-pane-title">{current.label}</span>
            <button className="icon-btn" onClick={() => setOverlay(null)} aria-label="Close">×</button>
          </div>
          <div className="settings-pane-body">{current.render()}</div>
        </div>
      </div>
    </div>
  );
}
