import type { Project } from "@polyth/contracts";
import { PERMISSION_RISK_REASONS } from "../src/risk.ts";
import ProjectGlyph from "../../../apps/web/src/components/ProjectGlyph.tsx";
import { Notice, Select } from "../../../apps/web/src/components/ui/index.ts";
import {
  EmptyState, ErrorState, ItemList, ItemRow, PageHead, SaveStatus, Section,
} from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import {
  confirmFullAccessDefault,
  saveProjectApprovalLevel,
  saveSpaceApprovalLevel,
  useApprovalSave,
  useFreshApprovalDefaults,
  type ApprovalDefaultsState,
  type ApprovalLevel,
} from "./approvalDefaults.ts";
import { APPROVAL_LEVEL_OPTIONS, ApprovalLevelChoices, ApprovalLevelSummary, approvalLevelTitle as levelTitle } from "./levels.tsx";

/** Every reason a request stays with a person under Auto-Approve. The
 *  Judgment code is not an assessment result, so it is not listed. */
const STILL_ASKS = PERMISSION_RISK_REASONS.filter((reason) => reason !== "outside-task");

type Save = ReturnType<typeof useApprovalSave>["save"];

/** Space-wide and per-project approval defaults. Each choice autosaves;
 *  making Full access a default takes two separate warnings first. */
export default function PermissionsSettingsPage() {
  const { state, loadError, reload } = useFreshApprovalDefaults();
  const { status, error, busy, save } = useApprovalSave();

  if (!state) {
    return (
      <>
        <PageHead blurb={tr("permissionbanner.settingsBlurb")} />
        <Section title={tr("permissionbanner.defaultLevelTitle")} hint={tr("permissionbanner.defaultLevelHint")} itemId="permissions.defaultLevel">
          {loadError !== null
            ? <ErrorState compact error={loadError} onRetry={reload} />
            : <EmptyState compact busy title={tr("common.loading")} />}
        </Section>
      </>
    );
  }

  const chooseSpace = async (level: ApprovalLevel) => {
    if (busy || level === state.level) return;
    if (level === "all" && !(await confirmFullAccessDefault())) return;
    await save(() => saveSpaceApprovalLevel(level));
  };

  return (
    <>
      <PageHead blurb={tr("permissionbanner.settingsBlurb")} />
      <Section
        title={tr("permissionbanner.defaultLevelTitle")}
        hint={state.canEdit ? tr("permissionbanner.defaultLevelHint") : tr("permissionbanner.defaultLevelReadOnly")}
        {...(state.canEdit ? { action: <SaveStatus state={status} {...(error ? { error } : {})} /> } : {})}
        itemId="permissions.defaultLevel"
      >
        {state.canEdit ? (
          <ApprovalLevelChoices
            label={tr("permissionbanner.defaultLevelTitle")}
            value={state.level}
            busy={busy}
            onChange={(level) => void chooseSpace(level)}
            choices={APPROVAL_LEVEL_OPTIONS.map((option) => ({
              value: option.level,
              level: option.level,
              icon: option.icon,
              title: tr(option.title),
              detail: tr(option.detail),
            }))}
          />
        ) : (
          <ApprovalLevelSummary level={state.level} />
        )}
        {state.level === "all" && (
          <div className="approval-notice">
            <Notice tone="warning" heading={tr("permissionbanner.defaultFullAccessOnHeading")}>
              {tr("permissionbanner.defaultFullAccessOn")}
            </Notice>
          </div>
        )}
        <details className="approval-still-asks">
          <summary>{tr("permissionbanner.stillAsks")}</summary>
          <p>{tr("permissionbanner.stillAsksHint")}</p>
          <ul>
            {STILL_ASKS.map((reason) => <li key={reason}>{tr(`permissionbanner.reason.${reason}`)}</li>)}
          </ul>
        </details>
      </Section>
      <ProjectLevels state={state} busy={busy} save={save} />
    </>
  );
}

/** Every project of the Space with the level its chats start from. */
function ProjectLevels({ state, busy, save }: { state: ApprovalDefaultsState; busy: boolean; save: Save }) {
  const registry = useStore((store) => store.projectRegistry);
  const projects = registry.status === "ready" ? registry.projects : [];
  const spaceDefault = tr("permissionbanner.useSpaceDefault", { level: levelTitle(state.level) });
  const choose = async (project: Project, value: string) => {
    const next = value === "inherit" ? "inherit" : value as ApprovalLevel;
    const own = state.projects[project.id]?.level;
    if (busy || next === (own ?? "inherit")) return;
    const after = next === "inherit" ? state.level : next;
    if (after === "all" && (own ?? state.level) !== "all" && !(await confirmFullAccessDefault(project.name))) return;
    await save(() => saveProjectApprovalLevel(project.id, next));
  };
  return (
    <Section title={tr("permissionbanner.projectsTitle")} hint={tr("permissionbanner.projectsHint")} itemId="permissions.projects">
      {projects.length === 0 ? (
        <EmptyState compact icon="folder" title={tr("permissionbanner.projectsEmpty")} />
      ) : (
        <ItemList label={tr("permissionbanner.projectsTitle")} className="approval-projects">
          {projects.map((project) => {
            const own = state.projects[project.id]?.level;
            const label = tr("permissionbanner.projectLevelFor", { project: project.name });
            return (
              <ItemRow
                key={project.id}
                icon={<ProjectGlyph project={project} />}
                title={project.name}
                description={project.path}
                data-approval-project={project.id}
                data-level={own ?? state.level}
                trailing={state.canEdit ? (
                  <Select
                    className="approval-project-level"
                    label={label}
                    ariaLabel={label}
                    searchable={false}
                    disabled={busy}
                    value={own ?? "inherit"}
                    options={[
                      { value: "inherit", label: spaceDefault },
                      ...APPROVAL_LEVEL_OPTIONS.map((option) => ({ value: option.level, label: tr(option.title) })),
                    ]}
                    onChange={(value) => void choose(project, value)}
                  />
                ) : (
                  <span className="approval-project-value">{own ? levelTitle(own) : spaceDefault}</span>
                )}
              />
            );
          })}
        </ItemList>
      )}
    </Section>
  );
}
