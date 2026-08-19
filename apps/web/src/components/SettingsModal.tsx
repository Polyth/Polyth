// Settings overlay: left nav pages, controls persisted to localStorage via the
// store (polyth.settings). Backend-owned areas get honest muted copy, no fake data.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useStore, updateSettings } from "../store.ts";
import { DEFAULT_SETTINGS, formatModelRef, modKeyLabel, type PolythSettings } from "../settings.ts";
import { fmtTokens, providerColor } from "../format.ts";

type PageId = "general" | "appearance" | "models" | "sessions" | "git" | "shortcuts";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const NAV_ICONS: Record<PageId, ReactNode> = {
  general: (
    <svg width="15" height="15" viewBox="0 0 16 16" {...STROKE}>
      <path d="M2.4 4.6h4M9.4 4.6h4.2M2.4 11.4h4.2M9.6 11.4h4" /><circle cx="7.6" cy="4.6" r="1.5" /><circle cx="8.4" cy="11.4" r="1.5" />
    </svg>
  ),
  appearance: (
    <svg width="15" height="15" viewBox="0 0 16 16" {...STROKE}>
      <path d="M8 14A6 6 0 1 1 14 8c0 1.5-1.2 2.2-2.5 2.2h-1c-.8 0-1.4.6-1.4 1.4 0 1-.5 2.4-1.1 2.4z" />
      <circle cx="5.4" cy="7" r=".8" fill="currentColor" /><circle cx="8" cy="5" r=".8" fill="currentColor" /><circle cx="10.7" cy="7" r=".8" fill="currentColor" />
    </svg>
  ),
  models: (
    <svg width="15" height="15" viewBox="0 0 16 16" {...STROKE}>
      <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.8" />
      <path d="M6.4 1.9v2.3M9.6 1.9v2.3M6.4 11.8v2.3M9.6 11.8v2.3M1.9 6.4h2.3M1.9 9.6h2.3M11.8 6.4h2.3M11.8 9.6h2.3" />
    </svg>
  ),
  sessions: (
    <svg width="15" height="15" viewBox="0 0 16 16" {...STROKE}>
      <path d="M8 1.9 14 5l-6 3.1L2 5z" /><path d="M2 8.4 8 11.5l6-3.1M2 11.4 8 14.5l6-3.1" />
    </svg>
  ),
  git: (
    <svg width="15" height="15" viewBox="0 0 16 16" {...STROKE}>
      <circle cx="4.6" cy="4" r="1.7" /><circle cx="4.6" cy="12" r="1.7" /><circle cx="11.4" cy="5.6" r="1.7" />
      <path d="M4.6 5.7v4.6M11.4 7.3c0 2.3-2.5 2.5-5 3" />
    </svg>
  ),
  shortcuts: (
    <svg width="15" height="15" viewBox="0 0 16 16" {...STROKE}>
      <rect x="1.4" y="4" width="13.2" height="8" rx="1.8" /><path d="M4 6.6h.01M6.4 6.6h.01M8.8 6.6h.01M11.2 6.6h.01M4 9.3h7.2" />
    </svg>
  ),
};

const PAGES: Array<{ id: PageId; label: string; desc: string }> = [
  { id: "general", label: "General", desc: "Workspace defaults and composer behaviour." },
  { id: "appearance", label: "Appearance", desc: "Theme, density, and typography." },
  { id: "models", label: "Models", desc: "Available models and the default for new sessions." },
  { id: "sessions", label: "Sessions", desc: "Titles and what the sidebar shows." },
  { id: "git", label: "Git", desc: "Branch preferences for this workspace." },
  { id: "shortcuts", label: "Shortcuts", desc: "Key bindings for every surface." },
];

const PAGE_KEYS: Record<PageId, Array<keyof PolythSettings>> = {
  general: ["productName", "relativeTime", "sendOnEnter"],
  appearance: ["theme", "density", "fontSize"],
  models: ["defaultModel"],
  sessions: ["autoTitleSessions", "showArchived"],
  git: ["branchTemplate"],
  shortcuts: [],
};

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

function Row({ title, desc, children, top }: { title: string; desc?: ReactNode; children?: ReactNode; top?: boolean }) {
  return (
    <div className={`set-row ${top ? "top" : ""}`}>
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        {desc !== undefined && <div className="set-row-desc">{desc}</div>}
      </div>
      {children !== undefined && <div className="set-row-ctl">{children}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="set-sec">
      <div className="set-sec-title">{title}</div>
      {children}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

function ShortcutRow({ name, ctx, keys }: { name: string; ctx: string; keys: string[] }) {
  return (
    <div className="krow">
      <span className="kname">{name}</span>
      <span className="kctx">{ctx}</span>
      <span className="combo">{keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>
    </div>
  );
}

function ThemeCard({ active, name, colors, onPick }: {
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
        <svg className="theme-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3.4 8.4 6.4 11.4l6.2-6.8" /></svg>
      </div>
    </button>
  );
}

export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [page, setPage] = useState<PageId>("general");
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const agents = useStore((s) => s.agents);
  const branch = useStore((s) => s.gitBranch);
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const modalRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const mod = modKeyLabel();

  // Escape closes; Tab cycles inside the dialog (simple focus trap).
  useEffect(() => {
    if (!open) return;
    modalRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && modalRef.current) {
        const focusables = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const modelGroups = useMemo(() => {
    const groups = new Map<string, typeof models>();
    for (const m of models) {
      const g = groups.get(m.providerID) ?? [];
      g.push(m);
      groups.set(m.providerID, g);
    }
    return [...groups.entries()];
  }, [models]);

  if (!open) return null;

  const pageMeta = PAGES.find((p) => p.id === page)!;
  const selectPage = (id: PageId) => {
    setPage(id);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };
  const resetPage = () => {
    const patch: Partial<PolythSettings> = {};
    for (const k of PAGE_KEYS[page]) (patch as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
    updateSettings(patch);
  };
  const fontPct = ((settings.fontSize - 12) / (18 - 12)) * 100;

  return (
    <div
      className="scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal" ref={modalRef} tabIndex={-1}>
        <nav className="modal-nav">
          <h3>Settings</h3>
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={`nav-item ${p.id === page ? "active" : ""}`}
              aria-current={p.id === page ? "page" : undefined}
              onClick={() => selectPage(p.id)}
            >
              {NAV_ICONS[p.id]}
              {p.label}
            </button>
          ))}
          <div className="nav-foot">
            Polyth <span className="mono">0.1.0</span><br />
            Preferences stored locally
          </div>
        </nav>

        <div className="modal-main">
          <div className="modal-head">
            <div>
              <div className="modal-title">{pageMeta.label}</div>
              <div className="modal-desc">{pageMeta.desc}</div>
            </div>
            <span className="header-spacer" />
            <button className="close-btn" aria-label="Close settings" onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" /></svg>
            </button>
          </div>

          <div className="modal-body" ref={bodyRef}>
            {page === "general" && (
              <>
                <Section title="Workspace">
                  <Row title="Product name" desc="Shown in the sidebar and the window title.">
                    <input
                      className="inp"
                      value={settings.productName}
                      aria-label="Product name"
                      onChange={(e) => updateSettings({ productName: e.target.value })}
                      onBlur={() => { if (settings.productName.trim() === "") updateSettings({ productName: DEFAULT_SETTINGS.productName }); }}
                    />
                  </Row>
                  <Row title="Relative timestamps" desc="Show session activity as “2m ago” instead of a clock time.">
                    <Switch checked={settings.relativeTime} label="Relative timestamps" onChange={(v) => updateSettings({ relativeTime: v })} />
                  </Row>
                </Section>
                <Section title="Composer">
                  <Row title="Send on Enter" desc={<>Enter sends the message. When off, Enter inserts a newline and {mod}+Enter sends.</>}>
                    <Switch checked={settings.sendOnEnter} label="Send on Enter" onChange={(v) => updateSettings({ sendOnEnter: v })} />
                  </Row>
                </Section>
              </>
            )}

            {page === "appearance" && (
              <>
                <Section title="Theme">
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
                </Section>
                <Section title="Layout & type">
                  <Row title="Density" desc="Compact tightens row heights in the sidebar and rail.">
                    <div className="seg">
                      <button className={settings.density === "comfortable" ? "active" : ""} onClick={() => updateSettings({ density: "comfortable" })}>Comfortable</button>
                      <button className={settings.density === "compact" ? "active" : ""} onClick={() => updateSettings({ density: "compact" })}>Compact</button>
                    </div>
                  </Row>
                  <Row title="Interface font size" desc="Scales everything except code blocks and the terminal.">
                    <div className="rng">
                      <input
                        type="range"
                        min={12}
                        max={18}
                        value={settings.fontSize}
                        aria-label="Interface font size"
                        style={{ "--p": `${fontPct}%` } as CSSProperties}
                        onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
                      />
                      <span className="rng-val">{settings.fontSize}px</span>
                    </div>
                  </Row>
                </Section>
              </>
            )}

            {page === "models" && (
              <>
                <Section title="Defaults">
                  <Row title="Default model" desc="Used for new sessions. Change per session from the composer.">
                    <span className="sel">
                      <select
                        value={settings.defaultModel}
                        aria-label="Default model"
                        onChange={(e) => updateSettings({ defaultModel: e.target.value })}
                      >
                        <option value="">Server default</option>
                        {modelGroups.map(([provider, ms]) => (
                          <optgroup key={provider} label={provider}>
                            {ms.map((m) => (
                              <option key={m.modelID} value={formatModelRef(m)}>{m.name || m.modelID}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      <svg width="14" height="14" viewBox="0 0 16 16" {...STROKE}><path d="M3.8 6.2 8 10.4l4.2-4.2" /></svg>
                    </span>
                  </Row>
                </Section>
                <Section title="Available models">
                  {models.length === 0 && (
                    <p className="set-muted">
                      No models yet. OpenCode reports models once a provider is configured — there is nothing to show at the moment.
                    </p>
                  )}
                  {modelGroups.map(([provider, ms]) => (
                    <div className="prov" key={provider}>
                      <span className="prov-logo" style={{ color: providerColor(provider) }}>{provider.slice(0, 1).toUpperCase()}</span>
                      <span className="prov-body">
                        <span className="prov-name">{provider}</span>
                        <span className="prov-sub">{ms.length} {ms.length === 1 ? "model" : "models"}</span>
                      </span>
                      <span className="prov-models">
                        {ms.map((m) => (
                          <span className="tag" key={m.modelID} title={m.modelID}>
                            {m.name || m.modelID}
                            {m.context !== undefined && <em>· {fmtTokens(m.context)} ctx</em>}
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                  {agents.length > 0 && (
                    <p className="set-muted">Agents from OpenCode: {agents.map((a) => a.name).join(", ")}.</p>
                  )}
                </Section>
              </>
            )}

            {page === "sessions" && (
              <>
                <Section title="Naming">
                  <Row title="Auto-title new sessions" desc="Derive a short title from the first prompt instead of showing the session id.">
                    <Switch checked={settings.autoTitleSessions} label="Auto-title new sessions" onChange={(v) => updateSettings({ autoTitleSessions: v })} />
                  </Row>
                </Section>
                <Section title="Sidebar">
                  <Row title="Show archived sessions" desc="Archived sessions stay replayable; hiding them just tidies the list.">
                    <Switch checked={settings.showArchived} label="Show archived sessions" onChange={(v) => updateSettings({ showArchived: v })} />
                  </Row>
                </Section>
                <p className="set-muted">
                  Retention, archive cleanup, and export formats are managed by the Polyth server and aren’t configurable from here yet.
                </p>
              </>
            )}

            {page === "git" && (
              <>
                <Section title="Workspace">
                  <Row title="Current branch" desc={project ? `Reported for ${project.name || project.path}.` : "Open a project to see its branch."}>
                    <span className="tag mono">{branch || "—"}</span>
                  </Row>
                  <Row title="Branch name template" desc={<>Tokens: <span className="mono">{"{slug}"}</span> <span className="mono">{"{date}"}</span>. Stored locally.</>}>
                    <input
                      className="inp inp-mono"
                      value={settings.branchTemplate}
                      aria-label="Branch name template"
                      onChange={(e) => updateSettings({ branchTemplate: e.target.value })}
                    />
                  </Row>
                </Section>
                <p className="set-muted">
                  Worktrees, protected branches, and commit policy live on the Polyth server and aren’t configurable from here yet.
                </p>
              </>
            )}

            {page === "shortcuts" && (
              <>
                <Section title="Global">
                  <div className="keys">
                    <ShortcutRow name="Command palette" ctx="Anywhere" keys={[mod, "K"]} />
                    <ShortcutRow name="New session" ctx="Anywhere" keys={[mod, "N"]} />
                    <ShortcutRow name="Settings" ctx="Anywhere" keys={[mod, ","]} />
                  </div>
                </Section>
                <Section title="Composer">
                  <div className="keys">
                    {settings.sendOnEnter ? (
                      <>
                        <ShortcutRow name="Send message" ctx="Composer" keys={["⏎"]} />
                        <ShortcutRow name="Newline" ctx="Composer" keys={["⇧", "⏎"]} />
                      </>
                    ) : (
                      <>
                        <ShortcutRow name="Send message" ctx="Composer" keys={[mod, "⏎"]} />
                        <ShortcutRow name="Newline" ctx="Composer" keys={["⏎"]} />
                      </>
                    )}
                    <ShortcutRow name="Close dialogs" ctx="Anywhere" keys={["Esc"]} />
                  </div>
                </Section>
                <p className="set-muted">Shortcuts are fixed for now — rebinding isn’t available yet.</p>
              </>
            )}
          </div>

          <div className="modal-foot">
            <span className="modal-note">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3.4 8.4 6.4 11.4l6.2-6.8" /></svg>
              Changes are saved as you edit
            </span>
            <span className="header-spacer" />
            {PAGE_KEYS[page].length > 0 && (
              <button className="btn-soft" onClick={resetPage}>Reset page</button>
            )}
            <button className="btn-accent" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
