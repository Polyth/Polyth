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
import { Button } from "./ui/index.ts";
import "./ProjectCompositionEditor.css";

const DIRECTION_COPY: Record<ProjectDirection, { label: string; description: string }> = {
  engineering: { label: "Engineering", description: "Code, infrastructure, source control and terminals." },
  research: { label: "Research", description: "Knowledge, browsing, notes and structured exploration." },
  wellbeing: { label: "Wellbeing", description: "Goals, routines, reflection and personal coaching." },
  finance: { label: "Finance", description: "Markets, portfolios and financial research." },
  home: { label: "Home", description: "Home systems, devices and automations." },
  operations: { label: "Operations", description: "Schedules, workflows, monitoring and recurring work." },
};

const DIRECTION_SET = new Set<string>(PROJECT_DIRECTIONS);

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
  const configurable = useMemo(() => packages
    .filter((pkg) => !pkg.core && pkg.category !== "system")
    .filter((pkg) => pkg.projectAffinity?.directions?.length
      || pkg.category === "workspace"
      || (typeof pkg.category === "string" && DIRECTION_SET.has(pkg.category)))
    .sort((a, b) => a.name.localeCompare(b.name)), [packages]);

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
            <h3 id="project-composition-purpose">What are you working on?</h3>
            <p>Choose one or more. This changes what Polyth surfaces first; it never changes permissions.</p>
          </div>
        </div>
        <div className="project-direction-grid">
          <button type="button" className={`project-direction-card${value.directions.length === 0 ? " is-selected" : ""}`} aria-pressed={value.directions.length === 0} onClick={setGeneral}>
            <strong>General</strong><span>Keep every globally enabled tool available.</span>
          </button>
          {PROJECT_DIRECTIONS.map((direction) => {
            const copy = DIRECTION_COPY[direction];
            const selected = value.directions.includes(direction);
            return <button key={direction} type="button" className={`project-direction-card${selected ? " is-selected" : ""}`} aria-pressed={selected} onClick={() => toggleDirection(direction)}>
              <strong>{copy.label}</strong><span>{copy.description}</span>
            </button>;
          })}
        </div>
      </section>

      <section className="project-composition-section project-composition-review" aria-labelledby="project-composition-review">
        <div className="project-composition-section-head">
          <div>
            <h3 id="project-composition-review">Workspace</h3>
            <p>{loading ? "Reading installed tools…" : value.directions.length === 0
              ? "General projects keep your globally enabled packages visible."
              : `${resolution.relevantPackageIds.length} enabled packages fit this project.`}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setCustomize((open) => !open)} aria-expanded={customize}>
            {customize ? "Done" : "Customize"}
          </Button>
        </div>

        {!loading && !error && recommended.length > 0 && (
          <div className="project-composition-recommended" aria-label="Recommended tools">
            <span className="project-composition-kicker">Recommended</span>
            <div className="project-composition-chips">{recommended.map((pkg) => <span key={pkg.id}>{pkg.name}</span>)}</div>
          </div>
        )}
        {error && <div className="project-composition-error" role="status">Package recommendations unavailable. Your selection can still be saved.</div>}

        {customize && (
          <div className="project-package-list">
            {configurable.map((pkg) => {
              const state = value.packageOverrides[pkg.id] ?? "auto";
              return <div className="project-package-row" key={pkg.id}>
                <div><strong>{pkg.name}</strong><span>{pkg.description}</span></div>
                {pkg.enabled ? <div className="project-package-choice" role="group" aria-label={`${pkg.name} visibility`}>
                  {(["auto", "include", "exclude"] as const).map((choice) => <button key={choice} type="button" className={state === choice ? "is-selected" : ""} aria-pressed={state === choice} onClick={() => setOverride(pkg.id, choice)}>{choice === "auto" ? "Auto" : choice === "include" ? "Show" : "Hide"}</button>)}
                </div> : <span className="project-package-disabled">Disabled globally</span>}
              </div>;
            })}
            {configurable.length === 0 && !loading && <p className="project-package-empty">No project-scoped package choices are available yet.</p>}
          </div>
        )}
      </section>
    </div>
  );
}
