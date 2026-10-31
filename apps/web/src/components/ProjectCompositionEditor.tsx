import { useEffect, useMemo, useState } from "react";
import type { PackageDescriptorDto } from "@polyth/contracts";
import {
  PROJECT_DIRECTIONS,
  parseProjectComposition,
  resolveProjectComposition,
  type ProjectComposition,
  type ProjectDirection,
} from "@polyth/contracts/project-composition";
import { api } from "@polyth/session/web-api";
import { tr, type TranslationKey } from "../i18n/index.ts";
import { missingProjectPackageOverrides } from "../projectCompositionOverrides.ts";
import { listRegisteredCapabilities, railLauncherPackageIds, useCapabilityVersion } from "../capabilities.ts";
import {
  Button,
  ChartIcon,
  ChevronDownIcon,
  CoachIcon,
  CodeIcon,
  FlaskIcon,
  HomeIcon,
  Icon,
  LayersIcon,
  WorkflowIcon,
  type LucideIcon,
} from "./ui/index.ts";
import "./ProjectCompositionEditor.css";

const DIRECTION_COPY: Record<ProjectDirection, {
  label: TranslationKey;
  description: TranslationKey;
  icon: LucideIcon;
}> = {
  engineering: { label: "projectcomposition.direction.engineering", description: "projectcomposition.direction.engineeringDescription", icon: CodeIcon },
  research: { label: "projectcomposition.direction.research", description: "projectcomposition.direction.researchDescription", icon: FlaskIcon },
  wellbeing: { label: "projectcomposition.direction.wellbeing", description: "projectcomposition.direction.wellbeingDescription", icon: CoachIcon },
  finance: { label: "projectcomposition.direction.finance", description: "projectcomposition.direction.financeDescription", icon: ChartIcon },
  home: { label: "projectcomposition.direction.home", description: "projectcomposition.direction.homeDescription", icon: HomeIcon },
  operations: { label: "projectcomposition.direction.operations", description: "projectcomposition.direction.operationsDescription", icon: WorkflowIcon },
};

export const emptyProjectComposition = (): ProjectComposition => ({
  version: 1,
  directions: [],
  packageOverrides: {},
});

export function compositionPackages(
  value: ProjectComposition,
  packages: readonly PackageDescriptorDto[],
) {
  return resolveProjectComposition(value, packages.map((pkg) => ({
    id: pkg.id,
    enabled: pkg.enabled,
    category: pkg.category,
    projectAffinity: pkg.projectAffinity,
  })));
}

/** Packages a project can show or hide: enabled, non-core, and owning a rail
 *  launcher (a window or surface with an icon placeable on any rail).
 *  Background helpers (title generation, recaps, importers, settings-only
 *  integrations) never reach a rail, so a per-project switch would do nothing
 *  visible; globally disabled packages register no launchers at all. */
export function configurableProjectPackages(
  packages: readonly PackageDescriptorDto[],
  railPackageIds: ReadonlySet<string>,
): PackageDescriptorDto[] {
  return packages
    .filter((pkg) => pkg.enabled && !pkg.core && pkg.category !== "system" && railPackageIds.has(pkg.id))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export default function ProjectCompositionEditor({
  value,
  onChange,
  compact = false,
  purposeHeading = true,
}: {
  value: ProjectComposition;
  onChange: (value: ProjectComposition) => void;
  compact?: boolean;
  /** Hosts that already ask "what are you working on?" in their own header
   *  (the new-project flow) hide the duplicate section heading. */
  purposeHeading?: boolean;
}) {
  const [packages, setPackages] = useState<PackageDescriptorDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [customize, setCustomize] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void api.packagesList()
      .then((result) => { if (live) { setPackages(result.packages); setError(""); } })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  // Launchers register as packages load, so re-read when the registry moves.
  const capabilityVersion = useCapabilityVersion();
  const railPackageIds = useMemo(
    () => railLauncherPackageIds(listRegisteredCapabilities()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capabilityVersion],
  );
  const resolution = useMemo(() => compositionPackages(value, packages), [packages, value]);
  const configurable = useMemo(() => configurableProjectPackages(packages, railPackageIds), [packages, railPackageIds]);
  const recommended = useMemo(() => {
    const ids = new Set(resolution.recommendedPackageIds);
    return configurable.filter((pkg) => ids.has(pkg.id));
  }, [configurable, resolution.recommendedPackageIds]);
  // Earlier choices for packages that are no longer listed (uninstalled,
  // disabled, or without a rail launcher) stay visible and removable.
  const missingOverrides = useMemo(
    () => missingProjectPackageOverrides(value, configurable.map((pkg) => pkg.id)),
    [configurable, value],
  );
  const packageNames = useMemo(() => new Map(packages.map((pkg) => [pkg.id, pkg.name])), [packages]);

  const commit = (next: ProjectComposition) => onChange(parseProjectComposition(next));
  const setGeneral = () => commit({ ...value, directions: [] });
  const toggleDirection = (direction: ProjectDirection) => {
    const selected = new Set(value.directions);
    if (selected.has(direction)) selected.delete(direction); else selected.add(direction);
    commit({ ...value, directions: PROJECT_DIRECTIONS.filter((item) => selected.has(item)) });
  };
  const setOverride = (id: string, state: "auto" | "include" | "exclude") => {
    const next = { ...value.packageOverrides };
    if (state === "auto") delete next[id]; else next[id] = state;
    commit({ ...value, packageOverrides: next });
  };

  return (
    <div className={`project-composition-editor${compact ? " is-compact" : ""}`}>
      <section
        className="project-composition-section"
        aria-labelledby={purposeHeading ? "project-composition-purpose" : undefined}
        aria-label={purposeHeading ? undefined : tr("projectcomposition.whatAreYouWorkingOn")}
      >
        {purposeHeading && (
          <div className="project-composition-section-head">
            <div>
              <h3 id="project-composition-purpose">{tr("projectcomposition.whatAreYouWorkingOn")}</h3>
              <p>{tr("projectcomposition.purposeHint")}</p>
            </div>
          </div>
        )}
        <div className="project-direction-grid">
          <button type="button" className={`project-direction-card project-direction-general${value.directions.length === 0 ? " is-selected" : ""}`} aria-pressed={value.directions.length === 0} title={tr("projectcomposition.generalDescription")} onClick={setGeneral}>
            <span className="project-direction-icon"><Icon icon={LayersIcon} size="lg" /></span>
            <span className="project-direction-copy">
              <strong>{tr("projectcomposition.general")}</strong>
              <span>{tr("projectcomposition.generalDescription")}</span>
            </span>
          </button>
          {PROJECT_DIRECTIONS.map((direction) => {
            const copy = DIRECTION_COPY[direction];
            const selected = value.directions.includes(direction);
            return <button key={direction} type="button" className={`project-direction-card${selected ? " is-selected" : ""}`} aria-pressed={selected} title={tr(copy.description)} onClick={() => toggleDirection(direction)}>
              <span className="project-direction-icon"><Icon icon={copy.icon} size="lg" /></span>
              <span className="project-direction-copy">
                <strong>{tr(copy.label)}</strong>
                <span>{tr(copy.description)}</span>
              </span>
            </button>;
          })}
        </div>
      </section>

      {/* Per-package visibility is a pro refinement: an accordion whose
          collapsed header still summarises what the directions surface. */}
      <section className={`project-composition-section project-composition-review${customize ? " is-open" : ""}`} aria-labelledby="project-composition-review">
        <button
          type="button"
          className="project-composition-disclosure"
          aria-expanded={customize}
          aria-controls="project-composition-tools"
          onClick={() => setCustomize((open) => !open)}
        >
          <span className="project-composition-disclosure-copy">
            <strong id="project-composition-review">{tr("projectcomposition.workspace")}</strong>
            <span>{loading
              ? tr("projectcomposition.readingInstalledTools")
              : value.directions.length === 0
                ? tr("projectcomposition.generalVisible")
                : recommended.length > 0
                  ? tr("projectcomposition.enabledPackagesFit", { count: recommended.length })
                  : tr("projectcomposition.workspaceMenuHint")}</span>
          </span>
          <span className="project-composition-disclosure-action">
            <span>{tr("projectcomposition.customize")}</span>
            <Icon icon={ChevronDownIcon} size="sm" />
          </span>
        </button>

        {!loading && !error && recommended.length > 0 && (
          <div className="project-composition-recommended" aria-label={tr("projectcomposition.recommendedTools")}>
            <span className="project-composition-kicker">{tr("projectcomposition.recommended")}</span>
            <div className="project-composition-chips">{recommended.map((pkg) => <span key={pkg.id}>{pkg.name}</span>)}</div>
          </div>
        )}
        {error && <div className="project-composition-error" role="status">{tr("common.unavailable")}</div>}

        {customize && (
          <div id="project-composition-tools" className="project-package-list">
            {configurable.map((pkg) => {
              const state = value.packageOverrides[pkg.id] ?? "auto";
              return <div className="project-package-row" key={pkg.id}>
                <div><strong>{pkg.name}</strong><span>{pkg.description}</span></div>
                <div className="project-package-choice" role="group" aria-label={tr("projectcomposition.visibility", { name: pkg.name })}>
                  {(["auto", "include", "exclude"] as const).map((choice) => <button key={choice} type="button" className={state === choice ? "is-selected" : ""} aria-pressed={state === choice} onClick={() => setOverride(pkg.id, choice)}>{choice === "auto" ? tr("projectcomposition.auto") : choice === "include" ? tr("projectcomposition.show") : tr("projectcomposition.hide")}</button>)}
                </div>
              </div>;
            })}
            {missingOverrides.map(({ id, preference }) => {
              const name = packageNames.get(id) ?? id;
              return <div className="project-package-row is-missing" key={`missing:${id}`}>
                <div><strong>{name}</strong><span>{preference === "include" ? tr("projectcomposition.show") : tr("projectcomposition.hide")}</span></div>
                <Button size="sm" variant="ghost" aria-label={`${tr("common.remove")} ${name}`} onClick={() => setOverride(id, "auto")}>{tr("common.remove")}</Button>
              </div>;
            })}
            {configurable.length === 0 && missingOverrides.length === 0 && (
              <p className="project-composition-error">{tr("projectcomposition.noPackageChoices")}</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
