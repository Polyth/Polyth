import { useEffect, useRef, useState } from "react";
import type { Project, ProjectComposition } from "@polyth/contracts";
import { setNextProjectComposition } from "@polyth/session/web-api";
import ProjectFolderDialog from "./ProjectFolderDialog.tsx";
import ProjectCompositionEditor, { emptyProjectComposition } from "./ProjectCompositionEditor.tsx";
import Dialog from "./a11y/Dialog.tsx";
import { Button } from "./ui/index.ts";
import { getState } from "../store.ts";
import { updateProjectAppearance } from "../init.ts";
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
      setError("The project was created but could not be resolved. Refresh projects and try again.");
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
      <Dialog title="Preparing your workspace" onClose={() => {}} size="sm" className="project-setup-flow-dialog">
        <div className="project-setup-progress" role="status" aria-live="polite">
          <div className="project-setup-spinner" aria-hidden="true" />
          <div><strong>Applying project setup…</strong><p>Keeping your package choices and workspace recommendations project-local.</p></div>
        </div>
      </Dialog>
    );
  }

  if (stage === "error") {
    return (
      <Dialog title="Finish project setup" onClose={compositionPersisted ? cancel : () => {}} size="sm" className="project-setup-flow-dialog">
        <div className="project-setup-error" role="alert">{error || "Project setup did not finish."}</div>
        <div className="project-setup-actions">
          {compositionPersisted && <Button variant="ghost" onClick={cancel}>Open anyway</Button>}
          <Button variant="primary" onClick={() => project && void finish(project)} disabled={!project}>Retry</Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Set up your project" onClose={cancel} size="lg" className="project-setup-flow-dialog">
      <div className="project-setup-intro">
        <span className="project-setup-step">Workspace</span>
        <h2>Shape the workspace around what you’re doing</h2>
        <p>Pick one or more directions. This only changes what Polyth surfaces first; globally enabled packages and permissions stay separate.</p>
      </div>
      <ProjectCompositionEditor value={composition} onChange={setComposition} />
      <div className="project-setup-actions">
        <Button variant="ghost" onClick={cancel}>Cancel</Button>
        <Button variant="primary" onClick={continueToPicker}>Choose project source</Button>
      </div>
    </Dialog>
  );
}
