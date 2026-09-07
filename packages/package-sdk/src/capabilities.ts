export const PACKAGE_CAPABILITY_NAMES = [
  "ui.toast",
  "ui.openSurface",
  "ui.openExternalUrl",
  "ui.render",
  "composer.write",
  "composer.send",
  "session.read",
  "session.appendContext",
  "project.readMetadata",
  "attachments.create",
  "storage.package",
  "network.fetch",
  "auth.connection",
  "clipboard.write",
] as const;

export type PackageCapabilityName = (typeof PACKAGE_CAPABILITY_NAMES)[number];

const catalog = new Set<string>(PACKAGE_CAPABILITY_NAMES);

export function isPackageCapabilityName(value: string): value is PackageCapabilityName {
  return catalog.has(value);
}

export interface DeclaredCapability {
  name: PackageCapabilityName;
  constraints?: { origins?: string[] };
}

/** Capabilities in `next` that are not covered by `current` (name + origins). */
export function expandedCapabilities(
  current: readonly DeclaredCapability[],
  next: readonly DeclaredCapability[],
): DeclaredCapability[] {
  const allowed = new Map<string, Set<string> | null>();
  for (const item of current) {
    const origins = item.constraints?.origins;
    allowed.set(item.name, origins ? new Set(origins) : null);
  }
  const extra: DeclaredCapability[] = [];
  for (const item of next) {
    const granted = allowed.get(item.name);
    if (granted === undefined) {
      extra.push(item);
      continue;
    }
    const requested = item.constraints?.origins ?? [];
    if (granted === null) continue;
    if (requested.length === 0 && granted.size > 0) {
      extra.push(item);
      continue;
    }
    const missing = requested.filter((origin) => !granted.has(origin));
    if (missing.length > 0) {
      extra.push({
        name: item.name,
        constraints: { origins: missing },
      });
    }
  }
  return extra;
}
