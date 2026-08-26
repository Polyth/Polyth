// The simpler settings pages: General, Appearance, Chat, Notifications,
// Behavior, Usage, Projects, Git, Agents, MCP, Plugins.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  activateProject,
  applyProjectUpsert,
  openWorkspacePane,
  setAgents,
  setOverlay,
  setUiError,
  updateSettings,
  useStore,
} from "../../store.ts";
import { UI_DEFAULTS, setUiSettings, useUiSettings } from "../../uiPrefs.ts";
import { DEFAULT_SETTINGS, friendlyError, INTERFACE_FONTS } from "../../settings.ts";
import { requestNotifyPermission } from "../../notify.ts";
import { disablePush, enablePush, pushSubscription, pushUnsupportedReason } from "../../push.ts";
import { api, type GitStatus } from "../../api.ts";
import { confirmAlert } from "../../alerts.ts";
import { EmptyState, PageHead, Row, Seg, Toggle } from "./parts.tsx";
import { refreshProfiles, useProfiles } from "../../profiles.ts";
import { removeProject } from "../../init.ts";
import AgentProfileForm from "../AgentProfileForm.tsx";
import ProjectFolderDialog from "../ProjectFolderDialog.tsx";
import { parseMcpServersJson, type McpImportResult } from "../../mcpImport.ts";
import { describePluginSpec, parseOpenCodePluginJson } from "../../pluginImport.ts";
import {
  PRESET_THEMES, addCustomTheme, applyTheme, loadCustomThemes, parseThemeJson,
  reapplyTheme, removeCustomTheme, resolveTheme, type AppearanceMode, type ThemeSpec,
} from "../../theme.ts";
import type { AssistSettingsDto } from "../../api.ts";
import type {
  AgentDescriptor,
  AgentProfile,
  InstalledPluginDto,
  McpServerDto,
  McpTransport,
  ModelRef,
  OpenCodePluginConfigEntry,
  OpenCodePluginEntryDto,
  OpenCodePluginPreviewDto,
  SystemInfoDto,
} from "@polyth/contracts";
import { useWidgetCatalog } from "../../widgets/catalog.ts";
import { useWidgetLayout } from "../../widgets/widgetLayout.ts";
import ModelPicker from "../ModelPicker.tsx";
import Dialog from "../a11y/Dialog.tsx";
import { modelSupportsTextWorkflow } from "../../composer/discovery.ts";
import { removeGitPersona, saveGitPersona, useGitPersonas, type GitPersona } from "../../gitPersonas.ts";
import { getLocale, LOCALES, LOCALE_NAMES, setLocale, tr, type Locale } from "../../i18n/index.ts";
import {
  projectRemembersModelSelection,
  resolveSessionDefaultModel,
  useSessionDefaults,
} from "../../sessionDefaults.ts";

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

export function GeneralPage() {
  const settings = useStore((s) => s.settings);
  return (
    <>
      <PageHead title={tr("settings.pages.general")} blurb={tr("settings.pages.applicationBasicsAndBrowserLocalBehavior")} />
      <Row label={tr("common.language")} hint={tr("common.languageHint")} itemId="general.language">
        <select
          className="inp"
          value={getLocale()}
          aria-label={tr("common.language")}
          onChange={(event) => {
            setLocale(event.target.value as Locale);
            window.location.reload();
          }}
        >
          {LOCALES.map((locale) => <option key={locale} value={locale}>{LOCALE_NAMES[locale]}</option>)}
        </select>
      </Row>
      <Row label={tr("settings.pages.productName")} hint={tr("settings.pages.shownInTheSidebarAndWindowChrome")} itemId="general.productName">
        <input
          className="inp"
          value={settings.productName}
          onChange={(e) => updateSettings({ productName: e.target.value })}
          onBlur={() => { if (!settings.productName.trim()) updateSettings({ productName: "Polyth" }); }}
        />
      </Row>
      <Row label={tr("settings.pages.relativeTimestamps")} hint={tr("settings.pages.showSessionActivityAs2mAgoInstead")} itemId="general.relativeTime">
        <Toggle on={settings.relativeTime} onChange={(relativeTime) => updateSettings({ relativeTime })} label={tr("settings.pages.relativeTimestamps")} />
      </Row>
    </>
  );
}

// F15: searchable palette picker + independent appearance mode + custom JSON.
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
  const systemDark = typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)").matches
    : true;
  const effective = (theme: ThemeSpec) => resolveTheme(theme.id, settings.appearanceMode, {
    custom: customs,
    systemDark,
  });
  const schedulePreview = (action: () => void) => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = null;
      action();
    }, 90);
  };
  const preview = (theme: ThemeSpec) => schedulePreview(() => {
    previewApplied.current = true;
    applyTheme(effective(theme));
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
    const current = resolveTheme(settings.theme, settings.appearanceMode, { custom: customs, systemDark });
    const draft = { ...current, id: "my-theme", name: tr("settings.pages.myTheme") };
    void navigator.clipboard?.writeText(JSON.stringify(draft, null, 2));
  };
  const removeCustom = (id: string) => {
    setCustoms(removeCustomTheme(id));
    if (settings.theme === id) updateSettings({ theme: "dark" });
  };
  const bundledGroup = tr("settings.pages.bundled");
  const customGroup = tr("settings.pages.custom");
  const choices = [
    ...PRESET_THEMES.map((theme) => ({ group: bundledGroup, theme })),
    ...customs.map((theme) => ({ group: customGroup, theme })),
  ];
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? choices.filter(({ group, theme }) =>
        `${theme.name} ${theme.id} ${group}`.toLowerCase().includes(normalizedQuery))
    : choices;
  const current = choices.find(({ theme }) => theme.id === settings.theme) ?? choices[0]!;
  const currentEffective = effective(current.theme);
  const appearanceName = (appearance: "dark" | "light") =>
    appearance === "dark" ? tr("settings.pages.dark") : tr("settings.pages.light");
  const appearanceLabel = settings.appearanceMode === "system"
    ? tr("settings.pages.systemValue", { appearance: appearanceName(currentEffective.appearance) })
    : tr("settings.pages.valueAppearance", { appearance: appearanceName(currentEffective.appearance) });
  const pick = (id: string) => {
    updateSettings({ theme: id });
    setQuery("");
    setPickerOpen(false);
  };
  return (
    <div className="set-sec" data-settings-item="appearance.theme">
      <div className="set-sec-title">{tr("settings.pages.theme")}</div>
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
          <ThemeSwatches theme={currentEffective} />
          <span><strong>{current.theme.name}</strong><small>{current.group} · {appearanceLabel}</small></span>
          <b aria-hidden="true">⌄</b>
        </button>
        {pickerOpen && (
          <div className="theme-picker-pop" id="theme-picker-options">
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls="theme-picker-list"
              aria-label={tr("settings.pages.searchThemes")}
              value={query}
              placeholder={tr("settings.pages.searchValueThemes", { length: choices.length })}
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
              {[bundledGroup, customGroup].map((group) => {
                const groupChoices = filtered.filter((choice) => choice.group === group);
                if (groupChoices.length === 0) return null;
                return (
                  <section key={group}>
                    <div className="theme-picker-group">{group}</div>
                    {groupChoices.map(({ theme }) => {
                      const rendered = effective(theme);
                      return (
                      <button
                        key={`${group}:${theme.id}`}
                        role="option"
                        aria-selected={settings.theme === theme.id}
                        className={settings.theme === theme.id ? "active" : ""}
                        onClick={() => pick(theme.id)}
                        onMouseEnter={() => preview(theme)}
                        onMouseLeave={endPreview}
                        onFocus={() => preview(theme)}
                        onBlur={endPreview}
                      >
                        <ThemeSwatches theme={rendered} />
                        <span><strong>{theme.name}</strong><small>{appearanceName(rendered.appearance)} {tr("settings.pages.palette")}</small></span>
                        <b aria-hidden="true">{settings.theme === theme.id ? "✓" : ""}</b>
                      </button>
                      );
                    })}
                  </section>
                );
              })}
              {filtered.length === 0 && <div className="theme-picker-empty">{tr("settings.pages.noMatchingThemes")}</div>}
            </div>
          </div>
        )}
      </div>
      <div className="theme-swatch-strip" aria-label={tr("settings.pages.quickThemePreview")}>
        {PRESET_THEMES.map((theme) => {
          const rendered = effective(theme);
          return (
          <button
            key={theme.id}
            className={settings.theme === theme.id ? "active" : ""}
            title={theme.name}
            aria-label={tr("settings.pages.useValueTheme", { name: theme.name })}
            onClick={() => pick(theme.id)}
            onMouseEnter={() => preview(theme)}
            onMouseLeave={endPreview}
            onFocus={() => preview(theme)}
            onBlur={endPreview}
            style={{ "--theme-swatch": rendered.tokens.accent } as CSSProperties}
          />
          );
        })}
      </div>
      {customs.length > 0 && (
        <div className="theme-custom-list">
          {customs.map((t) => (
            <div key={t.id} className="theme-custom-row">
              <span className="mono">{t.id}</span>
              <span className="muted">{t.name} {tr("settings.pages.adaptsTo")}{" "}{settings.appearanceMode}</span>
              <span className="header-spacer" />
              <button className="small-btn danger-btn" onClick={() => removeCustom(t.id)}>{tr("common.delete")}</button>
            </div>
          ))}
        </div>
      )}
      <div className="theme-import">
        <textarea
          className="theme-import-input"
          rows={3}
          placeholder={tr("settings.pages.pasteThemeJsonExample")}
          value={json}
          onChange={(e) => { setJson(e.target.value); setJsonError(""); }}
          aria-label={tr("settings.pages.customThemeJson")}
        />
        <div className="theme-import-actions">
          <button className="small-btn" disabled={!json.trim()} onClick={importJson}>{tr("settings.pages.importTheme")}</button>
          <button className="small-btn" onClick={copyCurrent} title={tr("settings.pages.copyTheActiveThemeAsJsonTo")}>{tr("settings.pages.copyCurrentAsJson")}</button>
        </div>
        {jsonError && <div className="form-error">{jsonError}</div>}
      </div>
    </div>
  );
}

export function AppearancePage() {
  const ui = useUiSettings();
  const settings = useStore((s) => s.settings);
  const editorFontPct = ((ui.editorFontSize - 11) / 13) * 100;
  const resetFontSizes = () => {
    updateSettings({ fontSize: DEFAULT_SETTINGS.fontSize });
    // `fontSize` is retained in the older UI-preferences record for
    // backwards compatibility, so restore it alongside the active editor
    // setting as well.
    setUiSettings({ fontSize: UI_DEFAULTS.fontSize, editorFontSize: UI_DEFAULTS.editorFontSize });
  };
  return (
    <>
      <PageHead title={tr("settings.pages.appearance")} blurb={tr("settings.pages.visualPreferencesSavedInThisBrowserAnd")} />
      <Row
        label={tr("settings.pages.appearance")}
        hint={tr("settings.pages.systemFollowsYourOperatingSystemEveryPalette")}
        itemId="appearance.mode"
      >
        <Seg<AppearanceMode>
          value={settings.appearanceMode}
          options={[
            ["system", tr("settingsview.system")],
            ["dark", tr("settings.pages.dark")],
            ["light", tr("settings.pages.light")],
          ]}
          onChange={(appearanceMode) => updateSettings({ appearanceMode })}
        />
      </Row>
      <ThemeSection />
      <Row label={tr("settings.pages.interfaceFont")} hint={tr("settings.pages.chooseFromCleanUiFaces")} itemId="appearance.fontFamily">
        <select
          aria-label={tr("settings.pages.interfaceFont")}
          value={settings.fontFamily}
          onChange={(event) => updateSettings({ fontFamily: event.target.value as typeof settings.fontFamily })}
        >
          <optgroup label={tr("settings.pages.uiSansSerif")}>
            {INTERFACE_FONTS.filter((font) => !font.mono && font.id !== "serif").map((font) => (
              <option key={font.id} value={font.id}>{font.label}</option>
            ))}
          </optgroup>
          <optgroup label={tr("settings.pages.serif")}>
            {INTERFACE_FONTS.filter((font) => font.id === "serif").map((font) => (
              <option key={font.id} value={font.id}>{font.label}</option>
            ))}
          </optgroup>
          <optgroup label={tr("settings.pages.programmerMonospaceLigaturesOff")}>
            {INTERFACE_FONTS.filter((font) => font.mono).map((font) => (
              <option key={font.id} value={font.id}>{font.label}</option>
            ))}
          </optgroup>
        </select>
      </Row>
      <Row label={tr("settings.pages.density")} hint={tr("settings.pages.chooseAiryBalancedOrCompactSpacingAcross")} itemId="appearance.density">
        <Seg value={ui.density} options={[
          ["comfortable", tr("settings.pages.comfortable")],
          ["balanced", tr("settings.pages.balanced")],
          ["compact", tr("settings.pages.compact")],
        ]} onChange={(density) => { setUiSettings({ density }); updateSettings({ density }); }} />
      </Row>
      <Row label={tr("settings.pages.interfaceScale")} hint={tr("settings.pages.increaseOrDecreaseTextThroughoutPolythCode")} itemId="appearance.fontSize">
        <Seg
          value={settings.fontSize}
          options={[
            [12, tr("settings.widgetlibraryoverlay.small")],
            [13, tr("settings.pages.smaller")],
            [14, tr("settings.widgetlibraryoverlay.medium")],
            [16, tr("settings.widgetlibraryoverlay.large")],
            [18, tr("settings.pages.extraLarge")],
          ]}
          onChange={(fontSize) => updateSettings({ fontSize })}
        />
      </Row>
      <Row label={tr("settings.pages.terminalFontSize")} hint={tr("settings.pages.setTheFontSizeUsed")} itemId="appearance.editorFontSize">
        <div className="rng">
          <input
            type="range" min={11} max={24} value={ui.editorFontSize}
            aria-label={tr("settings.pages.terminalFontSizeInPixels")}
            style={{ "--p": `${editorFontPct}%` } as CSSProperties}
            onChange={(e) => setUiSettings({ editorFontSize: Number(e.target.value) })}
          />
          <span className="rng-val">{ui.editorFontSize}{tr("settings.pages.px")}</span>
        </div>
      </Row>
      <Row label={tr("settings.pages.resetFontSizes")} hint={tr("settings.pages.restoreTheInterfaceAndTerminal")}>
        <button className="small-btn" type="button" onClick={resetFontSizes}>{tr("settings.pages.resetToDefaults")}</button>
      </Row>
      <Row label={tr("settings.pages.cornerRounding")} hint={tr("settings.pages.applySquareCompactOrGenerouslyRoundedCorners")} itemId="appearance.rounding">
        <Seg value={ui.rounding} options={[
          ["square", tr("settings.pages.square")],
          ["compact", tr("settings.pages.compact")],
          ["rounded", tr("settings.pages.rounded")],
        ]} onChange={(rounding) => setUiSettings({ rounding })} />
      </Row>
      <Row label={tr("settings.pages.optionalActions")} hint={tr("settings.pages.chooseWhichOptionalActionsAppearWhileYou")} itemId="appearance.menuItems">
        <div className="appearance-menu-items">
          <label><Toggle on={ui.showDictate} onChange={(showDictate) => setUiSettings({ showDictate })} label={tr("settings.pages.dictationAction")} /><span>{tr("settings.pages.dictation")}</span></label>
          <label><Toggle on={ui.showQuickActions} onChange={(showQuickActions) => setUiSettings({ showQuickActions })} label={tr("settings.pages.quickActions")} /><span>{tr("settings.pages.quickActions")}</span></label>
        </div>
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
      <PageHead title={tr("settings.pages.chat")} blurb={tr("settings.pages.conversationLayoutAndDeliveryPreferences")} />
      <Row label={tr("settings.pages.conversationWidth")} hint={tr("settings.pages.wideUsesMoreOfTheWindowFor")} itemId="chat.width">
        <Seg value={ui.chatWidth} options={[
          ["normal", tr("settings.pages.normal")],
          ["wide", tr("settings.pages.wide")],
        ]} onChange={(v) => setUiSettings({ chatWidth: v })} />
      </Row>
      <Row label={tr("settings.pages.whileTheAgentIsWorking")} hint={tr("settings.pages.whatEnterDoesDuringAnActiveTurn")} itemId="chat.followUp">
        <Seg value={ui.followUpBehavior} options={[
          ["steer", tr("settings.pages.steer")],
          ["queue", tr("composer.queue")],
          ["interrupt", tr("settings.pages.interrupt")],
        ]} onChange={(v) => setUiSettings({ followUpBehavior: v })} />
      </Row>
      <Row label={tr("settings.pages.thinkingBlocks")} hint={tr("settings.pages.collapseMergedReasoningIntoAnExpandableBlock")} itemId="chat.thinking">
        <Toggle on={ui.collapsibleThinkingBlocks} onChange={(v) => setUiSettings({ collapsibleThinkingBlocks: v })} label={tr("settings.pages.collapsibleThinking")} />
      </Row>
      <Row label={tr("settings.pages.messageActions")} hint={tr("settings.pages.showLightweightCopyRevertAndForkControls")} itemId="chat.messageActions">
        <Toggle on={ui.showMessageActions} onChange={(showMessageActions) => setUiSettings({ showMessageActions })} label={tr("settings.pages.messageActions")} />
      </Row>
      <Row label={tr("settings.pages.copyFormat")} hint={tr("settings.pages.chooseThePayloadUsedByTheSingle")} itemId="chat.copyFormat">
        <Seg
          value={ui.messageCopyFormat}
          options={[["markdown", tr("common.markdown")], ["json", tr("common.json")]]}
          onChange={(messageCopyFormat) => setUiSettings({ messageCopyFormat })}
        />
      </Row>
      <Row label={tr("settings.pages.sendOnEnter")} hint={tr("settings.pages.whenOffEnterInsertsANewlineAnd")} itemId="chat.sendOnEnter">
        <Toggle on={settings.sendOnEnter} onChange={(sendOnEnter) => updateSettings({ sendOnEnter })} label={tr("settings.pages.sendOnEnter")} />
      </Row>
      {assist && (
        <Row
          label={tr("settings.pages.idleRecapSuggestion")}
          hint={tr("settings.pages.afterASessionGoesQuietTheSmall")}
          itemId="chat.assist"
        >
          <Toggle on={assist.enabled} onChange={(enabled) => saveAssist({ enabled })} label={tr("settings.pages.idleRecap")} />
        </Row>
      )}
      {assist?.enabled && (
        <Row label={tr("settings.pages.quietTime")} hint={tr("settings.pages.secondsOfInactivityAfterAReplyBefore")}>
          <div className="editor-font-control">
            <input
              type="number" min={10} max={3600} value={assist.idleSeconds}
              aria-label={tr("settings.pages.assistQuietTimeInSeconds")}
              onChange={(e) => setAssist({ ...assist, idleSeconds: Number(e.target.value) })}
              onBlur={(e) => saveAssist({ idleSeconds: Number(e.target.value) })}
            />
            <span className="muted">{tr("settings.pages.s")}</span>
          </div>
        </Row>
      )}
    </>
  );
}

const NOTIFY_KIND_LABELS: Array<[kind: "completed" | "failed" | "question" | "permission" | "subagent", label: string]> = [
  ["completed", tr("settings.pages.turnCompleted")],
  ["failed", tr("settings.pages.turnFailed")],
  ["question", tr("settings.pages.agentQuestion")],
  ["permission", tr("settings.pages.permissionRequest")],
  ["subagent", tr("settings.pages.delegatedAgentFinished")],
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
      <PageHead title={tr("settings.pages.notifications")} blurb={tr("settings.pages.getToldWhenASessionNeedsYou")} />
      <Row
        label={tr("settings.pages.desktopNotification")}
        hint={denied ? tr("settings.pages.notificationsAreBlockedForThisSiteIn") : tr("settings.pages.nativeNotificationWhenAnEnabledEventHappens")}
        itemId="notifications.desktop"
      >
        <Toggle
          on={ui.notifyOnComplete}
          onChange={(v) => { setUiSettings({ notifyOnComplete: v }); if (v) requestNotifyPermission(); }}
          label={tr("settings.pages.desktopNotification")}
        />
      </Row>
      <Row label={tr("settings.pages.completionSound")} hint={tr("settings.pages.shortBeepWhenATurnCompletes")} itemId="notifications.sound">
        <Toggle on={ui.notifySound} onChange={(v) => setUiSettings({ notifySound: v })} label={tr("settings.pages.completionSound")} />
      </Row>
      <Row label={tr("settings.pages.notifyAbout")} hint={tr("settings.pages.eachEventKindIsIndependent")} itemId="notifications.kinds">
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
        label={tr("settings.pages.onlyWhenHidden")}
        hint={tr("settings.pages.offBackgroundSessionsMayNotifyWhileThe")}
        itemId="notifications.onlyHidden"
      >
        <Toggle on={ui.notifyOnlyWhenHidden} onChange={(v) => setUiSettings({ notifyOnlyWhenHidden: v })} label={tr("settings.pages.onlyWhenHidden")} />
      </Row>
      <Row
        label={tr("settings.pages.centreHistory")}
        hint={tr("settings.pages.keepReadNotificationsVisibleInTheNotification")}
        itemId="notifications.centreHistory"
      >
        <Toggle
          on={ui.notificationCentreHistory}
          onChange={(v) => setUiSettings({ notificationCentreHistory: v })}
          label={tr("settings.pages.centreHistory")}
        />
      </Row>
      <Row
        label={tr("settings.pages.template")}
        hint={tr("settings.pages.variablesValueValueValueValueValuesAre")}
        itemId="notifications.template"
      >
        <input
          className="notification-preview"
          value={ui.notifyTemplate}
          onChange={(e) => setUiSettings({ notifyTemplate: e.target.value.slice(0, 200) })}
          aria-label={tr("settings.pages.notificationTemplate")}
        />
      </Row>
      {ui.notifyOnComplete && !granted && !denied && (
        <Row label={tr("settings.pages.permission2")} hint={tr("settings.pages.theBrowserWillAskForPermissionOnce")}>
          <button className="small-btn" onClick={requestNotifyPermission}>{tr("settings.pages.grantPermission")}</button>
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
        label={tr("settings.pages.pushNotifications")}
        hint={unsupported ?? tr("settings.pages.pushDeliveryHint")}
        itemId="notifications.push"
      >
        {unsupported
          ? <span className="tag">{tr("settings.pages.unavailable")}</span>
          : <Toggle on={on} onChange={toggle} label={tr("settings.pages.pushNotifications")} />}
      </Row>
      {on && !unsupported && (
        <Row label={tr("settings.pages.testPush")} hint={tr("settings.pages.sendsATestNotificationThroughThePush")}>
          <button
            className="small-btn"
            disabled={busy}
            onClick={() => {
              setTested("");
              void api.pushTest().then((r) => setTested(r.sent === 1
                ? tr("settings.pages.sentToOneDevice")
                : tr("settings.pages.sentToValueDevices", { count: r.sent })))
                .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
            }}
          >{tr("settings.pages.sendTest")}</button>
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
      setMessage(tr("settings.pages.savedAndApplied"));
    } catch (e) {
      const status = (e as { status?: number }).status;
      setState(status === 409 ? "conflict" : "error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="behavior-editor" data-settings-item="behavior.instructions">
      <div className="stat-label">{tr("settings.pages.globalInstructions")}{" "}<span className="muted">({pathLabel || "…"})</span></div>
      <textarea
        rows={8}
        value={text}
        placeholder={tr("settings.pages.instructionsAppliedToEveryAgentTurnE")}
        onChange={(e) => { setText(e.target.value); setDirty(true); }}
        disabled={state === "loading" || state === "saving"}
        aria-label={tr("settings.pages.globalBehaviorInstructions")}
      />
      <div className="behavior-editor-foot">
        {state === "conflict" ? (
          <div className="revision-conflict" role="alert">
            <span>{tr("settings.pages.changedElsewhereSinceYouLoadedIt")}</span>
            <button className="small-btn" onClick={() => void load()}>{tr("settings.pages.reloadLatest")}</button>
          </div>
        ) : (
          <span className="muted">{message}</span>
        )}
        <span className="header-spacer" />
        <button className="small-btn" disabled={!dirty || state === "saving"} onClick={() => void save()}>
          {state === "saving" ? tr("common.saving") : tr("settings.pages.saveApply")}
        </button>
      </div>
    </div>
  );
}

export function BehaviorPage() {
  const ui = useUiSettings();
  return (
    <>
      <PageHead title={tr("settings.pages.behavior")} blurb={tr("settings.pages.workspaceSafetyFlowAndGlobalAgentInstructions")} />
      <Row label={tr("settings.pages.confirmBeforeArchivingSessions")} hint={tr("settings.pages.askBeforeASessionIsMovedTo")} itemId="behavior.confirmArchive">
        <Toggle on={ui.confirmSessionArchive} onChange={(v) => setUiSettings({ confirmSessionArchive: v })} label={tr("settings.pages.confirmArchive")} />
      </Row>
      <Row label={tr("settings.pages.editorAutosave")} hint={tr("settings.pages.savesEditsAfterAShortPauseRevision")} itemId="behavior.autosave">
        <Toggle on={ui.editorAutosave} onChange={(v) => setUiSettings({ editorAutosave: v })} label={tr("settings.pages.editorAutosave")} />
      </Row>
      <BehaviorInstructionsEditor />
      <Row label={tr("settings.pages.slashCommandsSnippets")} hint={tr("settings.pages.manageReusablePromptsUnderCommands")}>
        <span className="muted mono">/review · #alias</span>
      </Row>
    </>
  );
}

export function ProjectsPage() {
  const projects = useStore((s) => s.projectRegistry.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const models = useStore((s) => s.models).filter(modelSupportsTextWorkflow);
  const sessionDefaults = useSessionDefaults();
  const [picking, setPicking] = useState(false);
  const globalModel = resolveSessionDefaultModel(null, sessionDefaults.defaultModel, models[0]);
  const globalModelName = globalModel
    ? models.find((model) =>
        model.providerID === globalModel.providerID && model.modelID === globalModel.modelID)?.name
      ?? globalModel.modelID
    : "No model available";
  const saveModel = async (projectId: string, model?: ModelRef) => {
    if (!model) return;
    try {
      const updated = await api.patchProject(projectId, {
        defaults: { rememberModelSelection: true, model },
      });
      applyProjectUpsert(updated);
    } catch (error) {
      setUiError(friendlyError("Couldn’t save the project model", error));
    }
  };
  const setModelMemory = async (projectId: string, enabled: boolean) => {
    try {
      const project = projects.find((candidate) => candidate.id === projectId);
      const updated = await api.patchProject(projectId, {
        defaults: enabled
          ? { rememberModelSelection: true, model: project?.defaults?.model ?? globalModel ?? null }
          : { rememberModelSelection: false },
      });
      applyProjectUpsert(updated);
    } catch (error) {
      setUiError(friendlyError("Couldn’t update project model memory", error));
    }
  };
  const saveIcon = async (projectId: string, icon: string) => {
    try {
      const updated = await api.patchProject(projectId, { icon: icon.trim().slice(0, 16) });
      applyProjectUpsert(updated);
    } catch (error) {
      setUiError(friendlyError("Couldn’t save the project icon", error));
    }
  };
  return (
    <>
      <PageHead title={tr("settings.pages.projects")} blurb={tr("settings.pages.projectSpecificModelAndCanvasSetupRemoving")} />
      {projects.map((p) => (
        <section key={p.id} className={`project-settings-card${p.id === activeProjectId ? " active" : ""}`}>
          <header>
            <div className="set-row-text">
              <div className="set-row-label">{p.name || p.path}{p.id === activeProjectId && <span className="tag">{tr("settings.pages.active")}</span>}</div>
              <div className="set-row-hint mono">{p.path}</div>
            </div>
            <button
              className="small-btn danger-btn"
              onClick={() => { void confirmAlert(tr("settings.pages.removeProjectValueFromPolyth", { value: p.name || p.path }), { title: tr("settings.pages.removeProject"), confirmLabel: tr("common.remove") }).then((ok) => { if (ok) void removeProject(p.id); }); }}
            >{tr("common.remove")}</button>
          </header>
          <div className="project-settings-options">
            <div>
              <strong>{tr("settings.pages.projectIcon")}</strong>
              <span>{tr("settings.pages.useAnEmojiOrShortSymbolIn")}</span>
            </div>
            <input
              className="project-icon-input"
              defaultValue={p.icon ?? ""}
              maxLength={16}
              aria-label={tr("settings.pages.customIconForValue", { value: p.name || p.path })}
              placeholder="📁"
              onBlur={(event) => void saveIcon(p.id, event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            />
          </div>
          <div className="project-settings-options" data-settings-item="projects.modelMemory">
            <div>
              <strong>{tr("settings.pages.rememberModelSelection")}</strong>
              <span>
                {projectRemembersModelSelection(p.defaults)
                  ? tr("settings.pages.theLastModelChosenInThisProject")
                  : tr("settings.pages.offNewSessionsUseValue", { model: globalModelName })}
              </span>
            </div>
            <Toggle
              on={projectRemembersModelSelection(p.defaults)}
              onChange={(enabled) => void setModelMemory(p.id, enabled)}
              label={tr("settings.pages.rememberModelSelectionForValue", { project: p.name || p.path })}
            />
          </div>
          {projectRemembersModelSelection(p.defaults) && (
            <div className="project-settings-options project-settings-model">
              <div>
                <strong>{tr("settings.pages.rememberedModel")}</strong>
                <span>{tr("settings.pages.updatedWheneverYouChooseAModel")}</span>
              </div>
              <ModelPicker
                direction="down"
                models={models}
                value={p.defaults?.model ?? undefined}
                recommended={globalModel}
                onPick={(model) => void saveModel(p.id, model)}
              />
            </div>
          )}
          <div className="project-settings-options" data-settings-item="projects.canvas">
            <div>
              <strong>{tr("settings.pages.canvasSetup")}</strong>
              <span>{tr("settings.pages.chooseAStartingLayoutWidgetsAndWorkspace")}</span>
            </div>
            <button
              className="small-btn"
              onClick={() => {
                activateProject(p.id);
                setOverlay("onboarding");
              }}
            >{tr("settings.pages.configureCanvas")}</button>
          </div>
        </section>
      ))}
      <div className="set-add-form">
        <button className="small-btn" onClick={() => setPicking(true)}>{tr("settings.pages.openProjectFolder")}</button>
      </div>
      {picking && <ProjectFolderDialog onClose={() => setPicking(false)} />}
    </>
  );
}

function GitPersonas({ projectId }: { projectId: string }) {
  const personas = useGitPersonas();
  const [identity, setIdentity] = useState({ name: "", email: "" });
  const [draft, setDraft] = useState<GitPersona | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api.gitIdentity(projectId).then(setIdentity).catch(() => setIdentity({ name: "", email: "" }));
  }, [projectId]);
  const apply = async (persona: GitPersona) => {
    try {
      setError("");
      setIdentity(await api.gitIdentitySet(projectId, persona));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <section className="git-personas" data-settings-item="git.personas">
      <div className="settings-section-head">
        <div><strong>{tr("settings.pages.gitPersonas")}</strong><span>{tr("settings.pages.savedIdentitiesYouCanApplyToThis")}</span></div>
        <button className="small-btn" onClick={() => setDraft({ id: crypto.randomUUID(), label: "", name: "", email: "" })}>{tr("settings.pages.persona")}</button>
      </div>
      <div className="git-current-identity">
        {tr("settings.pages.currentRepositoryIdentity")}{" "}<strong>{identity.name || tr("settings.pages.notSet")}</strong>
        <span className="mono">{identity.email || "—"}</span>
      </div>
      {personas.map((persona) => {
        const active = persona.name === identity.name && persona.email === identity.email;
        return (
          <div key={persona.id} className={`git-persona-row${active ? " active" : ""}`}>
            <span className="profile-avatar">{persona.label.slice(0, 1).toUpperCase()}</span>
            <span><strong>{persona.label}</strong><small>{persona.name} · {persona.email}</small></span>
            {active && <span className="tag">{tr("settings.pages.inUse")}</span>}
            <button className="small-btn" disabled={active} onClick={() => void apply(persona)}>{tr("settings.pages.use")}</button>
            <button className="small-btn" onClick={() => setDraft(persona)}>{tr("common.edit")}</button>
            <button className="small-btn danger-btn" onClick={() => removeGitPersona(persona.id)}>{tr("common.delete")}</button>
          </div>
        );
      })}
      {personas.length === 0 && <p className="muted">{tr("settings.pages.addAWorkPersonalOrBotIdentity")}</p>}
      {error && <div className="form-error">{error}</div>}
      {draft && (
        <Dialog title={draft.label ? tr("settings.pages.editValue", { label: draft.label }) : tr("settings.pages.newGitPersona")} onClose={() => setDraft(null)} className="profile-form" initialFocus="input">
          <div className="dialog-head"><span>{draft.label ? tr("settings.pages.editValue", { label: draft.label }) : tr("settings.pages.newGitPersona")}</span><span className="header-spacer" /><button className="small-btn" onClick={() => setDraft(null)}>✕</button></div>
          <div className="profile-form-body">
            <label>{tr("settings.pages.label")}<input value={draft.label} placeholder={tr("settings.pages.work")} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
            <label>{tr("settings.pages.commitAuthorName")}<input value={draft.name} placeholder={tr("settings.pages.adaLovelace")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>{tr("settings.pages.commitEmail")}<input type="email" value={draft.email} placeholder={tr("settings.pages.adaExampleCom")} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>
          </div>
          <div className="dialog-foot">
            <button className="small-btn" onClick={() => setDraft(null)}>{tr("common.cancel")}</button>
            <span className="header-spacer" />
            <button className="primary-btn" disabled={!draft.label.trim() || !draft.name.trim() || !draft.email.trim()} onClick={() => { saveGitPersona({ ...draft, label: draft.label.trim(), name: draft.name.trim(), email: draft.email.trim() }); setDraft(null); }}>{tr("settings.pages.savePersona")}</button>
          </div>
        </Dialog>
      )}
    </section>
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
  if (!projectId) return <><PageHead title={tr("settings.pages.git")} /><EmptyState title={tr("settings.pages.noActiveProject")} /></>;
  const changes = status ? status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length : 0;
  return (
    <>
      <PageHead title={tr("settings.pages.git")} blurb={tr("settings.pages.repositoryStateForTheActiveProject")} />
      {!status?.branch ? (
        <EmptyState title={tr("settings.pages.notAGitRepository")} body={tr("settings.pages.initializeARepoToUseTheGit")} />
      ) : (
        <>
          <Row label={tr("settings.pages.branch")}><span className="mono">{status.branch}</span></Row>
          <Row label={tr("settings.pages.workingTree")}><span className="mono">{changes === 0
            ? tr("settings.pages.clean")
            : changes === 1
              ? tr("settings.pages.oneChangedFile")
              : tr("settings.pages.valueChangedFiles", { count: changes })}</span></Row>
          <Row label={tr("settings.pages.aheadBehind")}><span className="mono">↑{status.ahead} ↓{status.behind}</span></Row>
          <GitPersonas projectId={projectId} />
          <Row label={tr("settings.pages.branchNameTemplate")} hint={tr("settings.pages.tokensValueAndValueStoredLocally")} itemId="git.branchTemplate">
            <input
              className="inp inp-mono"
              value={settings.branchTemplate}
              onChange={(e) => updateSettings({ branchTemplate: e.target.value })}
            />
          </Row>
          <Row
            label={tr("settings.pages.conflictAgentPrompt")}
            hint={tr("settings.pages.conflictAgentPromptHint")}
            itemId="git.conflictAgentPrompt"
          >
            <textarea
              className="inp git-conflict-agent-prompt"
              rows={4}
              value={settings.conflictAgentPrompt}
              onChange={(event) => updateSettings({ conflictAgentPrompt: event.target.value })}
            />
          </Row>
          <Row
            label={tr("settings.pages.conflictAgentTarget")}
            hint={tr("settings.pages.conflictAgentTargetHint")}
            itemId="git.conflictAgentTarget"
          >
            <Seg
              value={settings.conflictAgentTarget}
              options={[
                ["new-session", tr("settings.pages.newSession")],
                ["current-session", tr("settings.pages.currentSession")],
              ]}
              onChange={(conflictAgentTarget) => updateSettings({ conflictAgentTarget })}
            />
          </Row>
          <Row label={tr("settings.pages.fullView")} hint={tr("settings.pages.stageCommitBranchAndManageWorktrees")}>
            <button className="small-btn" onClick={() => { setOverlay(null); openWorkspacePane("git"); }}>{tr("settings.pages.openGitView")}</button>
          </Row>
        </>
      )}
    </>
  );
}

function RoleEditor({ role, onClose }: { role: AgentDescriptor; onClose: () => void }) {
  const models = useStore((state) => state.models).filter(modelSupportsTextWorkflow);
  const agents = useStore((state) => state.agents);
  const defaults = useSessionDefaults();
  const defaultModel = resolveSessionDefaultModel(null, defaults.defaultModel, models[0]);
  const [prompt, setPrompt] = useState(role.prompt ?? "");
  const [model, setModel] = useState<ModelRef | undefined>(role.model ?? defaultModel);
  const [mode, setMode] = useState<AgentDescriptor["mode"]>(role.mode === "all" ? "primary" : role.mode);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await api.saveRole(role.name, { prompt, model, mode });
      setAgents(agents.map((candidate) => candidate.name === saved.name ? saved : candidate));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={tr("settings.pages.editValue2", { name: role.name })} onClose={onClose} className="role-editor" initialFocus="textarea">
      <div className="dialog-head"><span>{tr("settings.pages.editRole")}{" "}{role.name}</span><span className="header-spacer" /><button className="small-btn" onClick={onClose}>✕</button></div>
      <div className="role-editor-body">
        <label>
          <span>{tr("settings.pages.usage")}</span>
          <Seg value={mode} options={[
            ["primary", tr("settings.pages.mainAgent")],
            ["subagent", tr("settings.pages.subagent2")],
          ]} onChange={setMode} />
          <small>{tr("settings.pages.mainAgentsCanLeadSessionsSubagentsAre")}</small>
        </label>
        <label>
          <span>{tr("settings.pages.providerModel")}</span>
          <ModelPicker direction="down" models={models} value={model} recommended={defaultModel} onPick={setModel} />
          <small>{tr("settings.pages.usesTheSameSearchablePickerAndFavorites")}</small>
        </label>
        <label>
          <span>{tr("settings.pages.systemPrompt")}</span>
          <textarea rows={12} value={prompt} placeholder={tr("settings.pages.instructionsThatDefineThisRoleSBehavior")} onChange={(event) => setPrompt(event.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
      </div>
      <div className="dialog-foot"><button className="small-btn" onClick={onClose}>{tr("common.cancel")}</button><span className="header-spacer" /><button className="primary-btn" disabled={busy} onClick={() => void save()}>{busy ? tr("common.saving") : tr("settings.pages.saveRole")}</button></div>
    </Dialog>
  );
}

export function AgentsPage() {
  const agents = useStore((s) => s.agents);
  const models = useStore((s) => s.models).filter(modelSupportsTextWorkflow);
  const defaults = useSessionDefaults();
  const profiles = useProfiles();
  const [editingRole, setEditingRole] = useState<AgentDescriptor | null>(null);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [repairsFor, setRepairsFor] = useState<Record<string, string>>({});
  const configurableAgents = agents.filter((agent) => agent.name.toLowerCase() !== "compaction");
  const defaultModel = resolveSessionDefaultModel(null, defaults.defaultModel, models[0]);
  const modelLabel = (model?: ModelRef) => {
    const resolved = model ?? defaultModel;
    if (!resolved) return tr("settings.pages.noModelAvailable");
    return models.find((candidate) =>
      candidate.providerID === resolved.providerID && candidate.modelID === resolved.modelID)?.name
      ?? resolved.modelID;
  };
  const checkProfile = async (p: AgentProfile) => {
    const r = await api.validateProfile(p.id).catch(() => null);
    setRepairsFor((m) => ({
      ...m,
      [p.id]: !r ? "check failed" : !r.checked ? "backend unavailable — not checked" : r.valid ? "valid ✓" : r.repairs.map((x) => x.reason).join("; "),
    }));
  };
  return (
    <>
      <PageHead title={tr("settings.pages.roles")} blurb={tr("settings.pages.shapeHowEachOpencodeRoleWorksIts")} />
      {agents.length === 0 ? (
        <EmptyState title={tr("settings.pages.noAgentsReported")} body={tr("settings.pages.theBackendDidNotReportAgentPresets")} />
      ) : (
        <div className="role-card-grid">
          {configurableAgents.map((agent) => (
            <article key={agent.name} className="role-card">
              <header><span className="role-card-icon">{agent.name.slice(0, 1).toUpperCase()}</span><div><strong>{agent.name}</strong><span className={`tag role-kind ${agent.mode}`}>{agent.mode === "subagent" ? tr("settings.pages.subagent2") : tr("settings.pages.mainAgent")}</span></div></header>
              <p>{agent.description || tr("settings.pages.configurableOpenCodeRole")}</p>
              <div className="role-card-meta">
                <span><b>{tr("settings.pages.model")}</b>{modelLabel(agent.model)}</span>
                <span><b>{tr("settings.pages.prompt")}</b>{agent.prompt?.trim() ? `${agent.prompt.trim().slice(0, 72)}${agent.prompt.trim().length > 72 ? "…" : ""}` : tr("settings.pages.opencodeDefault")}</span>
              </div>
              <button className="small-btn" onClick={() => setEditingRole(agent)}>{tr("settings.pages.editRole2")}</button>
            </article>
          ))}
        </div>
      )}
      {editingRole && <RoleEditor role={editingRole} onClose={() => setEditingRole(null)} />}
      <div className="stat-label" style={{ display: "flex", alignItems: "center", gap: 8 }} data-settings-item="agents.profiles">
        <span>{tr("settings.pages.agentProfiles")}{profiles.length})</span>
        <span className="header-spacer" />
        <button className="small-btn" onClick={() => setCreating(true)}>{tr("settings.pages.profile")}</button>
      </div>
      {profiles.length === 0 && (
        <EmptyState title={tr("settings.pages.noProfilesYet")} body={tr("settings.pages.aProfileBundlesModelAgentAndOptions")} />
      )}
      {profiles.map((p) => (
        <div key={p.id} className="set-row">
          <div className="set-row-text">
            <div className="set-row-label">
              <span className="profile-avatar" style={{ background: p.color ?? "var(--blue)" }} />
              {p.name}
            </div>
            <div className="set-row-hint mono">
              {p.providerID}/{p.modelID}{p.agent ? ` · ${p.agent}` : ""}{p.thinking ? tr("settings.pages.thinkValue", { thinking: p.thinking }) : ""}
            </div>
            {repairsFor[p.id] && <div className="set-row-hint">{repairsFor[p.id]}</div>}
          </div>
          <div className="set-row-control">
            <button className="small-btn" onClick={() => void checkProfile(p)}>{tr("settings.pages.validate")}</button>
            <button className="small-btn" onClick={() => setEditing(p)}>{tr("common.edit")}</button>
            <button className="small-btn danger-btn"
              onClick={() => { void confirmAlert(tr("settings.pages.deleteProfileValue", { name: p.name }), { title: tr("settings.pages.deleteProfile"), confirmLabel: tr("common.delete") }).then((ok) => { if (ok) void api.deleteProfile(p.id).then(() => refreshProfiles()); }); }}>
              {tr("common.delete")}</button>
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
        <input value={name} placeholder={tr("settings.pages.name")} style={{ maxWidth: 140 }} onChange={(e) => setName(e.target.value)} aria-label={tr("settings.pages.serverName")} />
        <Seg value={kind} options={[["stdio", "stdio"], ["http", "HTTP"]]} onChange={setKind} />
      </div>
      {kind === "stdio" ? (
        <div className="mcp-form-row">
          <input value={command} placeholder={tr("settings.pages.commandNoShell")} style={{ maxWidth: 200 }} onChange={(e) => setCommand(e.target.value)} aria-label={tr("settings.pages.command")} />
          <input value={args} placeholder={tr("settings.pages.argsSpaceSeparated")} onChange={(e) => setArgs(e.target.value)} aria-label={tr("settings.pages.arguments")} />
        </div>
      ) : (
        <div className="mcp-form-row">
          <input value={url} placeholder={tr("settings.pages.httpsHostMcp")} onChange={(e) => setUrl(e.target.value)} aria-label={tr("settings.pages.serverUrl")} />
        </div>
      )}
      <div className="mcp-secrets">
        <div className="stat-label">{kind === "stdio" ? tr("settings.pages.environmentSecrets") : tr("settings.pages.headerSecrets")} <span className="muted">{tr("settings.pages.valuesStoredServerSideNeverShownAgain")}</span></div>
        {secretRows.map((row, i) => (
          <div key={i} className="mcp-form-row">
            <input value={row.key} placeholder={kind === "stdio" ? tr("settings.pages.envKey") : tr("settings.pages.headerName")} style={{ maxWidth: 160 }}
              onChange={(e) => setSecretRows((rs) => rs.map((r, j) => j === i ? { ...r, key: e.target.value } : r))} />
            <input type="password" value={row.value} placeholder={tr("settings.pages.value")}
              onChange={(e) => setSecretRows((rs) => rs.map((r, j) => j === i ? { ...r, value: e.target.value } : r))} />
            <button className="small-btn" onClick={() => setSecretRows((rs) => rs.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button className="ghost-link" onClick={() => setSecretRows((rs) => [...rs, { key: "", value: "" }])}>{tr("settings.pages.secret")}</button>
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="mcp-form-row">
        <button className="small-btn" disabled={busy || !name.trim() || (kind === "stdio" ? !command.trim() : !url.trim())} onClick={() => void submit()}>
          {existing ? tr("settings.pages.saveChanges") : tr("settings.pages.addServer")}
        </button>
        {existing && <button className="small-btn" disabled={busy} onClick={onDone}>{tr("common.cancel")}</button>}
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
      <div className="stat-label">{tr("settings.pages.importJson")}{" "}<span className="muted">{tr("settings.pages.mcpserversBlockClaudeOrOpencodeShapeEnv")}</span></div>
      <textarea
        rows={6}
        className="mono"
        placeholder={tr("settings.pages.valueNN")}
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
                {secretKeys.length > 0 && <span className="secret-redacted"> {tr("settings.pages.secrets")}{" "}{secretKeys.join(", ")}</span>}
                {dup && <span> {tr("settings.pages.nameAlreadyExistsWillFail")}</span>}
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
          {tr("settings.pages.preview")}</button>
        <button className="small-btn" disabled={busy || !preview || preview.entries.length === 0} onClick={() => void doImport()}>
          {busy
            ? tr("settings.pages.importing")
            : (preview?.entries.length ?? 0) === 1
              ? tr("settings.pages.importOneServer")
              : tr("settings.pages.importValueServers", { count: preview?.entries.length ?? 0 })}
        </button>
        <button className="small-btn" disabled={busy} onClick={onDone}>{tr("common.cancel")}</button>
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
      <PageHead title={tr("settings.pages.mcp")} blurb={tr("settings.pages.modelContextProtocolServersAppliedToThe")} />
      <div className="mcp-list" data-settings-item="mcp.servers">
        {servers.length === 0 && !adding && (
          <EmptyState title={tr("settings.pages.noMcpServersConfigured")} body={tr("settings.pages.addAStdioOrHttpServerThe")} />
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
                  <span className="secret-redacted"> {tr("settings.pages.env")}{" "}{s.transport.envKeys.join(", ")}</span>
                )}
                {s.transport.kind === "http" && s.transport.headersSecretRefs.length > 0 && (
                  <span className="secret-redacted"> {tr("settings.pages.headers")}{" "}{s.transport.headersSecretRefs.join(", ")}</span>
                )}
              </div>
              {(testMsg[s.id] || s.lastError) && <div className="set-row-hint">{testMsg[s.id] ?? s.lastError}</div>}
            </div>
            <div className="set-row-control">
              <span className={`tag mcp-status ${s.status}`}>{s.status}</span>
              <button className="small-btn" title={tr("settings.pages.checkReachabilityAndStoreTheResult")} onClick={() => void probe(s)}>{tr("settings.pages.probe")}</button>
              <button className="small-btn" onClick={() => setEditingId(s.id)}>{tr("common.edit")}</button>
              <button className="small-btn" onClick={() => void api.mcpUpdate(s.id, { enabled: !s.enabled }, s.revision).then(refresh)}>
                {s.enabled ? tr("settings.pages.disable") : tr("settings.pages.enable")}
              </button>
              <button className="small-btn danger-btn" onClick={() => { void confirmAlert(tr("settings.pages.removeMcpServerValue", { name: s.name }), { title: tr("settings.pages.removeMcpServer"), confirmLabel: tr("common.remove") }).then((ok) => { if (ok) void api.mcpRemove(s.id).then(refresh); }); }}>
                {tr("common.remove")}</button>
            </div>
          </div>
        ))}
      </div>
      {adding && <McpServerForm onDone={() => { setAdding(false); refresh(); }} />}
      {importing && <McpImportForm existingNames={servers.map((s) => s.name)} onDone={() => { setImporting(false); refresh(); }} />}
      {!adding && !importing && (
        <div className="mcp-form-row">
          <button className="small-btn" onClick={() => setAdding(true)}>{tr("settings.pages.mcpServer")}</button>
          <button className="small-btn" onClick={() => setImporting(true)}>{tr("settings.pages.importJson2")}</button>
        </div>
      )}
    </>
  );
}

const OTTO_PLUGIN_EXAMPLE = `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@otto-assistant/opencode-claude"]
}`;

function OpenCodePluginsSection() {
  const [plugins, setPlugins] = useState<OpenCodePluginEntryDto[]>([]);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<OpenCodePluginPreviewDto | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const result = await api.opencodePluginsList();
      setPlugins(result.plugins);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => { void refresh(); }, []);

  const importPlugins = async () => {
    if (!preview || preview.errors.length > 0 || preview.entries.length === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    const entries: OpenCodePluginConfigEntry[] = preview.entries.map((entry) =>
      entry.options ? [entry.spec, entry.options] : entry.spec);
    try {
      const result = await api.opencodePluginsImport({ plugins: entries });
      setPlugins(result.plugins);
      setText("");
      setPreview(null);
      setNotice(
        `${result.imported.length} OpenCode plugin${result.imported.length === 1 ? "" : "s"} staged.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (plugin: OpenCodePluginEntryDto) => {
    if (!window.confirm(`Remove OpenCode plugin "${plugin.spec}" from opencode.json?`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.opencodePluginRemove(plugin.spec);
      setPlugins(result.plugins);
      if (result.removed) setNotice(`${plugin.spec} removal staged.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="opencode-plugin-section" data-settings-item="plugins.opencode">
      <div className="plugin-library-head">
        <div>
          <strong>OpenCode plugins</strong>
          <span>Paste a package spec, plugin array, or OpenCode config. Only the plugin array is merged into opencode.json.</span>
        </div>
        <span>{plugins.length} configured</span>
      </div>
      <div className="mcp-list">
        {plugins.length === 0 && (
          <EmptyState title="No OpenCode plugins configured" body="Paste JSON below to add one without changing providers, MCP servers, agents, or other config." />
        )}
        {plugins.map((plugin) => {
          const info = describePluginSpec(plugin.spec);
          return (
            <div className="set-row" key={plugin.spec}>
              <div className="set-row-text">
                <div className="set-row-label">{info.name}</div>
                <div className="set-row-hint mono">{info.path}</div>
                <div className="set-row-hint">
                  {info.description}
                  {plugin.options && ` · Options: ${JSON.stringify(plugin.options)}`}
                </div>
              </div>
              <div className="set-row-control">
                <button className="small-btn danger-btn" disabled={busy} onClick={() => void remove(plugin)}>Remove</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mcp-form">
        <div className="stat-label">
          Import OpenCode plugin JSON <span className="muted">(string entries and [spec, options] tuples are supported)</span>
        </div>
        <textarea
          rows={7}
          className="mono"
          aria-label="OpenCode plugin JSON"
          placeholder={OTTO_PLUGIN_EXAMPLE}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setPreview(null);
            setError("");
            setNotice("");
          }}
        />
        {preview && (
          <div className="mcp-import-preview" aria-live="polite">
            {preview.entries.map((entry) => {
              const existing = plugins.some((plugin) => plugin.spec === entry.spec);
              return (
                <div key={entry.spec} className="set-row-hint mono">
                  {existing ? "↻" : "+"} {entry.spec}
                  {entry.options && ` · ${JSON.stringify(entry.options)}`}
                  {existing && <span> — existing entry will be updated</span>}
                </div>
              );
            })}
            {preview.ignoredKeys.length > 0 && (
              <div className="set-row-hint">
                Not imported: {preview.ignoredKeys.join(", ")}. Those config keys remain unchanged.
              </div>
            )}
            {preview.errors.map((message, index) => <div className="form-error" key={index}>{message}</div>)}
          </div>
        )}
        <div className="mcp-form-row">
          <button
            className="small-btn"
            disabled={busy || !text.trim()}
            onClick={() => setPreview(parseOpenCodePluginJson(text))}
          >
            Preview
          </button>
          <button
            className="small-btn"
            disabled={busy || !preview || preview.entries.length === 0 || preview.errors.length > 0}
            onClick={() => void importPlugins()}
          >
            {busy ? "Importing…" : `Import ${preview?.entries.length ?? 0} plugin${(preview?.entries.length ?? 0) === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="plugin-toast" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")}>Dismiss</button></div>}
    </section>
  );
}

function PluginLogViewer({ id }: { id: string }) {
  const [lines, setLines] = useState<Array<{ at: number; line: string }>>([]);
  useEffect(() => { void api.pluginsLogs(id).then(setLines).catch(() => setLines([])); }, [id]);
  return (
    <div className="plugin-log" role="log" aria-label={tr("settings.pages.logsForValue", { id: id })}>
      {lines.length === 0 && <span className="muted">{tr("settings.pages.noLogOutput")}</span>}
      {lines.map((l, i) => <div key={i} className="mono plugin-log-line">{l.line}</div>)}
    </div>
  );
}

export function ManagedPluginsSection() {
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
      setToast(tr("settings.pages.pluginInstalledContributionsAvailable", { name: installed.name }));
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
        ? tr("settings.pages.pluginDisabledPlacementsKept", { name: plugin.name })
        : what === "enable"
          ? tr("settings.pages.pluginEnabledSeeContributions", { name: plugin.name })
          : tr("settings.pages.pluginReloaded", { name: plugin.name }));
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
      ? tr("settings.pages.pluginWidgetsInLayoutUninstallWarning", {
          count: active.length,
          name: plugin.name,
        })
      : tr("settings.pages.removePluginValue", { name: plugin.name });
    if (!await confirmAlert(warning, { title: tr("settings.pages.removePlugin"), confirmLabel: tr("common.remove") })) return;
    await api.pluginsRemove(plugin.id);
    setToast(tr("settings.pages.pluginRemoved", { name: plugin.name }));
    if (selected === plugin.id) setSelected(null);
    refresh();
  };

  const selectedPlugin = plugins.find((plugin) => plugin.id === selected);
  const contributionCount = (plugin: InstalledPluginDto, prefix: string) =>
    plugin.contributions.filter((item) => item.slot.startsWith(prefix)).length;

  return (
    <div className="plugin-library" data-settings-item="plugins.managed">
      <div className="plugin-library-head">
        <div><strong>{tr("settings.pages.managedPolythPlugins")}</strong><span>{tr("settings.pages.extensionsWithAPolythPlugin")}</span></div>
        <span>{plugins.length} {tr("settings.pages.installed")}</span>
      </div>
      {plugins.length === 0 && (
        <EmptyState
          title={tr("settings.pages.noManagedPluginsInstalled")}
          body={tr("settings.pages.installManagedPluginHint")}
        />
      )}
      <div className="plugin-card-grid">
        {plugins.map((p) => {
          const widgetCount = contributionCount(p, "widget.");
          const commandCount = contributionCount(p, "command");
          const toolCount = p.capabilities.length;
          return (
            <article key={p.id} className={`plugin-card ${p.enabled ? "enabled" : "disabled"}`}>
              <button type="button" className="plugin-card-main" onClick={() => setSelected(p.id)}>
                <span className="plugin-card-icon">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="plugin-card-copy">
                  <strong>{p.name}</strong>
                  <small>{p.source}</small>
                </span>
                <span className={`tag mcp-status ${p.status === "ready" ? "connected" : p.status === "error" ? "error" : "disabled"}`}>
                  {p.status === "ready"
                    ? tr("settings.pages.ready")
                    : p.status === "error"
                      ? tr("common.error")
                      : p.status === "disabled"
                        ? tr("settings.packagespage.disabled")
                        : p.status}
                </span>
                <p>{p.lastError || tr("settings.pages.pluginContributionsCount", {
                  name: p.name,
                  count: p.contributions.length,
                })}</p>
                <span className="plugin-card-counts">
                  <b>{widgetCount} {tr("settings.pages.widgets")}</b><b>{commandCount} {tr("settings.pages.commands")}</b><b>{toolCount} {tr("settings.pages.tools")}</b>
                </span>
              </button>
              <div className="plugin-card-actions">
                {p.update && <button type="button" onClick={() => void op(p.id, "reload")}>{tr("settings.pages.updateTo")}{" "}{p.update.version}</button>}
                <button type="button" onClick={() => void op(p.id, p.enabled ? "disable" : "enable")}>{p.enabled ? tr("settings.pages.disable") : tr("settings.pages.enable")}</button>
                <button type="button" onClick={() => setLogsFor(logsFor === p.id ? null : p.id)}>{tr("settings.pages.logs")}</button>
                <button type="button" className="danger-btn" onClick={() => void remove(p)}>{tr("settings.pages.uninstall")}</button>
              </div>
            </article>
          );
        })}
      </div>
      {selectedPlugin && (
        <section className="plugin-detail">
          <header>
            <span className="plugin-card-icon">{selectedPlugin.name.slice(0, 1).toUpperCase()}</span>
            <div><strong>{selectedPlugin.name}</strong><small>{tr("settings.pages.v")}{selectedPlugin.version} · {selectedPlugin.source}</small></div>
            <button type="button" onClick={() => setSelected(null)} aria-label={tr("settings.pages.closePluginDetails")}>{tr("settings.pages.message")}</button>
          </header>
          <div className="plugin-detail-tabs" role="tablist">
            {(["overview", "widgets", "commands", "tools", "settings", "permissions", "contributions"] as const).map((tab) => (
              <button type="button" role="tab" aria-selected={detailTab === tab} className={detailTab === tab ? "active" : ""} key={tab} onClick={() => setDetailTab(tab)}>
                {tab[0]!.toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
          <div className="plugin-detail-body">
            {detailTab === "overview" && <p>{selectedPlugin.enabled ? tr("settings.pages.enabledAndReadyToContributeToYour") : tr("settings.pages.disabledExistingLayoutPlacementsAreKeptUntil")}</p>}
            {detailTab === "widgets" && <p>{contributionCount(selectedPlugin, "widget.")} {tr("settings.pages.widgetContributionsInstallingAPluginNeverInserts")}</p>}
            {detailTab === "commands" && <p>{contributionCount(selectedPlugin, "command")} {tr("settings.pages.commandContributions")}</p>}
            {detailTab === "tools" && <p>{selectedPlugin.capabilities.length ? selectedPlugin.capabilities.join(", ") : tr("settings.pages.noDeclaredTools")}</p>}
            {detailTab === "settings" && <p>{contributionCount(selectedPlugin, "settings.")} {tr("settings.pages.settingsPagesOrControls")}</p>}
            {detailTab === "permissions" && <p><span className={`tag plugin-trust trust-${selectedPlugin.trust}`}>{selectedPlugin.trust}</span> {tr("settings.pages.permissionsAreRequestedWhenThePluginNeeds")}</p>}
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
          placeholder={tr("settings.pages.npmScopeName100Or")}
          aria-invalid={source.length > 0 && !sourceValid ? true : undefined}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && sourceValid) void install(); }}
        />
        <button className="small-btn" disabled={!sourceValid} onClick={() => void install()}>{tr("settings.pages.install")}</button>
      </div>
      {error && <div className="form-error">{error}</div>}
      {toast && <div className="plugin-toast" role="status"><span>{toast}</span><button type="button" onClick={() => setToast("")}>{tr("settings.pages.dismiss")}</button></div>}
    </div>
  );
}

export function PluginsPage() {
  return (
    <>
      <PageHead title="Plugins" blurb="Configure OpenCode runtime plugins or install managed Polyth UI extensions." />
      <OpenCodePluginsSection />
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
  if (err) return <><PageHead title={tr("settings.pages.about")} /><EmptyState title={tr("settings.pages.serverUnreachable")} body={err} /></>;
  if (!info) return <><PageHead title={tr("settings.pages.about")} /><EmptyState title={tr("common.loading")} /></>;
  return (
    <>
      <PageHead title={tr("settings.pages.about")} blurb={tr("settings.pages.connectionDetailsForThisPolythServer")} />
      <div data-settings-item="about.info">
        <Row label={tr("settings.pages.version")}><span className="mono">{info.version}</span></Row>
        <Row label={tr("settings.pages.applicationUrl")} hint={tr("settings.pages.theConfiguredLocalAddressNeverDerivedFrom")}>
          <span className="mono">{info.applicationUrl}</span>
          <button className="small-btn" onClick={() => copy("URL", info.applicationUrl)}>{tr("common.copy")}</button>
        </Row>
        <Row label={tr("settings.pages.tunnel")} hint={info.tunnelUrl ? tr("settings.pages.publicTunnelIsConfigured") : tr("settings.pages.noTunnelConfigured")}>
          {info.tunnelUrl
            ? <><span className="mono">{info.tunnelUrl}</span><button className="small-btn" onClick={() => copy("tunnel", info.tunnelUrl!)}>{tr("common.copy")}</button></>
            : <span className="tag">{tr("settings.pages.none")}</span>}
        </Row>
        <Row label={tr("settings.pages.dataDirectory")}><span className="mono">{info.dataDirLabel}</span></Row>
        <Row label={tr("settings.pages.capabilities")}>
          <span className="muted" style={{ maxWidth: 360, textAlign: "right" }}>{info.capabilities.join(", ")}</span>
        </Row>
        {copied && <div className="muted" role="status">{copied === "copy blocked by the browser" ? copied : tr("settings.pages.valueCopied", { copied: copied })}</div>}
      </div>
    </>
  );
}
