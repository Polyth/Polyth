import { useState } from "react";
import type { Project } from "@polyth/contracts";
import { updateProjectAppearance } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { setUiError } from "../store.ts";
import Dialog from "./a11y/Dialog.tsx";

const DEFAULT_COLOR = "#9b4b2b";

export default function ProjectAppearanceDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [icon, setIcon] = useState(project.icon ?? "");
  const [color, setColor] = useState(project.color ?? DEFAULT_COLOR);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateProjectAppearance(project.id, { icon: icon.trim(), color });
      onClose();
    } catch (error) {
      setUiError(friendlyError("Couldn’t update project appearance", error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog title="Project appearance" onClose={onClose} size="md" className="project-appearance-dialog">
      <div className="project-appearance-body">
        <p>Choose the small marker shown next to <strong>{project.name || project.path}</strong>.</p>
        <label>Icon<input autoFocus value={icon} maxLength={8} placeholder="Folder" aria-label="Project icon" onChange={(event) => setIcon(event.target.value)} /></label>
        <label>Color<span className="project-color-input"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /><code>{color}</code></span></label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="primary-btn" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </Dialog>
  );
}
