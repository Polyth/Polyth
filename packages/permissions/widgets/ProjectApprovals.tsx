import type { Project } from "@polyth/contracts";
import { BackIcon, Button } from "../../../apps/web/src/components/ui/index.ts";
import { EmptyState, ErrorState, SaveStatus } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  confirmFullAccessDefault,
  saveProjectApprovalLevel,
  useApprovalSave,
  useFreshApprovalDefaults,
  type ApprovalLevel,
} from "./approvalDefaults.ts";
import { APPROVAL_LEVEL_OPTIONS, ApprovalLevelChoices, ApprovalLevelSummary, approvalLevelOption, approvalLevelTitle as levelTitle } from "./levels.tsx";

/** Project settings → Approvals: the level this project's chats start from,
 *  or the Space's. The same rules as Settings → Permissions apply. */
export default function ProjectApprovals({ project, onBack }: { project: Project; onBack(): void }) {
  const { state, loadError, reload } = useFreshApprovalDefaults();
  const { status, error, busy, save } = useApprovalSave();

  const body = () => {
    if (!state) {
      return loadError !== null
        ? <ErrorState compact error={loadError} onRetry={reload} />
        : <EmptyState compact busy title={tr("common.loading")} />;
    }
    const own = state.projects[project.id]?.level;
    if (!state.canEdit) {
      return own
        ? <ApprovalLevelSummary level={own} />
        : (
          <ApprovalLevelSummary
            level={state.level}
            title={tr("permissionbanner.followSpace")}
            detail={tr("permissionbanner.followSpaceDetail", { level: levelTitle(state.level) })}
          />
        );
    }
    const choose = async (value: ApprovalLevel | "inherit") => {
      if (busy || value === (own ?? "inherit")) return;
      const after = value === "inherit" ? state.level : value;
      if (after === "all" && (own ?? state.level) !== "all" && !(await confirmFullAccessDefault(project.name))) return;
      await save(() => saveProjectApprovalLevel(project.id, value));
    };
    const space = approvalLevelOption(state.level);
    return (
      <ApprovalLevelChoices<ApprovalLevel | "inherit">
        label={tr("permissionbanner.projectLevelFor", { project: project.name })}
        value={own ?? "inherit"}
        busy={busy}
        onChange={(value) => void choose(value)}
        choices={[
          {
            value: "inherit",
            level: state.level,
            icon: space.icon,
            title: tr("permissionbanner.followSpace"),
            detail: tr("permissionbanner.followSpaceDetail", { level: tr(space.title) }),
          },
          ...APPROVAL_LEVEL_OPTIONS.map((option) => ({
            value: option.level,
            level: option.level,
            icon: option.icon,
            title: tr(option.title),
            detail: tr(option.detail),
          })),
        ]}
      />
    );
  };

  return (
    <div className="approval-project-page">
      <div className="approval-project-intro">
        <Button size="sm" variant="ghost" iconStart={BackIcon} onClick={onBack}>{tr("common.back")}</Button>
        {state?.canEdit && <SaveStatus state={status} {...(error ? { error } : {})} />}
      </div>
      <p className="approval-project-hint">{tr("permissionbanner.projectSettingsHint")}</p>
      {body()}
    </div>
  );
}
