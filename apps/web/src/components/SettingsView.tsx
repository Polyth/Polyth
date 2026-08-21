// OC-style settings: modal with a left page nav and one focused page at a
// time. Plugins inject extra pages through the "settings.pages" slot. Search
// (WP9) matches individual settings rows through the item registry and jumps
// to the exact row; page-title filtering remains the fallback for plugin
// pages without item metadata.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { consumePendingSettingsPage, setOverlay } from "../store.ts";
import { listSlots } from "../slots.ts";
import { useSlotVersion } from "./slots/SlotHost.ts";
import { usePrefs } from "../prefs.ts";
import {
  registerSettingsItems, searchSettingsItems,
  type SettingsSearchHit, type SettingsSearchItem,
} from "../settings/registry.ts";
import {
  AboutPage, AgentsPage, AppearancePage, BehaviorPage, ChatPage, GeneralPage, GitPage,
  McpPage, NotificationsPage, PluginsPage, ProjectsPage, UsagePage,
} from "./settings/pages.tsx";
import ViewErrorBoundary from "./ViewErrorBoundary.ts";
import ShortcutsPage from "./settings/ShortcutsPage.tsx";
import ModelsPage from "./settings/ModelsPage.tsx";
import VoicePage from "./settings/VoicePage.tsx";
import IntegrationsPage from "./settings/IntegrationsPage.tsx";
import SessionsPage from "./settings/SessionsPage.tsx";
import CommandsPage from "./settings/CommandsPage.tsx";
import AccessPage from "./settings/AccessPage.tsx";

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
  { id: "access", label: "Access", render: () => <AccessPage /> },
  { id: "about", label: "About", render: () => <AboutPage /> },
];

export default function SettingsView({ onClose = () => setOverlay(null) }: { onClose?: () => void }) {
  const prefs = usePrefs();
  // Deep link (e.g. "Change shortcut…" palette rows land on the Shortcuts page).
  const [active, setActive] = useState(() => consumePendingSettingsPage() ?? "general");
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const paneRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    modalRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Plugin-contributed pages (settings.pages slot): one nav entry per item.
  // Slot props may carry `settingsItems` descriptors for item-level search.
  // Version-keyed so late registration/disposal re-renders and the list keeps
  // a stable identity between slot changes.
  const slotsAt = useSlotVersion();
  const slotItems = useMemo(() => listSlots("settings.pages"), [slotsAt]);
  const pages = useMemo<PageDef[]>(() => {
    const extra = slotItems.map((item): PageDef => ({
      id: `slot:${item.id}`,
      label: item.id.replace(/^[^.]*\./, "").replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      render: () => <>{item.render({ prefs })}</>,
    }));
    return [...BUILTIN, ...extra];
  }, [prefs, slotItems]);

  useEffect(() => {
    const contributed: SettingsSearchItem[] = [];
    for (const item of slotItems) {
      const list = (item.meta as { settingsItems?: SettingsSearchItem[] } | undefined)?.settingsItems;
      if (!Array.isArray(list)) continue;
      for (const si of list) {
        if (si && typeof si.id === "string" && typeof si.label === "string") {
          contributed.push({ ...si, pageId: `slot:${item.id}` });
        }
      }
    }
    if (contributed.length === 0) return;
    return registerSettingsItems(contributed); // disposed plugin items vanish with the slot
  }, [slotItems]);

  const pageLabels = useMemo(
    () => Object.fromEntries(pages.map((p) => [p.id, p.label])),
    [pages],
  );

  const q = filter.trim();
  const itemHits = useMemo<SettingsSearchHit[]>(
    () => (q ? searchSettingsItems(q, pageLabels) : []),
    [q, pageLabels],
  );
  // Fallback: pages whose TITLE matches but that had no item hits.
  const pageHits = q
    ? pages.filter((p) =>
        p.label.toLowerCase().includes(q.toLowerCase()) &&
        !itemHits.some((h) => h.item.pageId === p.id))
    : [];
  const resultCount = itemHits.length + pageHits.length;

  const current = pages.find((p) => p.id === active) ?? pages[0]!;

  const gotoItem = (hit: SettingsSearchHit) => {
    setActive(hit.item.pageId);
    setFilter("");
    setCursor(0);
    // Focus + flash after the page renders.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const row = paneRef.current?.querySelector<HTMLElement>(`[data-settings-item="${hit.item.focusTarget}"]`);
        if (!row) return;
        row.scrollIntoView({ block: "center" });
        row.classList.add("flash");
        window.setTimeout(() => row.classList.remove("flash"), 1600);
        row.querySelector<HTMLElement>("input, button, select, textarea")?.focus();
      });
    });
  };

  const gotoPage = (id: string) => {
    setActive(id);
    setFilter("");
    setCursor(0);
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (!q) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, resultCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor < itemHits.length) {
        const hit = itemHits[cursor];
        if (hit) gotoItem(hit);
      } else {
        const p = pageHits[cursor - itemHits.length];
        if (p) gotoPage(p.id);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setFilter("");
      setCursor(0);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="modal settings-shell"
        ref={modalRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        aria-describedby="settings-close-hint"
      >
        <nav className="modal-nav settings-nav">
          <div className="settings-nav-head">
            <h2>Settings</h2>
          </div>
          <input
            className="settings-nav-search"
            value={filter}
            placeholder="Search settings…"
            onChange={(e) => { setFilter(e.target.value); setCursor(0); }}
            onKeyDown={onSearchKey}
            aria-label="Search settings"
          />
          {q ? (
            <div className="settings-results" role="listbox" aria-label="Settings search results">
              {itemHits.map((hit, i) => (
                <button
                  key={hit.item.id}
                  className={`settings-result ${cursor === i ? "cursor" : ""}`}
                  role="option"
                  aria-selected={cursor === i}
                  onClick={() => gotoItem(hit)}
                >
                  <span className="settings-result-label">{hit.item.label}</span>
                  {hit.item.description && <span className="settings-result-hint">{hit.item.description}</span>}
                  <span className="settings-result-page">{hit.pageLabel}</span>
                </button>
              ))}
              {pageHits.map((p, i) => (
                <button
                  key={p.id}
                  className={`settings-result page-only ${cursor === itemHits.length + i ? "cursor" : ""}`}
                  role="option"
                  aria-selected={cursor === itemHits.length + i}
                  onClick={() => gotoPage(p.id)}
                >
                  <span className="settings-result-label">{p.label}</span>
                  <span className="settings-result-page">page</span>
                </button>
              ))}
              {resultCount === 0 && <div className="palette-empty">No matches</div>}
            </div>
          ) : (
            <nav className="settings-nav-list" aria-label="Settings pages">
              {pages.map((p) => (
                <button
                  key={p.id}
                  className={`settings-nav-item ${current.id === p.id ? "active" : ""}`}
                  aria-current={current.id === p.id ? "page" : undefined}
                  onClick={() => { setActive(p.id); }}
                >
                  {p.label}
                </button>
              ))}
            </nav>
          )}
          <div className="nav-foot">Polyth settings<br />Changes save automatically</div>
        </nav>
        <div className="modal-main settings-pane">
          <div className="modal-head settings-pane-head">
            <div>
              <div className="modal-title settings-pane-title">{current.label}</div>
              <div className="modal-desc">Configure this part of your Polyth workspace.</div>
            </div>
            <span className="dialog-hint" id="settings-close-hint"><kbd>Esc</kbd> close</span>
            <button className="close-btn" onClick={onClose} aria-label="Close">×</button>
          </div>
          <div className="modal-body settings-pane-body" ref={paneRef}>
            {/* A page that throws must not white-screen the whole app —
                Settings renders outside App's main view boundary. */}
            <ViewErrorBoundary resetKey={current.id} inline>{current.render()}</ViewErrorBoundary>
          </div>
          <div className="modal-foot">
            <span className="modal-note">Changes are saved as you edit</span>
            <span className="header-spacer" />
            <button className="btn-accent" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
