import { useEffect, useRef, useState } from "react";
import type { Project, ProjectComposition } from "@polyth/contracts";
import { setNextProjectComposition } from "@polyth/session/web-api";
import ProjectFolderDialog from "./ProjectFolderDialog.tsx";
import ProjectCompositionEditor, { emptyProjectComposition } from "./ProjectCompositionEditor.tsx";
import Dialog from "./a11y/Dialog.tsx";
import { Button } from "./ui/index.ts";
import { getState } from "../store.ts";
import { updateProjectAppearance } from "../init.ts";
import { tr } from "../i18n/index.ts";
import { seedInitialProjectWorkspace } from "../projectCompositionSeed.ts";
import "./ProjectSetupFlowDialog.css";

const sameComposition = (left: ProjectComposition | undefined, right: ProjectComposition): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right);

export default function ProjectSetupFlowDialog({ onClose }: { onClose: () => void }) {
  const [stage, setStage] = useState<"compose" | "picker" | "finalizing" | "error">("compose");
  const [composition, setComposition] = useState<ProjectComposition>(() => emptyProjectComposition());
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");
  const [compositionPersisted, setCompositionPersisted] = useState(false);
  const createdRef = useRef(false);

  useEffect(() => () => setNextProjectComposition(undefined), []);

  const cancel = () => {
    setNextProjectComposition(undefined);
    onClose();
  };

  const continueToPicker = () => {
    setNextProjectComposition(composition);
    createdRef.current = false;
    setStage("picker");
  };

  const finish = async (target: Project) => {
    setStage("finalizing");
    setError("");
    try {
      const current = getState().projectRegistry.projects.find((item) => item.id === target.id) ?? target;
      if (!sameComposition(current.composition, composition)) {
        await updateProjectAppearance(target.id, { composition });
      }
      setCompositionPersisted(true);
      await seedInitialProjectWorkspace(target.id, composition);
      setNextProjectComposition(undefined);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage("error");
    }
  };

  const projectOpened = () => {
    createdRef.current = true;
    const state = getState();
    const active = state.projectRegistry.projects.find((item) => item.id === state.activeProjectId) ?? null;
    if (!active) {
      setError(tr("projectcomposition.createdNotResolved"));
      setStage("error");
      return;
    }
    setProject(active);
    setCompositionPersisted(sameComposition(active.composition, composition));
    void finish(active);
  };

  const pickerClosed = () => {
    // ProjectFolderDialog calls onOpened immediately before onClose after a
    // successful source action. The ref makes that second callback a no-op;
    // finalization now owns the outer flow.
    if (createdRef.current) return;
    cancel();
  };

  if (stage === "picker") {
    return <ProjectFolderDialog onClose={pickerClosed} onOpened={projectOpened} />;
  }

  if (stage === "finalizing") {
    return (
      <Dialog title={tr("projectcomposition.preparingWorkspace")} onClose={() => {}} size="sm" className="project-setup-flow-dialog">
        <div className="project-setup-progress" role="status" aria-live="polite">
          <div className="project-setup-spinner" aria-hidden="true" />
          <div><strong>{tr("projectcomposition.applyingSetup")}</strong><p>{tr("projectcomposition.applyingSetupHint")}</p></div>
        </div>
      </Dialog>
    );
  }

  if (stage === "error") {
    return (
      <Dialog title={tr("projectcomposition.finishSetup")} onClose={compositionPersisted ? cancel : () => {}} size="sm" className="project-setup-flow-dialog">
        <div className="project-setup-error" role="alert">{error || tr("projectcomposition.setupFailed")}</div>
        <div className="project-setup-actions">
          {compositionPersisted && <Button variant="ghost" onClick={cancel}>{tr("projectcomposition.openAnyway")}</Button>}
          <Button variant="primary" onClick={() => project && void finish(project)} disabled={!project}>{tr("common.retry")}</Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={tr("projectcomposition.setupTitle")} onClose={cancel} size="lg" className="project-setup-flow-dialog">
      <div className="project-setup-intro">
        <span className="project-setup-step">{tr("projectcomposition.workspace")}</span>
        <h2>{tr("projectcomposition.setupHeadline")}</h2>
        <p>{tr("projectcomposition.setupHint")}</p>
      </div>
      <ProjectCompositionEditor value={composition} onChange={setComposition} />
      <div className="project-setup-actions">
        <Button variant="ghost" onClick={cancel}>{tr("common.cancel")}</Button>
        <Button variant="primary" onClick={continueToPicker}>{tr("projectcomposition.chooseProjectSource")}</Button>
      </div>
    </Dialog>
  );
}
