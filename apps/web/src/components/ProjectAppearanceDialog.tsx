import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { Project } from "@polyth/contracts";
import { updateProjectAppearance } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { setUiError } from "../store.ts";
import Dialog from "./a11y/Dialog.tsx";
import { tr } from "../i18n/index.ts";

const DEFAULT_COLOR = "#9b4b2b";
const MAX_ICON_BYTES = 512 * 1024;
const iconPath = (name: string): string => `/assets/project-icons/${name}`;
const assetIcon = (icon: string): boolean => icon.startsWith("/assets/project-icons/");
const iconLabel = (name: string): string => name.replace(/\.svg$/, "").replaceAll("-", " ");

function uploadedIcon(icon: string): boolean { return icon.startsWith("data:image/"); }

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(tr("projectappearancedialog.couldnTReadThatIcon")));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(tr("projectappearancedialog.couldnTReadThatIcon")));
    reader.readAsDataURL(file);
  });
}

export default function ProjectAppearanceDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name);
  const [icon, setIcon] = useState(project.icon ?? "");
  const [color, setColor] = useState(project.color ?? DEFAULT_COLOR);
  const [saving, setSaving] = useState(false);
  const [iconNames, setIconNames] = useState<string[]>([]);
  const [iconQuery, setIconQuery] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    void fetch("/project-icons.json")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Icon library unavailable")))
      .then((names: unknown) => {
        if (active && Array.isArray(names) && names.every((name) => typeof name === "string")) setIconNames(names);
      })
      .catch(() => { /* Upload remains available if a deployment omits the bundled library. */ });
    return () => { active = false; };
  }, []);
  const visibleIcons = iconNames.filter((name) => iconLabel(name).includes(iconQuery.trim().toLowerCase()));
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
    try { setIcon(await readImage(file)); }
    catch (error) { setUiError(friendlyError(tr("projectappearancedialog.couldnTUploadProjectIcon"), error)); }
  };
  return (
    <Dialog title={tr("projectappearancedialog.projectAppearance")} onClose={onClose} size="md" className="project-appearance-dialog">
      <div className="project-appearance-body">
        <p>{tr("projectappearancedialog.setTheTitleAndMarkerShown")}</p>
        <label>{tr("projectappearancedialog.projectTitle")}<input autoFocus value={name} maxLength={120} placeholder={tr("projectappearancedialog.projectTitle")} aria-label={tr("projectappearancedialog.projectTitle")} onChange={(event) => setName(event.target.value)} /></label>
        <div className="project-icon-picker">
          <span className="project-appearance-label">{tr("projectappearancedialog.icon")}</span>
          <input className="project-icon-search" value={iconQuery} placeholder={tr("projectappearancedialog.searchItemIcons")} aria-label={tr("projectappearancedialog.searchProjectIcons")} onChange={(event) => setIconQuery(event.target.value)} />
          <div className="project-icon-options" role="radiogroup" aria-label={tr("projectappearancedialog.projectIconLibrary")}>
            {visibleIcons.map((name) => {
              const value = iconPath(name);
              return <button key={name} type="button" role="radio" title={iconLabel(name)} aria-label={iconLabel(name)} aria-checked={icon === value} className={icon === value ? "selected" : ""} onClick={() => setIcon(value)}><span className="project-icon-art" aria-hidden="true" style={{ backgroundColor: color, WebkitMaskImage: `url("${value}")`, maskImage: `url("${value}")` }} /></button>;
            })}
            {iconNames.length === 0 && <small className="muted">{tr("projectappearancedialog.loadingIconLibrary")}</small>}
            {iconNames.length > 0 && visibleIcons.length === 0 && <small className="muted">{tr("projectappearancedialog.noIconsMatchThatSearch")}</small>}
          </div>
          <div className="project-icon-upload-row">
            {uploadedIcon(icon) && <img className="project-icon-preview" src={icon} alt={tr("projectappearancedialog.selectedProjectIcon")} />}
            <button type="button" className="small-btn" onClick={() => uploadRef.current?.click()}>{tr("projectappearancedialog.uploadSvgIcoOrPng")}</button>
            {icon && <button type="button" className="small-btn" onClick={() => setIcon("")}>{tr("projectappearancedialog.clear")}</button>}
            <input ref={uploadRef} type="file" accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.png,.svg,.ico" hidden onChange={(event) => void upload(event)} />
          </div>
          <small>{assetIcon(icon) ? `${tr("projectappearancedialog.selectedValue", { name: iconLabel(icon.split("/").pop() ?? "") })} ` : ""}{tr("projectappearancedialog.chooseFromTheBundledIconLibrary")}</small>
        </div>
        <label>{tr("projectappearancedialog.color")}<span className="project-color-input"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /><code>{color}</code></span></label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>{tr("common.cancel")}</button>
          <button type="button" className="primary-btn" onClick={() => void save()} disabled={saving || !name.trim()}>{saving ? tr("common.saving") : tr("common.save")}</button>
        </div>
      </div>
    </Dialog>
  );
}
