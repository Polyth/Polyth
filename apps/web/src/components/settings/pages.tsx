// The simpler settings pages: General, Appearance, Chat, Notifications,
// Behavior, Usage, Projects, Git, Agents, MCP, Plugins.
import { useEffect, useState } from "react";
import { PERSONAS, PLUGIN_LABELS, applyPersona, isCustomized, pluginOn, togglePlugin, usePrefs, type PersonaId, type PluginId } from "../../prefs.ts";
import { setOverlay, setActiveView, useStore } from "../../store.ts";
import { setUiSettings, useUiSettings } from "../../uiPrefs.ts";
import { requestNotifyPermission } from "../../notify.ts";
import { api, type GitStatus } from "../../api.ts";
import { addProject, createProject } from "../../init.ts";
import { fmtCost, fmtTokens } from "../../format.ts";
import { EmptyState, PageHead, Row, Seg, Toggle } from "./parts.tsx";

export function GeneralPage() {
  const prefs = usePrefs();
  const custom = isCustomized(prefs);
  const pick = (id: PersonaId) => {
    if (prefs.persona && custom && !window.confirm("Switching resets plugin customizations to the persona defaults. Continue?")) return;
    applyPersona(id);
  };
  return (
    <>
      <PageHead title="General" blurb="Personas set the rail, shortcuts and how much detail you see. Switch anytime." />
      <Row label="Workspace persona" hint={prefs.persona ? PERSONAS[prefs.persona].blurb : "Pick a starting point."}>
        <Seg
          value={prefs.persona ?? "engineer"}
          options={(["engineer", "manager", "creator", "blank"] as const).map((id) => [id, PERSONAS[id].label])}
          onChange={pick}
        />
      </Row>
      <Row label="Onboarding" hint="Re-run the guided workspace setup.">
        <button className="small-btn" onClick={() => setOverlay("onboarding")}>Customize workspace…</button>
      </Row>
      {custom && prefs.persona && (
        <Row label="Plugin customizations" hint="Your plugin set differs from the persona defaults.">
          <button className="small-btn" onClick={() => { if (prefs.persona) applyPersona(prefs.persona); }}>
            Reset to {PERSONAS[prefs.persona].label} defaults
          </button>
        </Row>
      )}
    </>
  );
}

export function AppearancePage() {
  const ui = useUiSettings();
  return (
    <>
      <PageHead title="Appearance" blurb="Visual preferences, saved in this browser and applied immediately." />
      <Row label="Density" hint="Compact tightens paddings and font sizes across panels.">
        <Seg value={ui.density} options={[["comfortable", "Comfortable"], ["compact", "Compact"]]} onChange={(v) => setUiSettings({ density: v })} />
      </Row>
      <Row label="Font size">
        <Seg value={ui.fontSize} options={[["s", "S"], ["m", "M"], ["l", "L"]]} onChange={(v) => setUiSettings({ fontSize: v })} />
      </Row>
      <Row label="Reduced motion" hint="Disables pulse and spinner animations.">
        <Toggle on={ui.reducedMotion} onChange={(v) => setUiSettings({ reducedMotion: v })} label="Reduced motion" />
      </Row>
    </>
  );
}

export function ChatPage() {
  const ui = useUiSettings();
  return (
    <>
      <PageHead title="Chat" blurb="Conversation layout preferences." />
      <Row label="Conversation width" hint="Wide uses more of the window for messages and diffs.">
        <Seg value={ui.chatWidth} options={[["normal", "Normal"], ["wide", "Wide"]]} onChange={(v) => setUiSettings({ chatWidth: v })} />
      </Row>
      <Row label="Send" hint="Enter sends, Shift+Enter inserts a newline. / for commands, # for snippets, @ to attach files.">
        <kbd>↵</kbd>
      </Row>
    </>
  );
}

export function NotificationsPage() {
  const ui = useUiSettings();
  const granted = typeof Notification !== "undefined" && Notification.permission === "granted";
  const denied = typeof Notification !== "undefined" && Notification.permission === "denied";
  return (
    <>
      <PageHead title="Notifications" blurb="Get told when a turn finishes while you're elsewhere." />
      <Row
        label="Desktop notification"
        hint={denied ? "Notifications are blocked for this site in your browser settings." : "Fires when a working session finishes and this tab is hidden."}
      >
        <Toggle
          on={ui.notifyOnComplete}
          onChange={(v) => { setUiSettings({ notifyOnComplete: v }); if (v) requestNotifyPermission(); }}
          label="Desktop notification"
        />
      </Row>
      <Row label="Completion sound" hint="Short beep when a turn completes.">
        <Toggle on={ui.notifySound} onChange={(v) => setUiSettings({ notifySound: v })} label="Completion sound" />
      </Row>
      {ui.notifyOnComplete && !granted && !denied && (
        <Row label="Permission" hint="The browser will ask for permission once.">
          <button className="small-btn" onClick={requestNotifyPermission}>Grant permission</button>
        </Row>
      )}
    </>
  );
}

export function BehaviorPage() {
  const ui = useUiSettings();
  return (
    <>
      <PageHead title="Behavior" blurb="Workspace safety and flow." />
      <Row label="Confirm before archiving sessions" hint="Ask before a session is moved to the archive.">
        <Toggle on={ui.confirmSessionArchive} onChange={(v) => setUiSettings({ confirmSessionArchive: v })} label="Confirm archive" />
      </Row>
      <Row label="Slash commands & snippets" hint="Manage reusable prompts under Commands.">
        <span className="muted mono">/review · #alias</span>
      </Row>
    </>
  );
}

export function UsagePage() {
  const sessions = useStore((s) => s.sessions);
  const projectId = useStore((s) => s.activeProjectId);
  const mine = sessions.filter((s) => s.projectId === projectId);
  const tok = (n?: { input: number; output: number }) => (n ? n.input + n.output : 0);
  const totalTokens = mine.reduce((a, s) => a + tok(s.tokenTotals), 0);
  const totalCost = mine.reduce((a, s) => a + (s.costTotal ?? 0), 0);
  const top = [...mine].sort((a, b) => (b.costTotal ?? 0) - (a.costTotal ?? 0) || tok(b.tokenTotals) - tok(a.tokenTotals)).slice(0, 8);
  return (
    <>
      <PageHead title="Usage" blurb="Token and cost totals for the active project (from the session log)." />
      {mine.length === 0 ? (
        <EmptyState title="No sessions yet" body="Usage appears once sessions run in this project." />
      ) : (
        <>
          <div className="set-usage-grid">
            <div className="goal-stat-cell"><div className="goal-stat-k">Sessions</div><div className="goal-stat-v">{mine.length}</div></div>
            <div className="goal-stat-cell"><div className="goal-stat-k">Tokens</div><div className="goal-stat-v mono">{fmtTokens(totalTokens)}</div></div>
            <div className="goal-stat-cell"><div className="goal-stat-k">Cost</div><div className="goal-stat-v mono">{totalCost > 0 ? fmtCost(totalCost) : "—"}</div></div>
          </div>
          <div className="stat-label">Top sessions</div>
          {top.map((s) => (
            <div key={s.id} className="stat-row">
              <span className="k" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }}>{s.title || s.id}</span>
              <span className="mono">{fmtTokens(tok(s.tokenTotals))}{s.costTotal ? ` · ${fmtCost(s.costTotal)}` : ""}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

export function ProjectsPage() {
  const projects = useStore((s) => s.projects);
  const [path, setPath] = useState("");
  const [create, setCreate] = useState(false);
  const [error, setError] = useState("");
  const add = async () => {
    if (!path.trim()) return;
    try {
      setError("");
      await (create ? createProject(path.trim()) : addProject(path.trim()));
      setPath("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <PageHead title="Projects" blurb="Folders Polyth can work in. Removing a project keeps the folder on disk." />
      {projects.map((p) => (
        <div key={p.id} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">{p.name || p.path}</div>
            <div className="set-row-hint mono">{p.path}</div>
          </div>
          <div className="set-row-control">
            <button
              className="small-btn danger-btn"
              onClick={() => { if (window.confirm(`Remove project "${p.name || p.path}" from Polyth?`)) void api.deleteProject(p.id).then(() => location.reload()); }}
            >Remove</button>
          </div>
        </div>
      ))}
      <div className="set-add-form">
        <input value={path} placeholder="/absolute/path/to/project" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
        <label className="plugin-toggle"><input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} />Create folder</label>
        <button className="small-btn" onClick={() => void add()}>Add</button>
      </div>
      {error && <div className="form-error">{error}</div>}
    </>
  );
}

export function GitPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const [status, setStatus] = useState<GitStatus | null>(null);
  useEffect(() => {
    if (!projectId) { setStatus(null); return; }
    void api.gitStatus(projectId).then(setStatus);
  }, [projectId]);
  if (!projectId) return <><PageHead title="Git" /><EmptyState title="No active project" /></>;
  const changes = status ? status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length : 0;
  return (
    <>
      <PageHead title="Git" blurb="Repository state for the active project." />
      {!status?.branch ? (
        <EmptyState title="Not a git repository" body="Initialize a repo to use the Git view, changes panel, and worktrees." />
      ) : (
        <>
          <Row label="Branch"><span className="mono">{status.branch}</span></Row>
          <Row label="Working tree"><span className="mono">{changes === 0 ? "clean" : `${changes} changed file${changes === 1 ? "" : "s"}`}</span></Row>
          <Row label="Ahead / behind"><span className="mono">↑{status.ahead} ↓{status.behind}</span></Row>
          <Row label="Full view" hint="Stage, commit, branch, and manage worktrees.">
            <button className="small-btn" onClick={() => { setOverlay(null); setActiveView("git"); }}>Open Git view →</button>
          </Row>
        </>
      )}
    </>
  );
}

export function AgentsPage() {
  const agents = useStore((s) => s.agents);
  return (
    <>
      <PageHead title="Agents" blurb="Agent presets reported by the backend runtime." />
      {agents.length === 0 ? (
        <EmptyState title="No agents reported" body="The backend did not report agent presets. Sessions run with the default agent." />
      ) : (
        agents.map((a) => (
          <div key={a.name} className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">{a.name}</div>
              {a.description && <div className="set-row-hint">{a.description}</div>}
            </div>
            <div className="set-row-control"><span className="tag">{a.mode}</span></div>
          </div>
        ))
      )}
    </>
  );
}

export function McpPage() {
  const ui = useUiSettings();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const add = () => {
    if (!name.trim() || !url.trim()) return;
    setUiSettings({ mcpServers: [...ui.mcpServers, { name: name.trim(), url: url.trim() }] });
    setName("");
    setUrl("");
  };
  return (
    <>
      <PageHead title="MCP" blurb="Model Context Protocol servers." />
      {ui.mcpServers.length === 0 && (
        <EmptyState
          title="No MCP servers configured"
          body="Polyth does not connect to MCP servers yet. Entries are saved locally and will be used once the MCP bridge ships."
        />
      )}
      {ui.mcpServers.map((s, i) => (
        <div key={`${s.name}-${i}`} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">{s.name}</div>
            <div className="set-row-hint mono">{s.url}</div>
          </div>
          <div className="set-row-control">
            <span className="tag">not connected</span>
            <button className="small-btn danger-btn" onClick={() => setUiSettings({ mcpServers: ui.mcpServers.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        </div>
      ))}
      <div className="set-add-form">
        <input value={name} placeholder="name" style={{ maxWidth: 140 }} onChange={(e) => setName(e.target.value)} />
        <input value={url} placeholder="command or URL" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="small-btn" onClick={add}>Add</button>
      </div>
    </>
  );
}

const TOGGLE: PluginId[] = [
  "files", "git", "github", "preview", "terminal", "context", "usage", "events",
  "goals", "multirun", "fusion", "walkthrough", "schedule", "dictation",
];

export function PluginsPage() {
  const prefs = usePrefs();
  const custom = isCustomized(prefs);
  return (
    <>
      <PageHead title="Plugins" blurb="Everything is a widget. Toggle panels and workflows without leaving the session." />
      <div className="plugin-toggles">
        {TOGGLE.map((id) => (
          <label key={id} className="plugin-toggle">
            <input type="checkbox" checked={pluginOn(id)} onChange={() => togglePlugin(id)} />
            {PLUGIN_LABELS[id]}
          </label>
        ))}
      </div>
      {custom && prefs.persona && (
        <button className="ghost-link" onClick={() => { if (prefs.persona) applyPersona(prefs.persona); }}>
          Reset to {PERSONAS[prefs.persona].label} defaults →
        </button>
      )}
    </>
  );
}
