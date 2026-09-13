// UX-MOBILE-01 §5/§6/§8: the "where am I?" row. Project and branch live
// directly above the composer as compact selectors — no permanent Project /
// Branch labels, no full-width fields in the middle of the screen. The whole
// name is the touch target (never a 12px chevron), long names truncate with an
// ellipsis instead of widening the viewport, and both open the shared sheet.
import { useId, useState } from "react";
import Sheet, { SheetRow } from "./Sheet.tsx";
import Picker from "../Picker.tsx";
import Switch from "../ui/Switch.tsx";
import { Icon } from "../../icons.tsx";
import { dismissKeyboard } from "../../mobileViewport.ts";
import { useSheetTrigger } from "./sheetTrigger.ts";
import { tr } from "../../i18n/index.ts";
import { useShellMode } from "../../responsiveShell.ts";

export interface ContextChoice {
  id: string;
  label: string;
  detail?: string;
}

function ContextSelector({
  kind,
  value,
  selectedId,
  choices,
  disabled,
  sheetTitle,
  ariaLabel,
  onPick,
  onOpen,
}: {
  kind: "project" | "branch";
  value: string;
  selectedId?: string;
  choices: ContextChoice[];
  disabled?: boolean;
  sheetTitle: string;
  ariaLabel: string;
  onPick: (id: string) => void;
  onOpen?: () => void;
}) {
  const phone = useShellMode() === "phone";
  const [open, setOpen] = useState(false);
  const current = selectedId ?? choices.find((choice) => choice.label === value)?.id;
  // §22: open on pointer-down, then dismiss the keyboard — a click can be
  // swallowed by the reflow the dismissal causes (see sheetTrigger.ts).
  const triggerHandlers = useSheetTrigger(phone, () => {
    onOpen?.();
    setOpen(true);
    void dismissKeyboard();
  });
  if (!phone) {
    return (
      <Picker
        className={`context-selector context-selector-${kind}`}
        label={kind === "project"
          ? tr("mobile.sessioncontextbar.project")
          : tr("mobile.sessioncontextbar.worktree")}
        items={choices.map((choice) => ({ ...choice, group: "" }))}
        value={current}
        onPick={onPick}
        {...(onOpen ? { onOpen } : {})}
        placeholder={value}
        ariaLabel={ariaLabel}
        disabled={disabled}
        triggerIcon={kind === "project" ? <Icon.files /> : <Icon.branch />}
      />
    );
  }
  return (
    <div className={`context-selector context-selector-${kind}`}>
      <button
        type="button"
        className="context-trigger"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={value}
        disabled={disabled}
        {...triggerHandlers}
      >
        <span className="context-trigger-icon" aria-hidden="true">
          {kind === "project" ? <Icon.files /> : <Icon.branch />}
        </span>
        <span className="context-trigger-name">{value}</span>
        <span className="context-trigger-caret" aria-hidden="true"><Icon.chevronDown /></span>
      </button>
      {open && (
        <Sheet title={sheetTitle} className="context-sheet" onClose={() => setOpen(false)}>
          <div role="listbox" aria-label={sheetTitle}>
            {choices.map((choice) => (
              <SheetRow
                key={choice.id}
                title={choice.label}
                {...(choice.detail ? { meta: choice.detail } : {})}
                icon={kind === "project" ? <Icon.files /> : <Icon.branch />}
                selected={choice.id === current}
                onClick={() => {
                  onPick(choice.id);
                  setOpen(false);
                }}
              />
            ))}
            {choices.length === 0 && <p className="sheet-empty">{tr("mobile.sessioncontextbar.nothingToChooseHereYet")}</p>}
          </div>
        </Sheet>
      )}
    </div>
  );
}

export interface SessionContextBarProps {
  projectName: string;
  projectId?: string;
  projects: ContextChoice[];
  onPickProject: (id: string) => void;
  branchName: string;
  branchId?: string;
  branches: ContextChoice[];
  branchLoading?: boolean;
  onPickBranch: (id: string) => void;
  /** Fired the first time the branch picker opens — used to fetch the remote
   *  so server-only branches appear in the list. */
  onBranchPickerOpen?: () => void;
  /** Start the new session in a managed checkout based on the selected live
   *  worktree. This stays visible beside location instead of hiding in it. */
  workInIsolation?: boolean;
  onToggleWorkInIsolation?: (on: boolean) => void;
  isolationDisabled?: boolean;
}

export default function SessionContextBar({
  projectName,
  projectId,
  projects,
  onPickProject,
  branchName,
  branchId,
  branches,
  branchLoading,
  onPickBranch,
  onBranchPickerOpen,
  workInIsolation,
  onToggleWorkInIsolation,
  isolationDisabled,
}: SessionContextBarProps) {
  const isolationLabelId = useId();
  return (
    <div className="session-context-bar" aria-label={tr("mobile.sessioncontextbar.chatLocation")}>
      <ContextSelector
        kind="project"
        value={projectName}
        selectedId={projectId}
        choices={projects}
        sheetTitle={tr("mobile.sessioncontextbar.project")}
        ariaLabel={tr("mobile.sessioncontextbar.projectCurrentValue", { projectName })}
        onPick={onPickProject}
      />
      <span className="context-sep" aria-hidden="true" />
      <ContextSelector
        kind="branch"
        value={branchLoading ? tr("common.loading") : branchName}
        selectedId={branchId}
        choices={branches}
        {...(branchLoading ? { disabled: true } : {})}
        sheetTitle={tr("mobile.sessioncontextbar.branchOrWorktree")}
        ariaLabel={tr("mobile.sessioncontextbar.worktreeCurrentValue", { branchName })}
        onPick={onPickBranch}
        {...(onBranchPickerOpen ? { onOpen: onBranchPickerOpen } : {})}
      />
      {onToggleWorkInIsolation && (
        <span
          className="context-isolation-control"
          data-active={workInIsolation ? "true" : undefined}
          title={tr("isolation.workInIsolationHint")}
        >
          <span id={isolationLabelId} className="context-isolation-label">
            {tr("isolation.workInIsolation")}
          </span>
          <Switch
            checked={workInIsolation ?? false}
            onChange={onToggleWorkInIsolation}
            labelledBy={isolationLabelId}
            disabled={isolationDisabled}
          />
        </span>
      )}
    </div>
  );
}
