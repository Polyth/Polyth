// The simpler settings pages: General, Appearance, Chat, Notifications,
// Behavior, Usage, Projects, Git, Agents, MCP, Plugins.
import { useEffect, useState, type CSSProperties } from "react";
import { PERSONAS, PLUGIN_LABELS, applyPersona, isCustomized, pluginOn, togglePlugin, usePrefs, type PersonaId, type PluginId } from "../../prefs.ts";
import { setOverlay, setActiveView, updateSettings, useStore } from "../../store.ts";
import { setUiSettings, useUiSettings } from "../../uiPrefs.ts";
import { groupQuotaWindows, setGroupCollapsed, setProviderHidden, useUsagePrefs } from "../../usagePrefs.ts";
import { requestNotifyPermission } from "../../notify.ts";
import { api, type GitStatus, type QuotaSnapshotDto, type QuotaWindowDto, type QuotaPaceDto } from "../../api.ts";
import { addProject, createProject } from "../../init.ts";
import { fmtCost, fmtTokens } from "../../format.ts";
import { EmptyState, PageHead, Row, Seg, Toggle } from "./parts.tsx";
import { refreshProfiles, useProfiles } from "../../profiles.ts";
import AgentProfileForm from "../AgentProfileForm.tsx";
import { parseMcpServersJson, type McpImportResult } from "../../mcpImport.ts";
import type { AssistSettingsDto } from "../../api.ts";
import type { AgentProfile, InstalledPluginDto, McpServerDto, McpTransport, SystemInfoDto } from "@polyth/contracts";

function ThemeCard({
  active,
  name,
  colors,
  onPick,
}: {
  active: boolean;
  name: string;
  colors: { bg: string; side: string; line: string; accent: string; soft: string };
  onPick: () => void;
}) {
  return (
    <button className={`theme-card ${active ? "active" : ""}`} onClick={onPick}>
      <div className="theme-prev" style={{ background: colors.bg }}>
        <div className="theme-prev-side" style={{ background: colors.side, borderRight: `1px solid ${colors.line}` }} />
        <div className="theme-prev-main">
          <div className="theme-prev-line" style={{ background: colors.accent, width: "42%" }} />
          <div className="theme-prev-line" style={{ background: colors.soft, width: "78%" }} />
          <div className="theme-prev-line" style={{ background: colors.soft, width: "60%" }} />
          <div className="theme-prev-line" style={{ background: colors.line, width: "70%" }} />
        </div>
      </div>
      <div className="theme-name">
        {name}
        <span className="theme-check" aria-hidden>✓</span>
      </div>
    </button>
  );
}

export function GeneralPage() {
  const prefs = usePrefs();
  const settings = useStore((s) => s.settings);
  const custom = isCustomized(prefs);
  const pick = (id: PersonaId) => {
    if (prefs.persona && custom && !window.confirm("Switching resets plugin customizations to the persona defaults. Continue?")) return;
    applyPersona(id);
  };
  return (
    <>
      <PageHead title="General" blurb="Personas set the rail, shortcuts and how much detail you see. Switch anytime." />
      <Row label="Product name" hint="Shown in the sidebar and window chrome." itemId="general.productName">
        <input
          className="inp"
          value={settings.productName}
          onChange={(e) => updateSettings({ productName: e.target.value })}
          onBlur={() => { if (!settings.productName.trim()) updateSettings({ productName: "Polyth" }); }}
        />
      </Row>
      <Row label="Relative timestamps" hint="Show session activity as “2m ago” instead of a clock time." itemId="general.relativeTime">
        <Toggle on={settings.relativeTime} onChange={(relativeTime) => updateSettings({ relativeTime })} label="Relative timestamps" />
      </Row>
      <Row label="Workspace persona" hint={prefs.persona ? PERSONAS[prefs.persona].blurb : "Pick a starting point."} itemId="general.persona">
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
  const settings = useStore((s) => s.settings);
  const fontPct = ((settings.fontSize - 12) / 6) * 100;
  const setFontSize = (fontSize: number) => {
    updateSettings({ fontSize });
    setUiSettings({ fontSize: fontSize <= 13 ? "s" : fontSize >= 16 ? "l" : "m" });
  };
  return (
    <>
      <PageHead title="Appearance" blurb="Visual preferences, saved in this browser and applied immediately." />
      <div className="set-sec" data-settings-item="appearance.theme">
        <div className="set-sec-title">Theme</div>
        <div className="theme-grid">
          <ThemeCard
            active={settings.theme === "dark"}
            name="Ember Dark"
            colors={{ bg: "#121110", side: "#191816", line: "#2a2723", accent: "#f49b5b", soft: "#3a352f" }}
            onPick={() => updateSettings({ theme: "dark" })}
          />
          <ThemeCard
            active={settings.theme === "light"}
            name="Parchment"
            colors={{ bg: "#faf8f4", side: "#f1ede6", line: "#e2dcd2", accent: "#d9822b", soft: "#ddd7cc" }}
            onPick={() => updateSettings({ theme: "light" })}
          />
        </div>
      </div>
      <Row label="Density" hint="Compact tightens paddings and font sizes across panels." itemId="appearance.density">
        <Seg value={ui.density} options={[["comfortable", "Comfortable"], ["compact", "Compact"]]} onChange={(density) => { setUiSettings({ density }); updateSettings({ density }); }} />
      </Row>
      <Row label="Interface font size" hint="Scales interface text except code blocks and the terminal." itemId="appearance.fontSize">
        <div className="rng">
          <input
            type="range"
            min={12}
            max={18}
            value={settings.fontSize}
            aria-label="Interface font size"
            style={{ "--p": `${fontPct}%` } as CSSProperties}
            onChange={(e) => setFontSize(Number(e.target.value))}
          />
          <span className="rng-val">{settings.fontSize}px</span>
        </div>
      </Row>
      <Row label="Editor font size" hint="Composer, file editor, diffs, terminal input, and code blocks (11–24 px)." itemId="appearance.editorFontSize">
        <div className="editor-font-control">
          <input
            type="number" min={11} max={24} value={ui.editorFontSize}
            aria-label="Editor font size in pixels"
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (Number.isFinite(v) && v >= 11 && v <= 24) setUiSettings({ editorFontSize: v });
            }}
          />
          <span className="muted">px</span>
        </div>
      </Row>
      <Row label="Reduced motion" hint="Disables pulse and spinner animations." itemId="appearance.reducedMotion">
        <Toggle on={ui.reducedMotion} onChange={(v) => setUiSettings({ reducedMotion: v })} label="Reduced motion" />
      </Row>
    </>
  );
}

export function ChatPage() {
  const ui = useUiSettings();
  const settings = useStore((s) => s.settings);
  // F9 hard switch lives server-side: disabled means nothing is generated at all
  const [assist, setAssist] = useState<AssistSettingsDto | null>(null);
  useEffect(() => { void api.assistSettings().then(setAssist).catch(() => setAssist(null)); }, []);
  const saveAssist = (patch: Partial<AssistSettingsDto>) => {
    void api.assistSettingsSave(patch).then(setAssist).catch(() => {});
  };
  return (
    <>
      <PageHead title="Chat" blurb="Conversation layout and delivery preferences." />
      <Row label="Conversation width" hint="Wide uses more of the window for messages and diffs." itemId="chat.width">
        <Seg value={ui.chatWidth} options={[["normal", "Normal"], ["wide", "Wide"]]} onChange={(v) => setUiSettings({ chatWidth: v })} />
      </Row>
      <Row label="While the agent is working" hint="What Enter does during an active turn: steer redirects it, queue waits, interrupt aborts first." itemId="chat.followUp">
        <Seg value={ui.followUpBehavior} options={[["steer", "Steer"], ["queue", "Queue"], ["interrupt", "Interrupt"]]} onChange={(v) => setUiSettings({ followUpBehavior: v })} />
      </Row>
      <Row label="Thinking blocks" hint="Collapse merged reasoning into an expandable block." itemId="chat.thinking">
        <Toggle on={ui.collapsibleThinkingBlocks} onChange={(v) => setUiSettings({ collapsibleThinkingBlocks: v })} label="Collapsible thinking" />
      </Row>
      <Row label="Send on Enter" hint="When off, Enter inserts a newline and Mod+Enter sends. / for commands, # for snippets, @ to attach files." itemId="chat.sendOnEnter">
        <Toggle on={settings.sendOnEnter} onChange={(sendOnEnter) => updateSettings({ sendOnEnter })} label="Send on Enter" />
      </Row>
      {assist && (
        <Row
          label="Idle recap & suggestion"
          hint="After a session goes quiet, the small model writes a ≤20-word recap and one suggested next prompt. Spends tokens only while enabled; off by default."
          itemId="chat.assist"
        >
          <Toggle on={assist.enabled} onChange={(enabled) => saveAssist({ enabled })} label="Idle recap" />
        </Row>
      )}
      {assist?.enabled && (
        <Row label="Quiet time" hint="Seconds of inactivity after a reply before the recap is generated (10–3600).">
          <div className="editor-font-control">
            <input
              type="number" min={10} max={3600} value={assist.idleSeconds}
              aria-label="Assist quiet time in seconds"
              onChange={(e) => setAssist({ ...assist, idleSeconds: Number(e.target.value) })}
              onBlur={(e) => saveAssist({ idleSeconds: Number(e.target.value) })}
            />
            <span className="muted">s</span>
          </div>
        </Row>
      )}
    </>
  );
}

const NOTIFY_KIND_LABELS: Array<[kind: "completed" | "failed" | "question" | "permission" | "subagent", label: string]> = [
  ["completed", "Turn completed"],
  ["failed", "Turn failed"],
  ["question", "Agent question"],
  ["permission", "Permission request"],
  ["subagent", "Delegated agent finished"],
];

export function NotificationsPage() {
  const ui = useUiSettings();
  const granted = typeof Notification !== "undefined" && Notification.permission === "granted";
  const denied = typeof Notification !== "undefined" && Notification.permission === "denied";
  const toggleKind = (kind: (typeof NOTIFY_KIND_LABELS)[number][0], on: boolean) => {
    const next = ui.notifyKinds.filter((k) => k !== kind);
    if (on) next.push(kind);
    setUiSettings({ notifyKinds: next });
  };
  return (
    <>
      <PageHead title="Notifications" blurb="Get told when a session needs you while you're elsewhere." />
      <Row
        label="Desktop notification"
        hint={denied ? "Notifications are blocked for this site in your browser settings." : "Native notification when an enabled event happens."}
        itemId="notifications.desktop"
      >
        <Toggle
          on={ui.notifyOnComplete}
          onChange={(v) => { setUiSettings({ notifyOnComplete: v }); if (v) requestNotifyPermission(); }}
          label="Desktop notification"
        />
      </Row>
      <Row label="Completion sound" hint="Short beep when a turn completes." itemId="notifications.sound">
        <Toggle on={ui.notifySound} onChange={(v) => setUiSettings({ notifySound: v })} label="Completion sound" />
      </Row>
      <Row label="Notify about" hint="Each event kind is independent." itemId="notifications.kinds">
        <div className="notification-kind-list">
          {NOTIFY_KIND_LABELS.map(([kind, label]) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={ui.notifyKinds.includes(kind)}
                onChange={(e) => toggleKind(kind, e.target.checked)}
              />
              {label}
            </label>
          ))}
        </div>
      </Row>
      <Row
        label="Only when hidden"
        hint="Off: background sessions may notify while the tab is visible; the active session stays quiet either way."
        itemId="notifications.onlyHidden"
      >
        <Toggle on={ui.notifyOnlyWhenHidden} onChange={(v) => setUiSettings({ notifyOnlyWhenHidden: v })} label="Only when hidden" />
      </Row>
      <Row
        label="Template"
        hint="Variables: {project} {session} {status} {preview}. Values are redacted and capped."
        itemId="notifications.template"
      >
        <input
          className="notification-preview"
          value={ui.notifyTemplate}
          onChange={(e) => setUiSettings({ notifyTemplate: e.target.value.slice(0, 200) })}
          aria-label="Notification template"
        />
      </Row>
      {ui.notifyOnComplete && !granted && !denied && (
        <Row label="Permission" hint="The browser will ask for permission once.">
          <button className="small-btn" onClick={requestNotifyPermission}>Grant permission</button>
        </Row>
      )}
    </>
  );
}

function BehaviorInstructionsEditor() {
  const [text, setText] = useState("");
  const [revision, setRevision] = useState("");
  const [pathLabel, setPathLabel] = useState("");
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "conflict" | "error">("loading");
  const [message, setMessage] = useState("");

  const load = async () => {
    try {
      const r = await api.behaviorGet();
      setText(r.text);
      setRevision(r.revision);
      setPathLabel(r.pathLabel);
      setDirty(false);
      setState("ready");
      setMessage("");
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    setState("saving");
    try {
      const r = await api.behaviorPut(text, revision);
      setRevision(r.revision);
      setDirty(false);
      setState("ready");
      setMessage("Saved and applied.");
    } catch (e) {
      const status = (e as { status?: number }).status;
      setState(status === 409 ? "conflict" : "error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="behavior-editor" data-settings-item="behavior.instructions">
      <div className="stat-label">Global instructions <span className="muted">({pathLabel || "…"})</span></div>
      <textarea
        rows={8}
        value={text}
        placeholder="Instructions applied to every agent turn, e.g. coding conventions or tone."
        onChange={(e) => { setText(e.target.value); setDirty(true); }}
        disabled={state === "loading" || state === "saving"}
        aria-label="Global behavior instructions"
      />
      <div className="behavior-editor-foot">
        {state === "conflict" ? (
          <div className="revision-conflict" role="alert">
            <span>Changed elsewhere since you loaded it.</span>
            <button className="small-btn" onClick={() => void load()}>Reload latest</button>
          </div>
        ) : (
          <span className="muted">{message}</span>
        )}
        <span className="header-spacer" />
        <button className="small-btn" disabled={!dirty || state === "saving"} onClick={() => void save()}>
          {state === "saving" ? "Saving…" : "Save & apply"}
        </button>
      </div>
    </div>
  );
}

export function BehaviorPage() {
  const ui = useUiSettings();
  return (
    <>
      <PageHead title="Behavior" blurb="Workspace safety, flow, and global agent instructions." />
      <Row label="Confirm before archiving sessions" hint="Ask before a session is moved to the archive." itemId="behavior.confirmArchive">
        <Toggle on={ui.confirmSessionArchive} onChange={(v) => setUiSettings({ confirmSessionArchive: v })} label="Confirm archive" />
      </Row>
      <Row label="Editor autosave" hint="Saves edits after a short pause. Revision-guarded: never overwrites a file changed on disk." itemId="behavior.autosave">
        <Toggle on={ui.editorAutosave} onChange={(v) => setUiSettings({ editorAutosave: v })} label="Editor autosave" />
      </Row>
      <BehaviorInstructionsEditor />
      <Row label="Slash commands & snippets" hint="Manage reusable prompts under Commands.">
        <span className="muted mono">/review · #alias</span>
      </Row>
    </>
  );
}

// ---- WP12: provider quota cards -------------------------------------------

function fmtQuota(n: number, unit: QuotaWindowDto["unit"]): string {
  if (unit === "currency") return `$${n.toFixed(2)}`;
  if (unit === "percent") return `${Math.round(n)}%`;
  if (unit === "tokens") return fmtTokens(n);
  return String(Math.round(n));
}

function paceText(pace: QuotaPaceDto | null, win: QuotaWindowDto): string {
  if (!pace) return "";
  const bits: string[] = [`${Math.round(pace.usageFraction * 100)}% used, ${Math.round(pace.timeFraction * 100)}% of window elapsed (${pace.pace})`];
  if (pace.predictedAtReset !== undefined) {
    bits.push(`At current pace: ~${fmtQuota(pace.predictedAtReset, win.unit)} of ${fmtQuota(win.limit, win.unit)} by reset`);
  }
  if (pace.exhaustsAt !== undefined) {
    bits.push(`may run out around ${new Date(pace.exhaustsAt).toLocaleTimeString()}`);
  }
  return bits.join(" · ");
}

function QuotaWindowRow({ w, pace }: { w: QuotaWindowDto; pace: QuotaPaceDto | null }) {
  const frac = w.limit > 0 ? Math.min(1, w.used / w.limit) : 0;
  return (
    <div className="quota-window">
      <div className="quota-window-head">
        <span>{w.label}</span>
        <span className="mono">{fmtQuota(w.used, w.unit)} / {fmtQuota(w.limit, w.unit)}</span>
      </div>
      <div className="quota-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-label={w.label}>
        <div className={`quota-progress-fill ${pace?.pace ?? ""}`} style={{ width: `${frac * 100}%` }} />
      </div>
      {pace && <div className="quota-pace">{paceText(pace, w)}</div>}
      {w.resetsAt !== undefined && <div className="muted" style={{ fontSize: 11 }}>resets {new Date(w.resetsAt).toLocaleString()}</div>}
    </div>
  );
}

function QuotaCard({ snap, onRefresh }: { snap: QuotaSnapshotDto; onRefresh: (id: string) => void }) {
  const prefs = useUsagePrefs();
  // F13: windows grouped by model family; groups collapse and remember it.
  const groups = groupQuotaWindows(snap.windows);
  const grouped = groups.some((g) => g.family !== null);
  return (
    <div className={`quota-card ${snap.stale ? "quota-stale" : ""}`}>
      <div className="quota-card-head">
        <strong>{snap.providerId}</strong>
        {snap.accountLabel && <span className="muted">{snap.accountLabel}</span>}
        {snap.stale && <span className="tag" title={snap.error?.message}>stale</span>}
        <span className="header-spacer" />
        {snap.fetchedAt > 0 && <span className="muted" style={{ fontSize: 11 }}>{new Date(snap.fetchedAt).toLocaleTimeString()}</span>}
        <button className="small-btn" onClick={() => onRefresh(snap.providerId)}>Refresh</button>
      </div>
      {snap.stale && snap.error && <div className="quota-error">{snap.error.message}</div>}
      {groups.map((g) => {
        const key = `${snap.providerId}/${g.family ?? "general"}`;
        const collapsed = grouped && prefs.collapsedGroups.includes(key);
        return (
          <div key={key} className="quota-group">
            {grouped && (
              <button
                className="quota-group-head"
                aria-expanded={!collapsed}
                onClick={() => setGroupCollapsed(key, !collapsed)}
              >
                <span className="quota-group-arrow">{collapsed ? "▸" : "▾"}</span>
                <span>{g.label}</span>
                <span className="muted">{g.windows.length}</span>
              </button>
            )}
            {!collapsed && g.windows.map((w) => <QuotaWindowRow key={w.id} w={w} pace={snap.pace[w.id] ?? null} />)}
          </div>
        );
      })}
      {snap.windows.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No quota data yet.</div>}
    </div>
  );
}

function QuotaSection() {
  const [snaps, setSnaps] = useState<QuotaSnapshotDto[]>([]);
  const prefs = useUsagePrefs();
  const reload = () => void api.usageQuotas().then(setSnaps);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, []);
  const refresh = (id: string) => void api.usageQuotasRefresh(id).then(reload).catch(reload);
  const visible = snaps.filter((s) => !prefs.hiddenProviders.includes(s.providerId));
  return (
    <>
      <div className="stat-label">Provider quotas</div>
      {snaps.length === 0 && (
        <EmptyState title="No quota providers configured" body="Provider quota adapters are registered on the server; credentials never reach the browser." />
      )}
      {snaps.length > 0 && (
        <div className="quota-visibility">
          {snaps.map((s) => (
            <label key={s.providerId} className="plugin-toggle">
              <input
                type="checkbox"
                checked={!prefs.hiddenProviders.includes(s.providerId)}
                onChange={(e) => setProviderHidden(s.providerId, !e.target.checked)}
              />
              {s.providerId}
            </label>
          ))}
        </div>
      )}
      {snaps.length > 0 && visible.length === 0 && (
        <div className="muted" style={{ fontSize: 12 }}>All providers hidden — tick one to show its card.</div>
      )}
      {visible.length > 0 && (
        <div className="quota-grid">
          {visible.map((s) => <QuotaCard key={s.providerId} snap={s} onRefresh={refresh} />)}
        </div>
      )}
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
      <QuotaSection />
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
  const settings = useStore((s) => s.settings);
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
          <Row label="Branch name template" hint="Tokens: {slug} and {date}. Stored locally." itemId="git.branchTemplate">
            <input
              className="inp inp-mono"
              value={settings.branchTemplate}
              onChange={(e) => updateSettings({ branchTemplate: e.target.value })}
            />
          </Row>
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
  const profiles = useProfiles();
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [repairsFor, setRepairsFor] = useState<Record<string, string>>({});
  const checkProfile = async (p: AgentProfile) => {
    const r = await api.validateProfile(p.id).catch(() => null);
    setRepairsFor((m) => ({
      ...m,
      [p.id]: !r ? "check failed" : !r.checked ? "backend unavailable — not checked" : r.valid ? "valid ✓" : r.repairs.map((x) => x.reason).join("; "),
    }));
  };
  return (
    <>
      <PageHead title="Agents" blurb="Agent presets reported by the backend runtime, plus reusable agent profiles." />
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
      <div className="stat-label" style={{ display: "flex", alignItems: "center", gap: 8 }} data-settings-item="agents.profiles">
        <span>Agent profiles ({profiles.length})</span>
        <span className="header-spacer" />
        <button className="small-btn" onClick={() => setCreating(true)}>+ Profile</button>
      </div>
      {profiles.length === 0 && (
        <EmptyState title="No profiles yet" body="A profile bundles model, agent, and options into one atomic pick. Pin one from the model chooser or create one here." />
      )}
      {profiles.map((p) => (
        <div key={p.id} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">
              <span className="profile-avatar" style={{ background: p.color ?? "#7aa2f7" }} />
              {p.name}
            </div>
            <div className="set-row-hint mono">
              {p.providerID}/{p.modelID}{p.agent ? ` · ${p.agent}` : ""}{p.thinking ? ` · think:${p.thinking}` : ""}
            </div>
            {repairsFor[p.id] && <div className="set-row-hint">{repairsFor[p.id]}</div>}
          </div>
          <div className="set-row-control">
            <button className="small-btn" onClick={() => void checkProfile(p)}>Validate</button>
            <button className="small-btn" onClick={() => setEditing(p)}>Edit</button>
            <button className="small-btn danger-btn"
              onClick={() => { if (window.confirm(`Delete profile "${p.name}"?`)) void api.deleteProfile(p.id).then(() => refreshProfiles()); }}>
              Delete
            </button>
          </div>
        </div>
      ))}
      {(editing || creating) && (
        <AgentProfileForm
          {...(editing ? { existing: editing } : {})}
          onClose={() => { setEditing(null); setCreating(false); }}
        />
      )}
    </>
  );
}

function McpServerForm({ existing, onDone }: { existing?: McpServerDto; onDone: () => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<"stdio" | "http">(existing?.transport.kind ?? "stdio");
  const [command, setCommand] = useState(existing?.transport.kind === "stdio" ? existing.transport.command : "");
  const [args, setArgs] = useState(existing?.transport.kind === "stdio" ? existing.transport.args.join(" ") : "");
  const [url, setUrl] = useState(existing?.transport.kind === "http" ? existing.transport.url : "");
  // Env keys / header names with values entered once; values are write-only.
  // Editing prefills the key names with EMPTY values — stored values are never
  // echoed back; leaving a value blank keeps the stored one.
  const [secretRows, setSecretRows] = useState<Array<{ key: string; value: string }>>(() => {
    if (!existing) return [];
    const keys = existing.transport.kind === "stdio" ? existing.transport.envKeys : existing.transport.headersSecretRefs;
    return keys.map((key) => ({ key, value: "" }));
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const keys = secretRows.map((r) => r.key.trim()).filter(Boolean);
      const secrets: Record<string, string> = {};
      for (const r of secretRows) if (r.key.trim() && r.value) secrets[r.key.trim()] = r.value;
      const transport: McpTransport = kind === "stdio"
        ? { kind: "stdio", command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : [], envKeys: keys }
        : { kind: "http", url: url.trim(), headersSecretRefs: keys };
      if (existing) {
        await api.mcpUpdate(existing.id, {
          name: name.trim(), transport,
          ...(Object.keys(secrets).length ? { secrets } : {}),
        }, existing.revision);
      } else {
        await api.mcpCreate({ name: name.trim(), transport, ...(Object.keys(secrets).length ? { secrets } : {}) });
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-form">
      <div className="mcp-form-row">
        <input value={name} placeholder="name" style={{ maxWidth: 140 }} onChange={(e) => setName(e.target.value)} aria-label="Server name" />
        <Seg value={kind} options={[["stdio", "stdio"], ["http", "HTTP"]]} onChange={setKind} />
      </div>
      {kind === "stdio" ? (
        <div className="mcp-form-row">
          <input value={command} placeholder="command (no shell)" style={{ maxWidth: 200 }} onChange={(e) => setCommand(e.target.value)} aria-label="Command" />
          <input value={args} placeholder="args (space separated)" onChange={(e) => setArgs(e.target.value)} aria-label="Arguments" />
        </div>
      ) : (
        <div className="mcp-form-row">
          <input value={url} placeholder="https://host/mcp" onChange={(e) => setUrl(e.target.value)} aria-label="Server URL" />
        </div>
      )}
      <div className="mcp-secrets">
        <div className="stat-label">{kind === "stdio" ? "Environment secrets" : "Header secrets"} <span className="muted">(values stored server-side, never shown again)</span></div>
        {secretRows.map((row, i) => (
          <div key={i} className="mcp-form-row">
            <input value={row.key} placeholder={kind === "stdio" ? "ENV_KEY" : "Header-Name"} style={{ maxWidth: 160 }}
              onChange={(e) => setSecretRows((rs) => rs.map((r, j) => j === i ? { ...r, key: e.target.value } : r))} />
            <input type="password" value={row.value} placeholder="value"
              onChange={(e) => setSecretRows((rs) => rs.map((r, j) => j === i ? { ...r, value: e.target.value } : r))} />
            <button className="small-btn" onClick={() => setSecretRows((rs) => rs.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button className="ghost-link" onClick={() => setSecretRows((rs) => [...rs, { key: "", value: "" }])}>+ secret</button>
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="mcp-form-row">
        <button className="small-btn" disabled={busy || !name.trim() || (kind === "stdio" ? !command.trim() : !url.trim())} onClick={() => void submit()}>
          {existing ? "Save changes" : "Add server"}
        </button>
        {existing && <button className="small-btn" disabled={busy} onClick={onDone}>Cancel</button>}
      </div>
    </div>
  );
}

/** F10: paste an mcpServers JSON block, preview the mapped entries, then save. */
function McpImportForm({ existingNames, onDone }: { existingNames: string[]; onDone: () => void }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<McpImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<string[]>([]);

  const doImport = async () => {
    if (!preview) return;
    setBusy(true);
    const out: string[] = [];
    for (const entry of preview.entries) {
      try {
        await api.mcpCreate({
          name: entry.name, transport: entry.transport,
          ...(entry.secrets ? { secrets: entry.secrets } : {}),
          ...(entry.enabled === false ? { enabled: false } : {}),
        });
        out.push(`✓ ${entry.name}`);
      } catch (e) {
        out.push(`✗ ${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      setResults([...out]);
    }
    setBusy(false);
    if (out.every((line) => line.startsWith("✓"))) onDone();
  };

  return (
    <div className="mcp-form" data-settings-item="mcp.import">
      <div className="stat-label">Import JSON <span className="muted">(mcpServers block — Claude or OpenCode shape; env/header values become write-only secrets)</span></div>
      <textarea
        rows={6}
        className="mono"
        placeholder={'{\n  "mcpServers": {\n    "my-server": { "command": "npx", "args": ["-y", "some-mcp"], "env": { "API_KEY": "…" } }\n  }\n}'}
        value={text}
        onChange={(e) => { setText(e.target.value); setPreview(null); setResults([]); }}
      />
      {preview && (
        <div className="mcp-import-preview">
          {preview.entries.map((entry) => {
            const dup = existingNames.includes(entry.name);
            const secretKeys = entry.transport.kind === "stdio" ? entry.transport.envKeys : entry.transport.headersSecretRefs;
            return (
              <div key={entry.name} className="set-row-hint mono">
                {dup ? "⚠" : "+"} {entry.name} · {entry.transport.kind === "stdio"
                  ? `${entry.transport.command} ${entry.transport.args.join(" ")}`.trim()
                  : entry.transport.url}
                {secretKeys.length > 0 && <span className="secret-redacted"> · secrets: {secretKeys.join(", ")}</span>}
                {dup && <span> — name already exists, will fail</span>}
              </div>
            );
          })}
          {preview.errors.map((e, i) => <div key={i} className="form-error">{e}</div>)}
        </div>
      )}
      {results.map((line, i) => (
        <div key={i} className={line.startsWith("✗") ? "form-error" : "set-row-hint"}>{line}</div>
      ))}
      <div className="mcp-form-row">
        <button className="small-btn" disabled={busy || !text.trim()} onClick={() => setPreview(parseMcpServersJson(text))}>
          Preview
        </button>
        <button className="small-btn" disabled={busy || !preview || preview.entries.length === 0} onClick={() => void doImport()}>
          {busy ? "Importing…" : `Import ${preview?.entries.length ?? 0} server${(preview?.entries.length ?? 0) === 1 ? "" : "s"}`}
        </button>
        <button className="small-btn" disabled={busy} onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

export function McpPage() {
  const [servers, setServers] = useState<McpServerDto[]>([]);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});
  const refresh = () => void api.mcpList().then(setServers);
  useEffect(() => { refresh(); }, []);

  const probe = async (s: McpServerDto) => {
    const r = await api.mcpProbe(s.id).catch((e) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
    setTestMsg((m) => ({ ...m, [s.id]: `${r.ok ? "✓" : "✗"} ${r.message}` }));
    refresh();
  };

  return (
    <>
      <PageHead title="MCP" blurb="Model Context Protocol servers, applied to the backend runtime. Secret values are write-only." />
      <div className="mcp-list" data-settings-item="mcp.servers">
        {servers.length === 0 && !adding && (
          <EmptyState title="No MCP servers configured" body="Add a stdio or HTTP server; the backend adapter applies the configuration." />
        )}
        {servers.map((s) => editingId === s.id ? (
          <McpServerForm key={s.id} existing={s} onDone={() => { setEditingId(null); refresh(); }} />
        ) : (
          <div key={s.id} className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">{s.name}</div>
              <div className="set-row-hint mono">
                {s.transport.kind === "stdio"
                  ? `${s.transport.command} ${s.transport.args.join(" ")}`.trim()
                  : s.transport.url}
                {s.transport.kind === "stdio" && s.transport.envKeys.length > 0 && (
                  <span className="secret-redacted"> · env: {s.transport.envKeys.join(", ")}</span>
                )}
                {s.transport.kind === "http" && s.transport.headersSecretRefs.length > 0 && (
                  <span className="secret-redacted"> · headers: {s.transport.headersSecretRefs.join(", ")}</span>
                )}
              </div>
              {(testMsg[s.id] || s.lastError) && <div className="set-row-hint">{testMsg[s.id] ?? s.lastError}</div>}
            </div>
            <div className="set-row-control">
              <span className={`tag mcp-status ${s.status}`}>{s.status}</span>
              <button className="small-btn" title="Check reachability and store the result" onClick={() => void probe(s)}>Probe</button>
              <button className="small-btn" onClick={() => setEditingId(s.id)}>Edit</button>
              <button className="small-btn" onClick={() => void api.mcpUpdate(s.id, { enabled: !s.enabled }, s.revision).then(refresh)}>
                {s.enabled ? "Disable" : "Enable"}
              </button>
              <button className="small-btn danger-btn" onClick={() => { if (window.confirm(`Remove MCP server "${s.name}"?`)) void api.mcpRemove(s.id).then(refresh); }}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      {adding && <McpServerForm onDone={() => { setAdding(false); refresh(); }} />}
      {importing && <McpImportForm existingNames={servers.map((s) => s.name)} onDone={() => { setImporting(false); refresh(); }} />}
      {!adding && !importing && (
        <div className="mcp-form-row">
          <button className="small-btn" onClick={() => setAdding(true)}>+ MCP server</button>
          <button className="small-btn" onClick={() => setImporting(true)}>Import JSON…</button>
        </div>
      )}
    </>
  );
}

const TOGGLE: PluginId[] = [
  "files", "git", "github", "preview", "terminal", "context", "usage", "events",
  "goals", "multirun", "fusion", "walkthrough", "schedule", "dictation",
];

function PluginLogViewer({ id }: { id: string }) {
  const [lines, setLines] = useState<Array<{ at: number; line: string }>>([]);
  useEffect(() => { void api.pluginsLogs(id).then(setLines).catch(() => setLines([])); }, [id]);
  return (
    <div className="plugin-log" role="log" aria-label={`Logs for ${id}`}>
      {lines.length === 0 && <span className="muted">No log output.</span>}
      {lines.map((l, i) => <div key={i} className="mono plugin-log-line">{l.line}</div>)}
    </div>
  );
}

function ManagedPluginsSection() {
  const [plugins, setPlugins] = useState<InstalledPluginDto[]>([]);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const refresh = () => void api.pluginsList().then(setPlugins);
  useEffect(() => { refresh(); }, []);

  const install = async () => {
    if (!source.trim()) return;
    setError("");
    try {
      await api.pluginsInstall(source.trim());
      setSource("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const op = async (id: string, what: "enable" | "disable" | "reload") => {
    setError("");
    try {
      await api.pluginsOp(id, what);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    refresh();
  };

  return (
    <div data-settings-item="plugins.managed">
      <div className="stat-label">Managed plugins ({plugins.length})</div>
      {plugins.length === 0 && (
        <EmptyState title="No managed plugins installed" body='Install with "npm:@scope/name@version" or "file:folder" (relative to the trusted plugin directory).' />
      )}
      {plugins.map((p) => (
        <div key={p.id} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">
              {p.name} <span className="muted mono">v{p.version}</span>
              <span className={`tag plugin-trust trust-${p.trust}`} title={p.trust}>{p.trust}</span>
            </div>
            <div className="set-row-hint mono">{p.source}{p.contributions.length ? ` · ${p.contributions.length} contribution${p.contributions.length === 1 ? "" : "s"}` : ""}</div>
            {p.lastError && <div className="set-row-hint form-error">{p.lastError}</div>}
          </div>
          <div className="set-row-control">
            <span className={`tag mcp-status ${p.status === "ready" ? "connected" : p.status === "error" ? "error" : "disabled"}`}>{p.status}</span>
            <button className="small-btn" onClick={() => void op(p.id, p.enabled ? "disable" : "enable")}>{p.enabled ? "Disable" : "Enable"}</button>
            <button className="small-btn" onClick={() => void op(p.id, "reload")}>Reload</button>
            <button className="small-btn" onClick={() => setLogsFor(logsFor === p.id ? null : p.id)}>Logs</button>
            <button className="small-btn danger-btn" onClick={() => { if (window.confirm(`Remove plugin "${p.name}"?`)) void api.pluginsRemove(p.id).then(refresh); }}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {logsFor && <PluginLogViewer id={logsFor} />}
      <div className="set-add-form">
        <input value={source} placeholder="npm:@scope/name@1.0.0 or file:my-plugin" onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void install()} />
        <button className="small-btn" onClick={() => void install()}>Install</button>
      </div>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

export function PluginsPage() {
  const prefs = usePrefs();
  const custom = isCustomized(prefs);
  return (
    <>
      <PageHead title="Plugins" blurb="Everything is a widget. Toggle panels and workflows without leaving the session." />
      <div className="plugin-toggles" data-settings-item="plugins.builtin">
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
      <ManagedPluginsSection />
    </>
  );
}

export function AboutPage() {
  const [info, setInfo] = useState<SystemInfoDto | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    void api.systemInfo().then(setInfo).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(
      () => { setCopied(label); window.setTimeout(() => setCopied(""), 1500); },
      () => setCopied("copy blocked by the browser"),
    );
  };
  if (err) return <><PageHead title="About" /><EmptyState title="Server unreachable" body={err} /></>;
  if (!info) return <><PageHead title="About" /><EmptyState title="Loading…" /></>;
  return (
    <>
      <PageHead title="About" blurb="Connection details for this Polyth server." />
      <div data-settings-item="about.info">
        <Row label="Version"><span className="mono">{info.version}</span></Row>
        <Row label="Application URL" hint="The configured local address (never derived from request headers).">
          <span className="mono">{info.applicationUrl}</span>
          <button className="small-btn" onClick={() => copy("URL", info.applicationUrl)}>Copy</button>
        </Row>
        <Row label="Tunnel" hint={info.tunnelUrl ? "Public tunnel is configured." : "No tunnel configured."}>
          {info.tunnelUrl
            ? <><span className="mono">{info.tunnelUrl}</span><button className="small-btn" onClick={() => copy("tunnel", info.tunnelUrl!)}>Copy</button></>
            : <span className="tag">none</span>}
        </Row>
        <Row label="Data directory"><span className="mono">{info.dataDirLabel}</span></Row>
        <Row label="Capabilities">
          <span className="muted" style={{ maxWidth: 360, textAlign: "right" }}>{info.capabilities.join(", ")}</span>
        </Row>
        {copied && <div className="muted" role="status">{copied === "copy blocked by the browser" ? copied : `${copied} copied.`}</div>}
      </div>
    </>
  );
}
