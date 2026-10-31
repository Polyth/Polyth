// The simpler settings pages: General, Appearance, Chat, Notifications,
// Behavior, Projects, Agents, MCP, and About.
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type CSSProperties, type ReactNode } from "react";
import {
  openSettingsPage,
  setUiError,
  updateSettings,
  useStore,
} from "../../store.ts";
import { useOrderedProjects } from "../../sidebarPrefs.ts";
import { HEADER_METRIC_IDS, RAIL_SIZE_MAX, RAIL_SIZE_MIN, RAIL_SIZE_STEP, RAIL_SPACING_MAX, RAIL_SPACING_MIN, RAIL_SPACING_STEP, UI_DEFAULTS, setUiSettings, useUiSettings, type GlassEffect, type HeaderMetricId, type StatusBarMode, type SwipeNavigationMode } from "../../uiPrefs.ts";
import { clampPromptHistoryLimit, projectIsolatesByDefault, projectIsolationLevel } from "@polyth/contracts";
import { DEFAULT_SETTINGS, friendlyError, INTERFACE_FONTS, interfaceFontLabel, TEXT_SIZE_MAX, TEXT_SIZE_MIN } from "../../settings.ts";
import { requestNotifyPermission } from "../../notify.ts";
import { DEFAULT_NOTIFY_TEMPLATE, renderTemplate } from "../../notifications.ts";
import { isPromptBookmarkHome, usePromptBookmarkPosition, writePromptBookmarkPosition } from "../../promptBookmarkPosition.ts";
import {
  describePushTest, disablePush, enablePush, reconcilePushSubscription, pushUnsupportedReason, sendTestPush,
} from "../../push.ts";
import { api } from "@polyth/session/web-api";
import { desktopBridge } from "../../desktopBridge.ts";
import { confirmAlert } from "../../alerts.ts";
import { CheckGroup, EmptyState, ErrorState, NumberField, PageHead, ResetLink, Row, SaveBar, Section, Seg, SizeStepper, Toggle } from "./parts.tsx";
import CompactShortcutsEditor, { CompactShortcutsReset } from "./CompactShortcutsEditor.tsx";
import { ShellLayoutSection } from "./ShellLayoutSection.tsx";
import {
  HEADER_SIZE_MAX, HEADER_SIZE_MIN, RAIL_PRESETS, railPresetOf, railPresetSizes, shiftTextSizes,
  type RailPreset, type TextSizes,
} from "./appearanceSizes.ts";
import { COMPACT_SHORTCUTS_SETTINGS_ITEM } from "../../compactHeaderFit.ts";
import { removeProject, saveProjectDefaultsOptimistic } from "../../init.ts";
import ProjectFolderDialog from "../ProjectFolderDialog.tsx";
import MessageActionsEditor from "./MessageActionsEditor.tsx";
import { parseMcpServersJson, type McpImportResult } from "../../mcpImport.ts";
import {
  ACCENT_SWATCHES, PRESET_THEMES, THEME_STYLE_CHOICES, accentRoles, addCustomTheme, applyTheme, effectiveThemeStyle, exportThemeJson,
  findPalette, loadCustomThemes, parseThemeJson, termAnsiPalette, themeContrastIssues, reapplyTheme, removeCustomTheme, resolveTheme,
  type AccentSwatchId, type AppearanceMode, type ThemeLook, type ThemeSpec, type ThemeStyleChoice,
} from "../../theme.ts";
import type {
  HarnessSelection,
  HarnessSnapshot,
  McpServerDto,
  McpTransport,
  ModelRef,
  Project,
  ProjectDefaults,
  ReleaseDownloadsDto,
  SystemInfoDto,
} from "@polyth/contracts";
import type { SettingsNavigationTarget } from "@polyth/web-sdk";
import ModelPicker from "@polyth/models/model-picker";
import { modelSupportsTextWorkflow } from "../../composer/discovery.ts";
import { getLocale, getLocalePreference, LOCALES, LOCALE_NAMES, setLocale, systemLocale, tr, type LocalePreference } from "../../i18n/index.ts";
import {
  projectRemembersModelSelection,
  resolveSessionDefaultModel,
  useSessionDefaults,
} from "../../sessionDefaults.ts";
import { Badge, Button, IconButton, Popover, ProjectPicker, Select, TextInput, Textarea } from "../ui/index.ts";
import { useShellMode } from "../../responsiveShell.ts";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, DeleteIcon, EditIcon, PlusIcon, SearchIcon } from "../ui/icons.ts";
import { BackgroundPicker } from "../BackgroundPicker.tsx";
import { ShellLookPicker } from "./ShellLookPicker.tsx";
import ProjectAppearanceDialogCore from "../ProjectAppearanceDialogCore.tsx";
import { SHARED_PRESENTATION_SCOPE, useProjectInterfaceMode, type ProjectInterfaceMode } from "../../projectInterfaceScope.ts";
import { chooseProjectInterface, copyProjectPresentationToShared } from "../../projectPresentationSync.ts";
import { mobileRailScopeKey, parseMobileRail, readMobileRail, writeMobileRail } from "../../composer/mobileRail.ts";
import { useSpaces } from "../../spaces.ts";
import { isPackageEnabled, subscribePackages } from "../../packages/registry.ts";
import {
  setWorkspaceCanvasEnabledForProject,
  subscribeWorkspaceCanvasEnabled,
  workspaceCanvasEnabledForProject,
} from "../../widgets/workspaceMode.ts";
import {
  setWorkbenchProfileOfferedForProject,
  subscribeWorkbenchProfileOffers,
  useOptionalWorkbenchProfiles,
  workbenchProfileOfferedForProject,
} from "../../workbench/profileNavigation.ts";
import {
  disableNativePushForCurrentAccount,
  enableNativePushForCurrentAccount,
  nativePushSettingsAvailable,
  nativePushSettingsStatus,
} from "../../nativePush.ts";

const SKIN_FILE_MAX_BYTES = 256 * 1024;
const ANSI_NAMES = [
  "settings.pages.ansiBlack", "settings.pages.ansiRed", "settings.pages.ansiGreen", "settings.pages.ansiYellow",
  "settings.pages.ansiBlue", "settings.pages.ansiMagenta", "settings.pages.ansiCyan", "settings.pages.ansiWhite",
] as const;
/** Localised accessible name of ANSI slot 0-15 (8-15 are the bright set). */
export function ansiSlotName(index: number): string {
  const base = tr(ANSI_NAMES[index % 8]!);
  return index < 8 ? base : tr("settings.pages.ansiBright", { name: base });
}
/** Advisory contrast summary for a skin, e.g. "text/bg 2.1:1 < 4.5:1". */
function contrastSummary(theme: ThemeSpec): string {
  const issues = themeContrastIssues(theme);
  return issues.length
    ? tr("settings.pages.themeContrastWarning", { issues: issues.map((i) => `${i.pair} ${i.ratio}:1 < ${i.min}:1`).join(", ") })
    : "";
}

/** The 16-slot terminal palette of a skin draft. Editing a slot writes an
 *  explicit `ansi` list into the draft JSON; reset removes it so the palette
 *  derives from the skin tokens again. */
function TerminalPaletteEditor({ theme, onChange }: { theme: ThemeSpec; onChange: (ansi: string[] | undefined) => void }) {
  const palette = termAnsiPalette(theme);
  const hintId = "theme-ansi-hint";
  return (
    <fieldset className="theme-ansi" aria-describedby={hintId}>
      <legend>{tr("settings.pages.terminalPalette")}</legend>
      <p className="theme-ansi-hint" id={hintId}>{tr("settings.pages.terminalPaletteHint")}</p>
      <div className="theme-ansi-grid">
        {palette.map((color, index) => (
          <label key={index} className="theme-ansi-swatch" style={{ "--theme-ansi": color } as CSSProperties} title={`${ansiSlotName(index)} · ${color}`}>
            <input
              type="color"
              value={color.toLowerCase()}
              aria-label={`${ansiSlotName(index)} (${index})`}
              onChange={(event) => onChange(palette.map((value, slot) => slot === index ? event.target.value : value))}
            />
            <span aria-hidden="true">{index}</span>
          </label>
        ))}
      </div>
      <Button size="sm" variant="ghost" disabled={!theme.ansi} onClick={() => onChange(undefined)}>{tr("settings.pages.useDerivedPalette")}</Button>
    </fieldset>
  );
}

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
  const ui = useUiSettings();
  const languageOptions: { value: LocalePreference; label: string }[] = [
    { value: "system", label: tr("settings.pages.languageSystem", { language: LOCALE_NAMES[systemLocale()] }) },
    ...LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] })),
  ];
  const languagePreference = getLocalePreference();
  return (
    <>
      <PageHead title={tr("settings.pages.general")} blurb={tr("settings.pages.applicationBasicsAndBrowserLocalBehavior")} />
      <Section title={tr("settings.pages.interfaceGroup")}>
        <Row label={tr("common.language")} hint={tr("settings.pages.languageReloadHint")} itemId="general.language">
          <Select
            label={languageOptions.find((option) => option.value === languagePreference)?.label ?? LOCALE_NAMES[getLocale()]}
            value={languagePreference}
            ariaLabel={tr("common.language")}
            options={languageOptions}
            onChange={(preference) => {
              // Persist happens after the catalog chunk loads; reload only once
              // the new locale is durable, else the reload races the write.
              void setLocale(preference as LocalePreference).then(() => window.location.reload());
            }}
          />
        </Row>
        <Row label={tr("settings.pages.productName")} hint={tr("settings.pages.productNameHint")} itemId="general.productName">
          <TextInput
            uiSize="sm"
            value={settings.productName}
            placeholder="Polyth"
            aria-label={tr("settings.pages.productName")}
            onChange={(e) => updateSettings({ productName: e.target.value })}
            onBlur={() => { if (!settings.productName.trim()) updateSettings({ productName: "Polyth" }); }}
          />
        </Row>
        <Row label={tr("settings.pages.relativeTimestamps")} hint={tr("settings.pages.showSessionActivityAs2mAgoInstead")} itemId="general.relativeTime">
          <Toggle on={settings.relativeTime} onChange={(relativeTime) => updateSettings({ relativeTime })} label={tr("settings.pages.relativeTimestamps")} />
        </Row>
        {/* How the phone shell answers a swipe: behaviour, not appearance. */}
        <Row label={tr("settings.pages.swipeNavigation")} hint={tr("settings.pages.swipeNavigationHint")} itemId="general.swipeNavigation">
          <Seg<SwipeNavigationMode>
            label={tr("settings.pages.swipeNavigation")}
            value={ui.swipeNavigation}
            options={[
              ["surface", tr("settings.pages.swipeNavigationSurface")],
              ["edge", tr("settings.pages.swipeNavigationEdge")],
              ["off", tr("settings.pages.swipeNavigationOff")],
            ]}
            onChange={(swipeNavigation) => setUiSettings({ swipeNavigation })}
          />
        </Row>
      </Section>
    </>
  );
}

type ThemeStyleId = Exclude<ThemeStyleChoice, "auto">;

/** Style names are product names, kept as is in every language; Classic is
 *  the only descriptive one. */
function themeStyleName(style: ThemeStyleId): string {
  if (style === "liquid-glass") return "macOS 27";
  if (style === "fluent") return "Polyth";
  if (style === "macos") return "Big Sur";
  return tr("settings.pages.styleClassic");
}
/** The schemes that ship with a style share its name (Polyth, Big Sur,
 *  macOS 27); the note names the style, so the scheme never reads as one. */
function nativeStyleNote(theme: ThemeSpec): string {
  return theme.style ? ` · ${tr("settings.pages.nativeToStyle", { style: themeStyleName(theme.style) })}` : "";
}
const THEME_STYLE_NOTES = {
  "liquid-glass": "settings.pages.styleLiquidGlassNote",
  fluent: "settings.pages.styleFluentNote",
  macos: "settings.pages.styleMacosNote",
  classic: "settings.pages.styleClassicNote",
} as const satisfies Record<ThemeStyleId, string>;
const ACCENT_NAMES = {
  blue: "settings.pages.accentBlue",
  purple: "settings.pages.accentPurple",
  pink: "settings.pages.accentPink",
  red: "settings.pages.accentRed",
  orange: "settings.pages.accentOrange",
  yellow: "settings.pages.accentYellow",
  green: "settings.pages.accentGreen",
  graphite: "settings.pages.accentGraphite",
  teal: "settings.pages.accentTeal",
} as const satisfies Record<AccentSwatchId, string>;

/** A miniature window in one style's geometry, painted with the current
 *  colours: a sidebar with a selected row, two lines of text, and a segmented
 *  control, switch and default button drawn the way that style draws them. */
function ThemeStyleSpecimen() {
  return (
    <span className="theme-style-specimen" aria-hidden="true">
      <span className="theme-style-specimen-side"><i /><i /><i /></span>
      <span className="theme-style-specimen-main">
        <i className="theme-style-specimen-line" />
        <i className="theme-style-specimen-line is-short" />
        <span className="theme-style-specimen-controls">
          <i className="theme-style-specimen-seg"><b /></i>
          <i className="theme-style-specimen-switch" />
          <i className="theme-style-specimen-button" />
        </span>
      </span>
    </span>
  );
}

/** Platform style (themeStyle): how controls, materials and motion are drawn.
 *  It is independent of the colour scheme and of the look (shellLook), so it
 *  sits under Appearance → Customize. A style applies on click only: its
 *  geometry would move the cards under the pointer. */
function PlatformStyleCards() {
  const settings = useStore((s) => s.settings);
  // Imported skins live in this browser; reread them when the scheme changes
  // so a just-imported scheme resolves to its own style.
  const customs = useMemo(() => loadCustomThemes(), [settings.theme]);
  const currentStyle = effectiveThemeStyle(findPalette(settings.theme, customs), settings.themeStyle);
  const pickStyle = (themeStyle: ThemeStyleId) => updateSettings({ themeStyle });
  return (
    <div className="theme-style-cards" role="group" aria-label={tr("settings.pages.themeStyle")}>
      {THEME_STYLE_CHOICES.map((style) => (
        <button
          key={style}
          type="button"
          className="theme-style-card"
          data-style={style}
          aria-pressed={currentStyle === style}
          onClick={() => pickStyle(style)}
        >
          <ThemeStyleSpecimen />
          <span className="theme-style-copy">
            <strong>{themeStyleName(style)}</strong>
            <small>{tr(THEME_STYLE_NOTES[style])}</small>
          </span>
          {currentStyle === style && <span className="theme-style-check"><CheckIcon aria-hidden="true" /></span>}
        </button>
      ))}
    </div>
  );
}

// Style, colour mode, colour scheme and accent are independent choices: any
// scheme can be drawn in any style, and the accent recolours whichever scheme
// is chosen. Hovering a scheme or an accent applies it live; leaving
// re-applies the saved pick. A style is applied on click only: its geometry
// would move the cards under the pointer.
function ThemeSection() {
  const settings = useStore((s) => s.settings);
  const [customs, setCustoms] = useState<ThemeSpec[]>(() => loadCustomThemes());
  const [json, setJson] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [jsonWarning, setJsonWarning] = useState("");
  const [jsonPreviewing, setJsonPreviewing] = useState(false);
  const skinFileRef = useRef<HTMLInputElement>(null);
  const accentInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const phone = useShellMode() === "phone";
  const themeTriggerRef = useRef<HTMLButtonElement>(null);
  // Each apply repaints ~35 CSS variables and notifies canvas consumers, so
  // hover preview is debounced on one shared timer: sweeping across the list
  // coalesces to a single apply per pause and a single restore on exit,
  // instead of an apply + restore per crossed row.
  const previewTimer = useRef<number | null>(null);
  const previewApplied = useRef(false);
  const systemDark = typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)").matches
    : true;
  const currentPalette = findPalette(settings.theme, customs);
  const currentStyle = effectiveThemeStyle(currentPalette, settings.themeStyle);
  // A record from before style and colours split draws each palette in its
  // own style. The first choice made here pins the style it shows, so a
  // colour scheme never brings a different style along.
  const pinnedStyle = settings.themeStyle === "auto" ? { themeStyle: currentStyle } : {};
  const resolveWith = (theme: ThemeSpec, look: ThemeLook = {}) => resolveTheme(theme.id, settings.appearanceMode, {
    custom: customs,
    systemDark,
    style: currentStyle,
    accent: settings.accentColor,
    ...look,
  });
  const effective = (theme: ThemeSpec) => resolveWith(theme);
  // Swatches show a palette's own colours, not the accent laid over it.
  const paletteView = (theme: ThemeSpec) => resolveWith(theme, { accent: "" });
  // An unsaved draft is not in `customs` yet, so resolving it by id alone
  // would fall back to the default theme. It previews as an import lands: in
  // its own style when it names one, with its own accent.
  const effectiveDraft = (theme: ThemeSpec) => resolveTheme(theme.id, settings.appearanceMode, {
    custom: [theme, ...customs],
    systemDark,
    style: theme.style ?? currentStyle,
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
  const previewAccent = (accent: string) => schedulePreview(() => {
    previewApplied.current = true;
    applyTheme(resolveWith(currentPalette, { accent }));
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
  // A parsed draft drives the palette editor; the textarea stays the source.
  const draft = useMemo(() => {
    if (!json.trim()) return null;
    const res = parseThemeJson(json);
    return res.ok ? res.theme : null;
  }, [json]);
  const endJsonPreview = () => {
    if (!jsonPreviewing) return;
    setJsonPreviewing(false);
    previewApplied.current = false;
    reapplyTheme();
  };
  const editJson = (next: string) => {
    endJsonPreview();
    setJson(next); setJsonError(""); setJsonWarning("");
  };
  const importJson = () => {
    const res = parseThemeJson(json);
    if (!res.ok) { setJsonError(res.error); return; }
    // Import is never blocked by contrast; the warning stays visible after it.
    setJsonWarning(contrastSummary(res.theme));
    setJsonPreviewing(false);
    previewApplied.current = false;
    setCustoms(addCustomTheme(res.theme));
    setJson("");
    setJsonError("");
    // A skin is a whole scheme: it brings its own accent, and its style when
    // it names one; a palette-only skin keeps the current style.
    updateSettings({ theme: res.theme.id, themeStyle: res.theme.style ?? currentStyle, accentColor: "" });
  };
  // Live preview of the draft before it is saved; a second press, an edit,
  // an import, or leaving the page restores the saved theme.
  const toggleJsonPreview = () => {
    if (jsonPreviewing) { endJsonPreview(); return; }
    const res = parseThemeJson(json);
    if (!res.ok) { setJsonError(res.error); return; }
    setJsonError("");
    setJsonWarning(contrastSummary(res.theme));
    previewApplied.current = true;
    setJsonPreviewing(true);
    applyTheme(effectiveDraft(res.theme));
  };
  const loadSkinFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > SKIN_FILE_MAX_BYTES) {
      setJsonError(tr("settings.pages.skinFileTooLarge", { name: file.name }));
      return;
    }
    void file.text().then((text) => {
      editJson(text);
      const res = parseThemeJson(text);
      if (!res.ok) setJsonError(res.error);
      else setJsonWarning(contrastSummary(res.theme));
    }, (cause: unknown) => setJsonError(cause instanceof Error ? cause.message : String(cause)));
  };
  const setDraftPalette = (ansi: string[] | undefined) => {
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(json) as Record<string, unknown>; } catch { return; }
    if (ansi) raw.ansi = ansi; else delete raw.ansi;
    const next = JSON.stringify(raw, null, 2);
    setJson(next);
    const res = parseThemeJson(next);
    if (res.ok && jsonPreviewing) applyTheme(effectiveDraft(res.theme));
  };
  // The exported skin is what is on screen: the scheme in the current style,
  // with the accent laid over both appearances.
  const currentSkin = () => exportThemeJson(effective(currentPalette), { id: "my-theme", name: tr("settings.pages.myTheme") });
  const downloadCurrent = () => {
    const blob = new Blob([currentSkin()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentPalette.id}.polyth-skin.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const copyCurrent = () => {
    void navigator.clipboard?.writeText(currentSkin());
  };
  const removeCustom = (id: string) => {
    setCustoms(removeCustomTheme(id));
    if (settings.theme === id) updateSettings({ theme: DEFAULT_SETTINGS.theme });
  };
  // Schemes authored for the current style come first; every other palette
  // still draws in it.
  const madeForStyle = (theme: ThemeSpec) => (theme.style ?? "classic") === currentStyle;
  const styleGroup = tr("settings.pages.schemesForStyle", { style: themeStyleName(currentStyle) });
  const allGroup = tr("settings.pages.allPalettes");
  const customGroup = tr("settings.pages.custom");
  const presets = [...PRESET_THEMES.filter(madeForStyle), ...PRESET_THEMES.filter((theme) => !madeForStyle(theme))];
  const choices = [
    ...presets.map((theme) => ({ group: madeForStyle(theme) ? styleGroup : allGroup, theme })),
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
    updateSettings({ theme: id, ...pinnedStyle });
    setQuery("");
    setPickerOpen(false);
    endPreview();
  };
  const pickAccent = (accentColor: string) => {
    updateSettings({ accentColor, ...pinnedStyle });
    endPreview();
  };
  const closeThemePicker = () => {
    setPickerOpen(false);
    endPreview();
  };
  // A colour well reports every drag step as `input` (previewed) and the
  // final colour as a native `change` (saved).
  const commitCustomAccent = useRef(pickAccent);
  commitCustomAccent.current = pickAccent;
  useEffect(() => {
    const input = accentInputRef.current;
    if (!input) return;
    const commit = () => commitCustomAccent.current(input.value.toLowerCase());
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, []);
  const swatches = ACCENT_SWATCHES[currentStyle];
  const shownAccent = (source: string) => accentRoles(source, currentEffective.appearance, currentStyle).accent;
  const customAccent = settings.accentColor && !swatches.some((swatch) => swatch.source === settings.accentColor)
    ? settings.accentColor
    : "";
  return (
    <>
      <Row
        label={tr("settings.pages.colorMode")}
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
      <Row label={tr("settings.pages.colorScheme")} hint={tr("settings.pages.colorSchemeHint")} itemId="appearance.theme" layout="stacked">
      <div className="appearance-theme">
      <div className="theme-picker">
        <button
          ref={themeTriggerRef}
          type="button"
          className="theme-picker-current"
          aria-expanded={pickerOpen}
          aria-controls="theme-picker-list"
          aria-haspopup="listbox"
          onClick={() => setPickerOpen((open) => !open)}
        >
          <ThemeSwatches theme={currentEffective} />
          <span><strong>{current.theme.name}</strong><small>{current.group} · {appearanceLabel}</small></span>
          <b aria-hidden="true">⌄</b>
        </button>
        {pickerOpen && (
          <Popover
            open
            onClose={closeThemePicker}
            anchorRef={themeTriggerRef}
            side="down"
            compact={phone}
            ariaLabel={tr("settings.pages.theme")}
            className="theme-picker-pop"
            restoreFocusRef={themeTriggerRef}
          >
            <div className="picker-search">
              <span className="picker-search-icon" aria-hidden="true"><SearchIcon /></span>
              {/* A plain input, as in Picker: platform styles paint .ui-input as
                  a field, which would nest a second field in the filter well. */}
              <input
                type="text"
                autoFocus={!phone}
                role="combobox"
                aria-expanded="true"
                aria-controls="theme-picker-list"
                aria-label={tr("settings.pages.searchThemes")}
                value={query}
                placeholder={tr("settings.pages.searchValueThemes", { length: choices.length })}
                onChange={(event) => setQuery(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="theme-picker-list" id="theme-picker-list" role="listbox">
              {[styleGroup, allGroup, customGroup].map((group) => {
                const groupChoices = filtered.filter((choice) => choice.group === group);
                if (groupChoices.length === 0) return null;
                return (
                  <section key={group}>
                    <div className="theme-picker-group">{group}</div>
                    {groupChoices.map(({ theme }) => {
                      const rendered = paletteView(theme);
                      return (
                      <button
                        key={`${group}:${theme.id}`}
                        type="button"
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
                        <span><strong>{theme.name}</strong><small>{appearanceName(rendered.appearance)} {tr("settings.pages.palette")}{nativeStyleNote(theme)}</small></span>
                        <b aria-hidden="true">{settings.theme === theme.id ? "✓" : ""}</b>
                      </button>
                      );
                    })}
                  </section>
                );
              })}
              {filtered.length === 0 && <div className="theme-picker-empty">{tr("settings.pages.noMatchingThemes")}</div>}
            </div>
          </Popover>
        )}
      </div>
      </div>
      </Row>
      <Row label={tr("settings.pages.accentColor")} hint={tr("settings.pages.accentColorHint")} itemId="appearance.accent">
        <div className="theme-accent-swatches" role="group" aria-label={tr("settings.pages.accentColor")}>
          <button
            type="button"
            className="theme-accent-swatch is-scheme"
            aria-pressed={!settings.accentColor}
            aria-label={tr("settings.pages.accentFromScheme")}
            title={tr("settings.pages.accentFromScheme")}
            style={{ "--theme-accent-swatch": paletteView(currentPalette).tokens.accent } as CSSProperties}
            onClick={() => pickAccent("")}
            onMouseEnter={() => previewAccent("")}
            onMouseLeave={endPreview}
          />
          {swatches.map((swatch) => (
            <button
              key={swatch.id}
              type="button"
              className="theme-accent-swatch"
              aria-pressed={settings.accentColor === swatch.source}
              aria-label={tr(ACCENT_NAMES[swatch.id])}
              title={tr(ACCENT_NAMES[swatch.id])}
              style={{ "--theme-accent-swatch": shownAccent(swatch.source) } as CSSProperties}
              onClick={() => pickAccent(swatch.source)}
              onMouseEnter={() => previewAccent(swatch.source)}
              onMouseLeave={endPreview}
            />
          ))}
          <label
            className={`theme-accent-swatch is-custom${customAccent ? " is-set" : ""}`}
            title={tr("settings.pages.accentCustom")}
            style={customAccent ? { "--theme-accent-swatch": shownAccent(customAccent) } as CSSProperties : undefined}
          >
            <input
              ref={accentInputRef}
              type="color"
              className="sr-only"
              aria-label={tr("settings.pages.accentCustom")}
              value={customAccent || currentEffective.tokens.accent}
              onChange={(event) => previewAccent(event.target.value.toLowerCase())}
            />
          </label>
        </div>
      </Row>
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
      <details className="theme-import-disclosure">
      <summary>{tr("settings.pages.importExportTheme")}</summary>
      <div className="theme-import">
        <Textarea
          className="theme-import-input"
          dir="ltr"
          rows={4}
          placeholder={tr("settings.pages.pasteThemeJsonExample")}
          value={json}
          onChange={(e) => editJson(e.target.value)}
          aria-label={tr("settings.pages.customThemeJson")}
          invalid={!!jsonError}
        />
        <input
          ref={skinFileRef}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          tabIndex={-1}
          aria-label={tr("settings.pages.loadSkinFile")}
          onChange={loadSkinFile}
        />
        <div className="theme-import-actions">
          <Button size="sm" onClick={() => skinFileRef.current?.click()}>{tr("settings.pages.loadSkinFile")}</Button>
          <Button size="sm" disabled={!json.trim()} aria-pressed={jsonPreviewing} onClick={toggleJsonPreview}>
            {jsonPreviewing ? tr("settings.pages.endPreview") : tr("settings.pages.previewTheme")}
          </Button>
          <Button size="sm" variant="primary" disabled={!json.trim()} onClick={importJson}>{tr("settings.pages.importTheme")}</Button>
        </div>
        {jsonError && <div className="form-error" role="alert">{jsonError}</div>}
        {jsonWarning && <div className="form-warning" role="status">{jsonWarning}</div>}
        {draft && <TerminalPaletteEditor theme={draft} onChange={setDraftPalette} />}
        <div className="theme-import-actions theme-export-actions">
          <Button size="sm" variant="ghost" onClick={copyCurrent} title={tr("settings.pages.copyTheActiveThemeAsJsonTo")}>{tr("settings.pages.copyCurrentAsJson")}</Button>
          <Button size="sm" variant="ghost" onClick={downloadCurrent}>{tr("settings.pages.downloadSkinFile")}</Button>
        </div>
      </div>
      </details>
    </>
  );
}

function RailSizeRange({
  value,
  label,
  onChange,
}: {
  value: number;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <SizeStepper
      value={value}
      min={RAIL_SIZE_MIN}
      max={RAIL_SIZE_MAX}
      step={RAIL_SIZE_STEP}
      label={label}
      unit="%"
      onChange={onChange}
    />
  );
}

/** Rows that sit behind a disclosure. A search hit or deep link on one of them
 *  arrives as the page's target and opens its group, since a collapsed row is
 *  not rendered and cannot be scrolled to. */
const TEXT_SIZE_ITEMS = new Set([
  "appearance.chatFontSize", "appearance.fontSize", "appearance.headerFontSize",
  "appearance.subheaderFontSize", "appearance.terminalFontSize", "appearance.editorFontSize",
]);
const RAIL_SIZE_ITEMS = new Set([
  "appearance.leftRailSize", "appearance.rightRailSize", "appearance.topRailSize", "appearance.railSpacing",
]);
const TABLET_ITEMS = new Set([COMPACT_SHORTCUTS_SETTINGS_ITEM]);
const RAIL_PRESET_NAMES = {
  compact: "settings.pages.railSizeCompact",
  standard: "settings.pages.railSizeStandard",
  large: "settings.pages.railSizeLarge",
} as const satisfies Record<RailPreset, string>;

/** A family's per-part controls, one click under its leading control. */
function SizeDetails({ open, onToggle, label, children }: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children: ReactNode;
}) {
  const bodyId = useId();
  return (
    <div className="settings-subrow settings-size-details">
      <Button
        variant="ghost"
        size="sm"
        className="settings-disclosure-toggle"
        iconEnd={open ? ChevronUpIcon : ChevronDownIcon}
        aria-expanded={open}
        {...(open ? { "aria-controls": bodyId } : {})}
        onClick={onToggle}
      >
        {label}
      </Button>
      {open && <div id={bodyId} className="settings-size-details-body">{children}</div>}
    </div>
  );
}

/** Opens a disclosure when the page is routed to one of the rows inside it. */
function useOpenForTarget(items: ReadonlySet<string>, target: string | undefined, initial = false) {
  const [open, setOpen] = useState(() => initial || (!!target && items.has(target)));
  useEffect(() => {
    if (target && items.has(target)) setOpen(true);
  }, [items, target]);
  return [open, setOpen] as const;
}

export function AppearancePage({ settingsTarget }: { settingsTarget?: SettingsNavigationTarget } = {}) {
  const ui = useUiSettings();
  const settings = useStore((s) => s.settings);
  const shellMode = useShellMode();
  const target = settingsTarget?.itemId;
  const railPreset = railPresetOf(ui);
  // Hand-set rails open their own sizes, so the numbers stay in view.
  const [textOpen, setTextOpen] = useOpenForTarget(TEXT_SIZE_ITEMS, target);
  const [railOpen, setRailOpen] = useOpenForTarget(RAIL_SIZE_ITEMS, target, railPreset === null);
  // The tablet bar only draws at tablet width; elsewhere it waits behind a
  // button, and a link from the bar itself opens it.
  const tabletWidth = shellMode === "compact";
  const [tabletOpen, setTabletOpen] = useOpenForTarget(TABLET_ITEMS, target);
  const tabletShown = tabletWidth || tabletOpen;
  const textSizes: TextSizes = {
    fontSize: settings.fontSize,
    chatFontSize: settings.chatFontSize,
    headerFontSize: ui.headerFontSize,
    subheaderFontSize: ui.subheaderFontSize,
    terminalFontSize: ui.terminalFontSize,
    editorFontSize: ui.editorFontSize,
  };
  // The leading text control shows the chat size and moves every size by the
  // same step, so the family keeps its proportions.
  const shiftAllTextSizes = (chatFontSize: number) => {
    const next = shiftTextSizes(textSizes, chatFontSize - settings.chatFontSize);
    updateSettings({ fontSize: next.fontSize, chatFontSize: next.chatFontSize });
    setUiSettings({
      headerFontSize: next.headerFontSize,
      subheaderFontSize: next.subheaderFontSize,
      terminalFontSize: next.terminalFontSize,
      editorFontSize: next.editorFontSize,
    });
  };
  const resetFontSizes = () => {
    updateSettings({
      fontSize: DEFAULT_SETTINGS.fontSize,
      chatFontSize: DEFAULT_SETTINGS.chatFontSize,
    });
    setUiSettings({
      fontSize: UI_DEFAULTS.fontSize,
      headerFontSize: UI_DEFAULTS.headerFontSize,
      subheaderFontSize: UI_DEFAULTS.subheaderFontSize,
      terminalFontSize: UI_DEFAULTS.terminalFontSize,
      editorFontSize: UI_DEFAULTS.editorFontSize,
    });
  };
  const fontSizesAreDefault = settings.fontSize === DEFAULT_SETTINGS.fontSize
    && settings.chatFontSize === DEFAULT_SETTINGS.chatFontSize
    && ui.headerFontSize === UI_DEFAULTS.headerFontSize
    && ui.subheaderFontSize === UI_DEFAULTS.subheaderFontSize
    && ui.terminalFontSize === UI_DEFAULTS.terminalFontSize
    && ui.editorFontSize === UI_DEFAULTS.editorFontSize;
  const textSize = tr("settings.pages.textSize");
  const chatTextSize = tr("settings.pages.chatTextSize");
  const menuTextSize = tr("settings.pages.menuTextSize");
  const headerSize = tr("settings.pages.headerSize");
  const subheaderSize = tr("settings.pages.subheaderSize");
  const railSize = tr("settings.pages.railSizes");
  const leftRailSize = tr("settings.pages.leftRailSize");
  const rightRailSize = tr("settings.pages.rightRailSize");
  const topRailSize = tr("settings.pages.topRailSize");
  const railSpacing = tr("settings.pages.railSpacing");
  return (
    <>
      <PageHead title={tr("settings.pages.appearance")} blurb={tr("settings.pages.visualPreferencesSavedInThisBrowserAnd")} />
      <Section
        title={tr("settings.pages.shellLook")}
        hint={tr("settings.pages.shellLookHint")}
        itemId="appearance.shellLook"
      >
        <ShellLookPicker />
      </Section>
      <Section title={tr("settings.pages.colorGroup")}>
        <ThemeSection />
      </Section>
      <Section
        title={tr("settings.pages.themeStyle")}
        hint={tr("settings.pages.themeStyleHint")}
        itemId="appearance.style"
      >
        <PlatformStyleCards />
      </Section>
      <Section
        title={tr("settings.pages.backgroundSurfaces")}
        hint={tr("settings.pages.workspaceBackgroundHint")}
        itemId="appearance.background"
      >
        <div className="background-settings">
          <BackgroundPicker />
        </div>
        <Row label={tr("settings.pages.glassSurfaces")} hint={tr("settings.pages.glassSurfacesHint")} itemId="appearance.glass">
          <Seg<GlassEffect>
            value={ui.glassEffect}
            options={[
              ["off", tr("settings.pages.glassOff")],
              ["matte", tr("settings.pages.glassMatte")],
              ["clear", tr("settings.pages.glassClear")],
            ]}
            onChange={(glassEffect) => setUiSettings({ glassEffect })}
          />
        </Row>
        <Row
          label={tr("settings.pages.hideBorders")}
          hint={tr("settings.pages.hideBordersHint")}
          itemId="appearance.hideBorders"
        >
          <Toggle
            on={ui.hideBorders}
            onChange={(hideBorders) => setUiSettings({ hideBorders })}
            label={tr("settings.pages.hideBorders")}
          />
        </Row>
      </Section>
      {/* The window's shape: the layout, its top bar and the mirror. */}
      <ShellLayoutSection />
      <Section
        title={tr("settings.pages.textGroup")}
        action={<ResetLink disabled={fontSizesAreDefault} onClick={resetFontSizes} />}
      >
        <Row label={tr("settings.pages.interfaceFont")} hint={tr("settings.pages.chooseFromCleanUiFaces")} itemId="appearance.fontFamily">
          <Select
            label={interfaceFontLabel(settings.fontFamily)}
            ariaLabel={tr("settings.pages.interfaceFont")}
            value={settings.fontFamily}
            options={INTERFACE_FONTS.map((font) => ({
              value: font.id,
              label: interfaceFontLabel(font.id),
              group: font.mono
                ? tr("settings.pages.programmerMonospaceLigaturesOff")
                : font.id === "serif"
                  ? tr("settings.pages.serif")
                  : tr("settings.pages.uiSansSerif"),
            }))}
            onChange={(fontFamily) => updateSettings({ fontFamily: fontFamily as typeof settings.fontFamily })}
          />
        </Row>
        <Row label={textSize} hint={tr("settings.pages.textSizeHint")} itemId="appearance.textSize">
          <SizeStepper
            value={settings.chatFontSize}
            min={TEXT_SIZE_MIN}
            max={TEXT_SIZE_MAX}
            label={textSize}
            unit={tr("settings.pages.px")}
            specimen={{ text: "Ag" }}
            onChange={shiftAllTextSizes}
          />
        </Row>
        <SizeDetails open={textOpen} onToggle={() => setTextOpen(!textOpen)} label={tr("settings.pages.textSizesEach")}>
          <Row label={chatTextSize} hint={tr("settings.pages.chatTextSizeHint")} itemId="appearance.chatFontSize">
            <SizeStepper
              value={settings.chatFontSize}
              min={TEXT_SIZE_MIN}
              max={TEXT_SIZE_MAX}
              label={chatTextSize}
              unit={tr("settings.pages.px")}
              specimen={{ text: "Ag" }}
              onChange={(chatFontSize) => updateSettings({ chatFontSize })}
            />
          </Row>
          <Row label={menuTextSize} hint={tr("settings.pages.menuTextSizeHint")} itemId="appearance.fontSize">
            <SizeStepper
              value={settings.fontSize}
              min={TEXT_SIZE_MIN}
              max={TEXT_SIZE_MAX}
              label={menuTextSize}
              unit={tr("settings.pages.px")}
              specimen={{ text: "Ag" }}
              onChange={(fontSize) => updateSettings({ fontSize })}
            />
          </Row>
          <Row label={headerSize} hint={tr("settings.pages.headerSizeHint")} itemId="appearance.headerFontSize">
            <SizeStepper
              value={ui.headerFontSize}
              min={HEADER_SIZE_MIN}
              max={HEADER_SIZE_MAX}
              label={headerSize}
              unit={tr("settings.pages.px")}
              specimen={{ text: "Ag" }}
              onChange={(headerFontSize) => setUiSettings({ headerFontSize })}
            />
          </Row>
          <Row label={subheaderSize} hint={tr("settings.pages.subheaderSizeHint")} itemId="appearance.subheaderFontSize">
            <SizeStepper
              value={ui.subheaderFontSize}
              min={TEXT_SIZE_MIN}
              max={TEXT_SIZE_MAX}
              label={subheaderSize}
              unit={tr("settings.pages.px")}
              specimen={{ text: "Ag" }}
              onChange={(subheaderFontSize) => setUiSettings({ subheaderFontSize })}
            />
          </Row>
          <Row label={tr("settings.pages.terminalFontSize")} hint={tr("settings.pages.terminalFontSizeHint")} itemId="appearance.terminalFontSize">
            <SizeStepper
              value={ui.terminalFontSize}
              min={TEXT_SIZE_MIN}
              max={TEXT_SIZE_MAX}
              label={tr("settings.pages.terminalFontSizeInPixels")}
              unit={tr("settings.pages.px")}
              specimen={{ text: "Ag", mono: true }}
              onChange={(terminalFontSize) => setUiSettings({ terminalFontSize })}
            />
          </Row>
          <Row label={tr("settings.pages.editorFontSize")} hint={tr("settings.pages.editorFontSizeHint")} itemId="appearance.editorFontSize">
            <SizeStepper
              value={ui.editorFontSize}
              min={TEXT_SIZE_MIN}
              max={TEXT_SIZE_MAX}
              label={tr("settings.pages.editorFontSizeInPixels")}
              unit={tr("settings.pages.px")}
              specimen={{ text: "Ag", mono: true }}
              onChange={(editorFontSize) => setUiSettings({ editorFontSize })}
            />
          </Row>
        </SizeDetails>
      </Section>
      <Section title={tr("settings.pages.layoutGroup")}>
        <Row label={tr("settings.pages.density")} hint={tr("settings.pages.chooseAiryBalancedOrCompactSpacingAcross")} itemId="appearance.density">
          <Seg value={ui.density} options={[
            ["comfortable", tr("settings.pages.comfortable")],
            ["balanced", tr("settings.pages.balanced")],
            ["compact", tr("settings.pages.compact")],
          ]} onChange={(density) => { setUiSettings({ density }); updateSettings({ density }); }} />
        </Row>
        <Row label={railSize} hint={tr("settings.pages.railSizeHint")} itemId="appearance.railSizes">
          {/* Hand-set rails match no preset, so no segment is pressed. */}
          <Seg<RailPreset | "custom">
            value={railPreset ?? "custom"}
            label={railSize}
            options={RAIL_PRESETS.map((preset) => [preset, tr(RAIL_PRESET_NAMES[preset])])}
            onChange={(preset) => { if (preset !== "custom") setUiSettings(railPresetSizes(preset)); }}
          />
        </Row>
        <SizeDetails open={railOpen} onToggle={() => setRailOpen(!railOpen)} label={tr("settings.pages.railSizesEach")}>
          <Row label={leftRailSize} hint={tr("settings.pages.leftRailSizeHint")} itemId="appearance.leftRailSize">
            <RailSizeRange value={ui.leftRailSize} label={leftRailSize} onChange={(leftRailSize) => setUiSettings({ leftRailSize })} />
          </Row>
          <Row label={rightRailSize} hint={tr("settings.pages.rightRailSizeHint")} itemId="appearance.rightRailSize">
            <RailSizeRange value={ui.rightRailSize} label={rightRailSize} onChange={(rightRailSize) => setUiSettings({ rightRailSize })} />
          </Row>
          <Row label={topRailSize} hint={tr("settings.pages.topRailSizeHint")} itemId="appearance.topRailSize">
            <RailSizeRange value={ui.topRailSize} label={topRailSize} onChange={(topRailSize) => setUiSettings({ topRailSize })} />
          </Row>
          <Row label={railSpacing} hint={tr("settings.pages.railSpacingHint")} itemId="appearance.railSpacing">
            <SizeStepper
              value={ui.railSpacing}
              min={RAIL_SPACING_MIN}
              max={RAIL_SPACING_MAX}
              step={RAIL_SPACING_STEP}
              label={railSpacing}
              unit="px"
              onChange={(railSpacing) => setUiSettings({ railSpacing })}
            />
          </Row>
        </SizeDetails>
        <Row label={tr("settings.pages.cornerRounding")} hint={tr("settings.pages.cornerRoundingHint")} itemId="appearance.rounding">
          <SizeStepper
            value={ui.rounding}
            min={0}
            max={10}
            label={tr("settings.pages.cornerRounding")}
            unit=""
            onChange={(rounding) => setUiSettings({ rounding })}
          />
        </Row>
        <Row label={tr("settings.pages.statusBar")} hint={tr("settings.pages.statusBarHint")} itemId="appearance.statusBar">
          <Seg<StatusBarMode>
            label={tr("settings.pages.statusBar")}
            value={ui.statusBar}
            options={[
              ["off", tr("settings.pages.statusBarOff")],
              ["workflows", tr("settings.pages.statusBarWorkflows")],
              ["always", tr("settings.pages.statusBarAlways")],
            ]}
            onChange={(statusBar) => setUiSettings({ statusBar })}
          />
        </Row>
      </Section>
      <Section
        title={tr("settings.pages.compactShortcuts")}
        hint={tr("settings.pages.compactShortcutsHint")}
        itemId={COMPACT_SHORTCUTS_SETTINGS_ITEM}
        action={(
          <>
            {tabletShown && <CompactShortcutsReset />}
            {!tabletWidth && (
              <Button
                variant="ghost"
                size="sm"
                className="settings-disclosure-toggle"
                iconEnd={tabletOpen ? ChevronUpIcon : ChevronDownIcon}
                aria-expanded={tabletOpen}
                onClick={() => setTabletOpen(!tabletOpen)}
              >
                {tabletOpen ? tr("settings.pages.hideDetails") : tr("settings.pages.showDetails")}
              </Button>
            )}
          </>
        )}
      >
        {tabletShown && <CompactShortcutsEditor />}
      </Section>
    </>
  );
}

export function ChatPage() {
  const ui = useUiSettings();
  const settings = useStore((s) => s.settings);
  const bookmarkPosition = usePromptBookmarkPosition();
  const thinkingOptions: Array<[typeof ui.thinkingDisplayMode, string]> = [
    ["collapsed", tr("settings.pages.collapsibleThinking")],
    ["expanded", tr("settings.pages.expandedThinking")],
    ...(ui.actionGrouping === "grouped"
      ? [["activity", tr("settings.pages.hideThinkingInActivity")] as [typeof ui.thinkingDisplayMode, string]]
      : []),
  ];
  const metricLabels: Record<HeaderMetricId, string> = {
    tokens: tr("chatmetrics.tokens"),
    messages: tr("chatmetrics.messages"),
    duration: tr("chatmetrics.duration"),
    cost: tr("chatmetrics.cost"),
  };
  const toggleOrdered = <T extends string>(current: readonly T[], id: T, update: (value: T[]) => void) => {
    update(current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };
  // CheckGroup reports the whole selection; apply only the one toggled id so
  // hidden ids (disabled packages) survive and new picks keep append order.
  const toggleChecked = <T extends string>(current: readonly T[], next: readonly T[], ids: readonly T[], update: (value: T[]) => void) => {
    const id = ids.find((candidate) => current.includes(candidate) !== next.includes(candidate));
    if (id) toggleOrdered(current, id, update);
  };
  return (
    <>
      <PageHead title={tr("settings.pages.chat")} blurb={tr("settings.pages.conversationLayoutAndDeliveryPreferences")} />
      <Section title={tr("settings.pages.messagesGroup")}>
        <Row
          label={tr("settings.pages.actionBlocks")}
          hint={tr("settings.pages.groupActionsIntoActivityBlocksOrKeepThemUngrouped")}
          itemId="chat.actionBlocks"
        >
          <Seg
            value={ui.actionGrouping}
            options={[
              ["grouped", tr("settings.pages.groupedActions")],
              ["ungrouped", tr("settings.pages.ungroupedActions")],
            ]}
            onChange={(actionGrouping) => setUiSettings({ actionGrouping })}
          />
        </Row>
        {ui.actionGrouping === "grouped" && (
          <Row label={tr("settings.pages.activityBlockStyle")} hint={tr("settings.pages.activityBlockStyleHint")} itemId="chat.activityStyle">
            <Seg
              value={ui.activityBlockStyle}
              options={[
                ["thread", tr("settings.pages.activityStyleThread")],
                ["ledger", tr("settings.pages.activityStyleLedger")],
                ["chip", tr("settings.pages.activityStyleChip")],
                ["margin", tr("settings.pages.activityStyleMargin")],
              ]}
              onChange={(activityBlockStyle) => setUiSettings({ activityBlockStyle })}
            />
          </Row>
        )}
        <Row label={tr("settings.pages.thinkingBlocks")} hint={tr("settings.pages.thinkingBlocksHint")} itemId="chat.thinking">
          <Seg
            value={ui.thinkingDisplayMode}
            options={thinkingOptions}
            onChange={(thinkingDisplayMode) => setUiSettings({ thinkingDisplayMode })}
          />
        </Row>
        <Row
          label={tr("settings.pages.sessionActivityDetails")}
          hint={tr("settings.pages.sessionActivityDetailsHint")}
          itemId="chat.activityDetails"
        >
          <Seg
            value={ui.sessionActivityDetails}
            options={[
              ["tabs", tr("settings.pages.sessionActivityTabs")],
              ["all", tr("settings.pages.sessionActivityAll")],
            ]}
            onChange={(sessionActivityDetails) => setUiSettings({ sessionActivityDetails })}
          />
        </Row>
        <Row label={tr("settings.pages.conversationWidth")} hint={tr("settings.pages.wideUsesMoreOfTheWindowFor")} itemId="chat.width">
          <Seg value={ui.chatWidth} options={[
            ["normal", tr("settings.pages.normal")],
            ["wide", tr("settings.pages.wide")],
          ]} onChange={(v) => setUiSettings({ chatWidth: v })} />
        </Row>
        <Row label={tr("settings.pages.copyFormat")} hint={tr("settings.pages.chooseThePayloadUsedByTheSingle")} itemId="chat.copyFormat">
          <Seg
            value={ui.messageCopyFormat}
            options={[["markdown", tr("common.markdown")], ["json", tr("common.json")]]}
            onChange={(messageCopyFormat) => setUiSettings({ messageCopyFormat })}
          />
        </Row>
      </Section>
      {/* Both roles use one editor so their quick actions configure identically. */}
      <MessageActionsEditor role="user" itemId="chat.messageActions" />
      <MessageActionsEditor role="assistant" itemId="chat.responseActions" />
      <Section title={tr("settings.pages.composerGroup")}>
        <Row label={tr("settings.pages.composerStatusStyle")} hint={tr("settings.pages.composerStatusStyleHint")} itemId="chat.composerStatusStyle">
          <Seg
            value={ui.composerStatusStyle}
            options={[
              ["line", tr("settings.pages.composerStatusLine")],
              ["tab", tr("settings.pages.composerStatusTab")],
              ["capsule", tr("settings.pages.composerStatusCapsule")],
            ]}
            onChange={(composerStatusStyle) => setUiSettings({ composerStatusStyle })}
          />
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
        <Row label={tr("settings.pages.desktopSendShortcut")} hint={tr("settings.pages.sendShortcutHint")} itemId="chat.sendOnEnter">
          <Seg value={settings.desktopSendShortcut} options={[["enter", "Enter"], ["shift-enter", "Shift+Enter"]]} onChange={(desktopSendShortcut) => updateSettings({ desktopSendShortcut, sendOnEnter: desktopSendShortcut === "enter" })} />
        </Row>
        <Row label={tr("settings.pages.mobileSendShortcut")} hint={tr("settings.pages.mobileSendShortcutHint")} itemId="chat.mobileSendShortcut">
          <Seg value={settings.mobileSendShortcut} options={[["none", tr("settings.pages.sendButtonOnly")], ["enter", "Enter"], ["shift-enter", "Shift+Enter"]]} onChange={(mobileSendShortcut) => updateSettings({ mobileSendShortcut })} />
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
          <NumberField
            value={ui.promptHistoryLimit}
            min={1}
            max={200}
            label={tr("settings.pages.promptHistoryLimit")}
            onCommit={(next) => setUiSettings({ promptHistoryLimit: clampPromptHistoryLimit(next, ui.promptHistoryLimit) })}
          />
        </Row>
        <Row label={tr("settings.pages.dictationButton")} hint={tr("settings.pages.dictationButtonHint")} itemId="chat.showDictate">
          <Toggle on={ui.showDictate} onChange={(showDictate) => setUiSettings({ showDictate })} label={tr("settings.pages.dictationButton")} />
        </Row>
        <Row label={tr("settings.pages.composerQuickActions")} hint={tr("settings.pages.composerQuickActionsHint")} itemId="chat.showQuickActions">
          <Toggle on={ui.showQuickActions} onChange={(showQuickActions) => setUiSettings({ showQuickActions })} label={tr("settings.pages.composerQuickActions")} />
        </Row>
      </Section>
      <Section title={tr("settings.pages.promptNavigatorGroup")}>
        <Row label={tr("settings.pages.promptRail")} hint={tr("settings.pages.promptRailHint")} itemId="chat.promptNavigator">
          <Toggle
            on={ui.promptNavigator !== "off"}
            onChange={(on) => setUiSettings({ promptNavigator: on ? "auto" : "off" })}
            label={tr("settings.pages.promptRail")}
          />
        </Row>
        {ui.promptNavigator !== "off" && (
          <Row label={tr("settings.pages.promptRailSide")} hint={tr("settings.pages.promptRailSideHint")} itemId="chat.promptNavigatorSide">
            <Seg value={ui.promptNavigatorSide} options={[
              ["left", tr("settings.pages.promptNavigatorSideLeft")],
              ["right", tr("settings.pages.promptNavigatorSideRight")],
            ]} onChange={(promptNavigatorSide) => setUiSettings({ promptNavigatorSide })} />
          </Row>
        )}
        <Row
          label={tr("settings.pages.promptBookmarkMobile")}
          hint={tr("settings.pages.promptBookmarkMobileHint")}
          itemId="chat.pinLatestPrompt"
        >
          <Toggle
            on={ui.pinLatestPrompt}
            onChange={(pinLatestPrompt) => setUiSettings({ pinLatestPrompt })}
            label={tr("settings.pages.promptBookmarkMobile")}
          />
        </Row>
        <Row
          label={tr("settings.pages.promptBookmarkDesktop")}
          hint={tr("settings.pages.promptBookmarkDesktopHint")}
          itemId="chat.promptBookmarkDesktop"
        >
          <Toggle
            on={ui.promptBookmarkDesktop}
            onChange={(promptBookmarkDesktop) => setUiSettings({ promptBookmarkDesktop })}
            label={tr("settings.pages.promptBookmarkDesktop")}
          />
        </Row>
        {(ui.pinLatestPrompt || ui.promptBookmarkDesktop) && (
          <Row
            label={tr("settings.pages.pinLatestPromptPosition")}
            hint={tr("settings.pages.bookmarkPositionPlainHint")}
            itemId="chat.pinLatestPromptPosition"
          >
            <Button
              size="sm"
              disabled={isPromptBookmarkHome(bookmarkPosition)}
              title={tr("timeline.promptBookmarkMoveHint")}
              onClick={() => writePromptBookmarkPosition(null)}
            >{tr("settings.pages.pinLatestPromptPositionReset")}</Button>
          </Row>
        )}
      </Section>
      <Section title={tr("settings.pages.headerGroup")}>
        <Row
          label={tr("settings.pages.mobileSessionTitle")}
          hint={tr("settings.pages.mobileSessionTitleHint")}
          itemId="chat.mobileSessionTitle"
        >
          <Select
            label={tr("settings.pages.mobileSessionTitle")}
            value={ui.mobileSessionTitle}
            options={[
              { value: "hidden", label: tr("settings.pages.mobileSessionTitleHidden") },
              { value: "title", label: tr("settings.pages.mobileSessionTitleOnly") },
              { value: "button", label: tr("settings.pages.mobileSessionTitleButton") },
            ]}
            onChange={(mobileSessionTitle) => setUiSettings({ mobileSessionTitle: mobileSessionTitle as typeof ui.mobileSessionTitle })}
          />
        </Row>
        <Row label={tr("settings.pages.chatMetrics")} hint={tr("settings.pages.chatMetricsHint")} itemId="chat.headerMetrics">
          <CheckGroup<HeaderMetricId>
            label={tr("settings.pages.chatMetrics")}
            value={ui.headerMetrics}
            options={HEADER_METRIC_IDS.map((id) => ({ id, label: metricLabels[id] }))}
            columns={2}
            onChange={(next) => toggleChecked(ui.headerMetrics, next, HEADER_METRIC_IDS, (headerMetrics) => setUiSettings({ headerMetrics }))}
          />
        </Row>
      </Section>
    </>
  );
}

type NotifyKindId = "completed" | "failed" | "question" | "permission" | "subagent" | "mention" | "message";

// Resolved per render: a module-level tr() would freeze the labels in the
// locale that happened to be loaded when this module was first imported.
const notifyKindLabels = (): Array<[kind: NotifyKindId, label: string]> => [
  ["completed", tr("settings.pages.turnCompleted")],
  ["failed", tr("settings.pages.turnFailed")],
  ["question", tr("settings.pages.agentQuestion")],
  ["permission", tr("settings.pages.permissionRequest")],
  ["subagent", tr("settings.pages.delegatedAgentFinished")],
  ["mention", tr("settings.pages.mention")],
  ["message", tr("settings.pages.personMessage")],
];

export function NotificationsPage() {
  const ui = useUiSettings();
  const [permission, setPermission] = useState(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const granted = permission === "granted";
  const denied = permission === "denied";
  const refreshPermission = () => {
    if (typeof Notification !== "undefined") setPermission(Notification.permission);
  };
  // The browser answers the permission prompt asynchronously; follow the
  // permission itself so the row's hint and Allow button stay truthful.
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let disposed = false;
    void navigator.permissions?.query({ name: "notifications" as PermissionName })
      .then((next) => {
        if (disposed) return;
        status = next;
        status.onchange = refreshPermission;
      })
      .catch(() => undefined);
    window.addEventListener("focus", refreshPermission);
    return () => {
      disposed = true;
      if (status) status.onchange = null;
      window.removeEventListener("focus", refreshPermission);
    };
  }, []);
  const askPermission = () => requestNotifyPermission();
  const toggleKind = (kind: NotifyKindId, on: boolean) => {
    const next = ui.notifyKinds.filter((k) => k !== kind);
    if (on) next.push(kind);
    setUiSettings({ notifyKinds: next });
  };
  const desktopOn = ui.notifyOnComplete;
  const anyLocalAlert = desktopOn || ui.notifySound;
  const desktopHint = denied
    ? tr("settings.pages.notificationsAreBlockedForThisSiteIn")
    : desktopOn && !granted
      ? tr("settings.pages.desktopNotificationNeedsPermission")
      : tr("settings.pages.desktopNotificationPlainHint");
  const templatePreview = renderTemplate(ui.notifyTemplate, {
    project: tr("settings.pages.templateSampleProject"),
    session: tr("settings.pages.templateSampleSession"),
    status: tr("settings.pages.turnCompleted"),
    preview: tr("settings.pages.templateSamplePreview"),
  });
  return (
    <>
      <PageHead title={tr("settings.pages.notifications")} blurb={tr("settings.pages.getToldWhenASessionNeedsYou")} />
      <Section title={tr("settings.pages.alertsGroup")}>
        <Row label={tr("settings.pages.desktopNotification")} hint={desktopHint} itemId="notifications.desktop">
          <div className="settings-inline-controls">
            {desktopOn && !granted && !denied && permission !== "unsupported" && (
              <Button size="sm" onClick={askPermission}>{tr("settings.pages.allowInBrowser")}</Button>
            )}
            <Toggle
              on={desktopOn}
              onChange={(v) => { setUiSettings({ notifyOnComplete: v }); if (v) askPermission(); }}
              label={tr("settings.pages.desktopNotification")}
            />
          </div>
        </Row>
        <Row label={tr("settings.pages.completionSound")} hint={tr("settings.pages.completionSoundPlainHint")} itemId="notifications.sound">
          <Toggle on={ui.notifySound} onChange={(v) => setUiSettings({ notifySound: v })} label={tr("settings.pages.completionSound")} />
        </Row>
        {/* Browser Web Push can never work inside the native app's WebView
            (no service-worker push); the native row owns delivery there. */}
        {nativePushSettingsAvailable() ? <NativePushRow /> : <PushRow />}
      </Section>
      <Section
        title={tr("settings.pages.triggersGroup")}
        hint={anyLocalAlert ? tr("settings.pages.triggersGroupHint") : tr("settings.pages.triggersGroupOffHint")}
      >
        <Row
          label={tr("settings.pages.notifyAbout")}
          layout="stacked"
          disabled={!anyLocalAlert}
          itemId="notifications.kinds"
        >
          <CheckGroup<NotifyKindId>
            label={tr("settings.pages.notifyAbout")}
            value={ui.notifyKinds.filter((kind): kind is NotifyKindId => notifyKindLabels().some(([id]) => id === kind))}
            options={notifyKindLabels().map(([id, label]) => ({ id, label }))}
            columns={2}
            disabled={!anyLocalAlert}
            onChange={(next) => {
              const id = notifyKindLabels().map(([kind]) => kind).find((kind) => ui.notifyKinds.includes(kind) !== next.includes(kind));
              if (id) toggleKind(id, next.includes(id));
            }}
          />
        </Row>
        <Row
          label={tr("settings.pages.onlyInBackground")}
          hint={tr("settings.pages.onlyInBackgroundHint")}
          itemId="notifications.onlyHidden"
          disabled={!desktopOn}
        >
          <Toggle
            on={ui.notifyOnlyWhenHidden}
            disabled={!desktopOn}
            onChange={(v) => setUiSettings({ notifyOnlyWhenHidden: v })}
            label={tr("settings.pages.onlyInBackground")}
          />
        </Row>
      </Section>
      <Section title={tr("settings.pages.notificationTextGroup")}>
        <Row
          label={tr("settings.pages.notificationTitle")}
          hint={tr("settings.pages.notificationTitleHint")}
          itemId="notifications.template"
          disabled={!desktopOn}
        >
          <div className="notification-template">
            <div className="notification-template-input">
              <TextInput
                uiSize="sm"
                className="notification-preview"
                value={ui.notifyTemplate}
                disabled={!desktopOn}
                onChange={(e) => setUiSettings({ notifyTemplate: e.target.value.slice(0, 200) })}
                aria-label={tr("settings.pages.notificationTemplate")}
                aria-describedby="notification-template-sample"
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={!desktopOn || ui.notifyTemplate === DEFAULT_NOTIFY_TEMPLATE}
                onClick={() => setUiSettings({ notifyTemplate: DEFAULT_NOTIFY_TEMPLATE })}
              >{tr("settings.parts.reset")}</Button>
            </div>
            <div className="notification-template-sample" id="notification-template-sample">
              <span>{tr("settings.pages.templateExample")}</span> {templatePreview}
            </div>
          </div>
        </Row>
        <Row
          label={tr("settings.pages.keepReadNotifications")}
          hint={tr("settings.pages.keepReadNotificationsHint")}
          itemId="notifications.centreHistory"
        >
          <Toggle
            on={ui.notificationCentreHistory}
            onChange={(v) => setUiSettings({ notificationCentreHistory: v })}
            label={tr("settings.pages.keepReadNotifications")}
          />
        </Row>
      </Section>
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
    ? tr("settings.pages.nativePushDenied")
    : status === "unavailable"
      ? tr("settings.pages.nativePushUnavailable")
      : tr("settings.pages.nativePushHint");
  const toggle = (next: boolean) => {
    if (busy) return;
    setBusy(true); setError("");
    void (next ? enableNativePushForCurrentAccount() : disableNativePushForCurrentAccount())
      .then((result) => setStatus(result.state))
      .catch((cause) => { setStatus("disabled"); setError(cause instanceof Error ? cause.message : tr("settings.pages.nativePushUpdateFailed")); })
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Row label={tr("settings.pages.mobilePushNotifications")} hint={hint} itemId="notifications.mobilePush">
        {status === "unavailable" || status === "denied"
          ? <span className="tag">{tr("settings.pages.unavailable")}</span>
          : <Button size="sm" busy={busy} onClick={() => toggle(!enabled)}>{enabled ? tr("settings.pages.disable") : tr("settings.pages.enable")}</Button>}
      </Row>
      {error && <div className="form-error settings-row-error" role="alert">{error}</div>}
    </>
  );
}

/** Web push toggle — notifications keep arriving after the tab closes.
 *  Subscription state lives in the browser's push manager, not localStorage. */
function PushRow() {
  const unsupported = pushUnsupportedReason();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tested, setTested] = useState("");
  useEffect(() => {
    if (unsupported) return;
    void reconcilePushSubscription()
      .then(setOn)
      .catch((cause) => {
        setOn(false);
        setErr(cause instanceof Error ? cause.message : String(cause));
      });
  }, [unsupported]);

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
              setErr("");
              void sendTestPush().then((r) => setTested(describePushTest(r)))
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
  const [state, setState] = useState<"loading" | "ready" | "saving" | "saved" | "conflict" | "error">("loading");
  const [error, setError] = useState<unknown>(null);

  const load = async () => {
    try {
      const r = await api.behaviorGet();
      setText(r.text);
      setRevision(r.revision);
      setPathLabel(r.pathLabel);
      setDirty(false);
      setState("ready");
      setError(null);
    } catch (e) {
      setState("error");
      setError(e);
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    setState("saving");
    try {
      const r = await api.behaviorPut(text, revision);
      setRevision(r.revision);
      setDirty(false);
      setState("saved");
      setError(null);
    } catch (e) {
      const status = (e as { status?: number }).status;
      setState(status === 409 ? "conflict" : "error");
      setError(e);
    }
  };

  return (
    <div className="behavior-editor" data-settings-item="behavior.instructions">
      <Row
        layout="stacked"
        label={tr("settings.pages.globalInstructions")}
        hint={tr("settings.pages.instructionsHint", { path: pathLabel || "…" })}
      >
        <Textarea
          rows={7}
          value={text}
          placeholder={tr("settings.pages.instructionsAppliedToEveryAgentTurnE")}
          onChange={(e) => { setText(e.target.value); setDirty(true); if (state === "saved") setState("ready"); }}
          disabled={state === "loading" || state === "saving"}
          aria-label={tr("settings.pages.globalBehaviorInstructions")}
        />
      </Row>
      {state === "conflict" && (
        <div className="revision-conflict" role="alert">
          <span>{tr("settings.pages.changedElsewhereSinceYouLoadedIt")}</span>
          <Button size="sm" onClick={() => void load()}>{tr("settings.pages.reloadLatest")}</Button>
        </div>
      )}
      {state === "error" && error !== null && (
        <ErrorState compact error={error} onRetry={dirty ? () => void save() : () => void load()} />
      )}
      <SaveBar
        dirty={dirty}
        saving={state === "saving"}
        status={state === "saved" ? "saved" : "idle"}
        onSave={() => void save()}
        saveLabel={tr("settings.pages.saveApply")}
      />
    </div>
  );
}

export function BehaviorPage() {
  const ui = useUiSettings();
  const commandsEnabled = useSyncExternalStore(subscribePackages, () => isPackageEnabled("commands"));
  const [favoriteSubagents, setFavoriteSubagents] = useState(true);
  const [savingFavoriteSubagents, setSavingFavoriteSubagents] = useState(false);
  const [workspaceInstructions, setWorkspaceInstructions] = useState(false);
  const [savingWorkspaceInstructions, setSavingWorkspaceInstructions] = useState(false);
  useEffect(() => {
    void api.subagentPolicyGet()
      .then((policy) => setFavoriteSubagents(policy.enabled))
      .catch((error) => setUiError(friendlyError(tr("settings.pages.loadSubagentPolicyFailed"), error)));
  }, []);
  useEffect(() => {
    void api.workspaceInstructionsPolicyGet()
      .then((policy) => setWorkspaceInstructions(policy.enabled))
      .catch((error) => setUiError(friendlyError(tr("settings.pages.loadWorkspaceInstructionsFailed"), error)));
  }, []);
  // Policy toggles flip at once; a rejection restores the previous value.
  const changeFavoriteSubagents = async (enabled: boolean) => {
    if (savingFavoriteSubagents) return;
    setSavingFavoriteSubagents(true);
    setFavoriteSubagents(enabled);
    try {
      const policy = await api.subagentPolicyPut(enabled);
      setFavoriteSubagents(policy.enabled);
    } catch (error) {
      setFavoriteSubagents(!enabled);
      setUiError(friendlyError(tr("settings.pages.saveSubagentPolicyFailed"), error));
    } finally {
      setSavingFavoriteSubagents(false);
    }
  };
  const changeWorkspaceInstructions = async (enabled: boolean) => {
    if (savingWorkspaceInstructions) return;
    setSavingWorkspaceInstructions(true);
    setWorkspaceInstructions(enabled);
    try {
      const policy = await api.workspaceInstructionsPolicyPut(enabled);
      setWorkspaceInstructions(policy.enabled);
    } catch (error) {
      setWorkspaceInstructions(!enabled);
      setUiError(friendlyError(tr("settings.pages.saveWorkspaceInstructionsFailed"), error));
    } finally {
      setSavingWorkspaceInstructions(false);
    }
  };
  return (
    <>
      <PageHead title={tr("settings.pages.behavior")} blurb={tr("settings.pages.workspaceSafetyFlowAndGlobalAgentInstructions")} />
      <Section title={tr("settings.pages.sectionSessions")}>
        <Row label={tr("settings.pages.confirmBeforeArchivingSessions")} hint={tr("settings.pages.askBeforeASessionIsMovedTo")} itemId="behavior.confirmArchive">
          <Toggle on={ui.confirmSessionArchive} onChange={(v) => setUiSettings({ confirmSessionArchive: v })} label={tr("settings.pages.confirmArchive")} />
        </Row>
      </Section>
      <Section title={tr("settings.pages.sectionAgents")}>
        <Row label={tr("settings.pages.favoriteSubagents")} hint={tr("settings.pages.favoriteSubagentsHint")} itemId="behavior.favoriteSubagents">
          <Toggle
            on={favoriteSubagents}
            disabled={savingFavoriteSubagents}
            onChange={(value) => void changeFavoriteSubagents(value)}
            label={tr("settings.pages.favoriteSubagents")}
          />
        </Row>
        <Row
          label={tr("settings.pages.workspaceInstructions")}
          hint={tr("settings.pages.workspaceInstructionsHint")}
          itemId="behavior.workspaceInstructions"
        >
          <Toggle
            on={workspaceInstructions}
            disabled={savingWorkspaceInstructions}
            onChange={(value) => void changeWorkspaceInstructions(value)}
            label={tr("settings.pages.workspaceInstructions")}
          />
        </Row>
        {commandsEnabled && (
          <Row label={tr("settings.pages.slashCommandsSnippets")} hint={tr("settings.pages.commandsHint")}>
            <Button size="sm" variant="quiet" onClick={() => openSettingsPage("commands")}>{tr("settings.pages.openCommands")}</Button>
          </Row>
        )}
      </Section>
      <Section title={tr("settings.pages.sectionInstructions")}>
        <BehaviorInstructionsEditor />
      </Section>
      <Section title={tr("settings.pages.sectionEditor")}>
        <Row label={tr("settings.pages.editorAutosave")} hint={tr("settings.pages.savesEditsAfterAShortPauseRevision")} itemId="behavior.autosave">
          <Toggle on={ui.editorAutosave} onChange={(v) => setUiSettings({ editorAutosave: v })} label={tr("settings.pages.editorAutosave")} />
        </Row>
      </Section>
      <Section title={tr("settings.pages.sectionPackageWindows")}>
        <Row label={tr("settings.pages.sharedPinnedWindow")} hint={tr("settings.pages.sharedPinnedWindowHint")} itemId="behavior.sharedPinnedWindow">
          <Toggle on={ui.sharedPinnedWindow} onChange={(v) => setUiSettings({ sharedPinnedWindow: v })} label={tr("settings.pages.sharedPinnedWindow")} />
        </Row>
      </Section>
    </>
  );
}

/** Canvas is a per-project opt-in, so this reads the selected project rather
 * than whichever project is currently open. */
function ProjectCanvasToggle({ projectId }: { projectId: string }) {
  const enabled = useSyncExternalStore(
    subscribeWorkspaceCanvasEnabled,
    () => workspaceCanvasEnabledForProject(projectId),
  );
  const label = tr("settings.pages.projectCanvasHint");
  return (
    <Toggle
      on={enabled}
      onChange={(next) => setWorkspaceCanvasEnabledForProject(projectId, next)}
      label={label}
    />
  );
}

/** Optional package views (the Tasks tab) are per-project opt-ins too. */
function ProjectProfileToggle({ projectId, profileId, label }: { projectId: string; profileId: string; label: string }) {
  const enabled = useSyncExternalStore(
    subscribeWorkbenchProfileOffers,
    () => workbenchProfileOfferedForProject(profileId, projectId),
  );
  return (
    <Toggle
      on={enabled}
      onChange={(next) => setWorkbenchProfileOfferedForProject(profileId, projectId, next)}
      label={tr("settings.pages.projectProfileTabHint", { label })}
    />
  );
}

function ProjectProfileRows({ projectId }: { projectId: string }) {
  const optional = useOptionalWorkbenchProfiles();
  return (
    <>
      {optional.map(({ profile }) => (
        <Row
          key={profile.id}
          label={tr("settings.pages.projectProfileTab", { label: profile.label })}
          hint={tr("settings.pages.projectProfileTabHint", { label: profile.label })}
          itemId={`projects.profile.${profile.id}`}
        >
          <ProjectProfileToggle projectId={projectId} profileId={profile.id} label={profile.label} />
        </Row>
      ))}
    </>
  );
}

/** One interface for every project, or one per project. Personal: it picks
 * which arrangement this account sees and never rewrites a project's record. */
function ProjectInterfaceSection({ activeProject }: { activeProject: Project | undefined }) {
  const mode = useProjectInterfaceMode();
  const spaceId = useSpaces().activeSpaceId ?? "";
  const activeId = activeProject?.id ?? null;
  // Phone composer buttons live in their own map (mobileRail), not in the
  // presentation records, so they are carried across here.
  const copyRail = (projectId: string, onlyIfEmpty: boolean) => {
    const source = readMobileRail(mobileRailScopeKey(spaceId, projectId));
    const target = mobileRailScopeKey(spaceId, SHARED_PRESENTATION_SCOPE);
    if (source === null || (onlyIfEmpty && readMobileRail(target) !== null)) return;
    writeMobileRail(target, parseMobileRail(source));
  };
  const choose = (next: ProjectInterfaceMode) => {
    if (next === "shared" && activeId !== null) copyRail(activeId, true);
    chooseProjectInterface(next, activeId);
  };
  const copyCurrent = () => {
    if (activeId === null) return;
    copyRail(activeId, false);
    copyProjectPresentationToShared(activeId);
  };
  return (
    <Section title={tr("projectcomposition.interfaceTitle")} hint={tr("projectcomposition.interfaceHint")} itemId="projects.interface">
      <Row
        label={tr("projectcomposition.interfaceMode")}
        hint={mode === "shared" ? tr("projectcomposition.interfaceSharedHint") : tr("projectcomposition.interfacePerProjectHint")}
      >
        <Seg
          label={tr("projectcomposition.interfaceMode")}
          value={mode}
          options={[
            ["shared", tr("projectcomposition.interfaceShared")],
            ["per-project", tr("projectcomposition.interfacePerProject")],
          ]}
          onChange={choose}
        />
      </Row>
      {mode === "shared" && activeProject && (
        <Row
          label={tr("projectcomposition.interfaceCopyCurrent", { project: activeProject.name || activeProject.path })}
          hint={tr("projectcomposition.interfaceCopyCurrentHint")}
        >
          <Button size="sm" variant="quiet" onClick={copyCurrent}>{tr("common.apply")}</Button>
        </Row>
      )}
    </Section>
  );
}

export function ProjectsPage() {
  const registryProjects = useStore((s) => s.projectRegistry.projects);
  const sessions = useStore((s) => s.sessions);
  // The picker is a project list like any other: it follows the same stored sort
  // and manual order as the sidebar, or a project sits in one place here and
  // another there and the saved order looks lost.
  const latestProjectActivity = useCallback((projectId: string) => sessions.reduce(
    (value, session) => session.projectId === projectId
      ? Math.max(value, session.lastTurnAt ?? session.createdAt)
      : value,
    0,
  ), [sessions]);
  const projects = useOrderedProjects(registryProjects, latestProjectActivity);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const interfaceMode = useProjectInterfaceMode();
  const models = useStore((s) => s.models).filter(modelSupportsTextWorkflow);
  const sessionDefaults = useSessionDefaults();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [harnesses, setHarnesses] = useState<HarnessSnapshot[]>([]);
  const [picking, setPicking] = useState(false);
  const selectedProject = projects.find((project) => project.id === selectedProjectId)
    ?? projects.find((project) => project.id === activeProjectId)
    ?? projects[0];
  const selectedHarnessId = selectedProject?.defaults?.harness?.mode === "pinned"
    ? selectedProject.defaults.harness.harnessId
    : undefined;
  const remembersSelectedModel = projectRemembersModelSelection(selectedProject?.defaults);
  const selectedProjectModel = remembersSelectedModel && selectedProject?.defaults?.model
    ? {
        ...selectedProject.defaults.model,
        ...(selectedHarnessId ? { harnessId: selectedHarnessId } : {}),
      }
    : undefined;
  const globalModel = resolveSessionDefaultModel(null, sessionDefaults.defaultModel, models[0]);
  const globalModelName = globalModel
    ? models.find((model) =>
        model.providerID === globalModel.providerID && model.modelID === globalModel.modelID
        && (!globalModel.harnessId || model.harnessId === globalModel.harnessId))?.name
      ?? globalModel.modelID
    : tr("settings.pages.noModelAvailable");

  useEffect(() => {
    let cancelled = false;
    setHarnesses([]);
    if (!selectedProject) return;
    void api.harnessSnapshots(selectedProject.id)
      .then((snapshots) => { if (!cancelled) setHarnesses(snapshots); })
      .catch((error) => {
        if (!cancelled) setUiError(friendlyError(tr("settings.pages.loadHarnessesFailed"), error));
      });
    return () => { cancelled = true; };
  }, [selectedProject?.id]);

  // Project defaults are optimistic: the control moves at once and a
  // rejection restores it with the usual notice (saveProjectDefaultsOptimistic).
  const saveDefaults = async (projectId: string, defaults: ProjectDefaults, failure: string) => {
    try {
      await saveProjectDefaultsOptimistic(projectId, defaults);
    } catch (error) {
      setUiError(friendlyError(failure, error));
    }
  };
  const saveHarness = (projectId: string, harness: HarnessSelection | null) =>
    saveDefaults(projectId, { harness }, tr("settings.pages.saveHarnessFailed"));
  const saveModel = async (projectId: string, model?: ModelRef & { harnessId?: string }) => {
    if (!model) return;
    await saveDefaults(projectId, {
      rememberModelSelection: true,
      model: { providerID: model.providerID, modelID: model.modelID },
      ...(model.harnessId ? { harness: { mode: "pinned", harnessId: model.harnessId } as const } : {}),
    }, tr("settings.pages.saveModelFailed"));
  };
  const saveIsolation = (projectId: string, defaults: Pick<ProjectDefaults, "isolation" | "isolateByDefault">) =>
    saveDefaults(projectId, defaults, tr("settings.pages.saveIsolationFailed"));
  const setModelMemory = (projectId: string, enabled: boolean) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    return saveDefaults(projectId, enabled
      ? { rememberModelSelection: true, model: project?.defaults?.model ?? globalModel ?? null }
      : { rememberModelSelection: false }, tr("settings.pages.modelMemoryFailed"));
  };

  return (
    <div className="projects-settings-page">
      <ProjectInterfaceSection activeProject={projects.find((project) => project.id === activeProjectId)} />
      <div className="projects-settings-picker">
        {selectedProject && (
          <ProjectPicker
            className="project-selector"
            label={tr("settings.pages.projects")}
            ariaLabel={`${tr("settings.pages.projects")}: ${selectedProject.name || selectedProject.path}`}
            projects={projects}
            value={selectedProject.id}
            itemDetail={(project) => project.id === activeProjectId
              ? `${project.path} · ${tr("settings.pages.active")}`
              : project.path}
            onPick={setSelectedProjectId}
          />
        )}
        <Button size="sm" variant="quiet" iconStart={PlusIcon} onClick={() => setPicking(true)}>{tr("settings.pages.addProject")}</Button>
      </div>
      {selectedProject ? (
        <>
          <p className="projects-settings-path" title={selectedProject.path}>
            <bdi className="mono">{selectedProject.path}</bdi>
          </p>

          <Section title={tr("projectappearancedialog.projectAppearance")} itemId="projects.appearance">
            <ProjectAppearanceDialogCore key={selectedProject.id} project={selectedProject} inline />
          </Section>

          {/* Canvas ships off. A project turns it on here or from the header
              menu; nothing enables it implicitly. */}
          <Section
            title={tr("settings.pages.sectionWorkspace")}
            {...(interfaceMode === "shared" ? { hint: tr("projectcomposition.interfaceSharedNote") } : {})}
          >
            <Row label={tr("settings.pages.projectCanvas")} hint={tr("settings.pages.projectCanvasHint")} itemId="projects.canvas">
              <ProjectCanvasToggle projectId={selectedProject.id} />
            </Row>
            <ProjectProfileRows projectId={selectedProject.id} />
          </Section>

          <Section title={tr("settings.pages.newSession")}>
            <Row label={tr("settings.pages.defaultHarness")} hint={tr("settings.pages.overridesTheGlobalDefaultForNewSessions")} itemId="projects.executionHarness">
              <Select
                label={tr("settings.pages.defaultHarness")}
                ariaLabel={tr("settings.pages.defaultHarnessFor", { project: selectedProject.name || selectedProject.path })}
                value={selectedProject.defaults?.harness === null || selectedProject.defaults?.harness === undefined
                  ? "inherit"
                  : selectedProject.defaults.harness.mode === "auto" ? "auto" : selectedProject.defaults.harness.harnessId}
                options={[
                  { value: "inherit", label: tr("settings.pages.inheritGlobalDefault") },
                  { value: "auto", label: tr("settings.pages.auto") },
                  ...harnesses.map((snapshot) => ({
                    value: snapshot.identity.id,
                    label: snapshot.identity.name,
                    detail: snapshot.availability.state === "ready" ? tr("settings.pages.ready") : tr("settings.pages.setupMayBeRequired"),
                  })),
                ]}
                onChange={(value) => void saveHarness(
                  selectedProject.id,
                  value === "inherit" ? null : value === "auto" ? { mode: "auto" } : { mode: "pinned", harnessId: value },
                )}
              />
            </Row>
            <Row
              label={tr("settings.pages.defaultModel")}
              hint={remembersSelectedModel
                ? tr("settings.pages.updatedWheneverYouChooseAModel")
                : tr("settings.pages.offNewSessionsUseValue", { model: globalModelName })}
              itemId="projects.defaultModel"
            >
              <ModelPicker
                direction="down"
                className="project-default-model-picker"
                models={models}
                harnessId={selectedHarnessId}
                value={selectedProjectModel}
                recommended={globalModel}
                onPick={(model) => void saveModel(selectedProject.id, model)}
              />
              {remembersSelectedModel && (
                <Button size="sm" variant="ghost" onClick={() => void setModelMemory(selectedProject.id, false)}>
                  {tr("settings.registry.globalDefaultModel")}
                </Button>
              )}
            </Row>
            <Row label={tr("settings.pages.rememberModelSelection")} hint={tr("settings.pages.rememberModelHint")} itemId="projects.modelMemory">
              <Toggle
                on={remembersSelectedModel}
                onChange={(enabled) => void setModelMemory(selectedProject.id, enabled)}
                label={tr("settings.pages.rememberModelSelectionForValue", { project: selectedProject.name || selectedProject.path })}
              />
            </Row>
          </Section>

          {/* Isolation ships off: until a project opts in, no isolation
              control appears anywhere. A virtualized environment is the
              planned second level and is shown but not selectable yet. */}
          <Section title={tr("settings.pages.sectionIsolation")}>
            <Row label={tr("settings.pages.isolationLevel")} hint={tr("settings.pages.isolationLevelHint")} itemId="projects.isolation">
              <Seg
                label={tr("settings.pages.isolationLevel")}
                value={projectIsolationLevel(selectedProject.defaults)}
                options={[
                  ["off", tr("settings.pages.isolationOff")],
                  ["workspace", tr("settings.pages.isolationWorkspace")],
                ]}
                onChange={(isolation) => void saveIsolation(selectedProject.id, { isolation })}
              />
            </Row>
            {projectIsolationLevel(selectedProject.defaults) === "workspace" && (
              <Row label={tr("settings.pages.isolateByDefault")} hint={tr("settings.pages.isolateByDefaultHint")} itemId="projects.isolateByDefault">
                <Toggle
                  on={projectIsolatesByDefault(selectedProject.defaults)}
                  onChange={(isolateByDefault) => void saveIsolation(selectedProject.id, { isolateByDefault })}
                  label={tr("settings.pages.isolateByDefault")}
                />
              </Row>
            )}
            <Row label={tr("settings.pages.isolationEnvironment")} hint={tr("settings.pages.isolationEnvironmentHint")}>
              <Badge>{tr("settings.pages.isolationLater")}</Badge>
            </Row>
          </Section>

          <Section title={tr("settings.pages.sectionDanger")} tone="danger">
            <Row label={tr("settings.pages.removeProjectButton")} hint={tr("settings.pages.removeProjectHint")}>
              <Button
                size="sm"
                variant="danger"
                onClick={() => { void confirmAlert(tr("settings.pages.removeProjectValueFromPolyth", { value: selectedProject.name || selectedProject.path }), { title: tr("settings.pages.removeProject"), confirmLabel: tr("common.remove") }).then((ok) => { if (ok) void removeProject(selectedProject.id).catch((e) => setUiError(friendlyError(tr("common.error"), e))); }); }}
              >{tr("common.remove")}</Button>
            </Row>
          </Section>
        </>
      ) : (
        <EmptyState
          title={tr("settings.pages.noActiveProject")}
          body={tr("sidebar.chooseAProjectPathToStart")}
          action={{ label: tr("settings.pages.addProject"), onClick: () => setPicking(true) }}
        />
      )}
      {picking && <ProjectFolderDialog onClose={() => setPicking(false)} />}
    </div>
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

/** Paste an mcpServers JSON block, preview the mapped entries, then save. */
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

function mcpStatusBadge(status: McpServerDto["status"]): { label: string; tone: "neutral" | "success" | "danger" } {
  if (status === "connected") return { label: tr("settings.pages.mcpStatusConnected"), tone: "success" };
  if (status === "error") return { label: tr("settings.pages.mcpStatusError"), tone: "danger" };
  if (status === "disabled") return { label: tr("settings.pages.mcpStatusDisabled"), tone: "neutral" };
  return { label: tr("settings.pages.mcpStatusStarting"), tone: "neutral" };
}

export function McpPage({ embedded = false }: { embedded?: boolean }) {
  const [servers, setServers] = useState<McpServerDto[]>([]);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});
  const [probing, setProbing] = useState<string | null>(null);
  const refresh = () => void api.mcpList().then(setServers);
  useEffect(() => { refresh(); }, []);

  const probe = async (s: McpServerDto) => {
    setProbing(s.id);
    const r = await api.mcpProbe(s.id).catch((e) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
    setProbing(null);
    setTestMsg((m) => ({ ...m, [s.id]: `${r.ok ? "✓" : "✗"} ${r.message}` }));
    refresh();
  };
  // Enable and remove reflect at once; a rejection restores the row (at its
  // place) and reports, then the list is re-read. Each request is sent once.
  const setServerEnabled = (s: McpServerDto, enabled: boolean) => {
    setServers((current) => current.map((item) => item.id === s.id ? { ...item, enabled } : item));
    void api.mcpUpdate(s.id, { enabled }, s.revision)
      .catch((error) => {
        setServers((current) => current.map((item) => item.id === s.id ? { ...item, enabled: s.enabled } : item));
        setUiError(friendlyError(tr("common.error"), error));
      })
      .finally(refresh);
  };
  const removeServer = (s: McpServerDto) => {
    const index = servers.findIndex((item) => item.id === s.id);
    setServers((current) => current.filter((item) => item.id !== s.id));
    void api.mcpRemove(s.id)
      .catch((error) => {
        setServers((current) => current.some((item) => item.id === s.id)
          ? current
          : [...current.slice(0, index), s, ...current.slice(index)]);
        setUiError(friendlyError(tr("common.error"), error));
      })
      .finally(refresh);
  };

  return (
    <div className="mcp-page">
      {!embedded && <PageHead title={tr("settings.pages.mcp")} blurb={tr("settings.pages.modelContextProtocolServersAppliedToThe")} />}
      {embedded && <p className="mcp-page-intro">{tr("settings.pages.mcpEmbeddedHint")}</p>}
      <div className="mcp-list" data-settings-item="mcp.servers">
        {servers.length === 0 && !adding && (
          <EmptyState
            compact={embedded}
            icon="server"
            title={tr("settings.pages.noMcpServersConfigured")}
            body={tr("settings.pages.addAStdioOrHttpServerThe")}
          />
        )}
        {servers.map((s) => {
          const status = mcpStatusBadge(s.enabled ? s.status : "disabled");
          return editingId === s.id ? (
            <McpServerForm key={s.id} existing={s} onDone={() => { setEditingId(null); refresh(); }} />
          ) : (
            <div key={s.id} className="set-row mcp-server-row">
              <div className="set-row-text">
                <div className="set-row-label mcp-server-title">
                  <span>{s.name}</span>
                  <Badge tone={status.tone} dot>{status.label}</Badge>
                </div>
                <div className="set-row-hint mono mcp-server-transport">
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
                <Button size="sm" variant="quiet" busy={probing === s.id} title={tr("settings.pages.mcpCheckHint")} onClick={() => void probe(s)}>
                  {tr("settings.pages.mcpCheck")}
                </Button>
                <IconButton icon={EditIcon} size="sm" variant="ghost" label={tr("settings.pages.mcpEditServer", { name: s.name })} onClick={() => setEditingId(s.id)} />
                <IconButton
                  icon={DeleteIcon}
                  size="sm"
                  variant="ghost"
                  label={tr("settings.pages.mcpRemoveServer", { name: s.name })}
                  onClick={() => { void confirmAlert(tr("settings.pages.removeMcpServerValue", { name: s.name }), { title: tr("settings.pages.removeMcpServer"), confirmLabel: tr("common.remove") }).then((ok) => { if (ok) removeServer(s); }); }}
                />
                <Toggle
                  on={s.enabled}
                  onChange={(enabled) => setServerEnabled(s, enabled)}
                  label={tr("settings.pages.mcpEnableServer", { name: s.name })}
                />
              </div>
            </div>
          );
        })}
      </div>
      {adding && <McpServerForm onDone={() => { setAdding(false); refresh(); }} />}
      {importing && <McpImportForm existingNames={servers.map((s) => s.name)} onDone={() => { setImporting(false); refresh(); }} />}
      {!adding && !importing && (
        <div className="mcp-page-actions">
          <Button size="sm" iconStart={PlusIcon} onClick={() => setAdding(true)}>{tr("settings.pages.mcpAddServer")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>{tr("settings.pages.importJson2")}</Button>
        </div>
      )}
    </div>
  );
}

export function AboutPage() {
  const [info, setInfo] = useState<SystemInfoDto | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  const [release, setRelease] = useState<ReleaseDownloadsDto | null>(null);
  const desktop = desktopBridge() !== undefined;
  useEffect(() => {
    void api.systemInfo().then(setInfo).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    if (desktop) return;
    void api.releaseDownloads().then(setRelease).catch(() => setRelease(null));
  }, [desktop]);
  const [copyBlocked, setCopyBlocked] = useState(false);
  const copy = (label: string, value: string) => {
    setCopyBlocked(false);
    void navigator.clipboard?.writeText(value).then(
      () => { setCopied(label); window.setTimeout(() => setCopied(""), 1500); },
      () => setCopyBlocked(true),
    );
  };
  const copyButton = (label: string, value: string) => (
    <Button size="sm" onClick={() => copy(label, value)}>
      {copied === label ? tr("settings.pages.copiedShort") : tr("common.copy")}
    </Button>
  );
  if (err) return <><PageHead title={tr("settings.pages.about")} /><EmptyState title={tr("settings.pages.serverUnreachable")} body={err} /></>;
  if (!info) return <><PageHead title={tr("settings.pages.about")} /><EmptyState title={tr("common.loading")} busy /></>;
  return (
    <>
      <PageHead title={tr("settings.pages.about")} blurb={tr("settings.pages.connectionDetailsForThisPolythServer")} />
      <div data-settings-item="about.info">
        <Row label={tr("settings.pages.version")}><span className="mono">{info.version}</span></Row>
        {release?.release && release.release.downloads.length > 0 && (
          <Row
            label={tr("settings.pages.downloadApp")}
            hint={tr("settings.pages.downloadAppHint", { version: release.release.version })}
            layout="stacked"
          >
            <span className="about-downloads">
              {release.release.downloads.map((download) => (
                <a
                  key={`${download.platform}-${download.arch ?? ""}`}
                  className="tag mono"
                  href={download.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >{download.label}</a>
              ))}
              <a
                className="tag mono"
                href={release.release.releaseUrl}
                target="_blank"
                rel="noreferrer noopener"
              >{tr("settings.pages.allReleases")}</a>
            </span>
          </Row>
        )}
        <Row label={tr("settings.pages.applicationUrl")} hint={tr("settings.pages.theConfiguredLocalAddressNeverDerivedFrom")}>
          <span className="mono">{info.applicationUrl}</span>
          {copyButton("url", info.applicationUrl)}
        </Row>
        <Row label={tr("settings.pages.publicUrl")} hint={tr("settings.pages.publicUrlHint")}>
          {info.tunnelUrl
            ? <><span className="mono">{info.tunnelUrl}</span>{copyButton("public", info.tunnelUrl)}</>
            : <span className="tag">{tr("settings.pages.publicUrlNone")}</span>}
        </Row>
        <Row label={tr("settings.pages.dataDirectory")}><span className="mono">{info.dataDirLabel}</span></Row>
        <Row label={tr("settings.pages.capabilities")} hint={tr("settings.pages.capabilitiesCount", { count: String(info.capabilities.length) })} layout="stacked">
          <span className="about-capabilities">
            {info.capabilities.map((capability) => <span key={capability} className="tag mono">{capability}</span>)}
          </span>
        </Row>
        {copyBlocked && <div className="muted" role="status">{tr("settings.pages.copyBlocked")}</div>}
      </div>
    </>
  );
}
