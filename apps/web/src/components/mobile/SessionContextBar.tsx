// The "where am I?" row. Project and branch live
// directly above the composer as compact selectors — no permanent Project /
// Branch labels, no full-width fields in the middle of the screen. The whole
// name is the touch target (never a 12px chevron), long names truncate with an
// ellipsis instead of widening the viewport, and both use the shared picker.
// A multi-repository project adds its repository scope between the two, so
// the row reads in the order the choices depend on each other:
// project › repositories › checkout of the execution repository › isolation.
import { useId } from "react";
import type { Project } from "@polyth/contracts";
import Picker from "../Picker.tsx";
import Switch from "../ui/Switch.tsx";
import ProjectPicker from "../ui/ProjectPicker.tsx";
import { LockIcon, RepositoriesIcon, UnlockIcon } from "../ui/icons.ts";
import { Icon } from "../../icons.tsx";
import { tr } from "../../i18n/index.ts";
import {
  ALL_REPOSITORIES,
  normalizeRepositoryScope,
  repositoryPathTail,
  repositoryScopeAliases,
  repositoryScopeValues,
  toggleRepositoryScope,
  type ScopeRepository,
} from "../../composer/repositoryScope.ts";

export interface ContextChoice {
  id: string;
  label: string;
  detail?: string;
}

/** A project row carries its appearance so the picker shows its own glyph. */
export type ProjectContextChoice = ContextChoice & Pick<Project, "icon" | "color" | "remote">;

export type RepositoryContextChoice = ScopeRepository;

function ContextSelector({
  value,
  selectedId,
  choices,
  lockedReason,
  ariaLabel,
  repositoryAlias,
  onPick,
  onOpen: requestedOpen,
  onRefresh,
  refreshing,
}: {
  value: string;
  selectedId?: string;
  choices: ContextChoice[];
  /** The checkout cannot be chosen here. Opening the chip explains why —
   *  a disabled control would leave touch users without the reason. */
  lockedReason?: string;
  ariaLabel: string;
  /** Multi-repository projects name the repository the checkout belongs to. */
  repositoryAlias?: string;
  onPick: (id: string) => void;
  onOpen?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  // A locked checkout has nothing to fetch: opening only explains it.
  const onOpen = lockedReason ? undefined : requestedOpen;
  const current = lockedReason ? undefined : selectedId ?? choices.find((choice) => choice.label === value)?.id;
  const label = repositoryAlias
    ? `${tr("mobile.sessioncontextbar.worktree")} · ${repositoryAlias}`
    : tr("mobile.sessioncontextbar.worktree");
  return (
    <Picker
      className={`context-selector context-selector-branch${lockedReason ? " is-locked" : ""}`}
      label={label}
      items={lockedReason ? [] : choices.map((choice) => ({ ...choice, group: "" }))}
      popoverClassName={`context-picker-pop${lockedReason ? " context-picker-note" : ""}`}
      value={current}
      onPick={onPick}
      {...(onOpen ? { onOpen } : {})}
      placeholder={value}
      {...(repositoryAlias ? {
        displayValue: (
          <>
            <span className="context-checkout-repo">{repositoryAlias}</span>
            <span className="context-checkout-slash" aria-hidden="true">/</span>
            {(current ? choices.find((choice) => choice.id === current)?.label : undefined) ?? value}
          </>
        ),
      } : {})}
      searchPlaceholder={tr("worktreesessiondialog.filterByBranchOrPath")}
      {...(lockedReason ? { searchable: false } : {})}
      {...(onRefresh && !lockedReason ? {
        footerAction: {
          label: refreshing ? tr("common.loading") : tr("common.refresh"),
          run: onRefresh,
          stayOpen: true,
        },
      } : {})}
      ariaLabel={ariaLabel}
      emptyMessage={lockedReason ?? tr("mobile.sessioncontextbar.nothingToChooseHereYet")}
      triggerIcon={<Icon.branch />}
    />
  );
}

/** Which repositories a new chat can work in. "All" is the default and stays
 *  dynamic until the first send; a subset always keeps one repository. */
function RepositorySelector({
  repositories,
  selected,
  primaryRepositoryId,
  onPick,
  onManage,
}: {
  repositories: readonly RepositoryContextChoice[];
  selected: readonly string[] | undefined;
  primaryRepositoryId?: string;
  onPick: (repositoryIds: string[] | undefined) => void;
  onManage?: () => void;
}) {
  const scope = normalizeRepositoryScope(repositories, selected);
  const total = String(repositories.length);
  const summary = scope
    ? repositoryScopeAliases(repositories, scope)
    : tr("mobile.sessioncontextbar.allRepos", { count: total });
  const items = [
    {
      id: ALL_REPOSITORIES,
      label: tr("mobile.sessioncontextbar.allRepositories"),
      detail: tr("mobile.sessioncontextbar.allRepositoriesDetail", { count: total }),
      group: "",
    },
    ...repositories.map((repository) => ({
      id: repository.id,
      label: repository.alias,
      detail: repository.id === primaryRepositoryId
        ? tr("mobile.sessioncontextbar.agentStartsHere")
        : repositoryPathTail(repository.path),
      group: "",
    })),
  ];
  return (
    <Picker
      className={`context-selector context-selector-repos${scope ? " is-subset" : ""}`}
      label={tr("mobile.sessioncontextbar.repositories")}
      items={items}
      values={repositoryScopeValues(repositories, selected)}
      onPick={(id) => onPick(toggleRepositoryScope(repositories, scope, id))}
      popoverClassName="context-picker-pop context-repos-pop"
      searchable={repositories.length > 8}
      ariaLabel={tr("mobile.sessioncontextbar.repositoriesCurrentValue", { value: summary })}
      triggerIcon={<RepositoriesIcon />}
      displayValue={(
        <>
          <span className="context-repos-full">{summary}</span>
          <span className="context-repos-short" aria-hidden="true">
            {scope ? `${scope.length}/${total}` : tr("mobile.sessioncontextbar.allShort")}
          </span>
        </>
      )}
      {...(onManage ? {
        footerAction: { label: tr("mobile.sessioncontextbar.manageRepositories"), run: onManage },
      } : {})}
    />
  );
}

export interface SessionContextBarProps {
  projectName: string;
  projectId?: string;
  projects: ProjectContextChoice[];
  onPickProject: (id: string) => void;
  /** Present only for projects with two or more repositories. */
  repositories?: RepositoryContextChoice[];
  /** The new chat's repository scope; omitted means every repository. */
  repositoryIds?: readonly string[];
  primaryRepositoryId?: string;
  onPickRepositories?: (repositoryIds: string[] | undefined) => void;
  onManageRepositories?: () => void;
  /** Alias of the repository the checkout picker applies to (multi-repo). */
  checkoutRepositoryAlias?: string;
  /** The checkout cannot be chosen (the primary repository is out of scope);
   *  opening the checkout chip shows this reason instead of choices. */
  branchLockedReason?: string;
  branchName: string;
  branchId?: string;
  branches: ContextChoice[];
  onPickBranch: (id: string) => void;
  /** Fired the first time the branch picker opens — used to fetch the remote
   *  so server-only branches appear in the list. */
  onBranchPickerOpen?: () => void;
  /** Explicit remote refresh shown in the picker footer. */
  onRefreshBranches?: () => void;
  branchRefreshing?: boolean;
  /** Start the new session in a managed checkout based on the selected live
   *  worktree. Passed only when the project enabled isolation and has Git;
   *  then it stays visible beside location instead of hiding in it. */
  workInIsolation?: boolean;
  onToggleWorkInIsolation?: (on: boolean) => void;
  /** The person switched the Isolate control off for new chats. Hiding it
   *  keeps `workInIsolation` as the project default set it. */
  showIsolation?: boolean;
}

export default function SessionContextBar({
  projectName,
  projectId,
  projects,
  onPickProject,
  repositories,
  repositoryIds,
  primaryRepositoryId,
  onPickRepositories,
  onManageRepositories,
  checkoutRepositoryAlias,
  branchLockedReason,
  branchName,
  branchId,
  branches,
  onPickBranch,
  onBranchPickerOpen,
  onRefreshBranches,
  branchRefreshing,
  workInIsolation,
  onToggleWorkInIsolation,
  showIsolation = true,
}: SessionContextBarProps) {
  const isolationLabelId = useId();
  const multiRepository = !!repositories && repositories.length > 1 && !!onPickRepositories;
  return (
    <div
      className={`session-context-bar${multiRepository ? " session-context-bar-repos" : ""}`}
      aria-label={tr("mobile.sessioncontextbar.chatLocation")}
    >
      <ProjectPicker
        className="context-selector context-selector-project"
        popoverClassName="context-picker-pop"
        label={tr("mobile.sessioncontextbar.project")}
        ariaLabel={tr("mobile.sessioncontextbar.projectCurrentValue", { projectName })}
        placeholder={projectName}
        projects={projects.map((choice) => ({
          id: choice.id,
          name: choice.label,
          path: choice.detail ?? choice.label,
          icon: choice.icon,
          color: choice.color,
          remote: choice.remote,
        }))}
        value={projectId ?? ""}
        onPick={onPickProject}
      />
      <span className="context-sep" aria-hidden="true" />
      {multiRepository && (
        <RepositorySelector
          repositories={repositories!}
          selected={repositoryIds}
          {...(primaryRepositoryId ? { primaryRepositoryId } : {})}
          onPick={onPickRepositories!}
          {...(onManageRepositories ? { onManage: onManageRepositories } : {})}
        />
      )}
      <ContextSelector
        value={branchName}
        selectedId={branchId}
        choices={branches}
        {...(branchLockedReason ? { lockedReason: branchLockedReason } : {})}
        ariaLabel={branchLockedReason
          ? `${tr("mobile.sessioncontextbar.repositoryWorktreeCurrentValue", { repository: checkoutRepositoryAlias ?? "", branchName })}. ${branchLockedReason}`
          : (multiRepository && checkoutRepositoryAlias
            ? tr("mobile.sessioncontextbar.repositoryWorktreeCurrentValue", { repository: checkoutRepositoryAlias, branchName })
            : tr("mobile.sessioncontextbar.worktreeCurrentValue", { branchName }))}
        {...(multiRepository && checkoutRepositoryAlias ? { repositoryAlias: checkoutRepositoryAlias } : {})}
        onPick={onPickBranch}
        {...(onBranchPickerOpen ? { onOpen: onBranchPickerOpen } : {})}
        {...(onRefreshBranches ? { onRefresh: onRefreshBranches } : {})}
        {...(branchRefreshing ? { refreshing: true } : {})}
      />
      {onToggleWorkInIsolation && showIsolation && (
        <span
          className="context-isolation-control"
          data-active={workInIsolation ? "true" : undefined}
          title={multiRepository ? tr("mobile.sessioncontextbar.isolateRepositoriesHint") : tr("isolation.workInIsolationHint")}
        >
          <span className="context-isolation-icon" aria-hidden="true">
            {workInIsolation ? <LockIcon /> : <UnlockIcon />}
          </span>
          <span id={isolationLabelId} className="context-isolation-label">
            {tr("isolation.isolate")}
          </span>
          <Switch
            checked={workInIsolation ?? false}
            onChange={onToggleWorkInIsolation}
            labelledBy={isolationLabelId}
          />
        </span>
      )}
    </div>
  );
}
