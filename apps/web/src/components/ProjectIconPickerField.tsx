// The full project icon picker: search, library filter, categories, favourites
// and upload. Shared by the project appearance dialog and the new-project window
// ("All icons"). The caller owns the value; recents and favourites are the
// person's own preferences and stay here.
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
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
  PROJECT_ICON_LIBRARIES,
  projectIconCategoryQuery,
  projectIconLabel,
  projectIconProviderLabel,
  rankSuggestedProjectIcons,
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
import Picker from "./Picker.tsx";
import {
  AssistIcon,
  Button,
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

const MAX_ICON_BYTES = 512 * 1024;
const PROJECT_ICON_PREFIX = "/assets/project-icons/";
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

export function IconArt({ value, initial, className, variant = "cell" }: { value: string; initial: string; className?: string; variant?: "cell" | "glyph" }) {
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

export default function ProjectIconPickerField({
  icon,
  onChange,
  title,
  initial,
  showHeading = true,
}: {
  icon: string;
  onChange: (value: string) => void;
  /** The project's name: suggestions follow it. */
  title: string;
  /** Shown for an icon that has no art yet. */
  initial: string;
  /** Hosts with their own heading row hide this one. */
  showHeading?: boolean;
}) {
  const pageSize = useShellMode() === "phone" ? 8 : 12;
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

  const categoryQuery = useMemo(() => projectIconCategoryQuery(category, title, variation), [category, title, variation]);
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
    const sorted = query.trim() ? filterProjectIcons(bundled, query) : rankSuggestedProjectIcons(bundled, effectiveQuery || title, selectedBundled);
    return sorted.map(bundledValue);
  }, [bundled, effectiveQuery, query, selectedBundled, title]);
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
  const selectedRemote = iconifyProjectIconName(icon);
  const selectedLabel = selectedRemote ? projectIconLabel(selectedRemote) : selectedBundled ? projectIconLabel(selectedBundled) : uploadedIcon(icon) ? tr("projectappearancedialog.customIcon") : "";
  const selectedProvider = icon ? projectIconProviderLabel(selectedRemote ?? selectedBundled) : "";
  const selectedFavorite = !!icon && favorites.includes(icon);

  const choose = (value: string) => {
    onChange(value);
    const next = updateRecentProjectIcons(recent, value, 24);
    setProjectIconPrefs({ ...getProjectIconPrefs(), recent: next });
  };
  const toggleFavorite = () => {
    if (!icon || uploadedIcon(icon)) return;
    const next = toggleFavoriteProjectIcon(favorites, icon).slice(0, 80);
    setProjectIconPrefs({ ...getProjectIconPrefs(), favorites: next });
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    const accepted = ["image/png", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"];
    if ((!accepted.includes(file.type) && !/\.(?:png|svg|ico)$/i.test(file.name)) || file.size > MAX_ICON_BYTES) {
      setUiError(tr("projectappearancedialog.chooseAnSvgIcoOrPngIcon")); return;
    }
    try { onChange(await readImage(file)); } catch (error) { setUiError(friendlyError(tr("projectappearancedialog.couldnTUploadProjectIcon"), error)); }
  };

  const libraryItems = [
    { id: "all", label: tr("projectappearancedialog.allStyles"), group: "", detail: "Hugeicons · MingCute · Phosphor · Myna · Tabler" },
    ...PROJECT_ICON_LIBRARIES.map(({ id, label }) => ({ id, label, group: "" })),
  ];

  const categoryActive = (id: ProjectIconCategory) => category === id && !query.trim();

  return (
        <section className="project-icon-picker" {...(showHeading ? { "aria-labelledby": "project-icon-picker-label" } : { "aria-label": tr("projectappearancedialog.projectIcon") })}>
          {showHeading && <span id="project-icon-picker-label" className="project-appearance-field">{tr("projectappearancedialog.projectIcon")}</span>}
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
              <Button size="sm" onClick={() => onChange("")}>{tr("projectappearancedialog.clear")}</Button>
            </div>
          )}

          <div className="project-icon-upload-row">
            <Button size="sm" iconStart={UploadIcon} title={tr("projectappearancedialog.uploadIconHint")} onClick={() => uploadRef.current?.click()}>{tr("projectappearancedialog.uploadIcon")}</Button>
            {uploadedIcon(icon) && <img className="project-icon-preview" src={icon} alt="" />}
            {uploadedIcon(icon) && <Button size="sm" onClick={() => onChange("")}>{tr("projectappearancedialog.clear")}</Button>}
            <input ref={uploadRef} type="file" accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.png,.svg,.ico" hidden onChange={(event) => void upload(event)} />
          </div>
        </section>
  );
}
