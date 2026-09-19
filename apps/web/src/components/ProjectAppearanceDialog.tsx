import { useState } from "react";
import type { Project, ProjectComposition } from "@polyth/contracts";
import ProjectAppearanceDialogCore from "./ProjectAppearanceDialogCore.tsx";
import ProjectCompositionEditor, { emptyProjectComposition } from "./ProjectCompositionEditor.tsx";
import ProjectGlyph from "./ProjectGlyph.tsx";
import {
  BackIcon,
  Button,
  ChevronRightIcon,
  Dialog,
  Icon,
  PaletteIcon,
  WorkflowIcon,
} from "./ui/index.ts";
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
    return <ProjectAppearanceDialogCore project={project} onBack={() => setPage("menu")} onClose={onClose} />;
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
      <Dialog
        title={tr("projectcomposition.workspace")}
        onClose={onClose}
        size="lg"
        className="project-settings-dialog project-settings-workspace-dialog"
        initialFocus=".project-settings-page-intro .ui-btn"
        footer={(
          <>
            <Button size="sm" onClick={onClose} disabled={saving}>{tr("common.cancel")}</Button>
            <Button size="sm" variant="primary" busy={saving} onClick={() => void saveWorkspace()}>{tr("common.save")}</Button>
          </>
        )}
      >
        <div className="project-settings-page-intro">
          <Button size="sm" variant="ghost" iconStart={BackIcon} onClick={() => setPage("menu")} disabled={saving}>
            {tr("common.back")}
          </Button>
          <p>{tr("projectcomposition.settingsWorkspaceHint")}</p>
        </div>
        <ProjectCompositionEditor value={composition} onChange={setComposition} compact />
        {error && <div className="project-settings-error" role="alert">{error}</div>}
      </Dialog>
    );
  }

  return (
    <Dialog
      title={tr("projectcomposition.settingsTitle")}
      onClose={onClose}
      className="project-settings-dialog"
      initialFocus=".project-settings-menu button"
    >
      <div className="project-settings-project">
        <ProjectGlyph project={project} className="project-settings-project-glyph" />
        <div>
          <strong>{project.name}</strong>
          <span className="project-settings-project-path" title={project.path}>{project.path}</span>
        </div>
      </div>
      <div className="project-settings-menu">
        <button type="button" onClick={() => setPage("appearance")}>
          <span className="project-settings-menu-icon" aria-hidden="true"><Icon icon={PaletteIcon} /></span>
          <span className="project-settings-menu-copy">
            <strong>{tr("projectcomposition.appearance")}</strong>
            <span>{tr("projectcomposition.appearanceHint")}</span>
          </span>
          <Icon icon={ChevronRightIcon} size="sm" />
        </button>
        <button type="button" onClick={() => setPage("workspace")}>
          <span className="project-settings-menu-icon" aria-hidden="true"><Icon icon={WorkflowIcon} /></span>
          <span className="project-settings-menu-copy">
            <strong>{tr("projectcomposition.workspace")}</strong>
            <span>{tr("projectcomposition.workspaceMenuHint")}</span>
          </span>
          <Icon icon={ChevronRightIcon} size="sm" />
        </button>
      </div>
    </Dialog>
  );
}
