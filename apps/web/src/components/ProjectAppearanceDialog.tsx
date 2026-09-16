import { useState } from "react";
import type { Project, ProjectComposition } from "@polyth/contracts";
import ProjectAppearanceDialogCore from "./ProjectAppearanceDialogCore.tsx";
import ProjectCompositionEditor, { emptyProjectComposition } from "./ProjectCompositionEditor.tsx";
import Dialog from "./a11y/Dialog.tsx";
import { Button } from "./ui/index.ts";
import { updateProjectAppearance } from "../init.ts";
import { tr } from "../i18n/index.ts";
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
      <Dialog title={tr("projectcomposition.settingsTitle")} onClose={onClose} size="lg" className="project-settings-dialog">
        <div className="project-settings-head">
          <Button size="sm" variant="ghost" onClick={() => setPage("menu")} disabled={saving}>{tr("common.back")}</Button>
          <div><strong>{tr("projectcomposition.workspace")}</strong><span>{tr("projectcomposition.settingsWorkspaceHint")}</span></div>
        </div>
        <ProjectCompositionEditor value={composition} onChange={setComposition} compact />
        {error && <div className="project-settings-error" role="alert">{error}</div>}
        <div className="project-settings-actions">
          <Button variant="ghost" onClick={onClose} disabled={saving}>{tr("common.cancel")}</Button>
          <Button variant="primary" busy={saving} onClick={() => void saveWorkspace()}>{tr("common.save")}</Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={tr("projectcomposition.settingsTitle")} onClose={onClose} size="sm" className="project-settings-dialog">
      <div className="project-settings-project"><strong>{project.name}</strong><span>{project.path}</span></div>
      <div className="project-settings-menu">
        <button type="button" onClick={() => setPage("appearance")}>
          <strong>{tr("projectcomposition.appearance")}</strong><span>{tr("projectcomposition.appearanceHint")}</span><b aria-hidden="true">›</b>
        </button>
        <button type="button" onClick={() => setPage("workspace")}>
          <strong>{tr("projectcomposition.workspace")}</strong><span>{tr("projectcomposition.workspaceMenuHint")}</span><b aria-hidden="true">›</b>
        </button>
      </div>
    </Dialog>
  );
}
