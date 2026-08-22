// UX-ONBOARDING: the first-run coordinator. One pure decision function maps
// project-registry truth to the surface the shell shows; App executes the
// result. Project setup is considered only after a valid project is active in
// a ready registry.
//
// The automatic-picker episode is in-memory, per document: it becomes true when
// the automatic picker opens and stays true after cancellation so an effect
// cannot immediately reopen it. It is never written to storage — reloading a
// still-empty runtime offers the picker again.

export type FirstRunSurface =
  | "project-loading"
  | "project-failed"
  | "project-picker"
  | "project-setup"
  | "workspace";

export interface FirstRunInput {
  registryStatus: "loading" | "failed" | "ready";
  projectCount: number;
  /** activeProjectId names a project in the ready registry. */
  hasValidActiveProject: boolean;
  /** The automatic picker already opened in this document. */
  pickerOfferedThisDocument: boolean;
  projectSetup: "unseen" | "completed";
}

/** The exact decision table from the specification. `workspace` covers both
 *  the recoverable no-project shell (ready empty, picker episode spent) and
 *  the transient restore-then-decide-again row (ready nonempty, no valid
 *  active project — restoration happens in the same publish transition). */
export function decideFirstRunSurface(input: FirstRunInput): FirstRunSurface {
  if (input.registryStatus === "loading") return "project-loading";
  if (input.registryStatus === "failed") return "project-failed";
  if (input.projectCount === 0) {
    return input.pickerOfferedThisDocument ? "workspace" : "project-picker";
  }
  if (!input.hasValidActiveProject) return "workspace";
  return input.projectSetup === "unseen" ? "project-setup" : "workspace";
}

// ---- per-document automatic-picker episode -------------------------------------

let autoPickerOffered = false;

export function wasAutoPickerOffered(): boolean {
  return autoPickerOffered;
}

/** Record that the automatic picker opened. Cancellation does not reset it;
 *  the two named `Choose a folder…` actions reopen the picker explicitly. */
export function markAutoPickerOffered(): void {
  autoPickerOffered = true;
}

/** Test seam only — a browser document never resets its episode. */
export function resetAutoPickerEpisodeForTest(): void {
  autoPickerOffered = false;
}
