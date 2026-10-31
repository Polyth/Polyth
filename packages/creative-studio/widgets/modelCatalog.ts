// Studio model settings: the catalog the pickers read and the pure helpers
// that keep the studio state, the chat's draft execution config and the brief
// in agreement. No React here so the mapping is unit-tested without rendering.
import type { HarnessSnapshot, ModelDescriptor, ModelRef } from "@polyth/contracts";
import {
  sameStudioModel,
  STUDIO_WORK_ROLES,
  type StudioModelRef,
  type StudioModels,
  type StudioWorkRole,
} from "../src/index.ts";

/**
 * Flat catalog the `@polyth/models/model-picker` consumes. The harness
 * snapshot carries its own identity id; a runtime-local catalog may omit
 * `harnessId` on each model, so it is filled from the snapshot.
 */
export function catalogFromSnapshots(rows: readonly HarnessSnapshot[]): ModelDescriptor[] {
  return rows.flatMap((row) =>
    (row.catalog?.models ?? []).map((model) => ({
      ...model,
      harnessId: model.harnessId ?? row.identity.id,
    })));
}

/** Picker selection → studio route. When the caller supplies the advertised
 * variants, a level the model does not offer is dropped, so a stored route
 * never names reasoning effort the model cannot run. */
export function toStudioModelRef(
  model: (ModelRef & { harnessId?: string }) | undefined,
  variant?: string,
  advertised?: readonly string[],
): StudioModelRef | undefined {
  if (!model?.harnessId) return undefined;
  const chosen = variant?.trim() ? variant.trim() : model.variant?.trim() ? model.variant.trim() : undefined;
  const allowed = chosen && (!advertised || advertised.includes(chosen)) ? chosen : undefined;
  return {
    harnessId: model.harnessId,
    providerID: model.providerID,
    modelID: model.modelID,
    ...(allowed ? { variant: allowed } : {}),
  };
}

/** The catalog row behind a stored route, so the picker shows a real name. */
export function findCatalogModel(
  models: readonly ModelDescriptor[],
  route: StudioModelRef | undefined,
): ModelDescriptor | undefined {
  if (!route) return undefined;
  return models.find((model) =>
    (model.harnessId ?? route.harnessId) === route.harnessId
    && model.providerID === route.providerID
    && model.modelID === route.modelID);
}

/** A route is usable when the picker still finds it in the live catalog. */
export function routeIsAvailable(models: readonly ModelDescriptor[], route: StudioModelRef | undefined): boolean {
  if (!route) return true;
  return Boolean(findCatalogModel(models, route));
}

export interface StudioModelSummaryRow {
  role: StudioWorkRole;
  route: StudioModelRef | undefined;
  /** True when the part has no route of its own and follows `default`. */
  inherited: boolean;
  available: boolean;
}

/** What the Expert step and the studio settings panel show per work part. */
export function summarizeModels(models: StudioModels | undefined, catalog: readonly ModelDescriptor[]): {
  fallback: StudioModelRef | undefined;
  fallbackAvailable: boolean;
  roles: StudioModelSummaryRow[];
} {
  const fallback = models?.default;
  return {
    fallback,
    fallbackAvailable: routeIsAvailable(catalog, fallback),
    roles: STUDIO_WORK_ROLES.map((role) => {
      const route = models?.roles?.[role];
      return {
        role,
        route,
        inherited: !route,
        available: routeIsAvailable(catalog, route),
      };
    }),
  };
}

/**
 * The route a work part actually runs on: its own, else the session default.
 * `undefined` means "leave it to the agent's normal choice".
 */
export function effectiveRoute(models: StudioModels | undefined, role: StudioWorkRole): StudioModelRef | undefined {
  return models?.roles?.[role] ?? models?.default;
}

/** Roles whose route differs from the session default, for the brief. */
export function overriddenRoles(models: StudioModels | undefined): StudioWorkRole[] {
  if (!models) return [];
  return STUDIO_WORK_ROLES.filter((role) => {
    const route = models.roles?.[role];
    return Boolean(route) && !sameStudioModel(route, models.default);
  });
}
