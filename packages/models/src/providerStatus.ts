// Provider instance status: enabled (visibility) is distinct from runtime
// readiness. The UI shows one quiet label derived from this — never a pile of
// overlapping "connected" / "not connected" / toggle-on badges.

export {
  deriveProviderStatus,
  type ProviderStatusInput,
} from "@polyth/contracts";
export type { ProviderOrigin, ProviderStatus } from "@polyth/contracts";

export function filterProviderModels<T extends { name: string; key?: string; modelID?: string }>(
  models: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...models];
  return models.filter((m) => {
    const id = (m.key ?? m.modelID ?? "").toLowerCase();
    return m.name.toLowerCase().includes(q) || id.includes(q);
  });
}
