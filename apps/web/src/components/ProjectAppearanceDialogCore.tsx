import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import type { Project } from "@polyth/contracts";
import { updateProjectAppearance } from "../init.ts";
import { tr } from "../i18n/index.ts";
import { useShellMode } from "../responsiveShell.ts";
import { friendlyError } from "../settings.ts";
import { setUiError } from "../store.ts";
import { copyText } from "../utils.ts";
import {
  filterProjectIcons,
  filterSupportedIconifyNames,
  iconifyProjectIconName,
  iconifyProjectIconValue,
  iconifySearchUrl,
  iconifySvgUrl,
  inlineIconifySvgDataUrl,
  PROJECT_ICON_LIBRARIES,
  projectIconCategoryQuery,
  projectIconLabel,
  projectIconMaskUrl,
  projectIconProviderLabel,
  rankSuggestedProjectIcons,
  storedProjectIconSelection,
  toggleFavoriteProjectIcon,
  updateRecentProjectIcons,
  type ProjectIconCategory,
  type ProjectIconLibrary,
} from "../projectIconPicker.ts";
import CopyButton from "./CopyButton.tsx";
import Picker from "./Picker.tsx";
import {
  AssistIcon,
  Button,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  Dialog,
  FavoriteIcon,
  FilterIcon,
  IconButton,
  MoreIcon,
  SearchIcon,
  TextInput,
  UploadIcon,
} from "./ui/index.ts";
import "./ProjectAppearanceDialog.css";

const DEFAULT_COLOR = "#b4532a";
const MAX_ICON_BYTES = 512 * 1024;
const RECENT_KEY = "polyth.projectAppearance.recentIcons.v2";
const FAVORITES_KEY = "polyth.projectAppearance.favoriteIcons.v1";
const PROJECT_ICON_PREFIX = "/assets/project-icons/";
const COLORS = ["#b4532a", "#f0a6ad", "#de5962", "#f28c38", "#eab83a", "#65b955", "#43b7a6", "#3f7de8", "#7253e8", "#d85cbe", "#858585", "#7b8495"] as const;
const CATEGORIES: readonly { id: ProjectIconCategory; label: string }[] = [
  { id: "suggested", label: "Suggested" }, { id: "recent", label: "Recent" },
  { id: "favorites", label: "Favorites" }, { id: "tech", label: "Tech" },
  { id: "work", label: "Work" }, { id: "creative", label: "Creative" },
  { id: "development", label: "Development" }, { id: "security", label: "Security" },
  { id: "media", label: "Media" }, { id: "home", label: "Home" },
];
const MORE_CATEGORIES: readonly { id: ProjectIconCategory; label: string }[] = [
  { id: "ai", label: "AI" }, { id: "data", label: "Data" }, { id: "cloud", label: "Cloud" },
  { id: "science", label: "Science" }, { id: "tools", label: "Tools" },
];

const bundledValue = (name: string): string => `${PROJECT_ICON_PREFIX}${encodeURIComponent(name)}`;
const bundledName = (value: string): string => {
  if (!value.startsWith(PROJECT_ICON_PREFIX)) return "";
  try { return decodeURIComponent(value.slice(PROJECT_ICON_PREFIX.length)); } catch { return value.slice(PROJECT_ICON_PREFIX.length); }
};
const uploadedIcon = (value: string): boolean => value.startsWith("data:image/");

function readStored(key: string, limit: number): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length <= 512).slice(0, limit) : [];
  } catch { return []; }
}
function writeStored(key: string, value: readonly string[]): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* convenience state only */ }
}
function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(tr("projectappearancedialog.couldnTReadThatIcon")));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(tr("projectappearancedialog.couldnTReadThatIcon")));
    reader.readAsDataURL(file);
  });
}
function contrastInk(color: string): string {
  const hex = color.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return "#fff";
  const r = Number.parseInt(hex.slice(0, 2), 16), g = Number.parseInt(hex.slice(2, 4), 16), b = Number.parseInt(hex.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 170 ? "#171717" : "#fff";
}
function IconArt({ value, initial, className }: { value: string; initial: string; className: string }) {
  if (uploadedIcon(value)) return <img className={className} src={value} alt="" />;
  const mask = projectIconMaskUrl(value);
  if (mask) return <span className={className} aria-hidden="true" style={{ WebkitMaskImage: `url("${mask}")`, maskImage: `url("${mask}")` }} />;
  return <span className={`${className} is-initial`} aria-hidden="true">{initial}</span>;
}

export default function ProjectAppearanceDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const pageSize = useShellMode() === "phone" ? 16 : 30;
  const [name, setName] = useState(project.name);
  const [icon, setIcon] = useState(() => storedProjectIconSelection(project.icon));
  const [color, setColor] = useState(project.color ?? DEFAULT_COLOR);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ProjectIconCategory>("suggested");
  const [library, setLibrary] = useState<ProjectIconLibrary | "all">("all");
  const [variation, setVariation] = useState(0);
  const [showMoreCategories, setShowMoreCategories] = useState(false);
  const [limit, setLimit] = useState(pageSize);
  const [bundled, setBundled] = useState<string[]>([]);
  const [remote, setRemote] = useState<string[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteUnavailable, setRemoteUnavailable] = useState(false);
  const [recent, setRecent] = useState(() => readStored(RECENT_KEY, 24));
  const [favorites, setFavorites] = useState(() => readStored(FAVORITES_KEY, 80));
  const [copyingSvg, setCopyingSvg] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void fetch("/project-icons.json", { cache: "force-cache" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Icon library unavailable")))
      .then((value: unknown) => { if (active && Array.isArray(value) && value.every((item) => typeof item === "string")) setBundled(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const categoryQuery = useMemo(() => projectIconCategoryQuery(category, name, variation), [category, name, variation]);
  const effectiveQuery = query.trim() || categoryQuery;
  const storedCategory = !query.trim() && (category === "recent" || category === "favorites");

  useEffect(() => setLimit(pageSize), [category, library, pageSize, query, variation]);
  useEffect(() => {
    if (storedCategory) { setRemote([]); setRemoteLoading(false); setRemoteUnavailable(false); return; }
    if (!effectiveQuery.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setRemoteLoading(true); setRemoteUnavailable(false);
      void fetch(iconifySearchUrl(effectiveQuery, library, 96), { cache: "force-cache", credentials: "omit", signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error(`Iconify HTTP ${response.status}`)))
        .then((value: { icons?: unknown }) => { if (!controller.signal.aborted) setRemote(Array.isArray(value.icons) ? filterSupportedIconifyNames(value.icons) : []); })
        .catch((error: unknown) => {
          if (controller.signal.aborted || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")) return;
          setRemote([]); setRemoteUnavailable(true);
        })
        .finally(() => { if (!controller.signal.aborted) setRemoteLoading(false); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [effectiveQuery, library, storedCategory]);

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
  const previewName = name.trim() || project.name;
  const initial = Array.from(previewName)[0]?.toLocaleUpperCase() ?? "P";
  const selectedRemote = iconifyProjectIconName(icon);
  const selectedLabel = selectedRemote ? projectIconLabel(selectedRemote) : selectedBundled ? projectIconLabel(selectedBundled) : uploadedIcon(icon) ? "Custom icon" : "";
  const selectedProvider = icon ? projectIconProviderLabel(selectedRemote ?? selectedBundled) : "";
  const selectedFavorite = !!icon && favorites.includes(icon);
  const style = { "--project-color": color, "--project-icon-ink": contrastInk(color) } as CSSProperties;

  const choose = (value: string) => {
    setIcon(value);
    const next = updateRecentProjectIcons(recent, value, 24);
    setRecent(next); writeStored(RECENT_KEY, next);
  };
  const toggleFavorite = () => {
    if (!icon || uploadedIcon(icon)) return;
    const next = toggleFavoriteProjectIcon(favorites, icon).slice(0, 80);
    setFavorites(next); writeStored(FAVORITES_KEY, next);
  };
  const copySvg = async () => {
    const remoteName = iconifyProjectIconName(icon);
    if (!remoteName || copyingSvg) return;
    setCopyingSvg(true);
    try {
      const response = await fetch(iconifySvgUrl(remoteName), { cache: "force-cache", credentials: "omit" });
      if (!response.ok) throw new Error(`Iconify HTTP ${response.status}`);
      await copyText(await response.text());
    } catch (error) { setUiError(friendlyError(tr("common.error"), error)); }
    finally { setCopyingSvg(false); }
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      let persistedIcon = icon.trim();
      const remoteName = iconifyProjectIconName(persistedIcon);
      if (remoteName) {
        const response = await fetch(iconifySvgUrl(remoteName), { cache: "force-cache", credentials: "omit" });
        if (!response.ok) throw new Error(`Iconify HTTP ${response.status}`);
        persistedIcon = inlineIconifySvgDataUrl(remoteName, await response.text(), color);
        if (!persistedIcon) throw new Error("Couldn’t prepare the selected project icon.");
      }
      await updateProjectAppearance(project.id, { name: name.trim(), icon: persistedIcon, color });
      onClose();
    } catch (error) { setUiError(friendlyError(tr("common.error"), error)); }
    finally { setSaving(false); }
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
    { id: "all", label: "All styles", group: "", detail: "Hugeicons · MingCute · Phosphor · Myna · Tabler" },
    ...PROJECT_ICON_LIBRARIES.map(({ id, label }) => ({ id, label, group: "" })),
  ];

  return (
    <Dialog title={tr("projectappearancedialog.projectAppearance")} onClose={onClose} size="lg" className="project-appearance-dialog" initialFocus="input" hideHeader
      footer={<><Button onClick={onClose} disabled={saving}>{tr("common.cancel")}</Button><Button variant="primary" busy={saving} disabled={!name.trim()} onClick={() => void save()}>{saving ? tr("common.saving") : tr("common.save")}</Button></>}>
      <div className="project-appearance-body" style={style}>
        <header className="project-appearance-head"><div><h2>{tr("projectappearancedialog.projectAppearance")}</h2><p>Set the title, icon and color for this project.</p></div><IconButton icon={CloseIcon} label={tr("common.close")} size="lg" onClick={onClose} /></header>

        <section className="project-appearance-hero" aria-label="Live preview">
          <div className="project-appearance-identity"><span className="project-appearance-hero-icon"><IconArt value={icon} initial={initial} className="project-appearance-hero-art" /></span><span className="project-appearance-hero-copy"><strong>{previewName}</strong><span>This is how it will look in your sidebar.</span></span></div>
          <aside className="project-sidebar-preview"><span className="project-sidebar-preview-label">Live preview</span><div className="project-sidebar-preview-row"><span className="project-sidebar-preview-icon"><IconArt value={icon} initial={initial} className="project-sidebar-preview-art" /></span><strong>{previewName}</strong><i aria-label="Project ready" /></div><div className="project-sidebar-preview-ghost" aria-hidden="true"><b /><span /></div><div className="project-sidebar-preview-ghost" aria-hidden="true"><b /><span /></div></aside>
        </section>

        <label className="project-appearance-field project-title-field"><span>{tr("projectappearancedialog.projectTitle")}</span><span className="project-title-input-wrap"><TextInput value={name} maxLength={120} aria-label={tr("projectappearancedialog.projectTitle")} onChange={(event) => setName(event.target.value)} />{name && <IconButton icon={CloseIcon} label={tr("projectappearancedialog.clear")} size="sm" onClick={() => setName("")} />}</span></label>

        <section className="project-icon-picker" aria-labelledby="project-icon-picker-label">
          <span id="project-icon-picker-label" className="project-appearance-label">{tr("projectappearancedialog.projectIcon")}</span>
          <div className="project-icon-toolbar"><div className="project-icon-search-wrap"><span className="project-icon-search-glyph" aria-hidden="true"><SearchIcon /></span><TextInput className="project-icon-search" value={query} placeholder="Search icons… (e.g. search, ai, code, folder, security)" aria-label={tr("projectappearancedialog.searchProjectIcons")} onChange={(event) => setQuery(event.target.value)} /></div><Picker label="Icon style" ariaLabel="Filter icon library" className="project-icon-library-picker" triggerIcon={<FilterIcon />} items={libraryItems} value={library} onPick={(value) => setLibrary(value as ProjectIconLibrary | "all")} searchable={false} mobileSheet /><IconButton icon={AssistIcon} label="Refresh suggestions" className="project-icon-surprise" onClick={() => { setQuery(""); setCategory("suggested"); setVariation((value) => value + 1); }} /></div>

          <div className="project-icon-categories" role="group" aria-label="Icon categories">
            {CATEGORIES.map(({ id, label }) => <button key={id} type="button" className={category === id && !query.trim() ? "active" : ""} aria-pressed={category === id && !query.trim()} disabled={id === "favorites" && favorites.length === 0} onClick={() => { setQuery(""); setCategory(id); }}>{id === "suggested" && <AssistIcon aria-hidden="true" />}{id === "favorites" && <FavoriteIcon aria-hidden="true" />}{label}</button>)}
            <button type="button" className={showMoreCategories ? "active project-icon-more-categories" : "project-icon-more-categories"} aria-expanded={showMoreCategories} onClick={() => setShowMoreCategories((value) => !value)}>{tr("common.more")} <span aria-hidden="true">⌄</span></button>
          </div>
          {showMoreCategories && <div className="project-icon-categories project-icon-categories-more" role="group" aria-label="More icon categories">{MORE_CATEGORIES.map(({ id, label }) => <button key={id} type="button" className={category === id && !query.trim() ? "active" : ""} onClick={() => { setQuery(""); setCategory(id); }}>{label}</button>)}</div>}

          <div className="project-icon-options" role="radiogroup" aria-label={tr("projectappearancedialog.projectIconLibrary")}>
            {shown.map((value) => { const remoteName = iconifyProjectIconName(value); const localName = bundledName(value); const label = projectIconLabel(remoteName ?? localName ?? value); const provider = projectIconProviderLabel(remoteName ?? localName); return <button key={value} type="button" role="radio" title={`${label} · ${provider}`} aria-label={`${label}, ${provider}`} aria-checked={icon === value} className={icon === value ? "selected" : ""} onClick={() => choose(value)}><IconArt value={value} initial={initial} className="project-icon-art" /></button>; })}
            {results.length > limit && <button type="button" className="project-icon-more-results" aria-label={tr("common.more")} onClick={() => setLimit((value) => value + pageSize)}><MoreIcon aria-hidden="true" /></button>}
            {remoteLoading && shown.length === 0 && <small role="status">{tr("common.loading")}</small>}
            {!remoteLoading && results.length === 0 && <small role="status">{tr("projectappearancedialog.noIconsMatchThatSearch")}</small>}
          </div>
          {remoteUnavailable && localFallback.length > 0 && <small className="project-icon-fallback-note">Iconify is unavailable right now. Showing bundled icons.</small>}

          {icon && !uploadedIcon(icon) && selectedLabel && <div className="project-icon-selection" aria-live="polite"><span className="project-icon-selection-copy"><strong>{selectedLabel}</strong><small>{selectedProvider}{selectedRemote ? ` · ${selectedRemote}` : ""}</small></span><IconButton icon={FavoriteIcon} label={selectedFavorite ? "Remove from favorites" : "Add to favorites"} size="sm" pressed={selectedFavorite} onClick={toggleFavorite} />{selectedRemote && <CopyButton text={selectedRemote} label="Copy icon name" />}{selectedRemote && <Button size="sm" iconStart={CopyIcon} busy={copyingSvg} onClick={() => void copySvg()}>Copy SVG</Button>}<Button size="sm" onClick={() => setIcon("")}>{tr("projectappearancedialog.clear")}</Button></div>}

          <div className={`project-icon-upload-row${uploadedIcon(icon) ? " has-upload" : ""}`}><button type="button" className="project-icon-upload-button" onClick={() => uploadRef.current?.click()}><span className="project-icon-upload-glyph" aria-hidden="true"><UploadIcon /></span><span className="project-icon-upload-copy"><strong>Upload custom icon</strong><small>SVG, PNG or ICO (max 512 KB)</small></span>{uploadedIcon(icon) && <img className="project-icon-preview" src={icon} alt="" />}<ChevronRightIcon aria-hidden="true" /></button>{uploadedIcon(icon) && <Button size="sm" className="project-icon-clear" onClick={() => setIcon("")}>{tr("projectappearancedialog.clear")}</Button>}<input ref={uploadRef} type="file" accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.png,.svg,.ico" hidden onChange={(event) => void upload(event)} /></div>
        </section>

        <section className="project-appearance-field project-color-field" aria-labelledby="project-color-label"><span id="project-color-label">{tr("projectappearancedialog.color")}</span><div className="project-color-presets" role="group" aria-label={tr("projectappearancedialog.color")}>{COLORS.map((preset) => <button key={preset} type="button" className={color.toLocaleLowerCase() === preset ? "selected" : ""} style={{ "--swatch-color": preset } as CSSProperties} aria-label={`${tr("projectappearancedialog.color")} ${preset}`} aria-pressed={color.toLocaleLowerCase() === preset} onClick={() => setColor(preset)} />)}<label className={`project-color-custom${COLORS.includes(color.toLocaleLowerCase() as typeof COLORS[number]) ? "" : " selected"}`} title="Custom color"><input type="color" value={color} aria-label={tr("projectappearancedialog.color")} onChange={(event) => setColor(event.target.value)} /><span aria-hidden="true" /></label></div></section>
        <p className="project-appearance-tip"><AssistIcon aria-hidden="true" /><strong>Tip:</strong> Start typing to quickly find the perfect icon.</p>
      </div>
    </Dialog>
  );
}
