import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import type { Project } from "@polyth/contracts";
import { updateProjectAppearance } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { setUiError } from "../store.ts";
import { tr } from "../i18n/index.ts";
import {
  filterProjectIcons,
  projectIconLabel,
  rankSuggestedProjectIcons,
  updateRecentProjectIcons,
} from "../projectIconPicker.ts";
import {
  AssistIcon,
  Button,
  Dialog,
  MoreIcon,
  SearchIcon,
  TextInput,
  UploadIcon,
} from "./ui/index.ts";
import "./ProjectAppearanceDialog.css";

const DEFAULT_COLOR = "#9b4b2b";
const MAX_ICON_BYTES = 512 * 1024;
const ICON_PAGE_SIZE = 30;
const RECENT_ICON_LIMIT = 12;
const RECENT_ICON_STORAGE_KEY = "polyth.projectAppearance.recentIcons.v1";
const PROJECT_ICON_PREFIX = "/assets/project-icons/";
const COLOR_PRESETS = [
  "#b4532a",
  "#e85d68",
  "#f28c38",
  "#eab83a",
  "#65b955",
  "#43b7a6",
  "#3f7de8",
  "#7253e8",
  "#d85cbe",
  "#7b8495",
] as const;

type IconView = "recommended" | "recent";

const iconPath = (name: string): string => `${PROJECT_ICON_PREFIX}${encodeURIComponent(name)}`;
const assetIcon = (icon: string): boolean => icon.startsWith(PROJECT_ICON_PREFIX);
const uploadedIcon = (icon: string): boolean => icon.startsWith("data:image/");
const assetIconName = (icon: string): string => {
  if (!assetIcon(icon)) return "";
  const name = icon.slice(PROJECT_ICON_PREFIX.length);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(tr("projectappearancedialog.couldnTReadThatIcon")));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error(tr("projectappearancedialog.couldnTReadThatIcon")));
    reader.readAsDataURL(file);
  });
}

function readRecentIcons(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_ICON_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(0, RECENT_ICON_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function writeRecentIcons(iconNames: readonly string[]): void {
  try {
    window.localStorage.setItem(RECENT_ICON_STORAGE_KEY, JSON.stringify(iconNames));
  } catch {
    // Private browsing/storage restrictions must never block choosing an icon.
  }
}

export default function ProjectAppearanceDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [icon, setIcon] = useState(project.icon ?? "");
  const [color, setColor] = useState(project.color ?? DEFAULT_COLOR);
  const [saving, setSaving] = useState(false);
  const [iconNames, setIconNames] = useState<string[]>([]);
  const [iconQuery, setIconQuery] = useState("");
  const [iconView, setIconView] = useState<IconView>("recommended");
  const [iconLimit, setIconLimit] = useState(ICON_PAGE_SIZE);
  const [recentIcons, setRecentIcons] = useState<string[]>(() => readRecentIcons());
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void fetch("/project-icons.json", { cache: "force-cache" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Icon library unavailable")))
      .then((names: unknown) => {
        if (active && Array.isArray(names) && names.every((item) => typeof item === "string")) setIconNames(names);
      })
      .catch(() => { /* Upload remains available if a deployment omits the bundled library. */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setIconLimit(ICON_PAGE_SIZE);
  }, [iconQuery, iconView]);

  const selectedBundledName = assetIconName(icon);
  const availableRecentIcons = useMemo(() => {
    const available = new Set(iconNames);
    return recentIcons.filter((item) => available.has(item));
  }, [iconNames, recentIcons]);
  const suggestedIcons = useMemo(
    () => rankSuggestedProjectIcons(iconNames, name, selectedBundledName),
    [iconNames, name, selectedBundledName],
  );
  const searchedIcons = useMemo(
    () => filterProjectIcons(iconNames, iconQuery),
    [iconNames, iconQuery],
  );
  const iconResults = iconQuery.trim()
    ? searchedIcons
    : iconView === "recent" && availableRecentIcons.length > 0
      ? availableRecentIcons
      : suggestedIcons;
  const visibleIcons = iconResults.slice(0, iconLimit);
  const hasMoreIcons = iconResults.length > iconLimit;
  const previewName = name.trim() || project.name;
  const previewInitial = Array.from(previewName.trim())[0]?.toLocaleUpperCase() ?? "P";
  const customStyle = { "--project-color": color } as CSSProperties;

  const chooseBundledIcon = (iconName: string): void => {
    setIcon(iconPath(iconName));
    const nextRecent = updateRecentProjectIcons(recentIcons, iconName, RECENT_ICON_LIMIT);
    setRecentIcons(nextRecent);
    writeRecentIcons(nextRecent);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateProjectAppearance(project.id, { name: name.trim(), icon: icon.trim(), color });
      onClose();
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    } finally {
      setSaving(false);
    }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const accepted = ["image/png", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"];
    const hasAllowedExtension = /\.(?:png|svg|ico)$/i.test(file.name);
    if ((!accepted.includes(file.type) && !hasAllowedExtension) || file.size > MAX_ICON_BYTES) {
      setUiError(tr("projectappearancedialog.chooseAnSvgIcoOrPngIcon"));
      return;
    }
    try {
      setIcon(await readImage(file));
    } catch (error) {
      setUiError(friendlyError(tr("projectappearancedialog.couldnTUploadProjectIcon"), error));
    }
  };

  return (
    <Dialog
      title={tr("projectappearancedialog.projectAppearance")}
      onClose={onClose}
      size="lg"
      className="project-appearance-dialog"
      initialFocus="input"
      footer={(
        <>
          <Button size="sm" onClick={onClose} disabled={saving}>{tr("common.cancel")}</Button>
          <Button
            size="sm"
            variant="primary"
            busy={saving}
            onClick={() => void save()}
            disabled={!name.trim()}
          >
            {saving ? tr("common.saving") : tr("common.save")}
          </Button>
        </>
      )}
    >
      <div className="project-appearance-body" style={customStyle}>
        <section className="project-appearance-preview" aria-label={tr("projectappearancedialog.projectAppearance")}>
          <span className="project-appearance-preview-icon" aria-hidden="true">
            {uploadedIcon(icon) ? (
              <img src={icon} alt="" />
            ) : assetIcon(icon) ? (
              <span
                className="project-appearance-preview-mask"
                style={{ WebkitMaskImage: `url("${icon}")`, maskImage: `url("${icon}")` }}
              />
            ) : (
              <span className="project-appearance-preview-initial">{previewInitial}</span>
            )}
          </span>
          <span className="project-appearance-preview-copy">
            <strong>{previewName}</strong>
            <span>{tr("projectappearancedialog.setTheTitleAndMarkerShown")}</span>
          </span>
        </section>

        <label className="project-appearance-field">
          <span>{tr("projectappearancedialog.projectTitle")}</span>
          <TextInput
            value={name}
            maxLength={120}
            placeholder={tr("projectappearancedialog.projectTitle")}
            aria-label={tr("projectappearancedialog.projectTitle")}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <div className="project-icon-picker">
          <span className="project-appearance-label">{tr("projectappearancedialog.icon")}</span>
          <div className="project-icon-search-wrap">
            <span className="project-icon-search-glyph" aria-hidden="true"><SearchIcon /></span>
            <TextInput
              className="project-icon-search"
              value={iconQuery}
              placeholder={tr("projectappearancedialog.searchItemIcons")}
              aria-label={tr("projectappearancedialog.searchProjectIcons")}
              onChange={(event) => setIconQuery(event.target.value)}
            />
          </div>

          {!iconQuery.trim() && (
            <div className="project-icon-tabs" role="group" aria-label={tr("projectappearancedialog.projectIconLibrary")}>
              <button
                type="button"
                className={iconView === "recommended" ? "active" : ""}
                aria-pressed={iconView === "recommended"}
                onClick={() => setIconView("recommended")}
              >
                <AssistIcon aria-hidden="true" />
                {tr("composer.recommended")}
              </button>
              <button
                type="button"
                className={iconView === "recent" ? "active" : ""}
                aria-pressed={iconView === "recent"}
                disabled={availableRecentIcons.length === 0}
                onClick={() => setIconView("recent")}
              >
                {tr("composer.recent")}
              </button>
            </div>
          )}

          <div className="project-icon-options" role="group" aria-label={tr("projectappearancedialog.projectIconLibrary")}>
            {visibleIcons.map((iconName) => {
              const value = iconPath(iconName);
              const selected = icon === value;
              const label = projectIconLabel(iconName);
              return (
                <button
                  key={iconName}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={selected}
                  className={selected ? "selected" : ""}
                  onClick={() => chooseBundledIcon(iconName)}
                >
                  <span
                    className="project-icon-art"
                    aria-hidden="true"
                    style={{ backgroundColor: color, WebkitMaskImage: `url("${value}")`, maskImage: `url("${value}")` }}
                  />
                </button>
              );
            })}
            {hasMoreIcons && (
              <button
                type="button"
                className="project-icon-more"
                title={tr("common.more")}
                aria-label={tr("common.more")}
                onClick={() => setIconLimit((current) => current + ICON_PAGE_SIZE)}
              >
                <MoreIcon aria-hidden="true" />
                <span>{tr("common.more")}</span>
              </button>
            )}
            {iconNames.length === 0 && <small className="muted">{tr("projectappearancedialog.loadingIconLibrary")}</small>}
            {iconNames.length > 0 && iconResults.length === 0 && <small className="muted">{tr("projectappearancedialog.noIconsMatchThatSearch")}</small>}
          </div>

          <div className={`project-icon-upload-row${uploadedIcon(icon) ? " has-upload" : ""}`}>
            <button type="button" className="project-icon-upload-button" onClick={() => uploadRef.current?.click()}>
              <span className="project-icon-upload-glyph" aria-hidden="true"><UploadIcon /></span>
              <span className="project-icon-upload-copy">
                <strong>{tr("projectappearancedialog.uploadSvgIcoOrPng")}</strong>
                <small>{tr("projectappearancedialog.chooseAnSvgIcoOrPngIcon")}</small>
              </span>
              {uploadedIcon(icon) && <img className="project-icon-preview" src={icon} alt="" />}
            </button>
            {icon && (
              <Button size="sm" className="project-icon-clear" onClick={() => setIcon("")}>
                {tr("projectappearancedialog.clear")}
              </Button>
            )}
            <input
              ref={uploadRef}
              type="file"
              accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.png,.svg,.ico"
              hidden
              onChange={(event) => void upload(event)}
            />
          </div>
        </div>

        <div className="project-appearance-field project-color-field">
          <span>{tr("projectappearancedialog.color")}</span>
          <div className="project-color-presets" role="group" aria-label={tr("projectappearancedialog.color")}>
            {COLOR_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={color.toLocaleLowerCase() === preset ? "selected" : ""}
                style={{ "--swatch-color": preset } as CSSProperties}
                aria-label={`${tr("projectappearancedialog.color")} ${preset}`}
                aria-pressed={color.toLocaleLowerCase() === preset}
                onClick={() => setColor(preset)}
              />
            ))}
            <label
              className={`project-color-custom${COLOR_PRESETS.includes(color.toLocaleLowerCase() as typeof COLOR_PRESETS[number]) ? "" : " selected"}`}
              aria-label={tr("projectappearancedialog.color")}
            >
              <input
                type="color"
                value={color}
                aria-label={tr("projectappearancedialog.color")}
                onChange={(event) => setColor(event.target.value)}
              />
              <span aria-hidden="true">+</span>
            </label>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
