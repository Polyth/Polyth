// Add project. Who sees a folder picker follows from what the project is for:
//
//   Engineering   directions → folder picker → name, colour, icon. A repository
//                 is the point, so the folder comes first.
//   Anything else directions → name, colour, icon. Files go to the Polyth folder
//                 the server chooses; "Choose another" is one press away.
//
// A project in the Polyth folder is created when the window is confirmed, because
// the folder takes its name from the project and a folder in use cannot safely be
// renamed. A chosen folder already is a project by the time the window opens, so
// there the window can be skipped and leaving it keeps what the project has.
import { useEffect, useRef, useState } from "react";
import type { ManagedProjectLocationDto, Project, ProjectComposition } from "@polyth/contracts";
import { api, setNextProjectComposition } from "@polyth/session/web-api";
import ProjectFolderDialog from "./ProjectFolderDialog.tsx";
import ProjectCompositionEditor, { emptyProjectComposition } from "./ProjectCompositionEditor.tsx";
import ProjectIdentityStep from "./ProjectIdentityStep.tsx";
import Dialog from "./a11y/Dialog.tsx";
import { BackIcon, Button, ChevronRightIcon, CloseIcon, IconButton, Spinner } from "./ui/index.ts";
import { focusComposer, getState, setUiError } from "../store.ts";
import { createManagedProject, saveProjectAppearanceOptimistic, updateProjectAppearance } from "../init.ts";
import { tr, type TranslationKey } from "../i18n/index.ts";
import { friendlyError } from "../settings.ts";
import { setProjectCompositionContext } from "../packages/projectRelevance.ts";
import { projectSetupRecovery } from "../projectCompositionPlan.ts";
import { seedInitialProjectWorkspace } from "../projectCompositionSeed.ts";
import { persistProjectIcon } from "../projectIconPicker.ts";
import { loadProjectIconSvg } from "../projectIconLoader.ts";
import {
  nextProjectName,
  projectIconStarters,
  refreshProjectIdentityDraft,
  unusedProjectColor,
  type ProjectIdentityDraft,
} from "../projectIdentity.ts";
import { isSharedProjectInterface } from "../projectInterfaceScope.ts";
import "./ProjectSetupFlowDialog.css";

const sameComposition = (left: ProjectComposition | undefined, right: ProjectComposition): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right);

const newOperationId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** A name, colour and icon that already look right for these directions. */
function identityDefaults(composition: ProjectComposition, projectName?: string) {
  const projects = getState().projectRegistry.projects;
  const { directions } = composition;
  const base = directions.length === 1
    ? tr(`projectcomposition.direction.${directions[0]!}` as TranslationKey)
    : tr("projectcomposition.identityDefaultName");
  return {
    name: projectName ?? nextProjectName(base, projects.map((project) => project.name)),
    color: unusedProjectColor(projects.map((project) => project.color)),
    icon: projectIconStarters(directions)[0] ?? "",
  };
}

export default function ProjectSetupFlowDialog({ onClose }: { onClose: () => void }) {
  // With one interface for every project the directions step has nothing to
  // shape: the project starts as General and the flow starts at its name.
  const [sharedInterface] = useState(isSharedProjectInterface);
  const [stage, setStage] = useState<"compose" | "picker" | "identity" | "finalizing" | "error">(() => sharedInterface ? "identity" : "compose");
  /** Coming back from the picker to the directions returns focus to Continue,
   *  where the person left the step — not to the first direction card. */
  const [returning, setReturning] = useState(false);
  const [composition, setComposition] = useState<ProjectComposition>(() => emptyProjectComposition());
  const [draft, setDraft] = useState<ProjectIdentityDraft>(() => refreshProjectIdentityDraft(null, identityDefaults(emptyProjectComposition())));
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");
  const [identityError, setIdentityError] = useState("");
  const [compositionPersisted, setCompositionPersisted] = useState(false);
  const [location, setLocation] = useState<ManagedProjectLocationDto | null>(null);
  const [pickerBack, setPickerBack] = useState<"compose" | "identity">("compose");
  const createdRef = useRef(false);
  /** Set once a project in the Polyth folder is on its way: Retry repeats that
   *  path, and the same id lets a resend find the project a lost response made. */
  const managedOperationRef = useRef<string | null>(null);
  // Opening a project this person already has is switching to it, not making one.
  const knownProjectIdsRef = useRef(new Set(getState().projectRegistry.projects.map((item) => item.id)));

  useEffect(() => {
    let live = true;
    void api.managedProjectLocation()
      .then((value) => { if (live) setLocation(value); })
      .catch(() => undefined);
    return () => {
      live = false;
      setNextProjectComposition(undefined);
    };
  }, []);

  // Until the answer lands, assume the common case; the picker reports its own
  // errors, so this can only ever show one link too many for a moment.
  const canChooseFolder = location?.canChooseFolder ?? true;
  const folderFirst = canChooseFolder && !sharedInterface && composition.directions.includes("engineering");
  const totalSteps = folderFirst ? 3 : 2;

  const cancel = () => {
    setNextProjectComposition(undefined);
    onClose();
  };

  const leave = () => {
    setNextProjectComposition(undefined);
    onClose();
    focusComposer();
  };

  const openPicker = (backTo: "compose" | "identity") => {
    setNextProjectComposition(composition);
    createdRef.current = false;
    setReturning(false);
    // A failed Polyth-folder create says nothing about the folder chosen next.
    setIdentityError("");
    setPickerBack(backTo);
    setStage("picker");
  };

  const continueFromCompose = () => {
    if (folderFirst) {
      openPicker("compose");
      return;
    }
    setDraft((current) => refreshProjectIdentityDraft(current, identityDefaults(composition)));
    setIdentityError("");
    setStage("identity");
  };

  /** A chosen folder: the project exists, so settle its directions and workspace
   *  before asking how it should look. */
  const finishChosenFolder = async (target: Project) => {
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
      if (knownProjectIdsRef.current.has(target.id)) {
        onClose();
        return;
      }
      setDraft((previous) => refreshProjectIdentityDraft(previous, identityDefaults(composition, current.name)));
      setStage("identity");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage("error");
    }
  };

  /** The Polyth folder: this press is what creates the project. */
  const createInPolythFolder = async () => {
    const name = draft.name.trim();
    if (!name) return;
    setStage("finalizing");
    setError("");
    setIdentityError("");
    managedOperationRef.current ??= newOperationId();
    let created = project;
    try {
      created ??= await createManagedProject({ name, composition, clientOperationId: managedOperationRef.current });
      setProject(created);
      setCompositionPersisted(sameComposition(created.composition, composition));
      if (!sharedInterface) setProjectCompositionContext(created.id, composition);
      // A resend may find a project made before the person went back and changed
      // something, so what is on screen now is what gets saved.
      await updateProjectAppearance(created.id, {
        name,
        color: draft.color,
        icon: await persistProjectIcon(draft.icon, draft.color, loadProjectIconSvg),
        ...(sameComposition(created.composition, composition) ? {} : { composition }),
      });
      setCompositionPersisted(true);
      if (!sharedInterface) await seedInitialProjectWorkspace(created.id, composition);
      leave();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (created) {
        setError(message);
        setStage("error");
      } else {
        // Nothing is known to exist: back to the window, with every choice intact.
        setIdentityError(message);
        setStage("identity");
      }
    }
  };

  const saveChosenFolderIdentity = () => {
    if (!project) return;
    const name = draft.name.trim();
    if (!name) return;
    const { color, icon } = draft;
    void saveProjectAppearanceOptimistic(project.id, { name, color }, async () => ({
      name,
      color,
      icon: await persistProjectIcon(icon, color, loadProjectIconSvg),
    })).catch((cause: unknown) => setUiError(friendlyError(tr("common.error"), cause)));
    leave();
  };

  const projectOpened = () => {
    createdRef.current = true;
    managedOperationRef.current = null;
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
    // The server PATCH in finishChosenFolder() remains the durable authority and
    // this seam never changes package lifecycle or permissions.
    if (!sharedInterface) setProjectCompositionContext(active.id, composition);
    setProject(active);
    setCompositionPersisted(sameComposition(active.composition, composition));
    void finishChosenFolder(active);
  };

  /** Back from the picker keeps what was chosen; its step re-arms the composition
   *  the next time the picker opens. */
  const backFromPicker = () => {
    setNextProjectComposition(undefined);
    setReturning(pickerBack === "compose");
    setStage(pickerBack);
  };

  const pickerClosed = () => {
    // ProjectFolderDialog calls onOpened immediately before onClose after a
    // successful source action. The ref makes that second callback a no-op;
    // finalization now owns the outer flow.
    if (createdRef.current) return;
    cancel();
  };

  const retry = () => {
    if (managedOperationRef.current) void createInPolythFolder();
    else if (project) void finishChosenFolder(project);
  };

  if (stage === "picker") {
    return (
      <ProjectFolderDialog
        onClose={pickerClosed}
        onOpened={projectOpened}
        // Started from the Polyth-folder window, or with one interface for all:
        // the picker is a detour, not a numbered step.
        {...(pickerBack === "compose" && !sharedInterface
          ? { stepLabel: tr("projectcomposition.setupStep", { step: 2, total: totalSteps }) }
          : {})}
        subtitle={tr("projectcomposition.pickerHint")}
        onBack={backFromPicker}
      />
    );
  }

  if (stage === "identity") {
    const chosenFolder = project && !managedOperationRef.current ? project : null;
    const stepLabel = sharedInterface ? undefined : tr("projectcomposition.setupStep", { step: totalSteps, total: totalSteps });
    return (
      <ProjectIdentityStep
        draft={draft}
        onDraftChange={setDraft}
        directions={composition.directions}
        {...(stepLabel ? { stepLabel } : {})}
        hint={tr(chosenFolder && !draft.nameEdited ? "projectcomposition.identityHintFromFolder" : "projectcomposition.identityHint")}
        {...(chosenFolder ? { folderPath: chosenFolder.path } : {})}
        {...(location?.rootLabel ? { folderRootLabel: location.rootLabel } : {})}
        {...(!chosenFolder && canChooseFolder ? { onChooseFolder: () => openPicker("identity") } : {})}
        {...(identityError ? { error: identityError } : {})}
        primaryLabel={tr(chosenFolder ? "common.done" : "projectcomposition.identityCreate")}
        onPrimary={chosenFolder ? saveChosenFolderIdentity : () => void createInPolythFolder()}
        secondaryLabel={tr(chosenFolder ? "projectcomposition.identitySkip" : sharedInterface ? "common.cancel" : "common.back")}
        {...(!chosenFolder && !sharedInterface ? { secondaryIcon: BackIcon } : {})}
        onSecondary={chosenFolder ? leave : sharedInterface ? cancel : () => setStage("compose")}
        onClose={chosenFolder ? leave : cancel}
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
          {recovery.canRetry && project && <Button variant="primary" onClick={retry}>{tr("common.retry")}</Button>}
        </div>
      </Dialog>
    );
  }

  return (
    // The top-end X is the only control in the head, never the opening focus:
    // the first direction keeps the focus an unchanged step 1 gave it, so
    // Enter does not dismiss the dialog on open.
    <Dialog title={tr("projectcomposition.setupTitle")} onClose={cancel} size="lg" className="project-setup-flow-dialog project-setup-flow-step" initialFocus={returning ? ".project-setup-actions .ui-btn" : ".project-direction-card"}>
      {/* Both steps close from the same place: one X in the top-end corner.
          Step 1 keeps only Continue in its footer, so the way out never moves
          and the bottom bar never competes with the primary action. */}
      <div className="project-setup-head">
        <div className="project-setup-head-top">
          <span className="project-setup-step">{tr("projectcomposition.setupStep", { step: 1, total: totalSteps })}</span>
          <IconButton icon={CloseIcon} label={tr("common.close")} onClick={cancel} />
        </div>
        <h2 className="project-setup-title">{tr("projectcomposition.whatAreYouWorkingOn")}</h2>
        <p className="project-setup-hint">{tr("projectcomposition.setupHint")}</p>
      </div>
      {/* The directions scroll; the primary action is pinned below, exactly
          where step 2 keeps its own. */}
      <div className="project-setup-scroll">
        <ProjectCompositionEditor value={composition} onChange={setComposition} purposeHeading={false} />
      </div>
      <div className="project-setup-actions">
        <Button size="sm" variant="primary" iconEnd={ChevronRightIcon} onClick={continueFromCompose}>{tr("common.continue")}</Button>
      </div>
    </Dialog>
  );
}
