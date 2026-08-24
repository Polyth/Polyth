import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { Project } from "@polyth/contracts";
import { updateProjectAppearance } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { setUiError } from "../store.ts";
import Dialog from "./a11y/Dialog.tsx";

const DEFAULT_COLOR = "#9b4b2b";
const MAX_ICON_BYTES = 512 * 1024;
const iconPath = (name: string): string => `/assets/project-icons/${name}`;
const assetIcon = (icon: string): boolean => icon.startsWith("/assets/project-icons/");
const iconLabel = (name: string): string => name.replace(/\.svg$/, "").replaceAll("-", " ");

function uploadedIcon(icon: string): boolean { return icon.startsWith("data:image/"); }

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn’t read that icon."));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Couldn’t read that icon."));
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
      setUiError(friendlyError("Couldn’t update project appearance", error));
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
      setUiError("Choose an SVG, ICO, or PNG icon up to 512 KiB.");
      return;
    }
    try { setIcon(await readImage(file)); }
    catch (error) { setUiError(friendlyError("Couldn’t upload project icon", error)); }
  };
  return (
    <Dialog title="Project appearance" onClose={onClose} size="md" className="project-appearance-dialog">
      <div className="project-appearance-body">
        <p>Set the title and marker shown for this project in the sidebar.</p>
        <label>Project title<input autoFocus value={name} maxLength={120} placeholder="Project title" aria-label="Project title" onChange={(event) => setName(event.target.value)} /></label>
        <div className="project-icon-picker">
          <span className="project-appearance-label">Icon</span>
          <input className="project-icon-search" value={iconQuery} placeholder="Search item icons…" aria-label="Search project icons" onChange={(event) => setIconQuery(event.target.value)} />
          <div className="project-icon-options" role="radiogroup" aria-label="Project icon library">
            {visibleIcons.map((name) => {
              const value = iconPath(name);
              return <button key={name} type="button" role="radio" title={iconLabel(name)} aria-label={iconLabel(name)} aria-checked={icon === value} className={icon === value ? "selected" : ""} onClick={() => setIcon(value)}><span className="project-icon-art" aria-hidden="true" style={{ backgroundColor: color, WebkitMaskImage: `url("${value}")`, maskImage: `url("${value}")` }} /></button>;
            })}
            {iconNames.length === 0 && <small className="muted">Loading icon library…</small>}
            {iconNames.length > 0 && visibleIcons.length === 0 && <small className="muted">No icons match that search.</small>}
          </div>
          <div className="project-icon-upload-row">
            {uploadedIcon(icon) && <img className="project-icon-preview" src={icon} alt="Selected project icon" />}
            <button type="button" className="small-btn" onClick={() => uploadRef.current?.click()}>Upload SVG, ICO, or PNG</button>
            {icon && <button type="button" className="small-btn" onClick={() => setIcon("")}>Clear</button>}
            <input ref={uploadRef} type="file" accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.png,.svg,.ico" hidden onChange={(event) => void upload(event)} />
          </div>
          <small>{assetIcon(icon) ? `Selected: ${iconLabel(icon.split("/").pop() ?? "")}. ` : ""}Choose from the bundled icon library or upload an SVG, ICO, or PNG up to 512 KiB.</small>
        </div>
        <label>Color<span className="project-color-input"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /><code>{color}</code></span></label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="primary-btn" onClick={() => void save()} disabled={saving || !name.trim()}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </Dialog>
  );
}
