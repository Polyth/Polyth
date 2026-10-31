export interface PackageLauncher {
  id: string;
  ownerPackageId?: string;
  /** `command` launchers (one per action) never share their package's slot. */
  kind?: "destination" | "command";
}

/** One entry per package in an ordered rail. Prefer its canonical home when
 * present; host navigation has no package grouping, and command launchers
 * are each their own entry. */
export function uniquePackageLaunchers<T>(
  entries: readonly T[],
  identity: (entry: T) => PackageLauncher,
): T[] {
  const chosen = new Map<string, T>();
  for (const entry of entries) {
    const { id, ownerPackageId: owner, kind } = identity(entry);
    if (!owner || owner === "host" || owner === "polyth" || kind === "command") continue;
    if (!chosen.has(owner) || id === owner) chosen.set(owner, entry);
  }
  return entries.filter((entry) => {
    const { ownerPackageId: owner, kind } = identity(entry);
    return !owner || owner === "host" || owner === "polyth" || kind === "command" || chosen.get(owner) === entry;
  });
}
