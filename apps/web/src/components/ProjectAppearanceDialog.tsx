import { useState } from "react";
import type { Project, ProjectComposition } from "@polyth/contracts";
import ProjectAppearanceDialogCore from "./ProjectAppearanceDialogCore.tsx";
import ProjectCompositionEditor, { emptyProjectComposition } from "./ProjectCompositionEditor.tsx";
import Dialog from "./a11y/Dialog.tsx";
import { Button } from "./ui/index.ts";
import { updateProjectAppearance } from "../init.ts";
import "./ProjectSettingsDialog.css";

type Page = "menu" | "appearance" | "workspace";

export default function ProjectAppearanceDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [page, setPage] = useState<Page>("menu");
  const [composition, setComposition] = useState<ProjectComposition>(() =>
    project.composition ? structuredClone(project.composition) : emptyProjectComposition());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (page === "appearance") {
    return <ProjectAppearanceDialogCore project={project} onClose={onClose} />;
  }

  const saveWorkspace = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      // Settings changes alter relevance only. Initial workspace seeding is a
      // creation-time operation and must never overwrite a user's layout here.
      await updateProjectAppearance(project.id, { composition });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (page === "workspace") {
    return (
      <Dialog title="Project settings" onClose={onClose} size="lg" className="project-settings-dialog">
        <div className="project-settings-head">
          <Button size="sm" variant="ghost" onClick={() => setPage("menu")} disabled={saving}>Back</Button>
          <div><strong>Workspace</strong><span>Directions and project-local tool visibility.</span></div>
        </div>
        <ProjectCompositionEditor value={composition} onChange={setComposition} compact />
        {error && <div className="project-settings-error" role="alert">{error}</div>}
        <div className="project-settings-actions">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" busy={saving} onClick={() => void saveWorkspace()}>Save</Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Project settings" onClose={onClose} size="sm" className="project-settings-dialog">
      <div className="project-settings-project"><strong>{project.name}</strong><span>{project.path}</span></div>
      <div className="project-settings-menu">
        <button type="button" onClick={() => setPage("appearance")}>
          <strong>Appearance</strong><span>Name, icon and project color.</span><b aria-hidden="true">›</b>
        </button>
        <button type="button" onClick={() => setPage("workspace")}>
          <strong>Workspace</strong><span>Directions, recommendations and tool visibility.</span><b aria-hidden="true">›</b>
        </button>
      </div>
    </Dialog>
  );
}
