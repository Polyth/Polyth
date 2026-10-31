// Three-way merge for project presentation records (widget layout, capability
// layout, …). `base` is the last server snapshot this device synced from,
// `local` is the device cache, `server` is the newer server snapshot.
//
// Only what changed locally since `base` is replayed onto `server`, so a stale
// device cache can never resurrect state another client already changed — e.g.
// a hidden rail icon that a stale phone/tab would otherwise restore together
// with an unrelated automatic layout repair.

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (value: Json): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
}

const isIdList = (value: Json): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Ordered id lists (rail/slot placements): replay local additions/removals
 * onto the server order. A pure local reorder keeps the local order. */
function mergeIdLists(base: string[], local: string[], server: string[]): string[] {
  const baseSet = new Set(base);
  const localSet = new Set(local);
  const serverSet = new Set(server);
  const removedLocally = base.filter((id) => !localSet.has(id));
  const addedLocally = local.filter((id) => !baseSet.has(id));
  if (removedLocally.length === 0 && addedLocally.length === 0) {
    // Same membership, new order: keep the local order, then apply the
    // server's membership changes.
    const ordered = local.filter((id) => serverSet.has(id) || !baseSet.has(id));
    return [...ordered, ...server.filter((id) => !baseSet.has(id) && !ordered.includes(id))];
  }
  const removed = new Set(removedLocally);
  const result = server.filter((id) => !removed.has(id));
  for (const id of addedLocally) if (!result.includes(id)) result.push(id);
  return result;
}

/** Returns the merged value; `undefined` means the entry is absent. */
export function mergeJson3(base: Json, local: Json, server: Json): Json {
  if (jsonEqual(local, base)) return server;
  if (jsonEqual(server, base) || jsonEqual(local, server)) return local;
  // Both sides created the entry independently: the durable server copy wins,
  // so an automatically generated default cannot override a real choice.
  if (base === undefined) return server;
  if (isObject(base) && isObject(local) && isObject(server)) {
    const merged: JsonObject = {};
    for (const key of new Set([...Object.keys(server), ...Object.keys(local)])) {
      const value = mergeJson3(base[key], local[key], server[key]);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  if (isIdList(base) && isIdList(local) && isIdList(server)) return mergeIdLists(base, local, server);
  // A genuine concurrent edit of the same leaf: the pending local edit wins.
  return local;
}

export function mergeRecords3(
  base: Record<string, Json>,
  local: Record<string, Json>,
  server: Record<string, Json>,
): Record<string, Json> {
  return mergeJson3(base, local, server) as Record<string, Json>;
}
