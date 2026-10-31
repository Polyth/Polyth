import type { ModelDescriptor, ModelRef } from "./index.ts";

const conflicted = (model: ModelDescriptor): ModelDescriptor => {
  const { context: _context, ...rest } = model;
  return { ...rest, contextStatus: "conflict" };
};

/** Merge native catalog rows before fallback enrichment. Conflict is durable
 * metadata, not a missing value that a later catalog may guess again. */
export function dedupeModelDescriptors(items: readonly ModelDescriptor[]): ModelDescriptor[] {
  const result: ModelDescriptor[] = [];
  const positions = new Map<string, number>();
  for (const model of items) {
    const key = JSON.stringify([model.harnessId ?? "legacy", model.providerID, model.modelID]);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, result.length);
      result.push(model.contextStatus === "conflict" ? conflicted(model) : model);
      continue;
    }
    const existing = result[position]!;
    if (existing.contextStatus === "conflict" || model.contextStatus === "conflict") {
      result[position] = conflicted(existing);
    } else if (existing.context === undefined && model.context !== undefined) {
      result[position] = { ...existing, context: model.context };
    } else if (existing.context !== undefined && model.context !== undefined && existing.context !== model.context) {
      result[position] = conflicted(existing);
    }
  }
  return result;
}

/** Capacity is runtime evidence, unlike a display-name fallback. Never borrow
 * another harness's row, and refuse conflicting duplicates within the scope. */
export function resolveModelContextLimit(
  model: ModelRef | null | undefined,
  catalog: readonly ModelDescriptor[],
  harnessId?: string,
): number | undefined {
  if (!model) return undefined;
  const matching = catalog.filter((row) =>
    row.providerID === model.providerID && row.modelID === model.modelID);
  const qualified = harnessId ? matching.filter((row) => row.harnessId === harnessId) : [];
  const scoped = qualified.length ? qualified : matching.filter((row) => row.harnessId === undefined);
  if (scoped.some((row) => row.contextStatus === "conflict")) return undefined;
  const limits = scoped.map((row) => row.context).filter((limit): limit is number =>
    typeof limit === "number" && Number.isFinite(limit) && limit > 0);
  return new Set(limits).size === 1 ? limits[0] : undefined;
}
