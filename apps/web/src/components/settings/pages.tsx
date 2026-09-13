// The simpler settings pages: General, Appearance, Chat, Notifications,
// Behavior, Projects, Agents, MCP, and About.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  activateProject,
  applyProjectUpsert,
  openSettingsPage,
  setUiError,
  updateSettings,
  useStore,
} from "../../store.ts";
import { HEADER_METRIC_IDS, RESPONSE_ACTION_IDS, UI_DEFAULTS, setUiSettings, useUiSettings, type ContextIndicatorMode, type GlassEffect, type HeaderMetricId, type ResponseActionId } from "../../uiPrefs.ts";
import { clampPromptHistoryLimit } from "@polyth/contracts";
import { DEFAULT_SETTINGS, friendlyError, INTERFACE_FONTS } from "../../settings.ts";
import { requestNotifyPermission } from "../../notify.ts";
import { disablePush, enablePush, pushSubscription, pushUnsupportedReason } from "../../push.ts";
import { api } from "@polyth/session/web-api";
import { confirmAlert } from "../../alerts.ts";
import { EmptyState, PageHead, Row, Seg, Toggle } from "./parts.tsx";
import { refreshProfiles, useProfiles } from "../../profiles.ts";
import { removeProject } from "../../init.ts";
import AgentProfileForm from "../AgentProfileForm.tsx";
import ProjectFolderDialog from "../ProjectFolderDialog.tsx";
import { parseMcpServersJson, type McpImportResult } from "../../mcpImport.ts";
import {
  PRESET_THEMES, addCustomTheme, applyTheme, loadCustomThemes, parseThemeJson,
  reapplyTheme, removeCustomTheme, resolveTheme, type AppearanceMode, type ThemeSpec,
} from "../../theme.ts";
import type { AssistSettingsDto } from "@polyth/session/web-api";
import type {
  AgentProfile,
  HarnessSelection,
  HarnessSnapshot,
  McpServerDto,
  McpTransport,
  ModelRef,
  SystemInfoDto,
} from "@polyth/contracts";
import ModelPicker from "../../../../../packages/models/widgets/ModelPicker.tsx";
import { modelSupportsTextWorkflow } from "../../composer/discovery.ts";
import { getLocale, LOCALES, LOCALE_NAMES, setLocale, tr, type Locale } from "../../i18n/index.ts";
import {
  projectRemembersModelSelection,
  resolveSessionDefaultModel,
  useSessionDefaults,
} from "../../sessionDefaults.ts";
import { Button, Checkbox, Dialog, IconButton, Select, Textarea, TextInput } from "../ui/index.ts";
import { DeleteIcon } from "../ui/icons.ts";
import { BackgroundPicker } from "../BackgroundPicker.tsx";
import {
  disableNativePushForCurrentAccount,
  enableNativePushForCurrentAccount,
  nativePushSettingsAvailable,
  nativePushSettingsStatus,
} from "../../nativePush.ts";

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
        <Select
          label={LOCALE_NAMES[getLocale()]}
          value={getLocale()}
          ariaLabel={tr("common.language")}
          options={LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] }))}
          onChange={(locale) => {
            // Persist happens after the catalog chunk loads; reload only once
            // the new locale is durable, else the reload races the write.
            void setLocale(locale as Locale).then(() => window.location.reload());
          }}
        />
      </Row>
      <Row label={tr("settings.pages.productName")} hint={tr("settings.pages.shownInTheSidebarAndWindowChrome")} itemId="general.productName">
        <TextInput
          uiSize="sm"
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
            <TextInput
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
              <Button size="sm" variant="danger" onClick={() => removeCustom(t.id)}>{tr("common.delete")}</Button>
            </div>
          ))}
        </div>
      )}
      <div className="theme-import">
        <Textarea
          className="theme-import-input"
          rows={3}
          placeholder={tr("settings.pages.pasteThemeJsonExample")}
          value={json}
          onChange={(e) => { setJson(e.target.value); setJsonError(""); }}
          aria-label={tr("settings.pages.customThemeJson")}
        />
        <div className="theme-import-actions">
          <Button size="sm" disabled={!json.trim()} onClick={importJson}>{tr("settings.pages.importTheme")}</Button>
          <Button size="sm" onClick={copyCurrent} title={tr("settings.pages.copyTheActiveThemeAsJsonTo")}>{tr("settings.pages.copyCurrentAsJson")}</Button>
        </div>
        {jsonError && <div className="form-error">{jsonError}</div>}
      </div>
    </div>
  );
}

function FontSizeRange({
  value,
  label,
  min = 10,
  max = 32,
  onChange,
}: {
  value: number;
  label: string;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  const percentage = ((value - min) / (max - min)) * 100;
  return (
    <div className="rng">
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        style={{ "--p": `${percentage}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="rng-val">{value}{tr("settings.pages.px")}</span>
    </div>
  );
}

export function AppearancePage() {
  const ui = useUiSettings();
  const settings = useStore((s) => s.settings);
  const resetFontSizes = () => {
    updateSettings({ fontSize: DEFAULT_SETTINGS.fontSize });
    setUiSettings({
      fontSize: UI_DEFAULTS.fontSize,
      headerFontSize: UI_DEFAULTS.headerFontSize,
      subheaderFontSize: UI_DEFAULTS.subheaderFontSize,
      terminalFontSize: UI_DEFAULTS.terminalFontSize,
      editorFontSize: UI_DEFAULTS.editorFontSize,
    });
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
      <div className="set-sec background-settings" data-settings-item="appearance.background">
        <div className="set-sec-title">Workspace background</div>
        <p className="background-settings-hint">Choose a quiet color atmosphere or add an image from this browser.</p>
        <BackgroundPicker />
      </div>
      <Row label="Glass surfaces" hint="Control matte transparency across the whole interface." itemId="appearance.glass">
        <Seg<GlassEffect>
          value={ui.glassEffect}
          options={[["off", "Off"], ["matte", "Matte"], ["clear", "Clear"]]}
          onChange={(glassEffect) => setUiSettings({ glassEffect })}
        />
      </Row>
      <Row label="Context indicator" hint="Choose how context usage appears beside the session title." itemId="appearance.contextIndicator">
        <Seg<ContextIndicatorMode>
          value={ui.contextIndicatorMode}
          options={[["logo", "Tinted logo"], ["donut", "Donut"]]}
          onChange={(contextIndicatorMode) => setUiSettings({ contextIndicatorMode })}
        />
      </Row>
      <Row label={tr("settings.pages.interfaceFont")} hint={tr("settings.pages.chooseFromCleanUiFaces")} itemId="appearance.fontFamily">
        <Select
          label={INTERFACE_FONTS.find((font) => font.id === settings.fontFamily)?.label ?? settings.fontFamily}
          ariaLabel={tr("settings.pages.interfaceFont")}
          value={settings.fontFamily}
          options={INTERFACE_FONTS.map((font) => ({
            value: font.id,
            label: font.label,
            group: font.mono
              ? tr("settings.pages.programmerMonospaceLigaturesOff")
              : font.id === "serif"
                ? tr("settings.pages.serif")
                : tr("settings.pages.uiSansSerif"),
          }))}
          onChange={(fontFamily) => updateSettings({ fontFamily: fontFamily as typeof settings.fontFamily })}
        />
      </Row>
      <Row label={tr("settings.pages.density")} hint={tr("settings.pages.chooseAiryBalancedOrCompactSpacingAcross")} itemId="appearance.density">
        <Seg value={ui.density} options={[
          ["comfortable", tr("settings.pages.comfortable")],
          ["balanced", tr("settings.pages.balanced")],
          ["compact", tr("settings.pages.compact")],
        ]} onChange={(density) => { setUiSettings({ density }); updateSettings({ density }); }} />
      </Row>
      <Row label="General text size" hint="Chat messages, inputs, session titles, and settings text." itemId="appearance.fontSize">
        <FontSizeRange value={settings.fontSize} label="General text size" onChange={(fontSize) => updateSettings({ fontSize })} />
      </Row>
      <Row label="Header size" hint="Page, section, and surface headings." itemId="appearance.headerFontSize">
        <FontSizeRange value={ui.headerFontSize} min={14} max={48} label="Header size" onChange={(headerFontSize) => setUiSettings({ headerFontSize })} />
      </Row>
      <Row label="Subheader size" hint="Subheadings, project names, and worktree names in the navigator." itemId="appearance.subheaderFontSize">
        <FontSizeRange value={ui.subheaderFontSize} label="Subheader size" onChange={(subheaderFontSize) => setUiSettings({ subheaderFontSize })} />
      </Row>
      <Row label={tr("settings.pages.terminalFontSize")} hint="Terminal input and output." itemId="appearance.terminalFontSize">
        <FontSizeRange value={ui.terminalFontSize} label={tr("settings.pages.terminalFontSizeInPixels")} onChange={(terminalFontSize) => setUiSettings({ terminalFontSize })} />
      </Row>
      <Row label={tr("settings.pages.editorFontSize")} hint={tr("settings.pages.editorFontSizeInPixels")} itemId="appearance.editorFontSize">
        <FontSizeRange value={ui.editorFontSize} label={tr("settings.pages.editorFontSizeInPixels")} onChange={(editorFontSize) => setUiSettings({ editorFontSize })} />
      </Row>
      <Row label={tr("settings.pages.resetFontSizes")} hint="Restore all five font sizes to their defaults.">
        <Button size="sm" onClick={resetFontSizes}>{tr("settings.pages.resetToDefaults")}</Button>
      </Row>
      <Row label={tr("settings.pages.cornerRounding")} hint={tr("settings.pages.applySquareCompactOrGenerouslyRoundedCorners")} itemId="appearance.rounding">
        <div className="rng rounding-range">
          <span>{tr("settings.pages.square")}</span>
          <input
            type="range" min={0} max={10} step={1} value={ui.rounding}
            aria-label={tr("settings.pages.cornerRounding")}
            style={{ "--p": `${ui.rounding * 10}%` } as CSSProperties}
            onChange={(e) => setUiSettings({ rounding: Number(e.target.value) })}
          />
          <span>{tr("settings.pages.rounded")}</span>
        </div>
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
  const [limitEdit, setLimitEdit] = useState(String(ui.promptHistoryLimit));
  useEffect(() => { setLimitEdit(String(ui.promptHistoryLimit)); }, [ui.promptHistoryLimit]);
  const commitHistoryLimit = () => {
    const next = clampPromptHistoryLimit(limitEdit, ui.promptHistoryLimit);
    setLimitEdit(String(next));
    if (next !== ui.promptHistoryLimit) setUiSettings({ promptHistoryLimit: next });
  };
  // F9 hard switch lives server-side: disabled means nothing is generated at all
  const [assist, setAssist] = useState<AssistSettingsDto | null>(null);
  useEffect(() => { void api.assistSettings().then(setAssist).catch(() => setAssist(null)); }, []);
  const saveAssist = (patch: Partial<AssistSettingsDto>) => {
    void api.assistSettingsSave(patch).then(setAssist).catch(() => {});
  };
  const metricLabels: Record<HeaderMetricId, string> = { tokens: "Tokens", messages: "Messages", duration: "Duration", cost: "Cost" };
  const actionLabels: Record<ResponseActionId, string> = { copy: "Copy", image: "Save image", plan: "Save as plan", pin: "Pin to content", session: "Start new session", multirun: "Start multirun" };
  const toggleOrdered = <T extends string>(current: readonly T[], id: T, update: (value: T[]) => void) => {
    update(current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
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
      <Row
        label={tr("composer.largePasteBanner")}
        hint={tr("settings.pages.largePasteHint")}
        itemId="chat.largePaste"
      >
        <Seg value={ui.largeTextPasteBehavior} options={[
          ["ask", tr("settings.pages.largePasteAsk")],
          ["attach", tr("composer.largePasteAttach")],
          ["inline", tr("composer.largePasteInline")],
        ]} onChange={(largeTextPasteBehavior) => setUiSettings({ largeTextPasteBehavior })} />
      </Row>
      <Row label={tr("settings.pages.thinkingBlocks")} hint={tr("settings.pages.collapseMergedReasoningIntoAnExpandableBlock")} itemId="chat.thinking">
        <Toggle on={ui.collapsibleThinkingBlocks} onChange={(v) => setUiSettings({ collapsibleThinkingBlocks: v })} label={tr("settings.pages.collapsibleThinking")} />
      </Row>
      <Row label={tr("settings.pages.messageActions")} hint={tr("settings.pages.showLightweightCopyRevertAndForkControls")} itemId="chat.messageActions">
        <Toggle on={ui.showMessageActions} onChange={(showMessageActions) => setUiSettings({ showMessageActions })} label={tr("settings.pages.messageActions")} />
      </Row>
      <Row label="Chat metrics" hint="Choose which session metrics stay visible in the chat header." itemId="chat.headerMetrics">
        <div className="settings-check-list">{HEADER_METRIC_IDS.map((id) => <label key={id}><Checkbox label={metricLabels[id]} checked={ui.headerMetrics.includes(id)} onChange={() => toggleOrdered(ui.headerMetrics, id, (headerMetrics) => setUiSettings({ headerMetrics }))} /></label>)}</div>
      </Row>
      <Row label="Answer quick actions" hint="Choose the buttons shown on agent answers. They appear in this order." itemId="chat.responseActions">
        <div className="settings-check-list">{RESPONSE_ACTION_IDS.map((id) => <label key={id}><Checkbox label={actionLabels[id]} checked={ui.responseActions.includes(id)} onChange={() => toggleOrdered(ui.responseActions, id, (responseActions) => setUiSettings({ responseActions }))} /></label>)}</div>
      </Row>
      <Row label={tr("settings.pages.copyFormat")} hint={tr("settings.pages.chooseThePayloadUsedByTheSingle")} itemId="chat.copyFormat">
        <Seg
          value={ui.messageCopyFormat}
          options={[["markdown", tr("common.markdown")], ["json", tr("common.json")]]}
          onChange={(messageCopyFormat) => setUiSettings({ messageCopyFormat })}
        />
      </Row>
      <Row label={tr("settings.pages.desktopSendShortcut")} itemId="chat.sendOnEnter">
        <Seg value={settings.desktopSendShortcut} options={[["enter", "Enter"], ["shift-enter", "Shift+Enter"]]} onChange={(desktopSendShortcut) => updateSettings({ desktopSendShortcut, sendOnEnter: desktopSendShortcut === "enter" })} />
      </Row>
      <Row label={tr("settings.pages.mobileSendShortcut")} itemId="chat.mobileSendShortcut">
        <Seg value={settings.mobileSendShortcut} options={[["none", tr("common.none")], ["enter", "Enter"], ["shift-enter", "Shift+Enter"]]} onChange={(mobileSendShortcut) => updateSettings({ mobileSendShortcut })} />
      </Row>
      <Row
        label={tr("settings.pages.promptHistory")}
        hint={tr("settings.pages.promptHistoryHint")}
        itemId="chat.promptHistory"
      >
        <Seg
          value={ui.promptHistoryScope}
          options={[
            ["session", tr("settings.pages.promptHistoryScopeSession")],
            ["space", tr("settings.pages.promptHistoryScopeSpace")],
          ]}
          onChange={(promptHistoryScope) => setUiSettings({ promptHistoryScope })}
        />
      </Row>
      <Row
        label={tr("settings.pages.promptHistoryLimit")}
        hint={tr("settings.pages.promptHistoryLimitHint")}
        itemId="chat.promptHistoryLimit"
      >
        <div className="editor-font-control">
          <TextInput
            uiSize="sm"
            type="number"
            min={1}
            max={200}
            value={limitEdit}
            aria-label={tr("settings.pages.promptHistoryLimit")}
            onChange={(e) => setLimitEdit(e.target.value)}
            onBlur={commitHistoryLimit}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
        </div>
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
            <TextInput
              uiSize="sm"
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
            <Checkbox
                key={kind}
                checked={ui.notifyKinds.includes(kind)}
                onChange={(checked) => toggleKind(kind, checked)}
                label={label}
              />
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
        <TextInput
          uiSize="sm"
          className="notification-preview"
          value={ui.notifyTemplate}
          onChange={(e) => setUiSettings({ notifyTemplate: e.target.value.slice(0, 200) })}
          aria-label={tr("settings.pages.notificationTemplate")}
        />
      </Row>
      {ui.notifyOnComplete && !granted && !denied && (
        <Row label={tr("settings.pages.permission2")} hint={tr("settings.pages.theBrowserWillAskForPermissionOnce")}>
          <Button size="sm" onClick={requestNotifyPermission}>{tr("settings.pages.grantPermission")}</Button>
        </Row>
      )}
      <PushRow />
      <NativePushRow />
    </>
  );
}

/** Capacitor-native delivery is separate from browser Web Push. It is shown
 * only inside the actual native client and asks the OS only after user intent. */
function NativePushRow() {
  const available = nativePushSettingsAvailable();
  const [status, setStatus] = useState<"loading" | "unavailable" | "disabled" | "enabling" | "enabled" | "denied" | "failed">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!available) return;
    void nativePushSettingsStatus().then((next) => setStatus(next.state)).catch(() => setStatus("failed"));
  }, [available]);
  if (!available) return null;
  const enabled = status === "enabled";
  const hint = status === "denied"
    ? "Notification permission is denied in system settings."
    : status === "unavailable"
      ? "Native push is unavailable in this app build."
      : "Uses this phone’s trusted Polyth connection; enabled only after the server confirms the claim.";
  const toggle = (next: boolean) => {
    if (busy) return;
    setBusy(true); setError("");
    void (next ? enableNativePushForCurrentAccount() : disableNativePushForCurrentAccount())
      .then((result) => setStatus(result.state))
      .catch((cause) => { setStatus("disabled"); setError(cause instanceof Error ? cause.message : "Could not update native notifications."); })
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Row label="Mobile push notifications" hint={hint} itemId="notifications.mobilePush">
        {status === "unavailable" || status === "denied"
          ? <span className="tag">Unavailable</span>
          : <Button size="sm" busy={busy} onClick={() => toggle(!enabled)}>{enabled ? "Disable" : "Enable"}</Button>}
      </Row>
      {error && <div className="muted" role="alert">{error}</div>}
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
          <Button
            size="sm"
            busy={busy}
            onClick={() => {
              setTested("");
              void api.pushTest().then((r) => setTested(r.sent === 1
                ? tr("settings.pages.sentToOneDevice")
                : tr("settings.pages.sentToValueDevices", { count: r.sent })))
                .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
            }}
          >{tr("settings.pages.sendTest")}</Button>
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
      <Textarea
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
            <Button size="sm" onClick={() => void load()}>{tr("settings.pages.reloadLatest")}</Button>
          </div>
        ) : (
          <span className="muted">{message}</span>
        )}
        <span className="header-spacer" />
        <Button size="sm" busy={state === "saving"} disabled={!dirty} onClick={() => void save()}>
          {state === "saving" ? tr("common.saving") : tr("settings.pages.saveApply")}
        </Button>
      </div>
    </div>
  );
}

export function BehaviorPage() {
  const ui = useUiSettings();
  const [favoriteSubagents, setFavoriteSubagents] = useState(true);
  const [savingFavoriteSubagents, setSavingFavoriteSubagents] = useState(false);
  const [workspaceInstructions, setWorkspaceInstructions] = useState(false);
  const [savingWorkspaceInstructions, setSavingWorkspaceInstructions] = useState(false);
  useEffect(() => {
    void api.subagentPolicyGet()
      .then((policy) => setFavoriteSubagents(policy.enabled))
      .catch((error) => setUiError(friendlyError("Couldn’t load subagent policy", error)));
  }, []);
  useEffect(() => {
    void api.workspaceInstructionsPolicyGet()
      .then((policy) => setWorkspaceInstructions(policy.enabled))
      .catch((error) => setUiError(friendlyError("Couldn’t load workspace instruction policy", error)));
  }, []);
  const changeFavoriteSubagents = async (enabled: boolean) => {
    if (savingFavoriteSubagents) return;
    setSavingFavoriteSubagents(true);
    try {
      const policy = await api.subagentPolicyPut(enabled);
      setFavoriteSubagents(policy.enabled);
    } catch (error) {
      setUiError(friendlyError("Couldn’t save subagent policy", error));
    } finally {
      setSavingFavoriteSubagents(false);
    }
  };
  const changeWorkspaceInstructions = async (enabled: boolean) => {
    if (savingWorkspaceInstructions) return;
    setSavingWorkspaceInstructions(true);
    try {
      const policy = await api.workspaceInstructionsPolicyPut(enabled);
      setWorkspaceInstructions(policy.enabled);
    } catch (error) {
      setUiError(friendlyError("Couldn’t save workspace instruction policy", error));
    } finally {
      setSavingWorkspaceInstructions(false);
    }
  };
  return (
    <>
      <PageHead title={tr("settings.pages.behavior")} blurb={tr("settings.pages.workspaceSafetyFlowAndGlobalAgentInstructions")} />
      <Row label={tr("settings.pages.confirmBeforeArchivingSessions")} hint={tr("settings.pages.askBeforeASessionIsMovedTo")} itemId="behavior.confirmArchive">
        <Toggle on={ui.confirmSessionArchive} onChange={(v) => setUiSettings({ confirmSessionArchive: v })} label={tr("settings.pages.confirmArchive")} />
      </Row>
      <Row label={tr("settings.pages.editorAutosave")} hint={tr("settings.pages.savesEditsAfterAShortPauseRevision")} itemId="behavior.autosave">
        <Toggle on={ui.editorAutosave} onChange={(v) => setUiSettings({ editorAutosave: v })} label={tr("settings.pages.editorAutosave")} />
      </Row>
      <Row label="Require favorite subagents" hint="Agents must choose the best favorite for each delegated task, then switch favorites if it fails." itemId="behavior.favoriteSubagents">
        <Toggle on={favoriteSubagents} onChange={(value) => void changeFavoriteSubagents(value)} label="Require favorite subagents" />
      </Row>
      <Row
        label="Include workspace AGENTS.md"
        hint="When enabled, the active workspace's AGENTS.md is hidden in the first prompt of each runtime leg. Off by default."
        itemId="behavior.workspaceInstructions"
      >
        <Toggle
          on={workspaceInstructions}
          onChange={(value) => void changeWorkspaceInstructions(value)}
          label="Include workspace AGENTS.md"
        />
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
  const [harnesses, setHarnesses] = useState<Record<string, HarnessSnapshot[]>>({});
  const [picking, setPicking] = useState(false);
  const globalModel = resolveSessionDefaultModel(null, sessionDefaults.defaultModel, models[0]);
  const globalModelName = globalModel
    ? models.find((model) =>
        model.providerID === globalModel.providerID && model.modelID === globalModel.modelID
        && (!globalModel.harnessId || model.harnessId === globalModel.harnessId))?.name
      ?? globalModel.modelID
    : "No model available";
  useEffect(() => {
    let cancelled = false;
    void Promise.all(projects.map(async (project) => [project.id, await api.harnessSnapshots(project.id)] as const))
      .then((entries) => { if (!cancelled) setHarnesses(Object.fromEntries(entries)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projects.map((project) => project.id).join("|")]);
  const saveExecution = async (projectId: string, patch: { harness?: HarnessSelection | null }) => {
    try {
      applyProjectUpsert(await api.patchProject(projectId, { defaults: patch }));
    } catch (error) {
      setUiError(friendlyError("Couldn’t save project execution defaults", error));
    }
  };
  const saveModel = async (projectId: string, model?: ModelRef & { harnessId?: string }) => {
    if (!model) return;
    try {
      const updated = await api.patchProject(projectId, {
        defaults: {
          rememberModelSelection: true,
          model: { providerID: model.providerID, modelID: model.modelID },
          ...(model.harnessId ? { harness: { mode: "pinned", harnessId: model.harnessId } as const } : {}),
        },
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
            <Button
              size="sm"
              variant="danger"
              onClick={() => { void confirmAlert(tr("settings.pages.removeProjectValueFromPolyth", { value: p.name || p.path }), { title: tr("settings.pages.removeProject"), confirmLabel: tr("common.remove") }).then((ok) => { if (ok) void removeProject(p.id); }); }}
            >{tr("common.remove")}</Button>
          </header>
          <div className="project-settings-options">
            <div>
              <strong>{tr("settings.pages.projectIcon")}</strong>
              <span>{tr("settings.pages.useAnEmojiOrShortSymbolIn")}</span>
            </div>
            <TextInput
              uiSize="sm"
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
          <div className="project-settings-options" data-settings-item="projects.executionHarness">
            <div><strong>Default harness</strong><span>Choose an execution engine for new conversations in this project.</span></div>
            <Select
              label="Default harness"
              value={p.defaults?.harness === null || p.defaults?.harness === undefined ? "inherit" : p.defaults.harness.mode === "auto" ? "auto" : p.defaults.harness.harnessId}
              options={[
                { value: "inherit", label: "Inherit global default" },
                { value: "auto", label: "Auto" },
                ...(harnesses[p.id] ?? []).map((snapshot) => ({ value: snapshot.identity.id, label: snapshot.identity.name, detail: snapshot.availability.state === "ready" ? "Ready" : "Setup may be required" })),
              ]}
              onChange={(value) => void saveExecution(p.id, { harness: value === "inherit" ? null : value === "auto" ? { mode: "auto" } : { mode: "pinned", harnessId: value } })}
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
                value={p.defaults?.model ? {
                  ...p.defaults.model,
                  ...(p.defaults.harness?.mode === "pinned" ? { harnessId: p.defaults.harness.harnessId } : {}),
                } : undefined}
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
            <Button
              size="sm"
              onClick={() => {
                activateProject(p.id);
                openSettingsPage("widgets");
              }}
            >{tr("settings.pages.configureCanvas")}</Button>
          </div>
        </section>
      ))}
      <div className="set-add-form">
        <Button size="sm" onClick={() => setPicking(true)}>{tr("settings.pages.openProjectFolder")}</Button>
      </div>
      {picking && <ProjectFolderDialog onClose={() => setPicking(false)} />}
    </>
  );
}

/** Polyth execution presets. Native harness roles live inside their harness
 * detail page; profiles may reference one, but are never presented as roles. */
export function ProfilesPage() {
  const profiles = useProfiles();
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [repairsFor, setRepairsFor] = useState<Record<string, string>>({});
  const checkProfile = async (profile: AgentProfile) => {
    const result = await api.validateProfile(profile.id).catch(() => null);
    setRepairsFor((current) => ({
      ...current,
      [profile.id]: !result ? "Check failed" : !result.checked ? "Harness unavailable — not checked" : result.valid ? "Valid ✓" : result.repairs.map((repair) => repair.reason).join("; "),
    }));
  };
  return <>
    <PageHead title="Profiles" blurb="Bundle a harness, model, native role, thinking level, and feature choices for repeatable execution." />
    <div className="stat-label stat-label-row" data-settings-item="profiles.list">
      <span>{profiles.length} profile{profiles.length === 1 ? "" : "s"}</span>
      <span className="header-spacer" />
      <Button size="sm" onClick={() => setCreating(true)}>New profile</Button>
    </div>
    {profiles.length === 0 && <EmptyState title="No profiles yet" body="Create a profile for execution choices you use together." />}
    {profiles.map((profile) => <div key={profile.id} className="set-row">
      <div className="set-row-text">
        <div className="set-row-label"><span className="profile-avatar" style={{ background: profile.color ?? "var(--blue)" }} />{profile.name}</div>
        <div className="set-row-hint mono">{profile.harnessId ?? "Legacy harness"} · {profile.providerID}/{profile.modelID}{profile.agent ? ` · ${profile.agent}` : ""}{profile.thinking ? ` · Think ${profile.thinking}` : ""}</div>
        {repairsFor[profile.id] && <div className="set-row-hint">{repairsFor[profile.id]}</div>}
      </div>
      <div className="set-row-control">
        <Button size="sm" onClick={() => void checkProfile(profile)}>Validate</Button>
        <Button size="sm" onClick={() => setEditing(profile)}>Edit</Button>
        <Button size="sm" variant="danger" onClick={() => { void confirmAlert(`Delete profile ${profile.name}?`, { title: "Delete profile", confirmLabel: tr("common.delete") }).then((ok) => { if (ok) void api.deleteProfile(profile.id).then(() => refreshProfiles()); }); }}>Delete</Button>
      </div>
    </div>)}
    {(editing || creating) && <AgentProfileForm {...(editing ? { existing: editing } : {})} onClose={() => { setEditing(null); setCreating(false); }} />}
  </>;
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
        <TextInput uiSize="sm" value={name} placeholder={tr("settings.pages.name")} className="mcp-server-name" onChange={(e) => setName(e.target.value)} aria-label={tr("settings.pages.serverName")} />
        <Seg value={kind} options={[["stdio", "stdio"], ["http", "HTTP"]]} onChange={setKind} />
      </div>
      {kind === "stdio" ? (
        <div className="mcp-form-row">
          <TextInput uiSize="sm" value={command} placeholder={tr("settings.pages.commandNoShell")} className="mcp-command" onChange={(e) => setCommand(e.target.value)} aria-label={tr("settings.pages.command")} />
          <TextInput uiSize="sm" value={args} placeholder={tr("settings.pages.argsSpaceSeparated")} onChange={(e) => setArgs(e.target.value)} aria-label={tr("settings.pages.arguments")} />
        </div>
      ) : (
        <div className="mcp-form-row">
          <TextInput uiSize="sm" value={url} placeholder={tr("settings.pages.httpsHostMcp")} onChange={(e) => setUrl(e.target.value)} aria-label={tr("settings.pages.serverUrl")} />
        </div>
      )}
      <div className="mcp-secrets">
        <div className="stat-label">{kind === "stdio" ? tr("settings.pages.environmentSecrets") : tr("settings.pages.headerSecrets")} <span className="muted">{tr("settings.pages.valuesStoredServerSideNeverShownAgain")}</span></div>
        {secretRows.map((row, i) => (
          <div key={i} className="mcp-form-row">
            <TextInput uiSize="sm" value={row.key} placeholder={kind === "stdio" ? tr("settings.pages.envKey") : tr("settings.pages.headerName")} className="mcp-secret-key"
              onChange={(e) => setSecretRows((rs) => rs.map((r, j) => j === i ? { ...r, key: e.target.value } : r))} />
            <TextInput uiSize="sm" type="password" value={row.value} placeholder={tr("settings.pages.value")}
              onChange={(e) => setSecretRows((rs) => rs.map((r, j) => j === i ? { ...r, value: e.target.value } : r))} />
            <IconButton icon={DeleteIcon} size="sm" variant="danger" label={`${tr("common.remove")} ${tr("settings.pages.secret")}`} onClick={() => setSecretRows((rs) => rs.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setSecretRows((rs) => [...rs, { key: "", value: "" }])}>{tr("settings.pages.secret")}</Button>
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="mcp-form-row">
        <Button size="sm" busy={busy} disabled={!name.trim() || (kind === "stdio" ? !command.trim() : !url.trim())} onClick={() => void submit()}>
          {existing ? tr("settings.pages.saveChanges") : tr("settings.pages.addServer")}
        </Button>
        {existing && <Button size="sm" disabled={busy} onClick={onDone}>{tr("common.cancel")}</Button>}
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
      <Textarea
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
        <Button size="sm" disabled={busy || !text.trim()} onClick={() => setPreview(parseMcpServersJson(text))}>
          {tr("settings.pages.preview")}</Button>
        <Button size="sm" busy={busy} disabled={!preview || preview.entries.length === 0} onClick={() => void doImport()}>
          {busy
            ? tr("settings.pages.importing")
            : (preview?.entries.length ?? 0) === 1
              ? tr("settings.pages.importOneServer")
              : tr("settings.pages.importValueServers", { count: preview?.entries.length ?? 0 })}
        </Button>
        <Button size="sm" disabled={busy} onClick={onDone}>{tr("common.cancel")}</Button>
      </div>
    </div>
  );
}

export function McpPage({ embedded = false }: { embedded?: boolean }) {
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
      {!embedded && <PageHead title={tr("settings.pages.mcp")} blurb={tr("settings.pages.modelContextProtocolServersAppliedToThe")} />}
      {embedded && <div className="stat-label">OpenCode MCP servers</div>}
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
              <Button size="sm" title={tr("settings.pages.checkReachabilityAndStoreTheResult")} onClick={() => void probe(s)}>{tr("settings.pages.probe")}</Button>
              <Button size="sm" onClick={() => setEditingId(s.id)}>{tr("common.edit")}</Button>
              <Button size="sm" onClick={() => void api.mcpUpdate(s.id, { enabled: !s.enabled }, s.revision).then(refresh)}>
                {s.enabled ? tr("settings.pages.disable") : tr("settings.pages.enable")}
              </Button>
              <Button size="sm" variant="danger" onClick={() => { void confirmAlert(tr("settings.pages.removeMcpServerValue", { name: s.name }), { title: tr("settings.pages.removeMcpServer"), confirmLabel: tr("common.remove") }).then((ok) => { if (ok) void api.mcpRemove(s.id).then(refresh); }); }}>
                {tr("common.remove")}</Button>
            </div>
          </div>
        ))}
      </div>
      {adding && <McpServerForm onDone={() => { setAdding(false); refresh(); }} />}
      {importing && <McpImportForm existingNames={servers.map((s) => s.name)} onDone={() => { setImporting(false); refresh(); }} />}
      {!adding && !importing && (
        <div className="mcp-form-row">
          <Button size="sm" onClick={() => setAdding(true)}>{tr("settings.pages.mcpServer")}</Button>
          <Button size="sm" onClick={() => setImporting(true)}>{tr("settings.pages.importJson2")}</Button>
        </div>
      )}
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
  if (!info) return <><PageHead title={tr("settings.pages.about")} /><EmptyState title={tr("common.loading")} busy /></>;
  return (
    <>
      <PageHead title={tr("settings.pages.about")} blurb={tr("settings.pages.connectionDetailsForThisPolythServer")} />
      <div data-settings-item="about.info">
        <Row label={tr("settings.pages.version")}><span className="mono">{info.version}</span></Row>
        <Row label={tr("settings.pages.applicationUrl")} hint={tr("settings.pages.theConfiguredLocalAddressNeverDerivedFrom")}>
          <span className="mono">{info.applicationUrl}</span>
          <Button size="sm" onClick={() => copy("URL", info.applicationUrl)}>{tr("common.copy")}</Button>
        </Row>
        <Row label={tr("settings.pages.tunnel")} hint={info.tunnelUrl ? tr("settings.pages.publicTunnelIsConfigured") : tr("settings.pages.noTunnelConfigured")}>
          {info.tunnelUrl
            ? <><span className="mono">{info.tunnelUrl}</span><Button size="sm" onClick={() => copy("tunnel", info.tunnelUrl!)}>{tr("common.copy")}</Button></>
            : <span className="tag">{tr("settings.pages.none")}</span>}
        </Row>
        <Row label={tr("settings.pages.dataDirectory")}><span className="mono">{info.dataDirLabel}</span></Row>
        <Row label={tr("settings.pages.capabilities")}>
          <span className="muted about-capabilities">{info.capabilities.join(", ")}</span>
        </Row>
        {copied && <div className="muted" role="status">{copied === "copy blocked by the browser" ? copied : tr("settings.pages.valueCopied", { copied: copied })}</div>}
      </div>
    </>
  );
}
