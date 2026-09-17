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
import { Button } from "./ui/index.ts";
import "./ProjectCompositionEditor.css";

const DIRECTION_COPY: Record<ProjectDirection, { label: TranslationKey; description: TranslationKey }> = {
  engineering: { label: "projectcomposition.direction.engineering", description: "projectcomposition.direction.engineeringDescription" },
  research: { label: "projectcomposition.direction.research", description: "projectcomposition.direction.researchDescription" },
  wellbeing: { label: "projectcomposition.direction.wellbeing", description: "projectcomposition.direction.wellbeingDescription" },
  finance: { label: "projectcomposition.direction.finance", description: "projectcomposition.direction.financeDescription" },
  home: { label: "projectcomposition.direction.home", description: "projectcomposition.direction.homeDescription" },
  operations: { label: "projectcomposition.direction.operations", description: "projectcomposition.direction.operationsDescription" },
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

export function configurableProjectPackages(packages: readonly PackageDescriptorDto[]): PackageDescriptorDto[] {
  return packages
    .filter((pkg) => !pkg.core && pkg.category !== "system")
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export default function ProjectCompositionEditor({
  value,
  onChange,
  compact = false,
}: {
  value: ProjectComposition;
  onChange: (value: ProjectComposition) => void;
  compact?: boolean;
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

  const resolution = useMemo(() => compositionPackages(value, packages), [packages, value]);
  const recommended = useMemo(() => {
    const ids = new Set(resolution.recommendedPackageIds);
    return packages.filter((pkg) => ids.has(pkg.id));
  }, [packages, resolution.recommendedPackageIds]);
  const configurable = useMemo(() => configurableProjectPackages(packages), [packages]);
  const missingOverrides = useMemo(
    () => missingProjectPackageOverrides(value, packages.map((pkg) => pkg.id)),
    [packages, value],
  );

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
      <section className="project-composition-section" aria-labelledby="project-composition-purpose">
        <div className="project-composition-section-head">
          <div>
            <h3 id="project-composition-purpose">{tr("projectcomposition.whatAreYouWorkingOn")}</h3>
            <p>{tr("projectcomposition.purposeHint")}</p>
          </div>
        </div>
        <div className="project-direction-grid">
          <button type="button" className={`project-direction-card${value.directions.length === 0 ? " is-selected" : ""}`} aria-pressed={value.directions.length === 0} onClick={setGeneral}>
            <strong>{tr("projectcomposition.general")}</strong><span>{tr("projectcomposition.generalDescription")}</span>
          </button>
          {PROJECT_DIRECTIONS.map((direction) => {
            const copy = DIRECTION_COPY[direction];
            const selected = value.directions.includes(direction);
            return <button key={direction} type="button" className={`project-direction-card${selected ? " is-selected" : ""}`} aria-pressed={selected} onClick={() => toggleDirection(direction)}>
              <strong>{tr(copy.label)}</strong><span>{tr(copy.description)}</span>
            </button>;
          })}
        </div>
      </section>

      <section className="project-composition-section project-composition-review" aria-labelledby="project-composition-review">
        <div className="project-composition-section-head">
          <div>
            <h3 id="project-composition-review">{tr("projectcomposition.workspace")}</h3>
            <p>{loading
              ? tr("projectcomposition.readingInstalledTools")
              : value.directions.length === 0
                ? tr("projectcomposition.generalDescription")
                : tr("projectcomposition.workspaceMenuHint")}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setCustomize((open) => !open)} aria-expanded={customize}>
            {customize ? tr("projectcomposition.done") : tr("projectcomposition.customize")}
          </Button>
        </div>

        {!loading && !error && recommended.length > 0 && (
          <div className="project-composition-recommended" aria-label={tr("projectcomposition.recommendedTools")}>
            <span className="project-composition-kicker">{tr("projectcomposition.recommended")}</span>
            <div className="project-composition-chips">{recommended.map((pkg) => <span key={pkg.id}>{pkg.name}</span>)}</div>
          </div>
        )}
        {error && <div className="project-composition-error" role="status">{tr("common.unavailable")}</div>}

        {customize && (
          <div className="project-package-list">
            {configurable.map((pkg) => {
              const state = value.packageOverrides[pkg.id] ?? "auto";
              return <div className="project-package-row" key={pkg.id}>
                <div><strong>{pkg.name}</strong><span>{pkg.description}</span></div>
                {pkg.enabled ? <div className="project-package-choice" role="group" aria-label={tr("projectcomposition.visibility", { name: pkg.name })}>
                  {(["auto", "include", "exclude"] as const).map((choice) => <button key={choice} type="button" className={state === choice ? "is-selected" : ""} aria-pressed={state === choice} onClick={() => setOverride(pkg.id, choice)}>{choice === "auto" ? tr("projectcomposition.auto") : choice === "include" ? tr("projectcomposition.show") : tr("projectcomposition.hide")}</button>)}
                </div> : <span className="project-package-disabled">{tr("projectcomposition.disabledGlobally")}</span>}
              </div>;
            })}
            {missingOverrides.map(({ id, preference }) => (
              <div className="project-package-row is-missing" key={`missing:${id}`}>
                <div><strong>{id}</strong><span>{preference === "include" ? tr("projectcomposition.show") : tr("projectcomposition.hide")}</span></div>
                <Button size="sm" variant="ghost" aria-label={`${tr("common.remove")} ${id}`} onClick={() => setOverride(id, "auto")}>{tr("common.remove")}</Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
