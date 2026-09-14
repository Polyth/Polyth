export const PACKAGE_CAPABILITY_NAMES = [
  "ui.toast",
  "ui.openSurface",
  "ui.openExternalUrl",
  "ui.render",
  "composer.write",
  "composer.send",
  "session.read",
  "session.appendContext",
  "session.messages.read",
  "session.create",
  "session.prompt",
  "context.append",
  "project.readMetadata",
  "project.files.read",
  "project.files.write",
  "attachments.create",
  "model.generate",
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

export interface CapabilityConstraints {
  origins?: string[];
  paths?: string[];
  methods?: Array<"GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE">;
  modelClasses?: Array<"utility" | "standard">;
  maxOutputTokens?: number;
}

export interface DeclaredCapability {
  name: PackageCapabilityName;
  /** Required access blocks activation when it is not granted. Optional access is usable only when granted. */
  required?: boolean;
  constraints?: CapabilityConstraints;
}

const missingStrings = (current: readonly string[] | undefined, next: readonly string[] | undefined): string[] => {
  if (!next?.length) return [];
  if (!current) return [];
  const allowed = new Set(current);
  return next.filter((value) => !allowed.has(value));
};

/** Capabilities in `next` that are not covered by `current`, including scope expansion. */
export function expandedCapabilities(
  current: readonly DeclaredCapability[],
  next: readonly DeclaredCapability[],
): DeclaredCapability[] {
  const allowed = new Map<PackageCapabilityName, DeclaredCapability>();
  for (const item of current) allowed.set(item.name, item);

  const extra: DeclaredCapability[] = [];
  for (const item of next) {
    const granted = allowed.get(item.name);
    if (!granted) {
      extra.push(item);
      continue;
    }

    const currentConstraints = granted.constraints;
    const requested = item.constraints;
    if (!requested) continue;
    if (!currentConstraints) continue;

    const origins = missingStrings(currentConstraints.origins, requested.origins);
    const paths = missingStrings(currentConstraints.paths, requested.paths);
    const methods = missingStrings(currentConstraints.methods, requested.methods) as CapabilityConstraints["methods"];
    const modelClasses = missingStrings(currentConstraints.modelClasses, requested.modelClasses) as CapabilityConstraints["modelClasses"];
    const tokenExpansion = typeof requested.maxOutputTokens === "number"
      && (typeof currentConstraints.maxOutputTokens !== "number" || requested.maxOutputTokens > currentConstraints.maxOutputTokens)
      ? requested.maxOutputTokens
      : undefined;

    if (origins.length || paths.length || methods?.length || modelClasses?.length || tokenExpansion !== undefined) {
      extra.push({
        name: item.name,
        ...(item.required === false ? { required: false } : {}),
        constraints: {
          ...(origins.length ? { origins } : {}),
          ...(paths.length ? { paths } : {}),
          ...(methods?.length ? { methods } : {}),
          ...(modelClasses?.length ? { modelClasses } : {}),
          ...(tokenExpansion !== undefined ? { maxOutputTokens: tokenExpansion } : {}),
        },
      });
    }
  }
  return extra;
}
