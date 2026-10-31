import { useEffect, useState } from "react";
import type { Project, ProjectComposition } from "@polyth/contracts";
import type { ProjectSettingsContribution } from "@polyth/web-sdk";
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
import { saveProjectAppearanceOptimistic } from "../init.ts";
import { setUiError } from "../store.ts";
import { friendlyError } from "../settings.ts";
import { listProjectSettings, subscribeProjectSettings } from "../projectSettings.ts";
import { PackageGlyph } from "./settings/packageIcons.tsx";
import { tr } from "../i18n/index.ts";
import { useProjectInterfaceMode } from "../projectInterfaceScope.ts";
import "./ProjectSettingsDialog.css";

type Page = "menu" | "appearance" | "workspace" | `contribution:${string}`;

function useProjectSettingsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}

export default function ProjectAppearanceDialog({ project, onClose, initialPage = "menu" }: { project: Project; onClose: () => void; initialPage?: Page }) {
  const [page, setPage] = useState<Page>(initialPage);
  const mobile = useProjectSettingsMobile();
  // A shared interface ignores a project's directions; Settings → Projects
  // explains the choice, so this menu does not offer a page with no effect.
  const sharedInterface = useProjectInterfaceMode() === "shared";
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [composition, setComposition] = useState<ProjectComposition>(() =>
    project.composition ? structuredClone(project.composition) : emptyProjectComposition());

  useEffect(() => subscribeProjectSettings(() => setSettingsVersion((value) => value + 1)), []);
  const contributions = listProjectSettings(project.id);
  const selectedContributionId = page.startsWith("contribution:") ? page.slice("contribution:".length) : "";
  const selectedContribution = selectedContributionId
    ? contributions.find((item) => item.id === selectedContributionId)
    : undefined;
  useEffect(() => {
    if (page.startsWith("contribution:") && !selectedContribution) setPage("menu");
  }, [page, selectedContributionId, settingsVersion]);

  if (selectedContribution) {
    return (
      <Dialog
        title={selectedContribution.label}
        onClose={onClose}
        size="lg"
        className="project-settings-dialog"
        initialFocus="button"
      >
        {selectedContribution.render({
          projectId: project.id,
          project,
          mobile,
          stage: "page",
          open: () => setPage(`contribution:${selectedContribution.id}`),
          onBack: () => setPage("menu"),
          onClose,
        })}
      </Dialog>
    );
  }

  if (page === "appearance") {
    return <ProjectAppearanceDialogCore project={project} onBack={() => setPage("menu")} onClose={onClose} />;
  }

  // Optimistic: relevance follows the new composition at once and the dialog
  // closes; a rejection restores it and reports through the shared notice.
  const saveWorkspace = () => {
    // Settings changes alter relevance only. Initial workspace seeding is a
    // creation-time operation and must never overwrite a user's layout here.
    void saveProjectAppearanceOptimistic(project.id, { composition }, async () => ({ composition }))
      .catch((cause: unknown) => setUiError(friendlyError(tr("common.error"), cause)));
    onClose();
  };

  if (page === "workspace") {
    return (
      <Dialog
        title={tr("projectcomposition.workspace")}
        onClose={onClose}
        size="lg"
        className="project-settings-dialog"
        initialFocus=".project-settings-page-intro .ui-btn"
        footer={(
          <>
            <Button size="sm" onClick={onClose}>{tr("common.cancel")}</Button>
            <Button size="sm" variant="primary" onClick={saveWorkspace}>{tr("common.save")}</Button>
          </>
        )}
      >
        <div className="project-settings-page-intro">
          <Button size="sm" variant="ghost" iconStart={BackIcon} onClick={() => setPage("menu")}>
            {tr("common.back")}
          </Button>
          <p>{tr("projectcomposition.settingsWorkspaceHint")}</p>
        </div>
        <ProjectCompositionEditor value={composition} onChange={setComposition} compact />
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
        {!sharedInterface && <button type="button" onClick={() => setPage("workspace")}>
          <span className="project-settings-menu-icon" aria-hidden="true"><Icon icon={WorkflowIcon} /></span>
          <span className="project-settings-menu-copy">
            <strong>{tr("projectcomposition.workspace")}</strong>
            <span>{tr("projectcomposition.workspaceMenuHint")}</span>
          </span>
          <Icon icon={ChevronRightIcon} size="sm" />
        </button>}
        {contributions.map((contribution: ProjectSettingsContribution) => (
          <button
            type="button"
            key={contribution.id}
            data-project-settings-contribution={contribution.id}
            onClick={() => setPage(`contribution:${contribution.id}`)}
          >
            <span className="project-settings-menu-icon" aria-hidden="true">
              <PackageGlyph icon={contribution.icon ?? "package"} size={18} strokeWidth={1.8} />
            </span>
            <span className="project-settings-menu-copy">
              <strong>{contribution.label}</strong>
              {contribution.description && <span>{contribution.description}</span>}
            </span>
            <Icon icon={ChevronRightIcon} size="sm" />
          </button>
        ))}
      </div>
    </Dialog>
  );
}
