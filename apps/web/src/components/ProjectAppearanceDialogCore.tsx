import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import type { Project } from "@polyth/contracts";
import { saveProjectAppearanceOptimistic } from "../init.ts";
import { tr, type TranslationKey } from "../i18n/index.ts";
import { useShellMode } from "../responsiveShell.ts";
import { friendlyError } from "../settings.ts";
import { setUiError } from "../store.ts";
import {
  getProjectIconPrefs,
  setProjectIconPrefs,
  subscribeProjectIconPrefs,
} from "../projectIconPrefs.ts";
import {
  embeddedIconifyName,
  filterProjectIcons,
  filterSupportedIconifyNames,
  iconifyProjectIconName,
  iconifyProjectIconValue,
  isProjectIconRef,
  persistProjectIcon,
  PROJECT_ICON_LIBRARIES,
  projectIconCategoryQuery,
  projectIconLabel,
  projectIconProviderLabel,
  rankSuggestedProjectIcons,
  storedProjectIconSelection,
  toggleFavoriteProjectIcon,
  updateRecentProjectIcons,
  type ProjectIconCategory,
  type ProjectIconLibrary,
} from "../projectIconPicker.ts";
import {
  loadProjectIconSvg,
  prefetchProjectIconSvgs,
  projectIconMaskBlobUrl,
  revokeProjectIconMaskBlobUrls,
  searchProjectIcons,
} from "../projectIconLoader.ts";
import { ProjectIconBody } from "./ProjectGlyph.tsx";
import {
  isProjectIconBundledPath,
  isProjectIconRasterDataUrl,
  isProjectIconSvgDataUrl,
  projectIconMaskStyle,
} from "../projectIconGlyph.ts";
import CopyButton from "./CopyButton.tsx";
import { SaveBar } from "./settings/parts.tsx";
import Picker from "./Picker.tsx";
import {
  AssistIcon,
  BackIcon,
  Button,
  CloseIcon,
  Dialog,
  Switch,
  FavoriteIcon,
  FilterIcon,
  Icon,
  IconButton,
  MoreIcon,
  SearchIcon,
  TextInput,
  UploadIcon,
} from "./ui/index.ts";
import "./ProjectAppearanceDialog.css";

const DEFAULT_COLOR = "#b4532a";
const MAX_ICON_BYTES = 512 * 1024;
const PROJECT_ICON_PREFIX = "/assets/project-icons/";
const COLORS = ["#b4532a", "#f0a6ad", "#de5962", "#f28c38", "#eab83a", "#65b955", "#43b7a6", "#3f7de8", "#7253e8", "#d85cbe", "#858585", "#7b8495"] as const;
const CATEGORIES: readonly { id: ProjectIconCategory; label: TranslationKey }[] = [
  { id: "suggested", label: "projectappearancedialog.categorySuggested" }, { id: "recent", label: "projectappearancedialog.categoryRecent" },
  { id: "favorites", label: "projectappearancedialog.categoryFavorites" }, { id: "tech", label: "projectappearancedialog.categoryTech" },
  { id: "work", label: "projectappearancedialog.categoryWork" }, { id: "creative", label: "projectappearancedialog.categoryCreative" },
  { id: "development", label: "projectappearancedialog.categoryDevelopment" }, { id: "security", label: "projectappearancedialog.categorySecurity" },
  { id: "media", label: "projectappearancedialog.categoryMedia" }, { id: "home", label: "projectappearancedialog.categoryHome" },
];
const MORE_CATEGORIES: readonly { id: ProjectIconCategory; label: TranslationKey }[] = [
  { id: "ai", label: "projectappearancedialog.categoryAi" }, { id: "data", label: "projectappearancedialog.categoryData" },
  { id: "cloud", label: "projectappearancedialog.categoryCloud" }, { id: "science", label: "projectappearancedialog.categoryScience" },
  { id: "tools", label: "projectappearancedialog.categoryTools" },
];

const bundledValue = (name: string): string => `${PROJECT_ICON_PREFIX}${encodeURIComponent(name)}`;
const bundledName = (value: string): string => {
  if (!value.startsWith(PROJECT_ICON_PREFIX)) return "";
  try { return decodeURIComponent(value.slice(PROJECT_ICON_PREFIX.length)); } catch { return value.slice(PROJECT_ICON_PREFIX.length); }
};
const uploadedIcon = (value: string): boolean => value.startsWith("data:image/") || isProjectIconRef(value);
// "" hides the hero greeting, null restores the built-in line.
const greetingPatch = (shown: boolean, text: string): string | null => shown ? (text.trim() || null) : "";

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(tr("projectappearancedialog.couldnTReadThatIcon")));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(tr("projectappearancedialog.couldnTReadThatIcon")));
    reader.readAsDataURL(file);
  });
}
function useIconMask(value: string): string {
  const bundled = value.startsWith(PROJECT_ICON_PREFIX) ? value : "";
  const remoteName = iconifyProjectIconName(value) ?? embeddedIconifyName(value);
  const [mask, setMask] = useState(bundled);

  useEffect(() => {
    if (uploadedIcon(value)) { setMask(""); return; }
    if (bundled) { setMask(bundled); return; }
    if (!remoteName) { setMask(""); return; }
    const controller = new AbortController();
    void loadProjectIconSvg(remoteName, controller.signal)
      .then((svg) => setMask(projectIconMaskBlobUrl(remoteName, svg)))
      .catch(() => setMask(""));
    return () => controller.abort();
  }, [bundled, remoteName, value]);

  return mask;
}

function IconArt({ value, initial, className, variant = "cell" }: { value: string; initial: string; className?: string; variant?: "cell" | "glyph" }) {
  const mask = useIconMask(value);
  if (variant === "glyph") {
    if (isProjectIconSvgDataUrl(value) || isProjectIconBundledPath(value)) {
      return <ProjectIconBody icon={value} loadingFallback={<span className="project-glyph-mask is-loading" aria-hidden="true" />} />;
    }
    if (mask) {
      return <span className="project-glyph-mask" aria-hidden="true" style={{ WebkitMaskImage: `url("${mask}")`, maskImage: `url("${mask}")` }} />;
    }
    if (iconifyProjectIconName(value) || embeddedIconifyName(value)) {
      return <span className="project-glyph-mask is-loading" aria-hidden="true" />;
    }
    if (isProjectIconRasterDataUrl(value)) return <img src={value} alt="" />;
    return <span aria-hidden="true">{value || initial}</span>;
  }
  if (uploadedIcon(value)) return <img className={className} src={value} alt="" />;
  if (mask || projectIconMaskStyle(value)) {
    const style = mask
      ? { WebkitMaskImage: `url("${mask}")`, maskImage: `url("${mask}")` }
      : projectIconMaskStyle(value)!;
    return <span className={className} aria-hidden="true" style={style} />;
  }
  return <span className={`${className ?? ""} is-initial`} aria-hidden="true">{initial}</span>;
}

export default function ProjectAppearanceDialog({
  project,
  onBack,
  onClose,
  inline = false,
}: {
  project: Project;
  onBack?: () => void;
  onClose?: () => void;
  inline?: boolean;
}) {
  const pageSize = useShellMode() === "phone" ? 8 : 12;
  const [name, setName] = useState(project.name);
  const [icon, setIcon] = useState(() => storedProjectIconSelection(project.icon));
  const [color, setColor] = useState(project.color ?? DEFAULT_COLOR);
  const [greetingShown, setGreetingShown] = useState(project.greeting !== "");
  const [greeting, setGreeting] = useState(project.greeting ?? "");
  // Inline (Settings) mode tracks what is persisted so Save/Discard only wake
  // up for real edits; the dialog keeps its always-available footer.
  const [baseline, setBaseline] = useState(() => ({
    name: project.name,
    icon: storedProjectIconSelection(project.icon),
    color: project.color ?? DEFAULT_COLOR,
    greetingShown: project.greeting !== "",
    greeting: project.greeting ?? "",
  }));
  const [justSaved, setJustSaved] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ProjectIconCategory>("suggested");
  const [library, setLibrary] = useState<ProjectIconLibrary | "all">("all");
  const [variation, setVariation] = useState(0);
  const [showMoreCategories, setShowMoreCategories] = useState(false);
  const [limit, setLimit] = useState(pageSize);
  const [bundled, setBundled] = useState<string[]>([]);
  const [bundledReady, setBundledReady] = useState(false);
  const [settledSearch, setSettledSearch] = useState("");
  const [remote, setRemote] = useState<string[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteUnavailable, setRemoteUnavailable] = useState(false);
  const [recent, setRecent] = useState(() => getProjectIconPrefs().recent);
  const [favorites, setFavorites] = useState(() => getProjectIconPrefs().favorites);
  useEffect(() => subscribeProjectIconPrefs(() => {
    const next = getProjectIconPrefs();
    setRecent(next.recent);
    setFavorites(next.favorites);
  }), []);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void fetch("/project-icons.json", { cache: "force-cache" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Icon library unavailable")))
      .then((value: unknown) => { if (active && Array.isArray(value) && value.every((item) => typeof item === "string")) setBundled(value); })
      .catch(() => undefined)
      .finally(() => { if (active) setBundledReady(true); });
    return () => { active = false; };
  }, []);

  const categoryQuery = useMemo(() => projectIconCategoryQuery(category, name, variation), [category, name, variation]);
  const effectiveQuery = query.trim() || categoryQuery;
  const storedCategory = !query.trim() && (category === "recent" || category === "favorites");
  const searchKey = `${effectiveQuery}|${library}`;

  useEffect(() => setLimit(pageSize), [category, library, pageSize, query, variation]);
  useEffect(() => () => revokeProjectIconMaskBlobUrls(), []);

  useEffect(() => {
    if (storedCategory) { setRemote([]); setRemoteLoading(false); setRemoteUnavailable(false); return; }
    if (!effectiveQuery.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setRemoteLoading(true); setRemoteUnavailable(false);
      void searchProjectIcons(effectiveQuery, library, 96, controller.signal)
        .then(async (icons) => {
          if (controller.signal.aborted) return;
          const names = filterSupportedIconifyNames(icons);
          await prefetchProjectIconSvgs(names.slice(0, pageSize), controller.signal).catch(() => undefined);
          if (controller.signal.aborted) return;
          setRemote(names);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")) return;
          setRemote([]); setRemoteUnavailable(true);
        })
        .finally(() => { if (!controller.signal.aborted) { setRemoteLoading(false); setSettledSearch(searchKey); } });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [effectiveQuery, library, pageSize, searchKey, storedCategory]);

  const selectedBundled = bundledName(icon);
  const localFallback = useMemo(() => {
    const sorted = query.trim() ? filterProjectIcons(bundled, query) : rankSuggestedProjectIcons(bundled, effectiveQuery || name, selectedBundled);
    return sorted.map(bundledValue);
  }, [bundled, effectiveQuery, name, query, selectedBundled]);
  const results = useMemo(() => {
    if (!query.trim() && category === "recent") return recent;
    if (!query.trim() && category === "favorites") return favorites;
    const remoteValues = remote.map(iconifyProjectIconValue).filter(Boolean);
    return remoteValues.length ? remoteValues : localFallback;
  }, [category, favorites, localFallback, query, recent, remote]);

  const shown = results.slice(0, limit);
  // Until the bundled list and the debounced search settle, an empty grid is
  // "still loading", not "no match".
  const searchPending = !storedCategory && !!effectiveQuery.trim() && settledSearch !== searchKey;
  const resultsLoading = shown.length === 0 && (remoteLoading || searchPending || !bundledReady);
  const emptyMessage = query.trim() ? tr("projectappearancedialog.noIconsMatchThatSearch") : tr("projectappearancedialog.noIconsInCategory");
  const shownRemoteKey = shown.map((value) => iconifyProjectIconName(value) ?? "").join("|");
  useEffect(() => {
    const names = shownRemoteKey.split("|").filter(Boolean);
    if (!names.length) return;
    const controller = new AbortController();
    void prefetchProjectIconSvgs(names, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [shownRemoteKey]);
  const previewName = name.trim() || project.name;
  const initial = Array.from(previewName)[0]?.toLocaleUpperCase() ?? "P";
  const selectedRemote = iconifyProjectIconName(icon);
  const selectedLabel = selectedRemote ? projectIconLabel(selectedRemote) : selectedBundled ? projectIconLabel(selectedBundled) : uploadedIcon(icon) ? tr("projectappearancedialog.customIcon") : "";
  const selectedProvider = icon ? projectIconProviderLabel(selectedRemote ?? selectedBundled) : "";
  const selectedFavorite = !!icon && favorites.includes(icon);
  const style = { "--project-color": color } as CSSProperties;

  const dirty = name !== baseline.name || icon !== baseline.icon || color !== baseline.color
    || greetingShown !== baseline.greetingShown || greeting !== baseline.greeting;
  const resetAppearance = () => {
    setName(baseline.name);
    setIcon(baseline.icon);
    setColor(baseline.color);
    setGreetingShown(baseline.greetingShown);
    setGreeting(baseline.greeting);
  };

  const choose = (value: string) => {
    setIcon(value);
    const next = updateRecentProjectIcons(recent, value, 24);
    setProjectIconPrefs({ ...getProjectIconPrefs(), recent: next });
  };
  const toggleFavorite = () => {
    if (!icon || uploadedIcon(icon)) return;
    const next = toggleFavoriteProjectIcon(favorites, icon).slice(0, 80);
    setProjectIconPrefs({ ...getProjectIconPrefs(), favorites: next });
  };
  // Optimistic: the project shows its new name, colour and greeting at once
  // and the dialog closes; the icon is prepared and the one PATCH sent in the
  // background. A rejection restores the project and, inline, the baseline.
  const save = () => {
    const trimmedName = name.trim();
    const greetingValue = greetingPatch(greetingShown, greeting);
    const previousBaseline = baseline;
    const request = saveProjectAppearanceOptimistic(
      project.id,
      { name: trimmedName, color, greeting: greetingValue ?? undefined },
      async () => ({
        name: trimmedName,
        // The colour is baked into an inlined icon, so it is always prepared.
        icon: await persistProjectIcon(icon.trim(), color, loadProjectIconSvg),
        color,
        greeting: greetingValue,
      }),
    );
    if (!inline) {
      onClose?.();
      void request.catch((error: unknown) => setUiError(friendlyError(tr("common.error"), error)));
      return;
    }
    const savedGreeting = greetingShown ? greeting.trim() : greeting;
    setName(trimmedName);
    setGreeting(savedGreeting);
    setBaseline({ name: trimmedName, icon, color, greetingShown, greeting: savedGreeting });
    setJustSaved(true);
    void request.catch((error: unknown) => {
      setBaseline(previousBaseline);
      setJustSaved(false);
      setUiError(friendlyError(tr("common.error"), error));
    });
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    const accepted = ["image/png", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"];
    if ((!accepted.includes(file.type) && !/\.(?:png|svg|ico)$/i.test(file.name)) || file.size > MAX_ICON_BYTES) {
      setUiError(tr("projectappearancedialog.chooseAnSvgIcoOrPngIcon")); return;
    }
    try { setIcon(await readImage(file)); } catch (error) { setUiError(friendlyError(tr("projectappearancedialog.couldnTUploadProjectIcon"), error)); }
  };

  const libraryItems = [
    { id: "all", label: tr("projectappearancedialog.allStyles"), group: "", detail: "Hugeicons · MingCute · Phosphor · Myna · Tabler" },
    ...PROJECT_ICON_LIBRARIES.map(({ id, label }) => ({ id, label, group: "" })),
  ];

  const categoryActive = (id: ProjectIconCategory) => category === id && !query.trim();

  const editor = (
    <div className="project-appearance-body" style={style}>
        {onBack && (
          <div className="project-appearance-navigation">
            <Button size="sm" variant="ghost" iconStart={BackIcon} onClick={onBack}>
              {tr("common.back")}
            </Button>
          </div>
        )}
        <div className="project-appearance-preview" aria-label={tr("projectappearancedialog.livePreview")}>
          <span className="project-glyph">
            <IconArt value={icon} initial={initial} variant="glyph" />
          </span>
          <span className="project-name">{previewName}</span>
        </div>

        <label className="project-appearance-field">
          <span>{tr("projectappearancedialog.projectTitle")}</span>
          <span className="project-title-input-wrap">
            <TextInput value={name} maxLength={120} aria-label={tr("projectappearancedialog.projectTitle")} onChange={(event) => setName(event.target.value)} />
            {name && <IconButton icon={CloseIcon} label={tr("projectappearancedialog.clear")} size="sm" onClick={() => setName("")} />}
          </span>
        </label>

        <section className="project-appearance-field" aria-labelledby="project-greeting-label">
          <span className="project-greeting-heading">
            <span id="project-greeting-label">{tr("projectappearancedialog.greeting")}</span>
            <Switch checked={greetingShown} label={tr("projectappearancedialog.showGreeting")} onChange={setGreetingShown} />
          </span>
          {greetingShown && (
            <>
              <span className="project-title-input-wrap">
                <TextInput
                  value={greeting}
                  maxLength={160}
                  placeholder={`${tr("workspace.builtinsurfaces.whatAreWeWorkingOnIn")} {project}.`}
                  aria-labelledby="project-greeting-label"
                  onChange={(event) => setGreeting(event.target.value)}
                />
                {greeting && <IconButton icon={CloseIcon} label={tr("projectappearancedialog.clear")} size="sm" onClick={() => setGreeting("")} />}
              </span>
              <small className="project-greeting-hint">{tr("projectappearancedialog.greetingHint")}</small>
            </>
          )}
        </section>

        <section className="project-appearance-field" aria-labelledby="project-color-label">
          <span id="project-color-label">{tr("projectappearancedialog.color")}</span>
          <div className="project-color-presets" role="group" aria-label={tr("projectappearancedialog.color")}>
            {COLORS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={color.toLocaleLowerCase() === preset ? "selected" : ""}
                style={{ "--swatch-color": preset } as CSSProperties}
                aria-label={tr("projectappearancedialog.colorValue", { value: preset })}
                aria-pressed={color.toLocaleLowerCase() === preset}
                onClick={() => setColor(preset)}
              />
            ))}
            <label className={`project-color-custom${COLORS.includes(color.toLocaleLowerCase() as typeof COLORS[number]) ? "" : " selected"}`} title={tr("projectappearancedialog.customColor")}>
              <input type="color" value={color} aria-label={tr("projectappearancedialog.color")} onChange={(event) => setColor(event.target.value)} />
              <span aria-hidden="true" />
            </label>
          </div>
        </section>

        <section className="project-icon-picker" aria-labelledby="project-icon-picker-label">
          <span id="project-icon-picker-label" className="project-appearance-field">{tr("projectappearancedialog.projectIcon")}</span>
          <div className="project-icon-toolbar">
            <div className="project-icon-search-wrap">
              <span className="project-icon-search-glyph" aria-hidden="true"><Icon icon={SearchIcon} size="sm" /></span>
              <TextInput value={query} placeholder={tr("projectappearancedialog.searchIcons")} aria-label={tr("projectappearancedialog.searchProjectIcons")} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <Picker
              label={tr("projectappearancedialog.iconStyle")}
              ariaLabel={tr("projectappearancedialog.filterIconLibrary")}
              className="project-icon-library-picker"
              triggerIcon={<FilterIcon />}
              items={libraryItems}
              value={library}
              onPick={(value) => setLibrary(value as ProjectIconLibrary | "all")}
              searchable={false}
            />
            <IconButton icon={AssistIcon} label={tr("projectappearancedialog.refreshSuggestions")} className="project-icon-surprise" onClick={() => { setQuery(""); setCategory("suggested"); setVariation((value) => value + 1); }} />
          </div>

          <div className="project-icon-categories" role="group" aria-label={tr("projectappearancedialog.iconCategories")}>
            {CATEGORIES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className="chip"
                aria-pressed={categoryActive(id)}
                disabled={id === "favorites" && favorites.length === 0}
                onClick={() => { setQuery(""); setCategory(id); }}
              >
                {id === "suggested" && <AssistIcon aria-hidden="true" />}
                {id === "favorites" && <FavoriteIcon aria-hidden="true" />}
                {tr(label)}
              </button>
            ))}
            <button
              type="button"
              className="chip project-icon-more-categories"
              aria-pressed={showMoreCategories}
              aria-expanded={showMoreCategories}
              onClick={() => setShowMoreCategories((value) => !value)}
            >
              {tr("common.more")}
            </button>
          </div>
          {showMoreCategories && (
            <div className="project-icon-categories" role="group" aria-label={tr("projectappearancedialog.moreIconCategories")}>
              {MORE_CATEGORIES.map(({ id, label }) => (
                <button key={id} type="button" className="chip" aria-pressed={categoryActive(id)} onClick={() => { setQuery(""); setCategory(id); }}>
                  {tr(label)}
                </button>
              ))}
            </div>
          )}

          <div className="project-icon-options" role="radiogroup" aria-label={tr("projectappearancedialog.projectIconLibrary")}>
            {shown.map((value) => {
              const remoteName = iconifyProjectIconName(value);
              const localName = bundledName(value);
              const label = projectIconLabel(remoteName ?? localName ?? value);
              const provider = projectIconProviderLabel(remoteName ?? localName);
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  title={`${label} · ${provider}`}
                  aria-label={`${label}, ${provider}`}
                  aria-checked={icon === value}
                  className={icon === value ? "selected" : ""}
                  onClick={() => choose(value)}
                >
                  <IconArt value={value} initial={initial} className="project-icon-art" />
                </button>
              );
            })}
            {results.length > limit && (
              <button type="button" className="project-icon-more-results" aria-label={tr("common.more")} onClick={() => setLimit((value) => value + pageSize)}>
                <MoreIcon aria-hidden="true" />
              </button>
            )}
            {resultsLoading && <small role="status">{tr("common.loading")}</small>}
            {!resultsLoading && results.length === 0 && <small role="status">{emptyMessage}</small>}
          </div>
          {remoteUnavailable && localFallback.length > 0 && <small className="project-icon-fallback-note">{tr("projectappearancedialog.iconifyUnavailable")}</small>}

          {icon && !uploadedIcon(icon) && selectedLabel && (
            <div className="project-icon-selection" aria-live="polite">
              <span className="project-icon-selection-copy">
                <strong>{selectedLabel}</strong>
                {selectedProvider ? ` · ${selectedProvider}` : ""}
              </span>
              <IconButton icon={FavoriteIcon} label={selectedFavorite ? tr("projectappearancedialog.removeFromFavorites") : tr("projectappearancedialog.addToFavorites")} size="sm" pressed={selectedFavorite} onClick={toggleFavorite} />
              {selectedRemote && <CopyButton text={selectedRemote} label={tr("projectappearancedialog.copyIconName")} />}
              <Button size="sm" onClick={() => setIcon("")}>{tr("projectappearancedialog.clear")}</Button>
            </div>
          )}

          <div className="project-icon-upload-row">
            <Button size="sm" iconStart={UploadIcon} title={tr("projectappearancedialog.uploadIconHint")} onClick={() => uploadRef.current?.click()}>{tr("projectappearancedialog.uploadIcon")}</Button>
            {uploadedIcon(icon) && <img className="project-icon-preview" src={icon} alt="" />}
            {uploadedIcon(icon) && <Button size="sm" onClick={() => setIcon("")}>{tr("projectappearancedialog.clear")}</Button>}
            <input ref={uploadRef} type="file" accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.png,.svg,.ico" hidden onChange={(event) => void upload(event)} />
          </div>
        </section>
    </div>
  );

  const actions = (
    <>
      <Button size="sm" onClick={() => onClose?.()}>{tr("common.cancel")}</Button>
      <Button size="sm" variant="primary" disabled={!name.trim()} onClick={save}>
        {tr("common.save")}
      </Button>
    </>
  );

  if (inline) {
    return (
      <div className="project-appearance-inline">
        {editor}
        <SaveBar
          dirty={dirty}
          saving={false}
          status={justSaved && !dirty ? "saved" : "idle"}
          onSave={() => { if (name.trim()) save(); else setUiError(tr("projectappearancedialog.titleRequired")); }}
          onDiscard={resetAppearance}
        />
      </div>
    );
  }

  return (
    <Dialog
      title={tr("projectappearancedialog.projectAppearance")}
      onClose={() => onClose?.()}
      size="sm"
      className="project-appearance-dialog"
      initialFocus="input"
      footer={actions}
    >
      {editor}
    </Dialog>
  );
}
