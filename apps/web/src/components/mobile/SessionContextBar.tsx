// UX-MOBILE-01 §5/§6/§8: the compact project/branch context bar docked above
// the composer on the fresh-session screen. Both targets stay one tap away
// without splitting the page between the headline and the composer; each
// trigger opens the shared bottom sheet to switch.
import { useState } from "react";
import Sheet, { SheetRow } from "./Sheet.tsx";
import { Icon } from "../../icons.tsx";
import { useShellMode } from "../../responsiveShell.ts";
import { dismissKeyboard } from "../../mobileViewport.ts";
import { tapFeedback } from "../../haptics.ts";

/** One switchable target: a project or a branch/worktree destination. */
export interface ContextChoice {
  id: string;
  label: string;
  detail: string;
}

export default function SessionContextBar({
  projectName,
  projects,
  onPickProject,
  branchName,
  branches,
  branchLoading,
  onPickBranch,
}: {
  projectName: string;
  projects: ContextChoice[];
  onPickProject: (id: string) => void;
  branchName: string;
  branches: ContextChoice[];
  branchLoading?: boolean;
  onPickBranch: (id: string) => void;
}) {
  const phone = useShellMode() === "phone";
  const [open, setOpen] = useState<"project" | "branch" | null>(null);

  // §22: never raise a sheet under an open keyboard.
  const openPicker = (which: "project" | "branch") => {
    if (phone) void dismissKeyboard().then(() => setOpen(which));
    else setOpen(which);
  };
  const pick = (choose: () => void) => {
    if (phone) tapFeedback();
    choose();
    setOpen(null);
  };

  return (
    <div className="session-context-bar">
      <span className="context-selector">
        <button
          type="button"
          className="context-trigger"
          title={projectName}
          aria-label={`Project for new session, current ${projectName}`}
          aria-haspopup="dialog"
          aria-expanded={open === "project"}
          onClick={() => openPicker("project")}
        >
          <span className="context-trigger-icon" aria-hidden="true"><Icon.files /></span>
          <span className="context-trigger-name">{projectName}</span>
          <span className="context-trigger-caret" aria-hidden="true"><Icon.chevronDown /></span>
        </button>
      </span>
      <span className="context-sep" aria-hidden="true" />
      <span className="context-selector">
        <button
          type="button"
          className="context-trigger"
          title={branchName}
          aria-label={`Branch for new session, current ${branchName}`}
          aria-haspopup="dialog"
          aria-expanded={open === "branch"}
          disabled={branchLoading === true}
          onClick={() => openPicker("branch")}
        >
          <span className="context-trigger-icon" aria-hidden="true"><Icon.branch /></span>
          <span className="context-trigger-name">{branchLoading ? "Loading…" : branchName}</span>
          <span className="context-trigger-caret" aria-hidden="true"><Icon.chevronDown /></span>
        </button>
      </span>
      {open === "project" && (
        <Sheet title="Project" onClose={() => setOpen(null)}>
          <div role="listbox" aria-label="Projects">
            {projects.map((choice) => (
              <SheetRow
                key={choice.id}
                title={choice.label}
                {...(choice.detail ? { meta: choice.detail } : {})}
                selected={choice.label === projectName}
                onClick={() => pick(() => onPickProject(choice.id))}
              />
            ))}
            {projects.length === 0 && <p className="sheet-empty">No projects yet</p>}
          </div>
        </Sheet>
      )}
      {open === "branch" && (
        <Sheet title="Branch" onClose={() => setOpen(null)}>
          <div role="listbox" aria-label="Branches">
            {branches.map((choice) => (
              <SheetRow
                key={choice.id}
                title={choice.label}
                {...(choice.detail ? { meta: choice.detail } : {})}
                selected={choice.label === branchName}
                onClick={() => pick(() => onPickBranch(choice.id))}
              />
            ))}
            {branches.length === 0 && <p className="sheet-empty">No branches found</p>}
          </div>
        </Sheet>
      )}
    </div>
  );
}
