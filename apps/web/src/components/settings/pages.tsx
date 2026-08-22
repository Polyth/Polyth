// The simpler settings pages: General, Appearance, Chat, Notifications,
// Behavior, Usage, Projects, Git, Agents, MCP, Plugins.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  NO_PRESET_CARD, WORKSPACE_PRESETS, applyPreset, clearPreset, formatPresetSummary,
  getPresentation, getPresetState, presetSummary, resetDisclosureChoices,
  resetWorkspaceOrder, setPlacementOverride, usePresentation, usePresetState,
  type CapabilityTier, type PresetSummary, type WorkspacePresetId,
} from "../../workspacePresets.ts";
import { listCapabilities, useResolvedCapabilities } from "../../capabilities.ts";
import { openWorkspacePane, setOverlay, updateSettings, useStore } from "../../store.ts";
import { setUiSettings, useUiSettings } from "../../uiPrefs.ts";
import { setProviderHidden, useUsagePrefs } from "../../usagePrefs.ts";
import { requestNotifyPermission } from "../../notify.ts";
import { disablePush, enablePush, pushSubscription, pushUnsupportedReason } from "../../push.ts";
import { api, type GitStatus } from "../../api.ts";
import { fmtCost, fmtTokens } from "../../format.ts";
import { EmptyState, PageHead, Row, Seg, Toggle } from "./parts.tsx";
import { refreshProfiles, useProfiles } from "../../profiles.ts";
import { removeProject } from "../../init.ts";
import AgentProfileForm from "../AgentProfileForm.tsx";
import ProjectFolderDialog from "../ProjectFolderDialog.tsx";
import { parseMcpServersJson, type McpImportResult } from "../../mcpImport.ts";
import {
  PRESET_THEMES, addCustomTheme, applyTheme, loadCustomThemes, parseThemeJson,
  reapplyTheme, removeCustomTheme, resolveTheme, type ThemeSpec,
} from "../../theme.ts";
import type { AssistSettingsDto } from "../../api.ts";
import type { AgentProfile, InstalledPluginDto, McpServerDto, McpTransport, SystemInfoDto } from "@polyth/contracts";
import { useWidgetCatalog } from "../../widgets/catalog.ts";
import { useWidgetLayout } from "../../widgets/widgetLayout.ts";
import { roleKind, setRoleKind, useRolePrefs } from "../../rolePrefs.ts";
import {
  ProviderUsageDonut,
  projectUsageStats,
  sessionTokens,
  topProjectSessions,
} from "../../usage/projectUi.tsx";
import {
  QuotaCard,
  QuotaOverviewGrid,
  useQuotaSnapshots,
} from "../../usage/quotaUi.tsx";

function ThemeSwatches({ theme }: { theme: ThemeSpec }) {
  return (
    <span className="theme-swatches" aria-hidden="true">
      <i style={{ background: theme.tokens.bg }} />
      <i style={{ background: theme.tokens.panel }} />
      <i style={{ background: theme.tokens.accent }} />
      <i style={{ background: theme.tokens.text }} />
    </span>
  );
}

/** UX-PERSONAS: `Workspace preset` (never "persona"). Offers the four
 *  choices, Preview changes, Apply, Clear preset, and the separate reset
 *  controls. Switching preserves explicit placement, starter, and disclosure
 *  overrides; when an override masks a proposed change, the preview says so
 *  and `Keep my layout` is the default. */
function WorkspacePresetSection() {
  const state = usePresetState();
  usePresentation();
  const [draft, setDraft] = useState<WorkspacePresetId | "none">(state.presetId ?? "none");
  const [preview, setPreview] = useState<PresetSummary | null>(null);
  useEffect(() => {
    setDraft(state.presetId ?? "none");
    setPreview(null);
  }, [state.presetId]);

  const summarize = (choice: WorkspacePresetId | "none"): PresetSummary =>
    presetSummary({
      presetId: choice === "none" ? null : choice,
      currentPresetId: getPresetState().presetId,
      caps: listCapabilities().map((d) => ({
        id: d.id,
        standardTier: d.standardTier,
        standardRank: d.standardRank,
        label: d.label,
        available: d.available(),
      })),
      overrides: getPresentation().placements,
      starterOverride: getPresentation().starterOrder,
      explicitComposerDetail: getPresetState().composerDetail,
    });

  const apply = () => applyPreset(draft === "none" ? null : draft);
  const usePresetOrder = () => {
    if (!window.confirm("Use the preset order? This clears only your explicit placement and starter overrides.")) return;
    resetWorkspaceOrder();
    apply();
  };

  const current = state.presetId
    ? WORKSPACE_PRESETS.find((p) => p.id === state.presetId)?.label ?? state.presetId
    : NO_PRESET_CARD.label;
  const presetOptions: Array<[WorkspacePresetId | "none", string]> = [
    ...WORKSPACE_PRESETS.map((p): [WorkspacePresetId | "none", string] => [p.id, p.label]),
    ["none", NO_PRESET_CARD.label],
  ];
  const currentId: WorkspacePresetId | "none" = state.presetId ?? "none";

  return (
    <>
      <Row
        label="Workspace preset"
        hint={`Current: ${current}. A preset changes starter actions, workspace order, and initial detail — it never hides tools or changes what you can do.`}
        itemId="general.workspacePreset"
      >
        <div className="seg workspace-preset-seg" role="radiogroup" aria-label="Workspace preset">
          {presetOptions.map(([id, label]) => {
            const selected = draft === id;
            const applied = currentId === id;
            return (
              <button
                key={id}
                type="button"
                className={selected ? "on" : ""}
                role="radio"
                aria-checked={selected}
                onClick={() => { setDraft(id); setPreview(null); }}
              >
                <span className="workspace-preset-choice">
                  <span className="workspace-preset-check" aria-hidden="true">{selected ? "✓" : ""}</span>
                  {label}
                </span>
                {applied && <span className="workspace-preset-current">Current</span>}
              </button>
            );
          })}
        </div>
      </Row>
      <Row label="Preview and apply" hint="Preview shows the exact effective changes before anything is saved.">
        <div className="preset-settings-actions">
          <button className="small-btn" onClick={() => setPreview(summarize(draft))}>Preview changes</button>
          <button className="small-btn" onClick={apply}>Apply</button>
          <button className="small-btn" onClick={clearPreset}>Clear preset</button>
        </div>
      </Row>
      {preview && (
        <div className="preset-preview preset-preview-settings" role="region" aria-label="Preset preview">
          <pre className="preset-preview-text">{formatPresetSummary(preview)}</pre>
          {preview.maskedByOverrides.length > 0 && (
            <div className="preset-preview-note">
              <p>Some of your explicit layout choices mask this preset’s suggested order. Keeping your layout is the default.</p>
              <div className="preset-settings-actions">
                <button className="small-btn btn-accent" onClick={apply}>Keep my layout</button>
                <button className="small-btn" onClick={usePresetOrder}>Use preset order</button>
              </div>
            </div>
          )}
        </div>
      )}
      <Row label="Workspace setup" hint="Choose another starting point. You can change everything afterward.">
        <button className="small-btn" onClick={() => setOverlay("onboarding")}>Choose a setup…</button>
      </Row>
      <Row label="Reset workspace order" hint="Clears your explicit capability placement and starter overrides only.">
        <button
          className="small-btn"
          onClick={() => { if (window.confirm("Reset workspace order to the preset (or standard) arrangement?")) resetWorkspaceOrder(); }}
        >Reset workspace order</button>
      </Row>
      <Row label="Reset disclosure choices" hint="Technical options and More tools return to their preset-seeded state.">
        <button className="small-btn" onClick={resetDisclosureChoices}>Reset disclosure choices</button>
      </Row>
    </>
  );
}

export function GeneralPage() {
  const settings = useStore((s) => s.settings);
  return (
    <>
      <PageHead title="General" blurb="Workspace basics. A preset is a starting arrangement — change or clear it anytime." />
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
      <WorkspacePresetSection />
    </>
  );
}

const EXAMPLE_THEME_HINT = 'Paste theme JSON: { "id": "my-theme", "name": "My theme", "appearance": "dark", "tokens": { "bg": "#101010", … } }';

// F15: searchable grouped picker + system-follow + custom JSON themes.
// Hover applies the candidate tokens live; leaving re-applies the saved pick.
function ThemeSection() {
  const settings = useStore((s) => s.settings);
  const [customs, setCustoms] = useState<ThemeSpec[]>(() => loadCustomThemes());
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  // Each apply repaints ~35 CSS variables and notifies canvas consumers, so
  // hover preview is debounced on one shared timer: sweeping across the list
  // coalesces to a single apply per pause and a single restore on exit,
  // instead of an apply + restore per crossed row.
  const previewTimer = useRef<number | null>(null);
  const previewApplied = useRef(false);
  const schedulePreview = (action: () => void) => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = null;
      action();
    }, 90);
  };
  const preview = (t: ThemeSpec) => schedulePreview(() => {
    previewApplied.current = true;
    applyTheme(t);
  });
  const endPreview = () => {
    if (!previewApplied.current) {
      if (previewTimer.current !== null) {
        window.clearTimeout(previewTimer.current);
        previewTimer.current = null;
      }
      return;
    }
    schedulePreview(() => {
      previewApplied.current = false;
      reapplyTheme();
    });
  };
  useEffect(() => () => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    if (previewApplied.current) reapplyTheme();
  }, []);
  const importJson = () => {
    const res = parseThemeJson(json);
    if (!res.ok) { setJsonError(res.error); return; }
    setCustoms(addCustomTheme(res.theme));
    setJson("");
    setJsonError("");
    updateSettings({ theme: res.theme.id });
  };
  const copyCurrent = () => {
    const current = resolveTheme(settings.theme, { custom: customs, systemDark: !document.documentElement.classList.contains("light") });
    const draft = { ...current, id: "my-theme", name: "My theme" };
    void navigator.clipboard?.writeText(JSON.stringify(draft, null, 2));
  };
  const removeCustom = (id: string) => {
    setCustoms(removeCustomTheme(id));
    if (settings.theme === id) updateSettings({ theme: "dark" });
  };
  const systemPreview = resolveTheme("system", {
    systemDark: typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : true,
  });
  const choices = [
    ...PRESET_THEMES.filter((theme) => theme.appearance === "dark").map((theme) => ({ group: "Dark", theme })),
    ...PRESET_THEMES.filter((theme) => theme.appearance === "light").map((theme) => ({ group: "Light", theme })),
    ...customs.map((theme) => ({ group: "Custom", theme })),
    { group: "System", theme: { ...systemPreview, id: "system", name: "System" } },
  ];
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? choices.filter(({ group, theme }) =>
        `${theme.name} ${theme.id} ${theme.appearance} ${group}`.toLowerCase().includes(normalizedQuery))
    : choices;
  const current = choices.find(({ theme }) => theme.id === settings.theme) ?? choices[0]!;
  const pick = (id: string) => {
    updateSettings({ theme: id });
    setQuery("");
    setPickerOpen(false);
  };
  return (
    <div className="set-sec" data-settings-item="appearance.theme">
      <div className="set-sec-title">Theme</div>
      <div
        className="theme-picker"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setPickerOpen(false);
            endPreview();
          }
        }}
      >
        <button
          className="theme-picker-current"
          aria-expanded={pickerOpen}
          aria-controls="theme-picker-options"
          onClick={() => setPickerOpen((open) => !open)}
        >
          <ThemeSwatches theme={current.theme} />
          <span><strong>{current.theme.name}</strong><small>{current.group} · {current.theme.appearance}</small></span>
          <b aria-hidden="true">⌄</b>
        </button>
        {pickerOpen && (
          <div className="theme-picker-pop" id="theme-picker-options">
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls="theme-picker-list"
              aria-label="Search themes"
              value={query}
              placeholder={`Search ${choices.length} themes…`}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setPickerOpen(false);
                  endPreview();
                }
              }}
            />
            <div className="theme-picker-list" id="theme-picker-list" role="listbox">
              {(["Dark", "Light", "Custom", "System"] as const).map((group) => {
                const groupChoices = filtered.filter((choice) => choice.group === group);
                if (groupChoices.length === 0) return null;
                return (
                  <section key={group}>
                    <div className="theme-picker-group">{group}</div>
                    {groupChoices.map(({ theme }) => (
                      <button
                        key={`${group}:${theme.id}`}
                        role="option"
                        aria-selected={settings.theme === theme.id}
                        className={settings.theme === theme.id ? "active" : ""}
                        onClick={() => pick(theme.id)}
                        onMouseEnter={() => preview(theme.id === "system" ? systemPreview : theme)}
                        onMouseLeave={endPreview}
                        onFocus={() => preview(theme.id === "system" ? systemPreview : theme)}
                        onBlur={endPreview}
                      >
                        <ThemeSwatches theme={theme} />
                        <span><strong>{theme.name}</strong><small>{theme.appearance}</small></span>
                        <b aria-hidden="true">{settings.theme === theme.id ? "✓" : ""}</b>
                      </button>
                    ))}
                  </section>
                );
              })}
              {filtered.length === 0 && <div className="theme-picker-empty">No matching themes</div>}
            </div>
          </div>
        )}
      </div>
      <div className="theme-swatch-strip" aria-label="Quick theme preview">
        {PRESET_THEMES.map((theme) => (
          <button
            key={theme.id}
            className={settings.theme === theme.id ? "active" : ""}
            title={theme.name}
            aria-label={`Use ${theme.name} theme`}
            onClick={() => pick(theme.id)}
            onMouseEnter={() => preview(theme)}
            onMouseLeave={endPreview}
            onFocus={() => preview(theme)}
            onBlur={endPreview}
            style={{ "--theme-swatch": theme.tokens.accent } as CSSProperties}
          />
        ))}
      </div>
      {customs.length > 0 && (
        <div className="theme-custom-list">
          {customs.map((t) => (
            <div key={t.id} className="theme-custom-row">
              <span className="mono">{t.id}</span>
              <span className="muted">{t.name} · {t.appearance}</span>
              <span className="header-spacer" />
              <button className="small-btn danger-btn" onClick={() => removeCustom(t.id)}>Delete</button>
            </div>
          ))}
        </div>
      )}
      <div className="theme-import">
        <textarea
          className="theme-import-input"
          rows={3}
          placeholder={EXAMPLE_THEME_HINT}
          value={json}
          onChange={(e) => { setJson(e.target.value); setJsonError(""); }}
          aria-label="Custom theme JSON"
        />
        <div className="theme-import-actions">
          <button className="small-btn" disabled={!json.trim()} onClick={importJson}>Import theme</button>
          <button className="small-btn" onClick={copyCurrent} title="Copy the active theme as JSON to edit">Copy current as JSON</button>
        </div>
        {jsonError && <div className="form-error">{jsonError}</div>}
      </div>
    </div>
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
      <ThemeSection />
      <Row label="Density" hint="Choose airy, balanced, or compact spacing across panels." itemId="appearance.density">
        <Seg value={ui.density} options={[["comfortable", "Comfortable"], ["balanced", "Balanced"], ["compact", "Compact"]]} onChange={(density) => { setUiSettings({ density }); updateSettings({ density }); }} />
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
      <PushRow />
    </>
  );
}

/** F18: web push toggle — notifications keep arriving after the tab closes.
 *  Subscription state lives in the browser's push manager, not localStorage. */
function PushRow() {
  const unsupported = pushUnsupportedReason();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tested, setTested] = useState("");
  useEffect(() => {
    void pushSubscription().then((s) => setOn(!!s)).catch(() => {});
  }, []);

  const toggle = (v: boolean) => {
    if (busy) return;
    setBusy(true);
    setErr("");
    void (v ? enablePush() : disablePush())
      .then(() => setOn(v))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Row
        label="Push notifications"
        hint={unsupported ?? "Delivered by the browser's push service even when this tab is closed. Clicking opens the session."}
        itemId="notifications.push"
      >
        {unsupported
          ? <span className="tag">unavailable</span>
          : <Toggle on={on} onChange={toggle} label="Push notifications" />}
      </Row>
      {on && !unsupported && (
        <Row label="Test push" hint="Sends a test notification through the push service (hide the tab to see it).">
          <button
            className="small-btn"
            disabled={busy}
            onClick={() => {
              setTested("");
              void api.pushTest().then((r) => setTested(`sent to ${r.sent} device${r.sent === 1 ? "" : "s"}`))
                .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
            }}
          >Send test</button>
          {tested && <span className="muted">{tested}</span>}
        </Row>
      )}
      {err && <div className="muted" role="alert">{err}</div>}
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

function QuotaSection() {
  const { snapshots: snaps, refresh } = useQuotaSnapshots();
  const prefs = useUsagePrefs();
  const visible = snaps.filter((s) => !prefs.hiddenProviders.includes(s.providerId));
  return (
    <>
      <div className="stat-label">Provider usage overview</div>
      {snaps.length === 0 && (
        <EmptyState title="No quota providers configured" body="Provider quota adapters are registered on the server; credentials never reach the browser." />
      )}
      {visible.length > 0 && (
        <QuotaOverviewGrid snapshots={visible} />
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
        <>
        <div className="stat-label">Provider details</div>
        <div className="quota-grid">
          {visible.map((s) => <QuotaCard key={s.providerId} snap={s} onRefresh={refresh} />)}
        </div>
        </>
      )}
    </>
  );
}

export function UsagePage() {
  const sessions = useStore((s) => s.sessions);
  const projectId = useStore((s) => s.activeProjectId);
  const mine = sessions.filter((s) => s.projectId === projectId);
  const totals = projectUsageStats(mine);
  const top = topProjectSessions(mine);
  return (
    <>
      <PageHead title="Usage" blurb="Token and cost totals for the active project (from the session log)." />
      {mine.length === 0 ? (
        <EmptyState title="No sessions yet" body="Usage appears once sessions run in this project." />
      ) : (
        <>
          <div className="set-usage-grid">
            <div className="goal-stat-cell"><div className="goal-stat-k">Sessions</div><div className="goal-stat-v">{mine.length}</div></div>
            <div className="goal-stat-cell"><div className="goal-stat-k">Tokens</div><div className="goal-stat-v mono">{fmtTokens(totals.tokens)}</div></div>
            <div className="goal-stat-cell"><div className="goal-stat-k">Cost</div><div className="goal-stat-v mono">{totals.cost > 0 ? fmtCost(totals.cost) : "—"}</div></div>
          </div>
          <ProviderUsageDonut sessions={mine} />
          <div className="stat-label">Top sessions</div>
          {top.map((s) => (
            <div key={s.id} className="stat-row">
              <span className="k" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }}>{s.title || s.id}</span>
              <span className="mono">{fmtTokens(sessionTokens(s))}{s.costTotal ? ` · ${fmtCost(s.costTotal)}` : ""}</span>
            </div>
          ))}
        </>
      )}
      <QuotaSection />
    </>
  );
}

export function ProjectsPage() {
  const projects = useStore((s) => s.projectRegistry.projects);
  const [picking, setPicking] = useState(false);
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
              onClick={() => { if (window.confirm(`Remove project "${p.name || p.path}" from Polyth?`)) void removeProject(p.id); }}
            >Remove</button>
          </div>
        </div>
      ))}
      <div className="set-add-form">
        <button className="small-btn" onClick={() => setPicking(true)}>+ Open project folder…</button>
      </div>
      {picking && <ProjectFolderDialog onClose={() => setPicking(false)} />}
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
            <button className="small-btn" onClick={() => { setOverlay(null); openWorkspacePane("git"); }}>Open Git view →</button>
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
  const rolePrefs = useRolePrefs();
  const configurableAgents = agents.filter((agent) => agent.name.toLowerCase() !== "compaction");
  const mainAgents = configurableAgents.filter((agent) => roleKind(agent, rolePrefs) === "main");
  const subagents = configurableAgents.filter((agent) => roleKind(agent, rolePrefs) === "subagent");
  const checkProfile = async (p: AgentProfile) => {
    const r = await api.validateProfile(p.id).catch(() => null);
    setRepairsFor((m) => ({
      ...m,
      [p.id]: !r ? "check failed" : !r.checked ? "backend unavailable — not checked" : r.valid ? "valid ✓" : r.repairs.map((x) => x.reason).join("; "),
    }));
  };
  return (
    <>
      <PageHead title="Roles" blurb="Choose which OpenCode roles appear as main agents and which run as subagents." />
      {agents.length === 0 ? (
        <EmptyState title="No agents reported" body="The backend did not report agent presets. Sessions run with the default agent." />
      ) : (
        <>
          <div className="stat-label">Main agents</div>
          {mainAgents.map((agent) => (
            <div key={agent.name} className="set-row role-row">
              <div className="set-row-label">{agent.name}</div>
              <div className="set-row-control">
                <select aria-label={`Role for ${agent.name}`} value="main" onChange={(event) => setRoleKind(agent.name, event.target.value as "main" | "subagent")}>
                  <option value="main">Main agent</option>
                  <option value="subagent">Subagent</option>
                </select>
              </div>
            </div>
          ))}
          <div className="stat-label">Subagents</div>
          {subagents.map((agent) => (
            <div key={agent.name} className="set-row role-row">
              <div className="set-row-label">{agent.name}</div>
              <div className="set-row-control">
                <select aria-label={`Role for ${agent.name}`} value="subagent" onChange={(event) => setRoleKind(agent.name, event.target.value as "main" | "subagent")}>
                  <option value="main">Main agent</option>
                  <option value="subagent">Subagent</option>
                </select>
              </div>
            </div>
          ))}
        </>
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
  const [selected, setSelected] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"overview" | "widgets" | "commands" | "tools" | "settings" | "permissions" | "contributions">("overview");
  const [toast, setToast] = useState("");
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const sourceValid = /^(?:npm|file):\S+$/.test(source.trim());
  const refresh = () => void api.pluginsList().then(setPlugins);
  useEffect(() => { refresh(); }, []);

  const install = async () => {
    if (!sourceValid) return;
    setError("");
    try {
      const installed = await api.pluginsInstall(source.trim());
      setSource("");
      setToast(`${installed.name} installed. Its contributions are available when you choose them.`);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const op = async (id: string, what: "enable" | "disable" | "reload") => {
    setError("");
    try {
      const plugin = await api.pluginsOp(id, what);
      setToast(what === "disable"
        ? `${plugin.name} disabled. Its widget placements are kept.`
        : what === "enable"
          ? `${plugin.name} enabled. See what’s new in its contributions.`
          : `${plugin.name} reloaded.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    refresh();
  };

  const remove = async (plugin: InstalledPluginDto) => {
    const active = Object.values(layout.widgets).filter((placement) =>
      placement.visible
      && (placement.pluginId === plugin.id
        || widgets.some((widget) => widget.id === placement.definitionId && widget.pluginId === plugin.id)));
    const warning = active.length > 0
      ? `${active.length} widget${active.length === 1 ? "" : "s"} from "${plugin.name}" ${active.length === 1 ? "is" : "are"} in your layout. Uninstalling keeps a placeholder so you can remove or restore each one. Continue?`
      : `Remove plugin "${plugin.name}"?`;
    if (!window.confirm(warning)) return;
    await api.pluginsRemove(plugin.id);
    setToast(`${plugin.name} removed.`);
    if (selected === plugin.id) setSelected(null);
    refresh();
  };

  const selectedPlugin = plugins.find((plugin) => plugin.id === selected);
  const contributionCount = (plugin: InstalledPluginDto, prefix: string) =>
    plugin.contributions.filter((item) => item.slot.startsWith(prefix)).length;

  return (
    <div className="plugin-library" data-settings-item="plugins.managed">
      <div className="plugin-library-head">
        <div><strong>Plugin library</strong><span>Extensions contribute widgets, commands, tools, settings, and workspace surfaces.</span></div>
        <span>{plugins.length} installed</span>
      </div>
      {plugins.length === 0 && (
        <EmptyState title="No managed plugins installed" body='Install with "npm:@scope/name@version" or "file:folder" (relative to the trusted plugin directory).' />
      )}
      <div className="plugin-card-grid">
        {plugins.map((p) => {
          const widgetCount = contributionCount(p, "widget.");
          const commandCount = contributionCount(p, "command");
          const toolCount = p.capabilities.length;
          return (
            <article key={p.id} className={`plugin-card ${p.enabled ? "" : "disabled"}`}>
              <button type="button" className="plugin-card-main" onClick={() => setSelected(p.id)}>
                <span className="plugin-card-icon">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="plugin-card-copy">
                  <strong>{p.name}</strong>
                  <small>{p.source}</small>
                </span>
                <span className={`tag mcp-status ${p.status === "ready" ? "connected" : p.status === "error" ? "error" : "disabled"}`}>{p.status}</span>
                <p>{p.lastError || `${p.name} adds ${p.contributions.length || "workspace"} contributions to Polyth.`}</p>
                <span className="plugin-card-counts">
                  <b>{widgetCount} widgets</b><b>{commandCount} commands</b><b>{toolCount} tools</b>
                </span>
              </button>
              <div className="plugin-card-actions">
                {p.update && <button type="button" onClick={() => void op(p.id, "reload")}>Update to {p.update.version}</button>}
                <button type="button" onClick={() => void op(p.id, p.enabled ? "disable" : "enable")}>{p.enabled ? "Disable" : "Enable"}</button>
                <button type="button" onClick={() => setLogsFor(logsFor === p.id ? null : p.id)}>Logs</button>
                <button type="button" className="danger-btn" onClick={() => void remove(p)}>Uninstall</button>
              </div>
            </article>
          );
        })}
      </div>
      {selectedPlugin && (
        <section className="plugin-detail">
          <header>
            <span className="plugin-card-icon">{selectedPlugin.name.slice(0, 1).toUpperCase()}</span>
            <div><strong>{selectedPlugin.name}</strong><small>v{selectedPlugin.version} · {selectedPlugin.source}</small></div>
            <button type="button" onClick={() => setSelected(null)} aria-label="Close plugin details">×</button>
          </header>
          <div className="plugin-detail-tabs" role="tablist">
            {(["overview", "widgets", "commands", "tools", "settings", "permissions", "contributions"] as const).map((tab) => (
              <button type="button" role="tab" aria-selected={detailTab === tab} className={detailTab === tab ? "active" : ""} key={tab} onClick={() => setDetailTab(tab)}>
                {tab[0]!.toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
          <div className="plugin-detail-body">
            {detailTab === "overview" && <p>{selectedPlugin.enabled ? "Enabled and ready to contribute to your workspace." : "Disabled. Existing layout placements are kept until you enable or remove them."}</p>}
            {detailTab === "widgets" && <p>{contributionCount(selectedPlugin, "widget.")} widget contributions. Installing a plugin never inserts them automatically.</p>}
            {detailTab === "commands" && <p>{contributionCount(selectedPlugin, "command")} command contributions.</p>}
            {detailTab === "tools" && <p>{selectedPlugin.capabilities.length ? selectedPlugin.capabilities.join(", ") : "No declared tools."}</p>}
            {detailTab === "settings" && <p>{contributionCount(selectedPlugin, "settings.")} settings pages or controls.</p>}
            {detailTab === "permissions" && <p><span className={`tag plugin-trust trust-${selectedPlugin.trust}`}>{selectedPlugin.trust}</span> Permissions are requested when the plugin needs them.</p>}
            {detailTab === "contributions" && (
              <ul>{selectedPlugin.contributions.map((item) => <li key={`${item.slot}:${item.id}`}><code>{item.slot}</code> {item.id}</li>)}</ul>
            )}
          </div>
        </section>
      )}
      {logsFor && <PluginLogViewer id={logsFor} />}
      <div className="set-add-form">
        <input
          value={source}
          placeholder="npm:@scope/name@1.0.0 or file:my-plugin"
          aria-invalid={source.length > 0 && !sourceValid ? true : undefined}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && sourceValid) void install(); }}
        />
        <button className="small-btn" disabled={!sourceValid} onClick={() => void install()}>Install</button>
      </div>
      {error && <div className="form-error">{error}</div>}
      {toast && <div className="plugin-toast" role="status"><span>{toast}</span><button type="button" onClick={() => setToast("")}>Dismiss</button></div>}
    </div>
  );
}

/** Plugins declared in the OpenCode config (read-only; managed via opencode.json). */
function OpenCodePluginsSection() {
  const [plugins, setPlugins] = useState<string[]>([]);
  useEffect(() => { void api.opencodePlugins().then((r) => setPlugins(r.plugins)); }, []);
  if (plugins.length === 0) return null;
  return (
    <div data-settings-item="plugins.opencode">
      <div className="stat-label">OpenCode plugins ({plugins.length})</div>
      {plugins.map((spec) => (
        <div key={spec} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label mono">{spec}</div>
            <div className="set-row-hint">Loaded by the OpenCode backend; edit opencode.json to change.</div>
          </div>
          <div className="set-row-control"><span className="tag">opencode.json</span></div>
        </div>
      ))}
    </div>
  );
}

const TIER_LABELS: Array<[CapabilityTier, string]> = [
  ["primary", "Primary"],
  ["more", "More tools"],
  ["technical", "Technical options"],
];

/** UX-PERSONAS: capability placement replaces the built-in enable
 *  checkboxes. Every capability is listed with its current placement; a
 *  change is an explicit override that survives preset switches. Nothing here
 *  can hide or disable a built-in capability. */
function CapabilityPlacementSection() {
  const resolved = useResolvedCapabilities();
  const presentation = usePresentation();
  return (
    <div data-settings-item="plugins.builtin">
      <div className="stat-label">Capability placement</div>
      {resolved.map((c) => {
        const overridden = c.descriptor.id in presentation.placements;
        const alias = c.descriptor.technicalLabel && c.descriptor.technicalLabel !== c.descriptor.label
          ? ` (${c.descriptor.technicalLabel})`
          : "";
        return (
          <div key={c.descriptor.id} className="set-row">
            <div className="set-row-text">
              <div className="set-row-label">
                {c.descriptor.label}{alias}
                {overridden && <span className="tag" title="Your explicit placement wins over preset suggestions">custom</span>}
                {!c.descriptor.available() && (
                  <span className="tag" title={c.descriptor.unavailableReason?.() ?? undefined}>unavailable</span>
                )}
              </div>
              <div className="set-row-hint">{c.descriptor.plainDescription}</div>
            </div>
            <div className="set-row-control">
              {c.descriptor.id === "session" ? (
                <span className="tag">Primary</span>
              ) : (
                <select
                  aria-label={`Placement for ${c.descriptor.label}`}
                  value={c.tier}
                  onChange={(e) => setPlacementOverride(c.descriptor.id, { tier: e.target.value as CapabilityTier, rank: c.rank })}
                >
                  {TIER_LABELS.map(([tier, label]) => <option key={tier} value={tier}>{label}</option>)}
                </select>
              )}
              {overridden && (
                <button className="small-btn" onClick={() => setPlacementOverride(c.descriptor.id, null)}>Reset</button>
              )}
            </div>
          </div>
        );
      })}
      <button
        className="ghost-link"
        onClick={() => { if (window.confirm("Reset workspace order to the preset (or standard) arrangement?")) resetWorkspaceOrder(); }}
      >
        Reset workspace order →
      </button>
    </div>
  );
}

export function PluginsPage() {
  return (
    <>
      <PageHead title="Plugins" blurb="Add workspace capabilities without changing your layout until you choose a widget." />
      <ManagedPluginsSection />
      <OpenCodePluginsSection />
      <CapabilityPlacementSection />
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
