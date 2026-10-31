// Model settings for a studio: one picker for the session's own route and, in
// Expert mode, one per work part. The catalog comes from the live harness
// snapshots (the same source the composer's picker uses), so a route always
// names a model the machine can actually run.
import { useEffect, useMemo, useState } from "react";
import type { HarnessSnapshot, ModelDescriptor, ModelRef } from "@polyth/contracts";
import ModelPicker from "@polyth/models/model-picker";
import { createApiTransport } from "@polyth/web-sdk";
import {
  STUDIO_WORK_ROLES,
  studioModelLabel,
  type StudioModelRef,
  type StudioModels,
  type StudioWorkRole,
} from "../src/index.ts";
import { catalogFromSnapshots, findCatalogModel, toStudioModelRef } from "./modelCatalog.ts";
import type { StudioStrings } from "./strings.ts";

const api = createApiTransport();

/** Live model catalog for one project, with loading/error state. */
export function useModelCatalog(projectId: string | null | undefined): {
  models: ModelDescriptor[];
  loading: boolean;
  error: boolean;
} {
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!projectId) { setModels([]); setLoading(false); setError(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(false);
    void api
      .get<HarnessSnapshot[]>(`/api/harnesses/snapshots?detail=1&projectId=${encodeURIComponent(projectId)}`, { signal: controller.signal })
      .then((rows) => { if (!controller.signal.aborted) setModels(catalogFromSnapshots(rows)); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId]);
  return { models, loading, error };
}

export interface ModelSettingsProps {
  projectId: string | null | undefined;
  /** Expert adds one picker per work part; otherwise only the session route. */
  expert: boolean;
  value: StudioModels;
  onChange(next: StudioModels): void;
  /** Rendered between the session picker and the work-part pickers. */
  expertIntro?: React.ReactNode;
  /** The studio's copy for the active locale (the surface computes it once). */
  strings: StudioStrings;
}

/**
 * A label for a route row. Shows the resolved catalogue name so the user sees
 * "Claude Opus 4.5", not "anthropic/claude-opus-4-5". An unavailable route
 * keeps its stored label and is flagged, so it is never silently swapped.
 */
function routeLabel(models: readonly ModelDescriptor[], route: StudioModelRef | undefined, fallback: string): string {
  if (!route) return fallback;
  return findCatalogModel(models, route)?.name ?? studioModelLabel(route);
}

export default function ModelSettings({ projectId, expert, value, onChange, expertIntro, strings }: ModelSettingsProps) {
  const t = strings;
  const { models, loading, error } = useModelCatalog(projectId);
  const roleRoutes = value.roles ?? {};

  const pick = (route: (ModelRef & { harnessId?: string }) | undefined, variant?: string) => {
    const row = route ? models.find((candidate) => candidate.harnessId === route.harnessId
      && candidate.providerID === route.providerID && candidate.modelID === route.modelID) : undefined;
    return toStudioModelRef(route, variant, row?.variants);
  };

  const setDefault = (model: StudioModelRef | undefined) =>
    onChange({ ...value, ...(model ? { default: model } : { default: undefined }) });

  const setRole = (role: StudioWorkRole, model: StudioModelRef | undefined) => {
    const roles = { ...roleRoutes };
    if (model) roles[role] = model;
    else delete roles[role];
    onChange({ ...value, roles: Object.keys(roles).length ? roles : undefined });
  };

  const roleRows = useMemo(() => STUDIO_WORK_ROLES.map((role) => ({
    role,
    label: t[`work_${role}` as keyof typeof t] as string,
    hint: t[`work_${role}_hint` as keyof typeof t] as string,
    route: roleRoutes[role],
  })), [roleRoutes, t]);

  const unavailable = error ? t.modelsLoadError : null;

  return (
    <div className="cs-models">
      <fieldset className="cs-field cs-model-row">
        <legend className="cs-field-label">{t.modelSessionLabel}</legend>
        <ModelPicker
          models={models}
          harnessId={value.default?.harnessId}
          {...(value.default ? { value: value.default } : {})}
          emptyLabel={t.modelAuto}
          catalogLoading={loading}
          onPick={(model) => setDefault(pick(model, model?.variant))}
        />
        <p className="cs-field-hint">
          {value.default ? routeLabel(models, value.default, t.modelAuto) : t.modelSessionHint}
        </p>
      </fieldset>
      {expert && (
        <>
          {expertIntro}
          <div className="cs-model-grid">
            {roleRows.map((row) => (
              <fieldset key={row.role} className="cs-field cs-model-row">
                <legend className="cs-field-label">{row.label}</legend>
                <ModelPicker
                  models={models}
                  harnessId={row.route?.harnessId ?? value.default?.harnessId}
                  {...(row.route ? { value: row.route } : {})}
                  emptyLabel={t.modelSameAsSession}
                  catalogLoading={loading}
                  onPick={(model) => setRole(row.role, pick(model, model?.variant))}
                />
                <p className="cs-field-hint">
                  {row.route ? routeLabel(models, row.route, t.modelSameAsSession) : t.modelRoleInherit}
                </p>
                <p className="cs-field-hint">{row.hint}</p>
              </fieldset>
            ))}
          </div>
        </>
      )}
      {unavailable && <p className="cs-field-error" role="alert">{unavailable}</p>}
      {!loading && !error && models.length === 0 && <p className="cs-field-hint" role="status">{t.modelsEmpty}</p>}
    </div>
  );
}
