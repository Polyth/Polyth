import { useEffect, useRef, useState } from "react";
import type { Project, ProjectComposition } from "@polyth/contracts";
import { setNextProjectComposition } from "@polyth/session/web-api";
import ProjectFolderDialog from "./ProjectFolderDialog.tsx";
import ProjectCompositionEditor, { emptyProjectComposition } from "./ProjectCompositionEditor.tsx";
import Dialog from "./a11y/Dialog.tsx";
import { Button, ChevronRightIcon, Spinner } from "./ui/index.ts";
import { getState } from "../store.ts";
import { updateProjectAppearance } from "../init.ts";
import { tr } from "../i18n/index.ts";
import { setProjectCompositionContext } from "../packages/projectRelevance.ts";
import { projectSetupRecovery } from "../projectCompositionPlan.ts";
import { seedInitialProjectWorkspace } from "../projectCompositionSeed.ts";
import { isSharedProjectInterface } from "../projectInterfaceScope.ts";
import "./ProjectSetupFlowDialog.css";

const sameComposition = (left: ProjectComposition | undefined, right: ProjectComposition): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right);

export default function ProjectSetupFlowDialog({ onClose }: { onClose: () => void }) {
  // With one interface for every project the directions step has nothing to
  // shape: the project starts as General and the flow is the folder picker.
  const [sharedInterface] = useState(isSharedProjectInterface);
  const [stage, setStage] = useState<"compose" | "picker" | "finalizing" | "error">(() => sharedInterface ? "picker" : "compose");
  const [composition, setComposition] = useState<ProjectComposition>(() => emptyProjectComposition());
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");
  const [compositionPersisted, setCompositionPersisted] = useState(false);
  const createdRef = useRef(false);

  useEffect(() => {
    if (sharedInterface) setNextProjectComposition(composition);
    return () => setNextProjectComposition(undefined);
  }, []);

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
      // The shared arrangement is the person's own; a new project never reseeds it.
      if (!sharedInterface) await seedInitialProjectWorkspace(target.id, composition);
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
      // The source has already completed its mutation but the shell cannot yet
      // resolve the authoritative project. Closing is safe: a later registry
      // refresh can reveal the already-created project without another write.
      setProject(null);
      setError(tr("projectcomposition.createdNotResolved"));
      setStage("error");
      return;
    }

    // Clone/SSH-style sources may activate the project before its composition
    // PATCH has completed. Set the selected composition as presentation context
    // synchronously so queued relevance/widget reconciliation cannot observe a
    // transient legacy "everything relevant" project and seed wrong defaults.
    // The server PATCH in finish() remains the durable authority and this seam
    // never changes package lifecycle or permissions.
    if (!sharedInterface) setProjectCompositionContext(active.id, composition);
    setProject(active);
    setCompositionPersisted(sameComposition(active.composition, composition));
    void finish(active);
  };

  /** Back from the picker keeps the chosen directions; Continue re-arms the
   *  pending composition. */
  const backToCompose = () => {
    setNextProjectComposition(undefined);
    setStage("compose");
  };

  const pickerClosed = () => {
    // ProjectFolderDialog calls onOpened immediately before onClose after a
    // successful source action. The ref makes that second callback a no-op;
    // finalization now owns the outer flow.
    if (createdRef.current) return;
    cancel();
  };

  if (stage === "picker") {
    return (
      <ProjectFolderDialog
        onClose={pickerClosed}
        onOpened={projectOpened}
        onBack={sharedInterface ? undefined : backToCompose}
        {...(sharedInterface ? {} : { subtitle: tr("projectcomposition.pickerSubtitle") })}
      />
    );
  }

  if (stage === "finalizing") {
    return (
      <Dialog title={tr("projectcomposition.preparingWorkspace")} onClose={() => {}} size="md" className="project-setup-flow-dialog project-setup-flow-dialog-compact">
        <div className="project-setup-progress" role="status" aria-live="polite">
          <Spinner size="md" />
          <div><strong>{tr("projectcomposition.applyingSetup")}</strong><p>{tr("projectcomposition.applyingSetupHint")}</p></div>
        </div>
      </Dialog>
    );
  }

  if (stage === "error") {
    const recovery = projectSetupRecovery(compositionPersisted, project !== null);
    return (
      <Dialog title={tr("projectcomposition.finishSetup")} onClose={recovery.canExit ? cancel : () => {}} size="md" className="project-setup-flow-dialog project-setup-flow-dialog-compact">
        <div className="project-setup-error" role="alert">{error || tr("projectcomposition.setupFailed")}</div>
        <div className="project-setup-actions">
          {recovery.exitKind && <Button variant="ghost" onClick={cancel}>{recovery.exitKind === "open-anyway" ? tr("projectcomposition.openAnyway") : tr("common.close")}</Button>}
          {recovery.canRetry && project && <Button variant="primary" onClick={() => void finish(project)}>{tr("common.retry")}</Button>}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={tr("projectcomposition.setupTitle")} onClose={cancel} size="lg" className="project-setup-flow-dialog">
      <div className="project-setup-intro">
        <span className="project-setup-step">{tr("projectcomposition.setupStep")}</span>
        <h2>{tr("projectcomposition.whatAreYouWorkingOn")}</h2>
        <p>{tr("projectcomposition.setupHint")}</p>
      </div>
      {/* One scroll region from the directions down to the actions: a short
          window must not trap the expanded Workspace list in its own box. */}
      <div className="project-setup-scroll">
        <ProjectCompositionEditor value={composition} onChange={setComposition} purposeHeading={false} />
        <div className="project-setup-actions">
          <Button variant="ghost" onClick={cancel}>{tr("common.cancel")}</Button>
          <Button variant="primary" iconEnd={ChevronRightIcon} onClick={continueToPicker}>{tr("common.continue")}</Button>
        </div>
      </div>
    </Dialog>
  );
}
