// UX-MOBILE-01 §5/§6/§8: the "where am I?" row. Project and branch live
// directly above the composer as compact selectors — no permanent Project /
// Branch labels, no full-width fields in the middle of the screen. The whole
// name is the touch target (never a 12px chevron), long names truncate with an
// ellipsis instead of widening the viewport, and both use the shared picker.
import { useId } from "react";
import Picker from "../Picker.tsx";
import Switch from "../ui/Switch.tsx";
import { Icon } from "../../icons.tsx";
import { tr } from "../../i18n/index.ts";

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
  ariaLabel,
  onPick,
  onOpen,
  onRefresh,
  refreshing,
}: {
  kind: "project" | "branch";
  value: string;
  selectedId?: string;
  choices: ContextChoice[];
  disabled?: boolean;
  ariaLabel: string;
  onPick: (id: string) => void;
  onOpen?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const current = selectedId ?? choices.find((choice) => choice.label === value)?.id;
  const label = kind === "project"
    ? tr("mobile.sessioncontextbar.project")
    : tr("mobile.sessioncontextbar.worktree");
  return (
    <Picker
      className={`context-selector context-selector-${kind}`}
      label={label}
      items={choices.map((choice) => ({ ...choice, group: "" }))}
      popoverClassName="context-picker-pop"
      value={current}
      onPick={onPick}
      {...(onOpen ? { onOpen } : {})}
      placeholder={value}
      {...(kind === "branch" ? {
        searchPlaceholder: tr("worktreesessiondialog.filterByBranchOrPath"),
      } : {})}
      {...(onRefresh ? {
        footerAction: {
          label: refreshing ? tr("common.loading") : tr("common.refresh"),
          run: onRefresh,
          stayOpen: true,
        },
      } : {})}
      ariaLabel={ariaLabel}
      disabled={disabled}
      emptyMessage={tr("mobile.sessioncontextbar.nothingToChooseHereYet")}
      triggerIcon={kind === "project" ? <Icon.files /> : <Icon.branch />}
    />
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
  /** Explicit remote refresh shown in the picker footer. */
  onRefreshBranches?: () => void;
  branchRefreshing?: boolean;
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
  onRefreshBranches,
  branchRefreshing,
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
        ariaLabel={tr("mobile.sessioncontextbar.worktreeCurrentValue", { branchName })}
        onPick={onPickBranch}
        {...(onBranchPickerOpen ? { onOpen: onBranchPickerOpen } : {})}
        {...(onRefreshBranches ? { onRefresh: onRefreshBranches } : {})}
        {...(branchRefreshing ? { refreshing: true } : {})}
      />
      {onToggleWorkInIsolation && (
        <span
          className="context-isolation-control"
          data-active={workInIsolation ? "true" : undefined}
          title={tr("isolation.workInIsolationHint")}
        >
          <span id={isolationLabelId} className="context-isolation-label">
            {tr("isolation.isolate")}
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
